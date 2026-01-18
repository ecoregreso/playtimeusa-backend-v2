const { Op, QueryTypes } = require("sequelize");
const {
  sequelize,
  Jackpot,
  JackpotEvent,
  JackpotContribution,
  Wallet,
  User,
  Transaction,
} = require("../models");
const { recordLedgerEvent, toCents, buildRequestMeta } = require("./ledgerService");

const RANGE = {
  hourly: { minCents: 500, maxCents: 1500 }, // 5–15 FUN
  daily: { minCents: 20000, maxCents: 50000 }, // 200–500 FUN
  weekly: { minCents: 140000, maxCents: 350000 }, // 1400–3500 FUN
};

// Contribution rates (basis points: 100 = 1%)
const CONTRIBUTION_BPS = {
  hourly: 100, // 1%
  daily: 50, // 0.5%
  weekly: 25, // 0.25%
};

function randomTriggerCents(type) {
  const range = RANGE[type];
  if (!range) return 0;
  const spread = range.maxCents - range.minCents;
  const draw = Math.random();
  return Math.round(range.minCents + spread * draw);
}

async function ensureJackpot(type, tenantId) {
  const [jackpot] = await Jackpot.findOrCreate({
    where: { type, tenantId: tenantId || null },
    defaults: {
      type,
      tenantId: tenantId || null,
      currentPotCents: 0,
      rangeMinCents: RANGE[type].minCents,
      rangeMaxCents: RANGE[type].maxCents,
      triggerCents: randomTriggerCents(type),
      contributionBps: CONTRIBUTION_BPS[type] || 0,
      nextDrawAt: type === "weekly" ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
    },
  });
  return jackpot;
}

async function ensureJackpotsForTenant(tenantId) {
  const [hourly, daily] = await Promise.all([
    ensureJackpot("hourly", tenantId),
    ensureJackpot("daily", tenantId),
  ]);
  const weekly = await ensureJackpot("weekly", null);
  return { hourly, daily, weekly };
}

function contributionFromBet(betCents, bps) {
  if (!bps) return 0;
  const contrib = Math.floor((Number(betCents) * Number(bps)) / 10000);
  return Number.isFinite(contrib) ? Math.max(contrib, 1) : 0;
}

async function upsertContribution(jackpotId, amountCents, transaction) {
  const day = new Date().toISOString().slice(0, 10);
  const sql = `
    INSERT INTO jackpot_contributions (jackpot_id, day, amount_cents, contributions_count)
    VALUES (:jackpotId, :day, :amountCents, 1)
    ON CONFLICT (jackpot_id, day)
    DO UPDATE SET
      amount_cents = jackpot_contributions.amount_cents + EXCLUDED.amount_cents,
      contributions_count = jackpot_contributions.contributions_count + 1,
      updated_at = NOW()
    RETURNING *;
  `;
  await sequelize.query(sql, {
    replacements: { jackpotId, day, amountCents },
    type: QueryTypes.INSERT,
    transaction,
  });
}

async function pickWeeklyWinner() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await sequelize.query(
    `
      SELECT DISTINCT "playerId"
      FROM ledger_events
      WHERE "eventType" = 'BET' AND "ts" >= :start
      ORDER BY random()
      LIMIT 1
    `,
    { replacements: { start: sevenDaysAgo }, type: QueryTypes.SELECT }
  );
  const id = rows?.[0]?.playerId || null;
  if (!id) return null;
  return id;
}

async function creditJackpot({ jackpot, tenantId, playerId, amountCents, gameId, transaction }) {
  const amountMajor = Number(amountCents || 0) / 100;
  let wallet = await Wallet.findOne({
    where: { userId: playerId, tenantId: tenantId || null },
    transaction,
    lock: transaction?.LOCK?.UPDATE ? transaction.LOCK.UPDATE : undefined,
  });
  if (!wallet) {
    wallet = await Wallet.create(
      {
        tenantId: tenantId || null,
        userId: playerId,
        balance: 0,
        currency: "FUN",
        bonusPending: 0,
        bonusUnacked: 0,
      },
      { transaction }
    );
  }

  const balanceBefore = Number(wallet.balance || 0);
  wallet.balance = balanceBefore + amountMajor;
  await wallet.save({ transaction });

  await Transaction.create(
    {
      tenantId: tenantId || null,
      walletId: wallet.id,
      type: "jackpot_win",
      amount: amountMajor,
      balanceBefore,
      balanceAfter: wallet.balance,
      reference: `jackpot:${jackpot.type}`,
      metadata: { jackpotId: jackpot.id, gameId: gameId || null },
      createdByUserId: playerId || null,
    },
    { transaction }
  );

  await recordLedgerEvent({
    ts: new Date(),
    playerId: playerId || null,
    sessionId: null,
    actionId: jackpot.id,
    gameKey: gameId || null,
    eventType: "JACKPOT_WIN",
    amountCents: Number(amountCents || 0),
    balanceCents: toCents(wallet.balance || 0),
    source: `jackpot.${jackpot.type}`,
    meta: { jackpotId: jackpot.id, tenantId: tenantId || null },
  });
}

async function processJackpotPayout({ jackpot, tenantId, playerId, gameId, transaction }) {
  const potBefore = Number(jackpot.currentPotCents || 0);
  const trigger = Number(jackpot.triggerCents || 0);
  if (!trigger || potBefore < trigger) return;

  // weekly: enforce 7d cooldown
  const now = new Date();
  if (
    jackpot.type === "weekly" &&
    jackpot.lastHitAt &&
    new Date(jackpot.lastHitAt).getTime() + 7 * 24 * 60 * 60 * 1000 > now.getTime()
  ) {
    return;
  }

  let winnerId = playerId || null;
  if (jackpot.type === "weekly") {
    const candidate = await pickWeeklyWinner();
    if (candidate) {
      winnerId = candidate;
      const user = await User.findByPk(candidate);
      if (user && user.tenantId) {
        tenantId = user.tenantId;
      }
    }
  }

  const potAfter = potBefore - trigger;
  jackpot.currentPotCents = potAfter;
  jackpot.lastHitAt = now;
  jackpot.triggerCents = randomTriggerCents(jackpot.type);
  if (jackpot.type === "weekly") {
    jackpot.nextDrawAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  await jackpot.save({ transaction });

  await JackpotEvent.create(
    {
      jackpotId: jackpot.id,
      tenantId: tenantId || null,
      playerId: winnerId || null,
      amountCents: trigger,
      potBeforeCents: potBefore,
      potAfterCents: potAfter,
      eventType: "hit",
      metadata: { type: jackpot.type, gameId: gameId || null },
    },
    { transaction }
  );

  if (winnerId) {
    await creditJackpot({ jackpot, tenantId, playerId: winnerId, amountCents: trigger, gameId, transaction });
  }
}

async function processBet({ tenantId, playerId, betAmount, gameId }) {
  const betCents = toCents(betAmount);
  if (!betCents || betCents <= 0) return;

  const jackpots = await ensureJackpotsForTenant(tenantId);
  const now = new Date();

  const targets = [
    jackpots.hourly,
    jackpots.daily,
    jackpots.weekly,
  ].filter(Boolean);

  for (const jp of targets) {
    const rate = CONTRIBUTION_BPS[jp.type] || 0;
    const contrib = contributionFromBet(betCents, rate);
    if (!contrib) continue;
    const t = await sequelize.transaction();
    try {
      const fresh = await Jackpot.findByPk(jp.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!fresh) {
        await t.rollback();
        continue;
      }
      fresh.currentPotCents = Number(fresh.currentPotCents || 0) + contrib;
      fresh.updated_at = now;
      await fresh.save({ transaction: t });

      await upsertContribution(fresh.id, contrib, t);
      await processJackpotPayout({
        jackpot: fresh,
        tenantId: fresh.tenantId || tenantId || null,
        playerId,
        gameId,
        transaction: t,
      });

      await t.commit();
    } catch (err) {
      await t.rollback();
      console.error("[JACKPOT] process bet failed:", err);
    }
  }
}

async function getJackpotSummary({ tenantId, includeGlobal = true }) {
  const where = {};
  if (tenantId) {
    where[Op.or] = [{ tenantId }, includeGlobal ? { tenantId: null } : null].filter(Boolean);
  }
  const jackpots = await Jackpot.findAll({
    where,
    order: [
      ["type", "ASC"],
      ["tenantId", "ASC NULLS LAST"],
    ],
  });

  const jackpotIds = jackpots.map((j) => j.id);
  const events = jackpotIds.length
    ? await JackpotEvent.findAll({
        where: { jackpotId: jackpotIds },
        limit: 50,
        order: [["created_at", "DESC"]],
      })
    : [];

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 14);
  const contributions = jackpotIds.length
    ? await JackpotContribution.findAll({
        where: {
          jackpotId: jackpotIds,
          day: { [Op.gte]: fourteenDaysAgo },
        },
        order: [["day", "ASC"]],
      })
    : [];

  return {
    jackpots,
    events,
    contributions,
  };
}

module.exports = {
  processBet,
  ensureJackpotsForTenant,
  getJackpotSummary,
};
