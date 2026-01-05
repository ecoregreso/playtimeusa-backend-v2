const { QueryTypes } = require("sequelize");
const {
  sequelize,
  PlayerSafetyLimit,
  PlayerSafetyAction,
} = require("../models");

const MAX_SPINS = 100;
const RECENT_SPINS = 20;
const GAME_HOP_WINDOW_MS = 5 * 60 * 1000;
const LOSS_CLUSTER_WINDOW_MS = 5 * 60 * 1000;
const LOSS_CLUSTER_ABSOLUTE_CENTS = 5000;
const NUDGE_THROTTLE_MS = 5 * 60 * 1000;
const COOLDOWN_THROTTLE_MS = 10 * 60 * 1000;
const COOLDOWN_SECONDS = 90;
const SPIN_RATE_MEDIAN_MS = 1200;

const SIGNALS = {
  BET_ACCEL: { code: "BET_ACCEL", score: 25 },
  SPIN_RATE: { code: "SPIN_RATE", score: 20 },
  GAME_HOP: { code: "GAME_HOP", score: 15 },
  LOSS_STREAK: { code: "LOSS_STREAK", score: 20 },
  LOSS_CLUSTER: { code: "LOSS_CLUSTER", score: 20 },
};

const ACTION_MESSAGES = {
  NUDGE:
    "Quick check-in: your pace/bets changed a lot in the last few minutes. Want to take a short break?",
  COOLDOWN: (seconds) =>
    `Let’s pause for ${seconds}s. Your balance and session will still be here.`,
  STOP: "Session limit reached. You’ve hit your loss cap for this session.",
};

class LossLimitError extends Error {
  constructor({ lossLimitCents, currentLossCents, projectedLossCents }) {
    super("Loss limit reached for this session.");
    this.code = "LOSS_LIMIT_REACHED";
    this.lossLimitCents = lossLimitCents;
    this.currentLossCents = currentLossCents;
    this.projectedLossCents = projectedLossCents;
  }
}

async function fetchRecentSpins(sessionId) {
  const rows = await sequelize.query(
    `
      WITH spins AS (
        SELECT "actionId", "gameKey", "ts", "createdAt",
               COALESCE("betCents", 0) AS "betCents",
               "balanceCents"
        FROM ledger_events
        WHERE "sessionId" = :sessionId
          AND "eventType" = 'SPIN'
        ORDER BY "ts" DESC
        LIMIT :limit
      ),
      wins AS (
        SELECT "actionId", SUM(COALESCE("winCents", 0)) AS "winCents"
        FROM ledger_events
        WHERE "sessionId" = :sessionId
          AND "eventType" = 'WIN'
          AND "actionId" IS NOT NULL
        GROUP BY "actionId"
      ),
      bets AS (
        SELECT "actionId", SUM(COALESCE("betCents", 0)) AS "betCents"
        FROM ledger_events
        WHERE "sessionId" = :sessionId
          AND "eventType" = 'BET'
          AND "actionId" IS NOT NULL
        GROUP BY "actionId"
      )
      SELECT s.*,
             COALESCE(w."winCents", 0) AS "winCents",
             COALESCE(s."betCents", b."betCents", 0) AS "resolvedBetCents"
      FROM spins s
      LEFT JOIN wins w ON w."actionId" = s."actionId"
      LEFT JOIN bets b ON b."actionId" = s."actionId"
      ORDER BY s."ts" DESC
    `,
    {
      replacements: { sessionId: String(sessionId), limit: MAX_SPINS },
      type: QueryTypes.SELECT,
    }
  );

  return rows.map((row) => ({
    ...row,
    betCents: Number(row.resolvedBetCents || row.betCents || 0),
    winCents: Number(row.winCents || 0),
  }));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

async function computeRisk(ctx, opts = {}) {
  if (!ctx?.sessionId) {
    return { score: 0, band: "CALM", reasons: [], evidence: {} };
  }

  const spins = await fetchRecentSpins(ctx.sessionId);
  if (!spins.length) {
    return { score: 0, band: "CALM", reasons: [], evidence: { spinCount: 0 } };
  }

  const now = Date.now();
  const recentSpins = spins.slice(0, RECENT_SPINS).reverse();
  const reasons = [];
  const evidence = {
    spinCount: spins.length,
  };
  let score = 0;

  const betValues = recentSpins.map((row) => Number(row.betCents || 0));
  let betIncreases = 0;
  for (let i = 1; i < betValues.length; i += 1) {
    if (betValues[i] > betValues[i - 1]) betIncreases += 1;
  }
  evidence.betIncreases = betIncreases;
  if (betIncreases >= 3) {
    reasons.push(SIGNALS.BET_ACCEL.code);
    score += SIGNALS.BET_ACCEL.score;
  }

  const eventTimes = recentSpins
    .map((row) => (row.ts ? new Date(row.ts).getTime() : new Date(row.createdAt).getTime()))
    .filter((value) => Number.isFinite(value));
  if (eventTimes.length >= 6) {
    const sorted = eventTimes.slice().sort((a, b) => a - b);
    const deltas = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const delta = sorted[i] - sorted[i - 1];
      if (delta > 0) deltas.push(delta);
    }
    const medianMs = median(deltas);
    evidence.medianSpinMs = medianMs;
    if (medianMs != null && medianMs < SPIN_RATE_MEDIAN_MS) {
      reasons.push(SIGNALS.SPIN_RATE.code);
      score += SIGNALS.SPIN_RATE.score;
    }
  }

  const recentWindowStart = new Date(now - GAME_HOP_WINDOW_MS);
  const recentWindowSpins = spins.filter(
    (row) => new Date(row.ts || row.createdAt) >= recentWindowStart
  );
  const distinctGames = new Set(
    recentWindowSpins.map((row) => row.gameKey).filter(Boolean)
  );
  evidence.distinctGames5m = distinctGames.size;
  if (distinctGames.size >= 3) {
    reasons.push(SIGNALS.GAME_HOP.code);
    score += SIGNALS.GAME_HOP.score;
  }

  let lossStreak = 0;
  for (const row of spins) {
    const win = Number(row.winCents || 0);
    if (win > 0) break;
    lossStreak += 1;
  }
  evidence.lossStreak = lossStreak;
  if (lossStreak >= 12) {
    reasons.push(SIGNALS.LOSS_STREAK.code);
    score += SIGNALS.LOSS_STREAK.score;
  }

  const lossWindowStart = new Date(now - LOSS_CLUSTER_WINDOW_MS);
  const lossWindowSpins = spins.filter(
    (row) => new Date(row.ts || row.createdAt) >= lossWindowStart
  );
  const totalBet = lossWindowSpins.reduce(
    (sum, row) => sum + Number(row.betCents || 0),
    0
  );
  const totalWin = lossWindowSpins.reduce(
    (sum, row) => sum + Number(row.winCents || 0),
    0
  );
  const loss5mCents = Math.max(0, totalBet - totalWin);
  evidence.loss5mCents = loss5mCents;

  const [sessionStartRow] = await sequelize.query(
    `
      SELECT "balanceCents", "betCents", "winCents", "eventType"
      FROM ledger_events
      WHERE "sessionId" = :sessionId
        AND "balanceCents" IS NOT NULL
      ORDER BY "ts" ASC
      LIMIT 1
    `,
    {
      replacements: { sessionId: String(ctx.sessionId) },
      type: QueryTypes.SELECT,
    }
  );

  let sessionStartBalanceCents = sessionStartRow
    ? Number(sessionStartRow.balanceCents || 0)
    : null;
  if (sessionStartRow?.eventType === "BET") {
    sessionStartBalanceCents += Number(sessionStartRow.betCents || 0);
  } else if (sessionStartRow?.eventType === "WIN") {
    sessionStartBalanceCents -= Number(sessionStartRow.winCents || 0);
  }
  evidence.sessionStartBalanceCents = sessionStartBalanceCents;
  if (sessionStartBalanceCents != null) {
    const thresholdCents = Math.max(
      LOSS_CLUSTER_ABSOLUTE_CENTS,
      sessionStartBalanceCents * 0.3
    );
    evidence.lossClusterThresholdCents = thresholdCents;
    if (loss5mCents >= thresholdCents) {
      reasons.push(SIGNALS.LOSS_CLUSTER.code);
      score += SIGNALS.LOSS_CLUSTER.score;
    }
  }

  let band = "CALM";
  if (score >= 75) band = "STOP";
  else if (score >= 50) band = "TILT_RISK";
  else if (score >= 25) band = "ELEVATED";

  return { score, band, reasons, evidence };
}

async function lastActionAt(sessionId, actionType) {
  const action = await PlayerSafetyAction.findOne({
    where: {
      sessionId: String(sessionId),
      actionType,
    },
    order: [["createdAt", "DESC"]],
  });
  return action ? new Date(action.createdAt) : null;
}

async function maybeIssueAction(ctx, risk) {
  if (!ctx?.sessionId || !risk) return null;
  const now = Date.now();

  if (risk.band === "ELEVATED") {
    const last = await lastActionAt(ctx.sessionId, "NUDGE");
    if (last && now - last.getTime() < NUDGE_THROTTLE_MS) return null;
    return {
      actionType: "NUDGE",
      message: ACTION_MESSAGES.NUDGE,
    };
  }

  if (risk.band === "TILT_RISK") {
    const last = await lastActionAt(ctx.sessionId, "COOLDOWN");
    if (last && now - last.getTime() < COOLDOWN_THROTTLE_MS) return null;
    return {
      actionType: "COOLDOWN",
      cooldownSeconds: COOLDOWN_SECONDS,
      message: ACTION_MESSAGES.COOLDOWN(COOLDOWN_SECONDS),
    };
  }

  if (risk.band === "STOP") {
    return {
      actionType: "STOP",
      message: ACTION_MESSAGES.STOP,
    };
  }

  return null;
}

async function enforceLossLimit(ctx, proposedAdditionalLossCents) {
  if (!ctx?.sessionId) return;
  const limit = await PlayerSafetyLimit.findOne({
    where: { sessionId: String(ctx.sessionId) },
  });
  if (!limit) return;

  const proposed = Math.max(0, Number(proposedAdditionalLossCents || 0));
  const rows = await sequelize.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END), 0) AS "betsCents",
        COALESCE(SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END), 0) AS "winsCents"
      FROM ledger_events
      WHERE "sessionId" = :sessionId
    `,
    {
      replacements: { sessionId: String(ctx.sessionId) },
      type: QueryTypes.SELECT,
    }
  );
  const betsCents = Number(rows[0]?.betsCents || 0);
  const winsCents = Number(rows[0]?.winsCents || 0);
  const currentLoss = Math.max(0, betsCents - winsCents);
  const projectedLoss = currentLoss + proposed;
  if (projectedLoss >= Number(limit.lossLimitCents || 0)) {
    throw new LossLimitError({
      lossLimitCents: Number(limit.lossLimitCents || 0),
      currentLossCents: currentLoss,
      projectedLossCents: projectedLoss,
    });
  }
}

module.exports = {
  computeRisk,
  maybeIssueAction,
  enforceLossLimit,
  LossLimitError,
  ACTION_MESSAGES,
};
