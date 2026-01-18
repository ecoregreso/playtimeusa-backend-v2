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
const { recordLedgerEvent, toCents } = require("./ledgerService");

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

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function dayKeyUtc(date) {
  return date.toISOString().slice(0, 10);
}

function buildDayWindow(days = 14, now = new Date()) {
  const dayKeys = [];
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    dayKeys.push(dayKeyUtc(d));
  }
  return dayKeys;
}

function groupByJackpotId(items = []) {
  const map = new Map();
  for (const item of items) {
    const jackpotId = item.jackpotId || item.jackpot_id;
    if (!jackpotId) continue;
    if (!map.has(jackpotId)) {
      map.set(jackpotId, []);
    }
    map.get(jackpotId).push(item);
  }
  return map;
}

function buildContributionMap(contributions = []) {
  const map = new Map();
  for (const row of contributions) {
    const day = typeof row.day === "string" ? row.day : dayKeyUtc(new Date(row.day));
    const current = map.get(day) || 0;
    map.set(day, current + toNumber(row.amountCents || row.amount_cents));
  }
  return map;
}

function buildPayoutMap(events = []) {
  const map = new Map();
  for (const evt of events) {
    const ts = evt.created_at || evt.createdAt || evt.createdat;
    if (!ts) continue;
    const day = dayKeyUtc(new Date(ts));
    const current = map.get(day) || 0;
    map.set(day, current + toNumber(evt.amountCents || evt.amount_cents));
  }
  return map;
}

function buildJackpotChart({ currentPotCents = 0, dayWindow = [], contributionsMap, payoutsMap }) {
  if (!dayWindow.length) return [];

  const contrib = contributionsMap || new Map();
  const payouts = payoutsMap || new Map();

  // Walk backward to find the pot at the start of the window.
  let windowStartPot = currentPotCents;
  for (const day of [...dayWindow].reverse()) {
    const dayContrib = contrib.get(day) || 0;
    const dayPayout = payouts.get(day) || 0;
    windowStartPot = windowStartPot + dayPayout - dayContrib;
  }

  // Now roll forward to build the timeline.
  let running = windowStartPot;
  const series = [];
  for (const day of dayWindow) {
    const dayContrib = contrib.get(day) || 0;
    const dayPayout = payouts.get(day) || 0;
    running = running + dayContrib - dayPayout;
    series.push({
      day,
      potCents: running,
      contributionsCents: dayContrib,
      payoutsCents: dayPayout,
    });
  }

  return series;
}

function buildJackpotMetrics({ jackpot, contributions = [], events = [], dayWindow, now = new Date() }) {
  const currentPotCents = toNumber(jackpot.currentPotCents || jackpot.current_pot_cents);
  const triggerCents = toNumber(jackpot.triggerCents || jackpot.trigger_cents);
  const rangeMinCents = toNumber(jackpot.rangeMinCents || jackpot.range_min_cents);
  const rangeMaxCents = toNumber(jackpot.rangeMaxCents || jackpot.range_max_cents);
  const contributionBps = toNumber(jackpot.contributionBps || jackpot.contribution_bps);

  const lastEvent = events[0] || null; // events are sorted desc
  const lastHitAt =
    jackpot.lastHitAt ||
    jackpot.last_hit_at ||
    lastEvent?.created_at ||
    lastEvent?.createdAt ||
    null;
  const timeSinceLastHitMs = lastHitAt ? now.getTime() - new Date(lastHitAt).getTime() : null;
  const lastHitAmountCents = lastEvent ? toNumber(lastEvent.amountCents || lastEvent.amount_cents) : null;

  const contributionsMap = buildContributionMap(contributions);
  const payoutsMap = buildPayoutMap(events);
  const dayKeys = Array.isArray(dayWindow) && dayWindow.length ? dayWindow : buildDayWindow(14, now);

  const todayKey = dayKeyUtc(now);
  const last24hContributionCents = contributionsMap.get(todayKey) || 0;
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const hoursElapsed = Math.max((now.getTime() - startOfTodayUtc.getTime()) / (1000 * 60 * 60), 1);
  const avgHourlyLast24h = last24hContributionCents / hoursElapsed;

  const last7Keys = dayKeys.slice(-7);
  const last7dContributionCents = last7Keys.reduce((sum, key) => sum + (contributionsMap.get(key) || 0), 0);
  const avgDailyLast7d = last7dContributionCents / (last7Keys.length || 1);

  const projectedHoursToTrigger =
    triggerCents > 0 && avgHourlyLast24h > 0 && currentPotCents < triggerCents
      ? (triggerCents - currentPotCents) / avgHourlyLast24h
      : null;

  const chart = buildJackpotChart({
    currentPotCents,
    dayWindow: dayKeys,
    contributionsMap,
    payoutsMap,
  });

  return {
    lastHitAt: lastHitAt || null,
    timeSinceLastHitMs,
    lastHitAmountCents,
    currentPotCents,
    triggerCents,
    rangeMinCents,
    rangeMaxCents,
    contributionBps,
    progressToTrigger: triggerCents > 0 ? currentPotCents / triggerCents : null,
    projectedHoursToTrigger,
    growth: {
      last24hContributionCents,
      avgHourlyLast24h,
      last7dContributionCents,
      avgDailyLast7d,
    },
    chart,
  };
}

async function loadScopedJackpot(jackpotId, tenantScope, transaction, allowGlobal = true) {
  const where = { id: jackpotId };
  if (tenantScope) {
    const or = [{ tenantId: tenantScope }];
    if (allowGlobal) or.push({ tenantId: null });
    where[Op.or] = or;
  }
  const jackpot = await Jackpot.findOne({
    where,
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (!jackpot) {
    const err = new Error("Jackpot not found for scope");
    err.status = 404;
    throw err;
  }
  return jackpot;
}

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
  const now = new Date();
  const dayWindow = buildDayWindow(14, now);
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
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 14);
  const [events, contributions] = jackpotIds.length
    ? await Promise.all([
        JackpotEvent.findAll({
          where: {
            jackpotId: jackpotIds,
            created_at: { [Op.gte]: fourteenDaysAgo },
          },
          order: [["created_at", "DESC"]],
        }),
        JackpotContribution.findAll({
          where: {
            jackpotId: jackpotIds,
            day: { [Op.gte]: fourteenDaysAgo },
          },
          order: [["day", "ASC"]],
        }),
      ])
    : [[], []];

  const eventsJson = events.map((e) => (e.toJSON ? e.toJSON() : e));
  const contributionsJson = contributions.map((c) => (c.toJSON ? c.toJSON() : c));
  const eventsByJackpot = groupByJackpotId(eventsJson);
  const contributionsByJackpot = groupByJackpotId(contributionsJson);

  const jackpotsWithMetrics = jackpots.map((j) => {
    const base = j.toJSON ? j.toJSON() : j;
    const jEvents = eventsByJackpot.get(base.id) || [];
    const jContrib = contributionsByJackpot.get(base.id) || [];
    const metrics = buildJackpotMetrics({
      jackpot: base,
      contributions: jContrib,
      events: jEvents,
      dayWindow,
      now,
    });
    return { ...base, metrics };
  });

  const charts = jackpotsWithMetrics.reduce((acc, jp) => {
    acc[jp.id] = jp.metrics?.chart || [];
    return acc;
  }, {});

  return {
    jackpots: jackpotsWithMetrics,
    events: eventsJson,
    contributions: contributionsJson,
    charts,
    windowDays: dayWindow.length,
  };
}

async function updateJackpotTarget({ jackpotId, triggerCents, rangeMinCents, rangeMaxCents, contributionBps, tenantScope }) {
  const target = toNumber(triggerCents);
  if (!target || target <= 0) {
    const err = new Error("triggerCents must be greater than 0");
    err.status = 400;
    throw err;
  }

  const t = await sequelize.transaction();
  try {
    const jackpot = await loadScopedJackpot(jackpotId, tenantScope, t);
    jackpot.triggerCents = Math.round(target);

    if (rangeMinCents !== undefined) {
      jackpot.rangeMinCents = Math.round(toNumber(rangeMinCents, jackpot.rangeMinCents));
    }
    if (rangeMaxCents !== undefined) {
      jackpot.rangeMaxCents = Math.round(toNumber(rangeMaxCents, jackpot.rangeMaxCents));
    }
    if (contributionBps !== undefined) {
      const bps = Math.max(0, Math.round(toNumber(contributionBps, jackpot.contributionBps)));
      jackpot.contributionBps = bps;
    }

    if (jackpot.rangeMinCents && jackpot.triggerCents < jackpot.rangeMinCents) {
      jackpot.rangeMinCents = jackpot.triggerCents;
    }
    if (jackpot.rangeMaxCents && jackpot.triggerCents > jackpot.rangeMaxCents) {
      jackpot.rangeMaxCents = jackpot.triggerCents;
    }

    await jackpot.save({ transaction: t });
    await t.commit();
    return jackpot.toJSON ? jackpot.toJSON() : jackpot;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function triggerJackpotHit({ jackpotId, tenantScope, payoutCents, playerId = null, triggeredBy = "admin_manual" }) {
  const t = await sequelize.transaction();
  try {
    const jackpot = await loadScopedJackpot(jackpotId, tenantScope, t);
    const potBefore = toNumber(jackpot.currentPotCents || 0);
    const trigger = toNumber(jackpot.triggerCents || 0);
    const desired = payoutCents !== undefined && payoutCents !== null ? toNumber(payoutCents) : trigger || potBefore;
    const amount = Math.min(Math.max(desired, 0), potBefore);
    if (!amount || amount <= 0) {
      const err = new Error("Jackpot pot is empty");
      err.status = 400;
      throw err;
    }

    const now = new Date();
    jackpot.currentPotCents = potBefore - amount;
    jackpot.lastHitAt = now;
    jackpot.triggerCents = randomTriggerCents(jackpot.type);
    if (jackpot.type === "weekly") {
      jackpot.nextDrawAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    await jackpot.save({ transaction: t });

    const event = await JackpotEvent.create(
      {
        jackpotId: jackpot.id,
        tenantId: jackpot.tenantId || null,
        playerId: playerId || null,
        amountCents: amount,
        potBeforeCents: potBefore,
        potAfterCents: jackpot.currentPotCents,
        eventType: "hit",
        metadata: { type: jackpot.type, triggeredBy: triggeredBy || "admin_manual" },
      },
      { transaction: t }
    );

    if (playerId) {
      await creditJackpot({
        jackpot,
        tenantId: jackpot.tenantId || null,
        playerId,
        amountCents: amount,
        transaction: t,
      });
    }

    await t.commit();
    return {
      jackpot: jackpot.toJSON ? jackpot.toJSON() : jackpot,
      event: event.toJSON ? event.toJSON() : event,
    };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = {
  processBet,
  ensureJackpotsForTenant,
  getJackpotSummary,
  updateJackpotTarget,
  triggerJackpotHit,
};
