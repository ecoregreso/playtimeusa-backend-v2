#!/usr/bin/env node
require("dotenv").config();

const { Op } = require("sequelize");
const { sequelize } = require("../src/db");
const {
  LedgerEvent,
  GameRound,
  Voucher,
  DepositIntent,
  WithdrawalIntent,
} = require("../src/models");
const { toCents } = require("../src/services/ledgerService");

async function run() {
  try {
    await sequelize.authenticate();
    await LedgerEvent.destroy({ where: {}, truncate: true });

    const events = [];

    const rounds = await GameRound.findAll();
    rounds.forEach((round) => {
      const sessionId = round.metadata?.sessionId || null;
      events.push({
        ts: round.createdAt,
        playerId: round.playerId,
        sessionId,
        gameKey: round.gameId,
        eventType: "BET",
        amountCents: toCents(-round.betAmount),
        betCents: toCents(round.betAmount),
      });
      events.push({
        ts: round.createdAt,
        playerId: round.playerId,
        sessionId,
        gameKey: round.gameId,
        eventType: "SPIN",
        betCents: toCents(round.betAmount),
      });
      if (Number(round.winAmount || 0) > 0) {
        events.push({
          ts: round.updatedAt || round.createdAt,
          playerId: round.playerId,
          sessionId,
          gameKey: round.gameId,
          eventType: "WIN",
          amountCents: toCents(round.winAmount),
          winCents: toCents(round.winAmount),
        });
      }
    });

    const vouchers = await Voucher.findAll();
    vouchers.forEach((voucher) => {
      events.push({
        ts: voucher.createdAt,
        eventType: "VOUCHER_ISSUED",
        amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
        meta: {
          voucherId: voucher.id,
          amountCents: toCents(voucher.amount || 0),
          bonusCents: toCents(voucher.bonusAmount || 0),
        },
      });
      if (voucher.redeemedAt) {
        events.push({
          ts: voucher.redeemedAt,
          eventType: "VOUCHER_REDEEMED",
          playerId: voucher.redeemedByUserId || null,
          amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
          meta: {
            voucherId: voucher.id,
            amountCents: toCents(voucher.amount || 0),
            bonusCents: toCents(voucher.bonusAmount || 0),
          },
        });
      }
      if (
        voucher.expiresAt &&
        new Date(voucher.expiresAt) < new Date() &&
        !voucher.redeemedAt
      ) {
        events.push({
          ts: voucher.expiresAt,
          eventType: "VOUCHER_EXPIRED",
          amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
          meta: { voucherId: voucher.id },
        });
      }
    });

    const deposits = await DepositIntent.findAll({
      where: { creditedAt: { [Op.not]: null } },
    });
    deposits.forEach((intent) => {
      events.push({
        ts: intent.creditedAt,
        eventType: "DEPOSIT",
        playerId: intent.userId,
        amountCents: toCents(intent.amountFun || 0),
        meta: { intentId: intent.id, provider: intent.provider },
      });
    });

    const withdrawals = await WithdrawalIntent.findAll({
      where: { sentAt: { [Op.not]: null } },
    });
    withdrawals.forEach((intent) => {
      events.push({
        ts: intent.sentAt,
        eventType: "WITHDRAW",
        playerId: intent.userId,
        amountCents: toCents(-(intent.amountFun || 0)),
        meta: { intentId: intent.id, provider: intent.provider },
      });
    });

    if (events.length) {
      await LedgerEvent.bulkCreate(events);
    }

    console.log(`[LEDGER] Backfilled ${events.length} events`);
    await sequelize.close();
  } catch (err) {
    console.error("[LEDGER] backfill error:", err);
    process.exit(1);
  }
}

run();
