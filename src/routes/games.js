// src/routes/games.js
const express = require('express');
const { Op } = require('sequelize');
const { sequelize } = require('../db');
const { Wallet, Transaction, GameRound, Session, PlayerSafetyAction, Voucher } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");
const { applyPendingBonusIfEligible, buildBonusState } = require("../services/bonusService");
const { getJson } = require("../utils/ownerSettings");
const {
  resolveVoucherMaxCashout,
  readVoucherPolicy,
  computeVoucherDrivenPayout,
  buildVoucherPolicyMetadata,
} = require("../services/voucherOutcomeService");
const {
  DEFAULT_OUTCOME_MODE,
  normalizeOutcomeMode,
  isVoucherControlledOutcomeMode,
} = require("../services/outcomeModeService");
const safetyEngine = require("../services/playerSafetyEngine");
const jackpotService = require("../services/jackpotService");

const router = express.Router();
const SYSTEM_CONFIG_KEY = "system_config";

function tenantConfigKey(tenantId) {
  return `tenant:${tenantId}:config`;
}

async function resolveOutcomeMode(tenantId) {
  const system = await getJson(SYSTEM_CONFIG_KEY, {});
  const tenant = tenantId ? await getJson(tenantConfigKey(tenantId), {}) : {};
  const merged = { ...(system || {}), ...(tenant || {}) };
  return normalizeOutcomeMode(merged?.outcomeMode, DEFAULT_OUTCOME_MODE);
}

function toMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

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

async function resolveActiveVoucher({ wallet, userId, tenantId, transaction }) {
  if (wallet?.activeVoucherId) {
    const active = await Voucher.findOne({
      where: { id: wallet.activeVoucherId, tenantId: tenantId || null },
      transaction,
      lock: transaction?.LOCK?.UPDATE,
    });
    if (active) return active;
  }

  const fallback = await Voucher.findOne({
    where: {
      tenantId: tenantId || null,
      redeemedByUserId: userId,
      status: { [Op.in]: ["redeemed", "REDEEMED"] },
    },
    order: [
      ["redeemedAt", "DESC"],
      ["createdAt", "DESC"],
    ],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });

  if (fallback && wallet && wallet.activeVoucherId !== fallback.id) {
    wallet.activeVoucherId = fallback.id;
    await wallet.save({ transaction });
  }

  return fallback;
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
      const activeVoucher = await resolveActiveVoucher({
        wallet,
        userId: req.user.id,
        tenantId: req.auth?.tenantId || null,
        transaction: t,
      });

      if (!activeVoucher) {
        await t.rollback();
        return res.status(403).json({
          ok: false,
          code: "NO_ACTIVE_VOUCHER",
          message: "No active redeemed voucher is linked to this wallet.",
        });
      }

      const outcomeMode = await resolveOutcomeMode(req.auth?.tenantId || null);
      const outcomesControlledByVoucher = isVoucherControlledOutcomeMode(outcomeMode);
      const resolvedMaxCashout = resolveVoucherMaxCashout(activeVoucher);
      const maxCashout = resolvedMaxCashout > 0 ? resolvedMaxCashout : null;

      if (outcomesControlledByVoucher && !(maxCashout > 0)) {
        await t.rollback();
        return res.status(400).json({
          ok: false,
          code: "INVALID_VOUCHER_CAP",
          message: "Voucher max cashout is not configured.",
        });
      }
      const policySnapshot = outcomesControlledByVoucher
        ? readVoucherPolicy(activeVoucher)
        : null;

      const balanceBefore = parseFloat(wallet.balance || 0);
      if (balanceBefore < amount) {
        await t.rollback();
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      const balanceAfter = balanceBefore - amount;
      let trackedBeforeBet = null;
      let trackedAfterBet = null;
      if (outcomesControlledByVoucher) {
        trackedBeforeBet = toMoney(
          Math.max(
            0,
            Number(
              policySnapshot.hasTrackedBalance
                ? policySnapshot.trackedBalance
                : Math.min(maxCashout, balanceBefore)
            )
          )
        );
        trackedAfterBet = toMoney(Math.max(0, trackedBeforeBet - amount));
      }
      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      if (outcomesControlledByVoucher) {
        const priorVoucherPolicy =
          activeVoucher.metadata &&
          activeVoucher.metadata.voucherPolicy &&
          typeof activeVoucher.metadata.voucherPolicy === "object"
            ? activeVoucher.metadata.voucherPolicy
            : {};
        activeVoucher.maxCashout = maxCashout;
        activeVoucher.metadata = {
          ...(activeVoucher.metadata || {}),
          maxCashout,
          voucherPolicy: {
            ...priorVoucherPolicy,
            maxCashout,
            trackedBalance: trackedAfterBet,
            lastBalance: trackedAfterBet,
            decayRate: Number(priorVoucherPolicy.decayRate || policySnapshot.decayRate),
            minDecayAmount: Number(
              priorVoucherPolicy.minDecayAmount || policySnapshot.minDecayAmount
            ),
            stakeDecayMultiplier: Number(
              priorVoucherPolicy.stakeDecayMultiplier || policySnapshot.stakeDecayMultiplier
            ),
          },
        };
        await activeVoucher.save({ transaction: t });
      }

      const txMetadata = {
        gameId,
        roundIndex: roundIndex ?? null,
        voucherId: activeVoucher.id,
        outcomeMode,
        outcomesControlledByVoucher,
        ...(metadata || {}),
      };
      if (maxCashout != null) txMetadata.maxCashout = maxCashout;
      if (trackedBeforeBet != null) txMetadata.voucherTrackedBeforeBet = trackedBeforeBet;
      if (trackedAfterBet != null) txMetadata.voucherTrackedAfterBet = trackedAfterBet;
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
        voucherId: activeVoucher.id,
        outcomeMode,
        outcomesControlledByVoucher,
        balanceBeforeBet: balanceBefore,
        balanceAfterBet: balanceAfter,
        ...(maxCashout != null ? { maxCashout } : {}),
        ...(trackedBeforeBet != null ? { voucherTrackedBeforeBet: trackedBeforeBet } : {}),
        ...(trackedAfterBet != null ? { voucherTrackedAfterBet: trackedAfterBet } : {}),
        voucherPolicy: outcomesControlledByVoucher ? readVoucherPolicy(activeVoucher) : null,
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

      // If a jackpot was hit, refresh wallet so the returned balance includes the payout
      let walletWithJackpots = wallet;
      if (Array.isArray(jackpotWins) && jackpotWins.length) {
        const refreshed = await Wallet.findByPk(wallet.id);
        if (refreshed) {
          walletWithJackpots = refreshed;
        }
      }

      return res.status(201).json({
        wallet: walletWithJackpots,
        transaction: betTx,
        round,
        bonus: buildBonusState(walletWithJackpots),
        jackpotWins,
        voucherPolicy: {
          voucherId: activeVoucher.id,
          outcomeMode,
          outcomesControlledByVoucher,
          maxCashout,
          trackedBeforeBet,
          trackedAfterBet,
          jackpotExcludedFromCap: true,
        },
      });
    } catch (err) {
      console.error('[GAMES] POST /games/:gameId/bet error:', err);
      if (!t.finished) {
        await t.rollback();
      }
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

      const requestedWin = parseFloat(winAmount || 0);
      if (Number.isNaN(requestedWin) || requestedWin < 0) {
        await t.rollback();
        return res.status(400).json({ error: 'winAmount must be >= 0' });
      }

      const sessionId =
        (await resolveSessionId(req, round.playerId, t)) ||
        round?.metadata?.sessionId ||
        null;

      const tenantId = round.tenantId || req.auth?.tenantId || null;
      let wallet = await getOrCreateWallet(round.playerId, tenantId, t);
      const roundMetadata = round.metadata && typeof round.metadata === "object"
        ? { ...round.metadata }
        : {};

      const activeVoucher = await resolveActiveVoucher({
        wallet,
        userId: round.playerId,
        tenantId,
        transaction: t,
      });

      if (!activeVoucher) {
        await t.rollback();
        return res.status(403).json({
          ok: false,
          code: "NO_ACTIVE_VOUCHER",
          message: "No active redeemed voucher is linked to this wallet.",
        });
      }

      const outcomeMode = await resolveOutcomeMode(tenantId);
      const outcomesControlledByVoucher = isVoucherControlledOutcomeMode(outcomeMode);
      const resolvedMaxCashout = resolveVoucherMaxCashout(
        activeVoucher,
        Number(roundMetadata.maxCashout || 0)
      );
      const maxCashout = resolvedMaxCashout > 0 ? resolvedMaxCashout : null;
      if (outcomesControlledByVoucher && !(maxCashout > 0)) {
        await t.rollback();
        return res.status(400).json({
          ok: false,
          code: "INVALID_VOUCHER_CAP",
          message: "Voucher max cashout is not configured.",
        });
      }
      const policySnapshot = outcomesControlledByVoucher
        ? readVoucherPolicy(activeVoucher)
        : null;

      const stakeAmount = Number(round.betAmount || 0);
      const balanceBeforeSettle = toMoney(wallet.balance || 0);
      let inferredBeforeBet = null;
      let inferredAfterBet = null;
      let payoutOutcome;

      if (outcomesControlledByVoucher) {
        const fallbackTrackedBefore = toMoney(
          Math.max(
            0,
            Number(
              roundMetadata.balanceBeforeBet ||
                Math.min(maxCashout, balanceBeforeSettle + stakeAmount)
            )
          )
        );
        const fallbackTrackedAfter = toMoney(
          Math.max(
            0,
            Number(roundMetadata.balanceAfterBet || fallbackTrackedBefore - stakeAmount)
          )
        );
        inferredBeforeBet = toMoney(
          Math.max(
            0,
            Number(
              roundMetadata.voucherTrackedBeforeBet ||
                (policySnapshot.hasTrackedBalance
                  ? policySnapshot.trackedBalance + stakeAmount
                  : fallbackTrackedBefore)
            )
          )
        );
        inferredAfterBet = toMoney(
          Math.max(
            0,
            Number(
              roundMetadata.voucherTrackedAfterBet ||
                (policySnapshot.hasTrackedBalance
                  ? policySnapshot.trackedBalance
                  : fallbackTrackedAfter)
            )
          )
        );
        payoutOutcome = computeVoucherDrivenPayout({
          stakeAmount,
          balanceBeforeBet: inferredBeforeBet,
          balanceAfterBet: inferredAfterBet,
          requestedWinAmount: requestedWin,
          maxCashout,
          policy: policySnapshot,
        });
      } else {
        const pureRngWin = toMoney(Math.max(0, requestedWin));
        payoutOutcome = {
          payoutAmount: pureRngWin,
          balanceAfterSettle: toMoney(balanceBeforeSettle + pureRngWin),
          mode: "pure_rng",
          progress: null,
          reachedOrExceededCap: false,
          decayStep: 0,
          targetBalanceAfterSettle: toMoney(balanceBeforeSettle + pureRngWin),
          capApplied: false,
        };
      }

      const win = toMoney(payoutOutcome.payoutAmount || 0);
      let balanceAfter = toMoney(balanceBeforeSettle + win);
      let winTx = null;

      if (win > 0) {
        const balanceBeforeWinTx = balanceBeforeSettle;
        wallet.balance = balanceAfter;
        await wallet.save({ transaction: t });

        const winMetadata = {
          gameId,
          roundId: round.id,
          voucherId: activeVoucher.id,
          outcomeMode,
          outcomesControlledByVoucher,
          maxCashout,
          payoutMode: payoutOutcome.mode,
          requestedWinAmount: requestedWin,
          computedWinAmount: win,
          ...(metadata || {}),
        };
        if (sessionId) winMetadata.sessionId = sessionId;

        winTx = await Transaction.create(
          {
            tenantId,
            walletId: wallet.id,
            type: 'game_win',
            amount: win,
            balanceBefore: balanceBeforeWinTx,
            balanceAfter,
            reference: `game_round:${round.id}`,
            metadata: winMetadata,
            createdByUserId: req.user.id,
          },
          { transaction: t }
        );
      } else {
        wallet.balance = balanceBeforeSettle;
        await wallet.save({ transaction: t });
      }

      round.winAmount = win;
      round.status = 'settled';

      const nextResult = {
        ...(round.result && typeof round.result === "object" ? round.result : {}),
        ...(result && typeof result === "object" ? result : {}),
        ...(result && typeof result !== "object" ? { providerResult: result } : {}),
        voucherPolicy: {
          voucherId: activeVoucher.id,
          outcomeMode,
          outcomesControlledByVoucher,
          mode: payoutOutcome.mode,
          maxCashout,
          capApplied: Boolean(payoutOutcome.capApplied),
          reachedOrExceededCap: Boolean(payoutOutcome.reachedOrExceededCap),
          requestedWinAmount: requestedWin,
          computedWinAmount: win,
          decayStep: Number(payoutOutcome.decayStep || 0),
          trackedBalanceAfterSettle: outcomesControlledByVoucher
            ? Number(payoutOutcome.balanceAfterSettle || 0)
            : null,
          jackpotExcludedFromCap: true,
        },
      };
      round.result = nextResult;

      round.metadata = {
        ...roundMetadata,
        ...(metadata || {}),
        ...(sessionId ? { sessionId } : {}),
        voucherId: activeVoucher.id,
        outcomeMode,
        outcomesControlledByVoucher,
        maxCashout,
        voucherOutcome: {
          mode: payoutOutcome.mode,
          requestedWinAmount: requestedWin,
          computedWinAmount: win,
          balanceBeforeSettle,
          balanceAfterSettle: balanceAfter,
          trackedBalanceBeforeSettle: outcomesControlledByVoucher ? inferredAfterBet : null,
          trackedBalanceAfterSettle: outcomesControlledByVoucher
            ? Number(payoutOutcome.balanceAfterSettle || 0)
            : null,
          reachedOrExceededCap: Boolean(payoutOutcome.reachedOrExceededCap),
          jackpotExcludedFromCap: true,
        },
      };

      const bet = parseFloat(round.betAmount || 0);
      if (bet > 0) {
        round.rtpSample = win / bet;
      }

      if (outcomesControlledByVoucher && maxCashout > 0) {
        activeVoucher.maxCashout = maxCashout;
        const updatedMetadata = buildVoucherPolicyMetadata(activeVoucher, {
          maxCashout,
          payoutOutcome,
          balanceAfterSettle: payoutOutcome.balanceAfterSettle,
        });
        updatedMetadata.voucherPolicy = {
          ...(updatedMetadata.voucherPolicy || {}),
          lastWalletBalance: balanceAfter,
        };
        activeVoucher.metadata = updatedMetadata;
        await activeVoucher.save({ transaction: t });
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
          meta: buildRequestMeta(req, {
            roundId: round.id,
            payoutMode: round?.result?.voucherPolicy?.mode || "normal",
            maxCashout: round?.result?.voucherPolicy?.maxCashout || null,
          }),
        });
      }

      return res.status(200).json({
        wallet,
        round,
        winTransaction: winTx,
        voucherPolicy: round?.result?.voucherPolicy || null,
      });
    } catch (err) {
      console.error('[GAMES] POST /games/:gameId/settle error:', err);
      if (!t.finished) {
        await t.rollback();
      }
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
