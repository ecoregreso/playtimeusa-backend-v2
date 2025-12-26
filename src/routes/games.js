// src/routes/games.js
const express = require('express');
const { Op } = require('sequelize');
const { sequelize } = require('../db');
const { Wallet, Transaction, GameRound, Session } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");

const router = express.Router();

async function getOrCreateWallet(userId, t) {
  let wallet = await Wallet.findOne({ where: { userId }, transaction: t });
  if (!wallet) {
    wallet = await Wallet.create(
      { userId, balance: 0, currency: 'FUN' },
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
    const t = await sequelize.transaction();
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

      const wallet = await getOrCreateWallet(req.user.id, t);

      const balanceBefore = parseFloat(wallet.balance || 0);
      if (balanceBefore < amount) {
        await t.rollback();
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      const balanceAfter = balanceBefore - amount;
      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const sessionId = await resolveSessionId(req, req.user.id, t);
      const txMetadata = {
        gameId,
        roundIndex: roundIndex ?? null,
        ...(metadata || {}),
      };
      if (sessionId) txMetadata.sessionId = sessionId;

      const betTx = await Transaction.create(
        {
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

      await t.commit();

      const betMeta = buildRequestMeta(req, { roundId: round.id });
      await recordLedgerEvent({
        ts: new Date(),
        playerId: req.user.id,
        sessionId: sessionId ? String(sessionId) : null,
        gameKey: gameId,
        eventType: "BET",
        amountCents: toCents(-amount),
        betCents: toCents(amount),
        balanceCents: toCents(balanceAfter),
        meta: betMeta,
      });

      await recordLedgerEvent({
        ts: new Date(),
        playerId: req.user.id,
        sessionId: sessionId ? String(sessionId) : null,
        gameKey: gameId,
        eventType: "SPIN",
        betCents: toCents(amount),
        meta: betMeta,
      });

      return res.status(201).json({
        wallet,
        transaction: betTx,
        round,
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
    const t = await sequelize.transaction();
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

      let wallet = await getOrCreateWallet(round.playerId, t);
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
          gameKey: gameId,
          eventType: "WIN",
          amountCents: toCents(win),
          winCents: toCents(win),
          balanceCents: toCents(balanceAfter),
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
