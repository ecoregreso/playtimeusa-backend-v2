// src/routes/games.js
const express = require('express');
const { Op } = require('sequelize');
const { sequelize } = require('../db');
const { Wallet, Transaction, GameRound, Session, PlayerSafetyAction } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");
const { applyPendingBonusIfEligible, buildBonusState } = require("../services/bonusService");
const safetyEngine = require("../services/playerSafetyEngine");
const jackpotService = require("../services/jackpotService");

const router = express.Router();

async function getOrCreateWallet(userId, tenantId, t) {
  let wallet = await Wallet.findOne({
    where: { userId, tenantId },
    transaction: t,
  });
  if (!wallet) {
    wallet = await Wallet.create(
      {
        userId,
        tenantId,
        balance: 0,
        currency: "FUN",
        bonusPending: 0,
        bonusUnacked: 0,
      },
      { transaction: t }
    );
  }
  return wallet;
}

async function resolveSessionId(req, userId, t) {
  const raw = req.headers["x-session-id"];
  if (!raw) return null;
  const session = await Session.findOne({
    where: {
      id: String(raw),
      actorType: "user",
      userId: String(userId),
      revokedAt: { [Op.is]: null },
    },
    transaction: t,
  });
  if (!session) return null;
  session.lastSeenAt = new Date();
  await session.save({ transaction: t });
  return session.id;
}

/**
 * POST /games/:gameId/bet
 * player places a bet
 * Body: { betAmount, roundIndex?, currency?, result?, metadata? }
 */
router.post(
  '/:gameId/bet',
  requireAuth,
  requireRole('player'),
  async (req, res) => {
    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const { gameId } = req.params;
      const {
        betAmount,
        roundIndex,
        currency = 'FUN',
        result,
        metadata,
      } = req.body;

      const amount = parseFloat(betAmount);
      if (!amount || amount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'betAmount must be > 0' });
      }

      const sessionId = await resolveSessionId(req, req.user.id, t);
      const proposedLossCents = toCents(amount);

      try {
        await safetyEngine.enforceLossLimit(
          { playerId: req.user.id, sessionId },
          proposedLossCents
        );
      } catch (err) {
        await t.rollback();
        if (err?.code === "LOSS_LIMIT_REACHED") {
          await PlayerSafetyAction.create({
            tenantId: req.auth?.tenantId || null,
            playerId: req.user.id,
            sessionId,
            gameKey: gameId,
            actionType: "STOP",
            reasonCodes: ["LOSS_LIMIT_HIT"],
            severity: 5,
            details: {
              score: 100,
              band: "STOP",
              evidence: {
                lossLimitCents: err.lossLimitCents,
                currentLossCents: err.currentLossCents,
                projectedLossCents: err.projectedLossCents,
              },
            },
          });
          return res.status(403).json({
            ok: false,
            code: "LOSS_LIMIT_REACHED",
            message: "Loss limit reached for this session.",
            action: { actionType: "STOP", message: safetyEngine.ACTION_MESSAGES.STOP },
          });
        }
        throw err;
      }

      const wallet = await getOrCreateWallet(req.user.id, req.auth?.tenantId || null, t);

      const balanceBefore = parseFloat(wallet.balance || 0);
      if (balanceBefore < amount) {
        await t.rollback();
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      const balanceAfter = balanceBefore - amount;
      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const txMetadata = {
        gameId,
        roundIndex: roundIndex ?? null,
        ...(metadata || {}),
      };
      if (sessionId) txMetadata.sessionId = sessionId;

      const betTx = await Transaction.create(
        {
          tenantId: req.auth?.tenantId || null,
          walletId: wallet.id,
          type: 'game_bet',
          amount,
          balanceBefore,
          balanceAfter,
          reference: `game:${gameId}`,
          metadata: txMetadata,
          createdByUserId: req.user.id,
        },
        { transaction: t }
      );

      const roundMetadata = {
        ...(metadata || {}),
      };
      if (sessionId) roundMetadata.sessionId = sessionId;

      const round = await GameRound.create(
        {
          tenantId: req.auth?.tenantId || null,
          playerId: req.user.id,
          gameId,
          roundIndex: roundIndex ?? null,
          betAmount: amount,
          winAmount: 0,
          currency,
          status: 'pending',
          result: result || null,
          metadata: Object.keys(roundMetadata).length ? roundMetadata : null,
        },
        { transaction: t }
      );

      await applyPendingBonusIfEligible({
        wallet,
        transaction: t,
        reference: `bonus:${gameId}:${roundIndex ?? "spin"}`,
        metadata: { gameId, roundIndex: roundIndex ?? null, roundId: round.id },
      });

      await t.commit();

      const betMeta = buildRequestMeta(req, { roundId: round.id });
      await recordLedgerEvent({
        ts: new Date(),
        playerId: req.user.id,
        sessionId: sessionId ? String(sessionId) : null,
        actionId: round.id,
        gameKey: gameId,
        eventType: "BET",
        amountCents: toCents(-amount),
        betCents: toCents(amount),
        balanceCents: toCents(balanceAfter),
        source: "games.bet",
        meta: betMeta,
      });

      await recordLedgerEvent({
        ts: new Date(),
        playerId: req.user.id,
        sessionId: sessionId ? String(sessionId) : null,
        actionId: round.id,
        gameKey: gameId,
        eventType: "SPIN",
        betCents: toCents(amount),
        source: "games.bet",
        meta: betMeta,
      });

      // Jackpot contributions & triggers
      const jackpotWins = await jackpotService.processBet({
        tenantId: req.auth?.tenantId || null,
        playerId: req.user.id,
        betAmount: amount,
        gameId,
      });

      return res.status(201).json({
        wallet,
        transaction: betTx,
        round,
        bonus: buildBonusState(wallet),
        jackpotWins,
      });
    } catch (err) {
      console.error('[GAMES] POST /games/:gameId/bet error:', err);
      await t.rollback();
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /games/:gameId/settle
 * settle a round with win amount
 * Body: { roundId, winAmount, result?, metadata? }
 */
router.post(
  '/:gameId/settle',
  requireAuth,
  requireRole('player', 'admin'),
  async (req, res) => {
    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const { gameId } = req.params;
      const { roundId, winAmount, result, metadata } = req.body;

      const round = await GameRound.findOne({
        where: { id: roundId, gameId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!round) {
        await t.rollback();
        return res.status(404).json({ error: 'Round not found' });
      }

      // if player, can only settle own rounds
      if (req.user.role === 'player' && round.playerId !== req.user.id) {
        await t.rollback();
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (round.status === 'settled') {
        await t.rollback();
        return res.status(400).json({ error: 'Round already settled' });
      }

      const win = parseFloat(winAmount || 0);
      if (Number.isNaN(win) || win < 0) {
        await t.rollback();
        return res.status(400).json({ error: 'winAmount must be >= 0' });
      }

      const sessionId =
        (await resolveSessionId(req, round.playerId, t)) ||
        round?.metadata?.sessionId ||
        null;

      let wallet = await getOrCreateWallet(round.playerId, req.auth?.tenantId || null, t);
      const balanceBefore = parseFloat(wallet.balance || 0);
      let balanceAfter = balanceBefore;
      let winTx = null;

      if (win > 0) {
        balanceAfter = balanceBefore + win;
        wallet.balance = balanceAfter;
        await wallet.save({ transaction: t });

        const winMetadata = {
          gameId,
          roundId: round.id,
          ...(metadata || {}),
        };
        if (sessionId) winMetadata.sessionId = sessionId;

        winTx = await Transaction.create(
          {
            tenantId: req.auth?.tenantId || null,
            walletId: wallet.id,
            type: 'game_win',
            amount: win,
            balanceBefore,
            balanceAfter,
            reference: `game_round:${round.id}`,
            metadata: winMetadata,
            createdByUserId: req.user.id,
          },
          { transaction: t }
        );
      }

      round.winAmount = win;
      round.status = 'settled';

      if (result) {
        round.result = result;
      }
      if (metadata || sessionId) {
        round.metadata = {
          ...(round.metadata || {}),
          ...(metadata || {}),
          ...(sessionId ? { sessionId } : {}),
        };
      }

      const bet = parseFloat(round.betAmount || 0);
      if (bet > 0) {
        round.rtpSample = win / bet;
      }

      await round.save({ transaction: t });

      await t.commit();

      if (win > 0) {
        await recordLedgerEvent({
          ts: new Date(),
          playerId: round.playerId,
          sessionId: sessionId ? String(sessionId) : null,
          actionId: round.id,
          gameKey: gameId,
          eventType: "WIN",
          amountCents: toCents(win),
          winCents: toCents(win),
          balanceCents: toCents(balanceAfter),
          source: "games.settle",
          meta: buildRequestMeta(req, { roundId: round.id }),
        });
      }

      return res.status(200).json({
        wallet,
        round,
        winTransaction: winTx,
      });
    } catch (err) {
      console.error('[GAMES] POST /games/:gameId/settle error:', err);
      await t.rollback();
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /games/rounds/me
 * last 50 rounds for logged-in player
 */
router.get(
  '/rounds/me',
  requireAuth,
  requireRole('player'),
  async (req, res) => {
    try {
      const rounds = await GameRound.findAll({
        where: { playerId: req.user.id },
        order: [['createdAt', 'DESC']],
        limit: 50,
      });

      return res.json({ rounds });
    } catch (err) {
      console.error('[GAMES] GET /games/rounds/me error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
