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
    await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
      await LedgerEvent.destroy({ where: {}, truncate: true, transaction: t });
    });

    const events = [];

    const rounds = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
      return GameRound.findAll({ transaction: t });
    });
    rounds.forEach((round) => {
      const sessionId = round.metadata?.sessionId || null;
      events.push({
        tenantId: round.tenantId,
        ts: round.createdAt,
        playerId: round.playerId,
        sessionId,
        actionId: round.id,
        gameKey: round.gameId,
        eventType: "BET",
        amountCents: toCents(-round.betAmount),
        betCents: toCents(round.betAmount),
        source: "backfill.round",
      });
      events.push({
        tenantId: round.tenantId,
        ts: round.createdAt,
        playerId: round.playerId,
        sessionId,
        actionId: round.id,
        gameKey: round.gameId,
        eventType: "SPIN",
        betCents: toCents(round.betAmount),
        source: "backfill.round",
      });
      if (Number(round.winAmount || 0) > 0) {
        events.push({
          tenantId: round.tenantId,
          ts: round.updatedAt || round.createdAt,
          playerId: round.playerId,
          sessionId,
          actionId: round.id,
          gameKey: round.gameId,
          eventType: "WIN",
          amountCents: toCents(round.winAmount),
          winCents: toCents(round.winAmount),
          source: "backfill.round",
        });
      }
    });

    const vouchers = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
      return Voucher.findAll({ transaction: t });
    });
    vouchers.forEach((voucher) => {
      events.push({
        tenantId: voucher.tenantId,
        ts: voucher.createdAt,
        eventType: "VOUCHER_ISSUED",
        actionId: voucher.id,
        amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
        source: "backfill.voucher",
        meta: {
          voucherId: voucher.id,
          amountCents: toCents(voucher.amount || 0),
          bonusCents: toCents(voucher.bonusAmount || 0),
        },
      });
      if (voucher.redeemedAt) {
        events.push({
          tenantId: voucher.tenantId,
          ts: voucher.redeemedAt,
          eventType: "VOUCHER_REDEEMED",
          playerId: voucher.redeemedByUserId || null,
          actionId: voucher.id,
          amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
          source: "backfill.voucher",
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
          tenantId: voucher.tenantId,
          ts: voucher.expiresAt,
          eventType: "VOUCHER_EXPIRED",
          actionId: voucher.id,
          amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
          source: "backfill.voucher",
          meta: { voucherId: voucher.id },
        });
      }
    });

    const deposits = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
      return DepositIntent.findAll({
        where: { creditedAt: { [Op.not]: null } },
        transaction: t,
      });
    });
    deposits.forEach((intent) => {
      events.push({
        tenantId: intent.tenantId,
        ts: intent.creditedAt,
        eventType: "DEPOSIT",
        playerId: intent.userId,
        actionId: intent.id,
        amountCents: toCents(intent.amountFun || 0),
        source: "backfill.finance",
        meta: { intentId: intent.id, provider: intent.provider },
      });
    });

    const withdrawals = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
      return WithdrawalIntent.findAll({
        where: { sentAt: { [Op.not]: null } },
        transaction: t,
      });
    });
    withdrawals.forEach((intent) => {
      events.push({
        tenantId: intent.tenantId,
        ts: intent.sentAt,
        eventType: "WITHDRAW",
        playerId: intent.userId,
        actionId: intent.id,
        amountCents: toCents(-(intent.amountFun || 0)),
        source: "backfill.finance",
        meta: { intentId: intent.id, provider: intent.provider },
      });
    });

    if (events.length) {
      await sequelize.transaction(async (t) => {
        await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
        await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
        await LedgerEvent.bulkCreate(events, { transaction: t });
      });
    }

    console.log(`[LEDGER] Backfilled ${events.length} events`);
    await sequelize.close();
  } catch (err) {
    console.error("[LEDGER] backfill error:", err);
    process.exit(1);
  }
}

run();
