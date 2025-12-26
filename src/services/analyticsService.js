const { Op, QueryTypes } = require("sequelize");
const {
  sequelize,
  LedgerEvent,
  SessionSnapshot,
  GameConfig,
  ApiErrorEvent,
  SupportTicket,
  GameRound,
  Voucher,
  DepositIntent,
  WithdrawalIntent,
  StaffUser,
  User,
  Session,
} = require("../models");
const {
  normalizeBucket,
  normalizeTimezone,
  bucketExpression,
} = require("../utils/timeBucket");

const DEFAULT_RANGE_DAYS = 30;
const FAILED_BET_STALE_MINUTES = 10;
const ACTIVE_EVENT_TYPES = ["BET", "SPIN"];
const BET_EVENT_TYPES = ["BET"];
const WIN_EVENT_TYPES = ["WIN"];

function parseDateInput(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00.000Z`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseRange(query = {}) {
  const bucket = normalizeBucket(query.bucket);
  const timezone = normalizeTimezone(query.timezone);
  const fromRaw = query.from || query.start || null;
  const toRaw = query.to || query.end || null;
  let startDate = parseDateInput(fromRaw);
  let endDate = parseDateInput(toRaw);

  if (!startDate && !endDate) {
    const now = new Date();
    endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));
  } else if (!startDate) {
    startDate = new Date(endDate);
  } else if (!endDate) {
    endDate = new Date(startDate);
  }

  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  const endExclusive = new Date(endDate);
  if (toRaw && /^\d{4}-\d{2}-\d{2}$/.test(String(toRaw))) {
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  } else {
    endExclusive.setTime(endExclusive.getTime() + 1);
  }

  return {
    from: startDate.toISOString(),
    to: endDate.toISOString(),
    bucket,
    timezone,
    startDate,
    endDateExclusive: endExclusive,
  };
}

function formatBucketValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

function buildLedgerWhere({ range, filters = {}, includeTypes }) {
  const clauses = ['"ts" >= :startDate', '"ts" < :endDateExclusive'];
  const replacements = {
    startDate: range.startDate,
    endDateExclusive: range.endDateExclusive,
  };

  if (includeTypes?.length) {
    clauses.push(`"eventType" IN (:eventTypes)`);
    replacements.eventTypes = includeTypes;
  }

  if (filters.agentId) {
    clauses.push(`"agentId" = :agentId`);
    replacements.agentId = Number(filters.agentId);
  }
  if (filters.cashierId) {
    clauses.push(`"cashierId" = :cashierId`);
    replacements.cashierId = Number(filters.cashierId);
  }
  if (filters.gameKey) {
    clauses.push(`"gameKey" = :gameKey`);
    replacements.gameKey = String(filters.gameKey);
  }
  if (filters.provider) {
    clauses.push(`meta->>'provider' = :provider`);
    replacements.provider = String(filters.provider);
  }
  if (filters.region) {
    clauses.push(`meta->>'region' = :region`);
    replacements.region = String(filters.region);
  }

  return { clause: clauses.join(" AND "), replacements };
}

function buildBucketExpr(column, range) {
  return bucketExpression(column, range.bucket, range.timezone);
}

async function getRevenueSeries(range, filters) {
  const bucketExpr = buildBucketExpr("ts", range);
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN", "VOUCHER_REDEEMED"],
  });

  const sql = `
    SELECT ${bucketExpr} AS t,
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents",
      SUM(
        CASE WHEN "eventType" = 'VOUCHER_REDEEMED'
          THEN COALESCE((meta->>'bonusCents')::int, 0)
          ELSE 0
        END
      ) AS "bonusesCents"
    FROM ledger_events
    WHERE ${clause}
    GROUP BY t
    ORDER BY t ASC
  `;

  const rows = await sequelize.query(sql, {
    replacements,
    type: QueryTypes.SELECT,
  });

  return rows.map((row) => {
    const bets = Number(row.betsCents || 0);
    const wins = Number(row.winsCents || 0);
    const bonuses = Number(row.bonusesCents || 0);
    return {
      t: formatBucketValue(row.t),
      betsCents: bets,
      winsCents: wins,
      bonusesCents: bonuses,
      ngrCents: bets - wins - bonuses,
    };
  });
}

async function getHandlePayoutSeries(range, filters) {
  const series = await getRevenueSeries(range, filters);
  return series.map((row) => ({
    t: row.t,
    handleCents: row.betsCents,
    payoutCents: row.winsCents,
    ratio: row.betsCents > 0 ? row.winsCents / row.betsCents : 0,
  }));
}

async function getDepositWithdrawalSeries(range, filters) {
  const bucketExpr = buildBucketExpr("ts", range);
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["DEPOSIT", "WITHDRAW"],
  });

  const sql = `
    SELECT ${bucketExpr} AS t,
      SUM(CASE WHEN "eventType" = 'DEPOSIT' THEN COALESCE("amountCents", 0) ELSE 0 END) AS "depositsCents",
      SUM(CASE WHEN "eventType" = 'WITHDRAW' THEN ABS(COALESCE("amountCents", 0)) ELSE 0 END) AS "withdrawalsCents"
    FROM ledger_events
    WHERE ${clause}
    GROUP BY t
    ORDER BY t ASC
  `;

  const rows = await sequelize.query(sql, {
    replacements,
    type: QueryTypes.SELECT,
  });

  return rows.map((row) => ({
    t: formatBucketValue(row.t),
    depositsCents: Number(row.depositsCents || 0),
    withdrawalsCents: Number(row.withdrawalsCents || 0),
  }));
}

async function getRevenueByGame(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN", "SPIN"],
  });

  const sql = `
    SELECT COALESCE("gameKey", 'Unknown') AS "gameKey",
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents",
      SUM(CASE WHEN "eventType" = 'SPIN' THEN 1 ELSE 0 END) AS "spins"
    FROM ledger_events
    WHERE ${clause}
    GROUP BY "gameKey"
  `;

  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const mapped = rows.map((row) => {
    const bets = Number(row.betsCents || 0);
    const wins = Number(row.winsCents || 0);
    return {
      gameKey: row.gameKey,
      betsCents: bets,
      winsCents: wins,
      ngrCents: bets - wins,
      spins: Number(row.spins || 0),
    };
  });

  mapped.sort((a, b) => b.ngrCents - a.ngrCents);
  const top = mapped.slice(0, 10);
  const other = mapped.slice(10);
  if (other.length) {
    const rollup = other.reduce(
      (acc, row) => {
        acc.betsCents += row.betsCents;
        acc.winsCents += row.winsCents;
        acc.ngrCents += row.ngrCents;
        acc.spins += row.spins;
        return acc;
      },
      { gameKey: "Other", betsCents: 0, winsCents: 0, ngrCents: 0, spins: 0 }
    );
    top.push(rollup);
  }

  return top;
}

async function getActiveUsers(range, filters) {
  const bucketExpr = buildBucketExpr("ts", range);
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ACTIVE_EVENT_TYPES,
  });

  const sql = `
    SELECT ${bucketExpr} AS t,
      COUNT(DISTINCT "playerId") AS "activeUsers"
    FROM ledger_events
    WHERE ${clause}
    GROUP BY t
    ORDER BY t ASC
  `;

  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const series = rows.map((row) => ({
    t: formatBucketValue(row.t),
    activeUsers: Number(row.activeUsers || 0),
  }));

  const windows = [
    { key: "dau", days: 1 },
    { key: "wau", days: 7 },
    { key: "mau", days: 30 },
  ];
  const kpis = {};
  for (const window of windows) {
    const start = new Date(range.endDateExclusive);
    start.setUTCDate(start.getUTCDate() - window.days);
    const { clause: windowClause, replacements: windowReplacements } = buildLedgerWhere({
      range: { ...range, startDate: start },
      filters,
      includeTypes: ACTIVE_EVENT_TYPES,
    });
    const countSql = `
      SELECT COUNT(DISTINCT "playerId") AS "count"
      FROM ledger_events
      WHERE ${windowClause}
    `;
    const countRows = await sequelize.query(countSql, {
      replacements: windowReplacements,
      type: QueryTypes.SELECT,
    });
    kpis[window.key] = Number(countRows[0]?.count || 0);
  }

  return { kpis, series };
}

async function getRetention(range, filters) {
  const tz = range.timezone;
  const startDate = range.startDate;
  const endDate = range.endDateExclusive;
  const snapshotCount = await SessionSnapshot.count({
    where: { startedAt: { [Op.gte]: startDate, [Op.lt]: endDate } },
  });

  const cohortSql = snapshotCount
    ? `
      SELECT cohort_day, ARRAY_AGG(player_id) AS players
      FROM (
        SELECT "playerId" AS player_id,
          DATE_TRUNC('day', TIMEZONE(:tz, MIN("startedAt"))) AS cohort_day
        FROM session_snapshots
        GROUP BY "playerId"
      ) cohorts
      WHERE cohort_day >= :startDate AND cohort_day < :endDateExclusive
      GROUP BY cohort_day
      ORDER BY cohort_day ASC
    `
    : `
      SELECT cohort_day, ARRAY_AGG(player_id) AS players
      FROM (
        SELECT "userId" AS player_id,
          DATE_TRUNC('day', TIMEZONE(:tz, MIN("createdAt"))) AS cohort_day
        FROM sessions
        WHERE "actorType" = 'user'
        GROUP BY "userId"
      ) cohorts
      WHERE cohort_day >= :startDate AND cohort_day < :endDateExclusive
      GROUP BY cohort_day
      ORDER BY cohort_day ASC
    `;

  const cohortRows = await sequelize.query(cohortSql, {
    replacements: { tz, startDate, endDateExclusive: endDate },
    type: QueryTypes.SELECT,
  });

  if (!cohortRows.length) {
    return [];
  }

  const activityEnd = new Date(endDate);
  activityEnd.setUTCDate(activityEnd.getUTCDate() + 30);
  const activitySql = `
    SELECT DATE_TRUNC('day', TIMEZONE(:tz, "ts")) AS day,
      ARRAY_AGG(DISTINCT "playerId") AS players
    FROM ledger_events
    WHERE "ts" >= :startDate AND "ts" < :activityEnd
      AND "eventType" IN ('BET', 'SPIN')
    GROUP BY day
    ORDER BY day ASC
  `;
  const activityRows = await sequelize.query(activitySql, {
    replacements: { tz, startDate, activityEnd },
    type: QueryTypes.SELECT,
  });

  const activityMap = new Map();
  for (const row of activityRows) {
    const key = new Date(row.day).toISOString().slice(0, 10);
    const list = row.players || [];
    activityMap.set(
      key,
      Array.isArray(list) ? list.map(String) : String(list).split(",")
    );
  }

  const cohorts = cohortRows.map((row) => {
    const day = new Date(row.cohort_day).toISOString().slice(0, 10);
    const cohortPlayers = Array.isArray(row.players)
      ? row.players.map(String)
      : String(row.players || "").split(",");
    const size = cohortPlayers.length;
    const offsets = [1, 7, 30];
    const retention = {};
    offsets.forEach((offset) => {
      const target = new Date(`${day}T00:00:00.000Z`);
      target.setUTCDate(target.getUTCDate() + offset);
      const key = target.toISOString().slice(0, 10);
      const activePlayers = new Set(activityMap.get(key) || []);
      let retained = 0;
      cohortPlayers.forEach((playerId) => {
        if (activePlayers.has(playerId)) retained += 1;
      });
      retention[`d${offset}`] = size ? (retained / size) * 100 : null;
    });
    return {
      cohortDate: day,
      d1: retention.d1,
      d7: retention.d7,
      d30: retention.d30,
      cohortSize: size,
    };
  });

  return cohorts;
}

async function getSessionLengthDistribution(range) {
  const snapshotCount = await SessionSnapshot.count({
    where: { startedAt: { [Op.gte]: range.startDate, [Op.lt]: range.endDateExclusive } },
  });
  const sql = snapshotCount
    ? `
      SELECT
        CASE
          WHEN duration < 2 THEN '0-2m'
          WHEN duration < 5 THEN '2-5m'
          WHEN duration < 10 THEN '5-10m'
          WHEN duration < 20 THEN '10-20m'
          WHEN duration < 40 THEN '20-40m'
          ELSE '40m+'
        END AS label,
        COUNT(*) AS count
      FROM (
        SELECT EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) / 60 AS duration
        FROM session_snapshots
        WHERE "startedAt" >= :startDate AND "startedAt" < :endDateExclusive
      ) durations
      GROUP BY label
    `
    : `
      SELECT
        CASE
          WHEN duration < 2 THEN '0-2m'
          WHEN duration < 5 THEN '2-5m'
          WHEN duration < 10 THEN '5-10m'
          WHEN duration < 20 THEN '10-20m'
          WHEN duration < 40 THEN '20-40m'
          ELSE '40m+'
        END AS label,
        COUNT(*) AS count
      FROM (
        SELECT EXTRACT(EPOCH FROM (COALESCE("lastSeenAt", "createdAt") - "createdAt")) / 60 AS duration
        FROM sessions
        WHERE "actorType" = 'user'
          AND "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
      ) durations
      GROUP BY label
    `;
  const rows = await sequelize.query(sql, {
    replacements: {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
    },
    type: QueryTypes.SELECT,
  });

  const order = ["0-2m", "2-5m", "5-10m", "10-20m", "20-40m", "40m+"];
  return order.map((label) => ({
    label,
    count: Number(rows.find((row) => row.label === label)?.count || 0),
  }));
}

async function getBetSizeDistribution(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: BET_EVENT_TYPES,
  });

  const sql = `
    SELECT
      CASE
        WHEN "betCents" < 100 THEN '0-1'
        WHEN "betCents" < 500 THEN '1-5'
        WHEN "betCents" < 1000 THEN '5-10'
        WHEN "betCents" < 2500 THEN '10-25'
        WHEN "betCents" < 5000 THEN '25-50'
        WHEN "betCents" < 10000 THEN '50-100'
        WHEN "betCents" < 25000 THEN '100-250'
        ELSE '250+'
      END AS label,
      COUNT(*) AS count
    FROM ledger_events
    WHERE ${clause}
    GROUP BY label
  `;

  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const order = ["0-1", "1-5", "5-10", "10-25", "25-50", "50-100", "100-250", "250+"];
  return order.map((label) => ({
    label,
    count: Number(rows.find((row) => row.label === label)?.count || 0),
  }));
}

async function getHighValuePlayers(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN"],
  });
  const sql = `
    SELECT "playerId",
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents"
    FROM ledger_events
    WHERE ${clause} AND "playerId" IS NOT NULL
    GROUP BY "playerId"
    ORDER BY (SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) -
              SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END)) DESC
    LIMIT 20
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows.map((row) => {
    const bets = Number(row.betsCents || 0);
    const wins = Number(row.winsCents || 0);
    return {
      playerId: row.playerId,
      betsCents: bets,
      winsCents: wins,
      ngrCents: bets - wins,
    };
  });
}

async function getWinRateOutliers(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN"],
  });

  const baseSql = `
    SELECT
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents"
    FROM ledger_events
    WHERE ${clause}
  `;

  const baseRows = await sequelize.query(baseSql, { replacements, type: QueryTypes.SELECT });
  const baseBets = Number(baseRows[0]?.betsCents || 0);
  const baseWins = Number(baseRows[0]?.winsCents || 0);
  const baselineRtp = baseBets > 0 ? baseWins / baseBets : 0;

  const playerSql = `
    SELECT "playerId",
      COUNT(*) FILTER (WHERE "eventType" = 'BET') AS "spins",
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents"
    FROM ledger_events
    WHERE ${clause} AND "playerId" IS NOT NULL
    GROUP BY "playerId"
    HAVING COUNT(*) FILTER (WHERE "eventType" = 'BET') >= 20
  `;

  const players = await sequelize.query(playerSql, { replacements, type: QueryTypes.SELECT });
  const rows = players
    .map((row) => {
      const bets = Number(row.betsCents || 0);
      const wins = Number(row.winsCents || 0);
      const spins = Number(row.spins || 0);
      const actualRtp = bets > 0 ? wins / bets : 0;
      const deviation = actualRtp - baselineRtp;
      const zScoreLikeMetric = baselineRtp ? deviation / baselineRtp : deviation;
      return {
        playerId: row.playerId,
        spins,
        betsCents: bets,
        winsCents: wins,
        actualRtp,
        zScoreLikeMetric,
      };
    })
    .sort((a, b) => Math.abs(b.zScoreLikeMetric) - Math.abs(a.zScoreLikeMetric))
    .slice(0, 50);

  return { baselineRtp, rows };
}

async function getBonusAbuse(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["VOUCHER_REDEEMED"],
  });

  const sql = `
    SELECT "playerId",
      SUM(COALESCE((meta->>'bonusCents')::int, 0)) AS "bonusCents",
      SUM(COALESCE((meta->>'amountCents')::int, 0)) AS "voucherCents",
      COUNT(*) AS "redemptions"
    FROM ledger_events
    WHERE ${clause}
    GROUP BY "playerId"
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  if (!rows.length) {
    return { configured: false, rows: [], summary: null };
  }

  const depositWhere = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["DEPOSIT"],
  });
  const depositSql = `
    SELECT "playerId",
      SUM(COALESCE("amountCents", 0)) AS "depositsCents"
    FROM ledger_events
    WHERE ${depositWhere.clause}
    GROUP BY "playerId"
  `;
  const depositRows = await sequelize.query(depositSql, {
    replacements: depositWhere.replacements,
    type: QueryTypes.SELECT,
  });
  const depositMap = new Map(
    depositRows.map((row) => [String(row.playerId), Number(row.depositsCents || 0)])
  );

  const enriched = rows.map((row) => {
    const bonus = Number(row.bonusCents || 0);
    const voucher = Number(row.voucherCents || 0);
    const deposits = depositMap.get(String(row.playerId)) || 0;
    return {
      playerId: row.playerId,
      bonusCents: bonus,
      voucherCents: voucher,
      redemptions: Number(row.redemptions || 0),
      bonusToDepositRatio: deposits > 0 ? bonus / deposits : null,
    };
  });

  enriched.sort((a, b) => (b.bonusCents || 0) - (a.bonusCents || 0));
  const summary = enriched.reduce(
    (acc, row) => {
      acc.totalBonusCents += row.bonusCents || 0;
      acc.totalRedemptions += row.redemptions || 0;
      return acc;
    },
    { totalBonusCents: 0, totalRedemptions: 0 }
  );

  return { configured: true, rows: enriched.slice(0, 20), summary };
}

async function getGeoAnomalies(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["LOGIN", "BET", "SPIN"],
  });

  const sql = `
    SELECT COALESCE(meta->>'country', 'Unknown') AS region,
      COUNT(*) AS sessions
    FROM ledger_events
    WHERE ${clause}
    GROUP BY region
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const pie = rows.map((row) => ({
    region: row.region,
    sessions: Number(row.sessions || 0),
  }));

  const prevRange = previousRange(range);
  const prevWhere = buildLedgerWhere({
    range: prevRange,
    filters,
    includeTypes: ["LOGIN", "BET", "SPIN"],
  });
  const prevRows = await sequelize.query(
    `
      SELECT COALESCE(meta->>'country', 'Unknown') AS region,
        COUNT(*) AS sessions
      FROM ledger_events
      WHERE ${prevWhere.clause}
      GROUP BY region
    `,
    { replacements: prevWhere.replacements, type: QueryTypes.SELECT }
  );
  const prevMap = new Map(
    prevRows.map((row) => [row.region, Number(row.sessions || 0)])
  );

  const anomalies = pie
    .map((entry) => {
      const prev = prevMap.get(entry.region) || 0;
      const spike = prev > 0 ? entry.sessions / prev : entry.sessions;
      return { ...entry, previousSessions: prev, spike };
    })
    .filter((entry) => entry.sessions >= 20 && entry.spike >= 2)
    .sort((a, b) => b.spike - a.spike);

  return { pie, anomalies };
}

async function getAccountVelocity(range, filters) {
  const bucketExpr = buildBucketExpr("createdAt", range);
  const userSql = `
    SELECT ${bucketExpr} AS t, COUNT(*) AS count
    FROM users
    WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
      AND role = 'player'
    GROUP BY t
    ORDER BY t ASC
  `;
  const userRows = await sequelize.query(userSql, {
    replacements: {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
    },
    type: QueryTypes.SELECT,
  });
  const userSeries = userRows.map((row) => ({
    t: formatBucketValue(row.t),
    count: Number(row.count || 0),
  }));

  const sessionSql = `
    SELECT ${bucketExpr} AS t, COUNT(*) AS count
    FROM sessions
    WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
      AND "actorType" = 'user'
    GROUP BY t
    ORDER BY t ASC
  `;
  const sessionRows = await sequelize.query(sessionSql, {
    replacements: {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
    },
    type: QueryTypes.SELECT,
  });
  const sessionSeries = sessionRows.map((row) => ({
    t: formatBucketValue(row.t),
    count: Number(row.count || 0),
  }));

  return { users: userSeries, sessions: sessionSeries };
}

async function getRtpByGame(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN"],
  });
  const sql = `
    SELECT COALESCE("gameKey", 'Unknown') AS "gameKey",
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents",
      COUNT(*) FILTER (WHERE "eventType" = 'BET') AS "spins"
    FROM ledger_events
    WHERE ${clause}
    GROUP BY "gameKey"
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const configs = await GameConfig.findAll();
  const configMap = new Map(
    configs.map((config) => [String(config.gameKey), Number(config.expectedRtp || 0)])
  );

  return rows.map((row) => {
    const bets = Number(row.betsCents || 0);
    const wins = Number(row.winsCents || 0);
    const actualRtp = bets > 0 ? wins / bets : 0;
    const expectedRtp = configMap.get(String(row.gameKey)) || null;
    return {
      gameKey: row.gameKey,
      betsCents: bets,
      winsCents: wins,
      spins: Number(row.spins || 0),
      actualRtp,
      expectedRtp,
    };
  });
}

async function getVolatilityHeatmap(range, filters) {
  const bucketExpr = buildBucketExpr("createdAt", range);
  const clauses = ['"createdAt" >= :startDate', '"createdAt" < :endDateExclusive'];
  const replacements = {
    startDate: range.startDate,
    endDateExclusive: range.endDateExclusive,
  };
  if (filters.gameKey) {
    clauses.push(`"gameId" = :gameKey`);
    replacements.gameKey = String(filters.gameKey);
  }
  const sql = `
    SELECT ${bucketExpr} AS t,
      "gameId" AS "gameKey",
      STDDEV_POP(("winAmount" - "betAmount")) AS volatility,
      COUNT(*) AS spins
    FROM game_rounds
    WHERE ${clauses.join(" AND ")}
    GROUP BY t, "gameId"
    ORDER BY t ASC
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows.map((row) => ({
    t: formatBucketValue(row.t),
    gameKey: row.gameKey,
    volatility: Number(row.volatility || 0),
    spins: Number(row.spins || 0),
  }));
}

async function getSpinVolume(range, filters) {
  const bucketExpr = buildBucketExpr("ts", range);
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["SPIN"],
  });
  const sql = `
    SELECT ${bucketExpr} AS t,
      COUNT(*) AS spins
    FROM ledger_events
    WHERE ${clause}
    GROUP BY t
    ORDER BY t ASC
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows.map((row) => ({
    t: formatBucketValue(row.t),
    spins: Number(row.spins || 0),
  }));
}

async function getErrorMetrics(range) {
  const bucketExpr = buildBucketExpr("ts", range);
  const sql = `
    SELECT ${bucketExpr} AS t, COUNT(*) AS errors
    FROM api_error_events
    WHERE "ts" >= :startDate AND "ts" < :endDateExclusive
    GROUP BY t
    ORDER BY t ASC
  `;
  const rows = await sequelize.query(sql, {
    replacements: {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
    },
    type: QueryTypes.SELECT,
  });

  const now = new Date();
  const rangeEnd = range.endDateExclusive < now ? range.endDateExclusive : now;
  const staleCutoff = new Date(rangeEnd.getTime() - FAILED_BET_STALE_MINUTES * 60000);
  const failedRows =
    staleCutoff > range.startDate
      ? await sequelize.query(
          `
          SELECT ${bucketExpr} AS t, COUNT(*) AS "failedBets"
          FROM game_rounds
          WHERE "createdAt" >= :startDate
            AND "createdAt" < :staleCutoff
            AND "status" != 'settled'
          GROUP BY t
          ORDER BY t ASC
          `,
          {
            replacements: {
              startDate: range.startDate,
              staleCutoff,
            },
            type: QueryTypes.SELECT,
          }
        )
      : [];

  const routesSql = `
    SELECT COALESCE(route, 'Unknown') AS route, COUNT(*) AS errors
    FROM api_error_events
    WHERE "ts" >= :startDate AND "ts" < :endDateExclusive
    GROUP BY route
    ORDER BY errors DESC
    LIMIT 10
  `;
  const routeRows = await sequelize.query(routesSql, {
    replacements: {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
    },
    type: QueryTypes.SELECT,
  });

  const errorMap = new Map(
    rows.map((row) => [formatBucketValue(row.t), Number(row.errors || 0)])
  );
  const failedMap = new Map(
    (failedRows || []).map((row) => [formatBucketValue(row.t), Number(row.failedBets || 0)])
  );
  const allKeys = Array.from(new Set([...errorMap.keys(), ...failedMap.keys()])).sort();

  return {
    series: allKeys.map((key) => ({
      t: key,
      errors: errorMap.get(key) || 0,
      failedBets: failedMap.get(key) || 0,
    })),
    staleMinutes: FAILED_BET_STALE_MINUTES,
    topRoutes: routeRows.map((row) => ({
      route: row.route,
      errors: Number(row.errors || 0),
    })),
  };
}

async function getCashierPerformance(range) {
  const bucketExpr = buildBucketExpr("createdAt", range);
  const issuedSql = `
    SELECT ${bucketExpr} AS t, COUNT(*) AS count
    FROM vouchers
    WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
    GROUP BY t
    ORDER BY t ASC
  `;
  const redeemedSql = `
    SELECT ${bucketExpr} AS t, COUNT(*) AS count
    FROM vouchers
    WHERE "redeemedAt" >= :startDate AND "redeemedAt" < :endDateExclusive
    GROUP BY t
    ORDER BY t ASC
  `;
  const expiredSql = `
    SELECT ${bucketExpr} AS t, COUNT(*) AS count
    FROM vouchers
    WHERE "expiresAt" >= :startDate AND "expiresAt" < :endDateExclusive
      AND "redeemedAt" IS NULL
    GROUP BY t
    ORDER BY t ASC
  `;
  const replacements = { startDate: range.startDate, endDateExclusive: range.endDateExclusive };
  const [issuedRows, redeemedRows, expiredRows] = await Promise.all([
    sequelize.query(issuedSql, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(redeemedSql, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(expiredSql, { replacements, type: QueryTypes.SELECT }),
  ]);

  const mapSeries = (rows) =>
    new Map(rows.map((row) => [formatBucketValue(row.t), Number(row.count || 0)]));

  const issuedMap = mapSeries(issuedRows);
  const redeemedMap = mapSeries(redeemedRows);
  const expiredMap = mapSeries(expiredRows);

  const allKeys = Array.from(
    new Set([...issuedMap.keys(), ...redeemedMap.keys(), ...expiredMap.keys()])
  ).sort();

  const series = allKeys.map((key) => ({
    t: key,
    issued: issuedMap.get(key) || 0,
    redeemed: redeemedMap.get(key) || 0,
    expired: expiredMap.get(key) || 0,
  }));

  const totals = series.reduce(
    (acc, row) => {
      acc.issued += row.issued;
      acc.redeemed += row.redeemed;
      acc.expired += row.expired;
      return acc;
    },
    { issued: 0, redeemed: 0, expired: 0 }
  );

  return { series, totals };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeDistribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return { count: 0, min: null, q1: null, median: null, q3: null, max: null };
  }
  return {
    count: sorted.length,
    min: sorted[0],
    q1: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    q3: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  };
}

async function getResolutionTimes(range) {
  const tickets = await SupportTicket.findAll({
    where: {
      createdAt: { [Op.gte]: range.startDate, [Op.lt]: range.endDateExclusive },
      resolvedAt: { [Op.not]: null },
    },
    attributes: ["createdAt", "resolvedAt", "assignedStaffId"],
  });
  const supportDurations = tickets.map((ticket) => {
    const created = new Date(ticket.createdAt);
    const resolved = new Date(ticket.resolvedAt);
    return Math.max(0, (resolved - created) / 60000);
  });

  const [deposits, withdrawals] = await Promise.all([
    DepositIntent.findAll({
      where: {
        createdAt: { [Op.gte]: range.startDate, [Op.lt]: range.endDateExclusive },
        creditedAt: { [Op.not]: null },
      },
      attributes: ["createdAt", "creditedAt", "metadata"],
    }),
    WithdrawalIntent.findAll({
      where: {
        createdAt: { [Op.gte]: range.startDate, [Op.lt]: range.endDateExclusive },
        sentAt: { [Op.not]: null },
      },
      attributes: ["createdAt", "sentAt", "metadata"],
    }),
  ]);

  const staffIds = new Set();
  [...deposits, ...withdrawals].forEach((intent) => {
    const id = intent?.metadata?.markedByStaffId;
    if (id) staffIds.add(Number(id));
  });

  const staffRoles = {};
  if (staffIds.size) {
    const staffRows = await StaffUser.findAll({
      where: { id: Array.from(staffIds) },
      attributes: ["id", "role"],
    });
    staffRows.forEach((staff) => {
      staffRoles[staff.id] = staff.role;
    });
  }

  const cashierDurations = [];
  const supportOpsDurations = [];
  const addIntentDuration = (intent, resolvedAt) => {
    const created = new Date(intent.createdAt);
    const resolved = new Date(resolvedAt);
    if (Number.isNaN(created.getTime()) || Number.isNaN(resolved.getTime())) return;
    const minutes = Math.max(0, (resolved - created) / 60000);
    const staffId = intent?.metadata?.markedByStaffId;
    const role = staffId ? staffRoles[Number(staffId)] : null;
    if (role === "cashier") {
      cashierDurations.push(minutes);
    } else if (role) {
      supportOpsDurations.push(minutes);
    }
  };

  deposits.forEach((intent) => addIntentDuration(intent, intent.creditedAt));
  withdrawals.forEach((intent) => addIntentDuration(intent, intent.sentAt));

  const categories = [
    { name: "Support", ...summarizeDistribution(supportDurations) },
    { name: "Cashier", ...summarizeDistribution(cashierDurations) },
  ];
  if (supportOpsDurations.length) {
    categories.push({ name: "Ops", ...summarizeDistribution(supportOpsDurations) });
  }

  const configured = categories.some((category) => category.count);
  return { configured, categories: configured ? categories : [] };
}

async function getLtvSegments(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN"],
  });
  const sql = `
    SELECT "playerId",
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents"
    FROM ledger_events
    WHERE ${clause} AND "playerId" IS NOT NULL
    GROUP BY "playerId"
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const bins = [
    { label: "0-10", min: 0, max: 1000 },
    { label: "10-50", min: 1000, max: 5000 },
    { label: "50-200", min: 5000, max: 20000 },
    { label: "200-1000", min: 20000, max: 100000 },
    { label: "1000+", min: 100000, max: Infinity },
  ];
  const counts = bins.map((bin) => ({ label: bin.label, count: 0 }));
  rows.forEach((row) => {
    const bets = Number(row.betsCents || 0);
    const wins = Number(row.winsCents || 0);
    const ltv = bets - wins;
    const match = bins.find((bin) => ltv >= bin.min && ltv < bin.max);
    if (match) {
      const entry = counts.find((c) => c.label === match.label);
      if (entry) entry.count += 1;
    }
  });
  return counts;
}

async function getWhaleDependency(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["BET", "WIN"],
  });
  const sql = `
    SELECT "playerId",
      SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "betsCents",
      SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "winsCents"
    FROM ledger_events
    WHERE ${clause} AND "playerId" IS NOT NULL
    GROUP BY "playerId"
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  if (!rows.length) {
    return { totalPlayers: 0, top1Pct: 0, top5Pct: 0, top10Pct: 0 };
  }
  const players = rows
    .map((row) => {
      const bets = Number(row.betsCents || 0);
      const wins = Number(row.winsCents || 0);
      return { playerId: row.playerId, ngr: bets - wins };
    })
    .sort((a, b) => b.ngr - a.ngr);

  const total = players.reduce((sum, p) => sum + p.ngr, 0) || 1;
  const calcPct = (pct) => {
    const count = Math.max(1, Math.ceil(players.length * pct));
    const slice = players.slice(0, count).reduce((sum, p) => sum + p.ngr, 0);
    return slice / total;
  };

  return {
    totalPlayers: players.length,
    top1Pct: calcPct(0.01),
    top5Pct: calcPct(0.05),
    top10Pct: calcPct(0.1),
  };
}

async function getFunnel(range, filters) {
  const { clause, replacements } = buildLedgerWhere({
    range,
    filters,
    includeTypes: ["LOGIN", "DEPOSIT", "VOUCHER_REDEEMED", "BET", "SPIN", "WITHDRAW"],
  });

  const sql = `
    SELECT "eventType", ARRAY_AGG(DISTINCT "playerId") AS players
    FROM ledger_events
    WHERE ${clause} AND "playerId" IS NOT NULL
    GROUP BY "eventType"
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const byType = new Map(
    rows.map((row) => [row.eventType, new Set(row.players || [])])
  );

  const login = byType.get("LOGIN") || new Set();
  const deposit = new Set(
    [...(byType.get("DEPOSIT") || new Set()), ...(byType.get("VOUCHER_REDEEMED") || new Set())]
  );
  const play = new Set([...(byType.get("BET") || new Set()), ...(byType.get("SPIN") || new Set())]);
  const cashout = byType.get("WITHDRAW") || new Set();

  const stepCounts = [
    { step: "Login", count: login.size },
    { step: "Deposit / Voucher", count: intersectionSize(login, deposit) },
    { step: "Play", count: intersectionSize(login, play) },
    { step: "Cashout", count: intersectionSize(login, cashout) },
  ];

  const returners = await getReturners(range, filters, login);
  stepCounts.push({ step: "Return (7d)", count: returners });

  const funnel = stepCounts.map((step, index) => {
    const prev = index === 0 ? step.count : stepCounts[index - 1].count;
    const dropoff = prev > 0 ? ((prev - step.count) / prev) * 100 : 0;
    return { ...step, dropoffPct: dropoff };
  });

  return funnel;
}

async function getReturners(range, filters, loginSet) {
  if (!loginSet.size) return 0;
  const returnEnd = new Date(range.endDateExclusive);
  returnEnd.setUTCDate(returnEnd.getUTCDate() + 7);
  const { clause, replacements } = buildLedgerWhere({
    range: { ...range, endDateExclusive: returnEnd },
    filters,
    includeTypes: ["LOGIN"],
  });
  const sql = `
    SELECT DISTINCT "playerId"
    FROM ledger_events
    WHERE ${clause} AND "playerId" IS NOT NULL
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  const returning = new Set(rows.map((row) => String(row.playerId)));
  let count = 0;
  loginSet.forEach((id) => {
    if (returning.has(String(id))) count += 1;
  });
  return count;
}

function intersectionSize(a, b) {
  let count = 0;
  a.forEach((value) => {
    if (b.has(value)) count += 1;
  });
  return count;
}

function previousRange(range) {
  const duration = range.endDateExclusive - range.startDate;
  const prevEnd = new Date(range.startDate);
  const prevStart = new Date(range.startDate.getTime() - duration);
  return {
    ...range,
    startDate: prevStart,
    endDateExclusive: prevEnd,
  };
}

async function getAttribution(metric, range, filters) {
  const current = await getRevenueSeries(range, filters);
  const prevRange = previousRange(range);
  const previous = await getRevenueSeries(prevRange, filters);

  const sumMetric = (rows) =>
    rows.reduce((sum, row) => sum + (metric === "ngr" ? row.ngrCents : row.betsCents), 0);
  const delta = sumMetric(current) - sumMetric(previous);

  const revenueByGame = await getRevenueByGame(range, filters);
  const prevByGame = await getRevenueByGame(prevRange, filters);
  const prevMap = new Map(prevByGame.map((row) => [row.gameKey, row.ngrCents]));
  const gameDeltas = revenueByGame.map((row) => ({
    factor: `Game: ${row.gameKey}`,
    contribution: row.ngrCents - (prevMap.get(row.gameKey) || 0),
  }));

  const depositSeries = await getDepositWithdrawalSeries(range, filters);
  const prevDeposits = await getDepositWithdrawalSeries(prevRange, filters);
  const depositDelta =
    depositSeries.reduce((sum, row) => sum + row.depositsCents, 0) -
    prevDeposits.reduce((sum, row) => sum + row.depositsCents, 0);

  const payoutDelta =
    current.reduce((sum, row) => sum + row.winsCents, 0) -
    previous.reduce((sum, row) => sum + row.winsCents, 0);

  const sessionDelta =
    (await getAccountVelocity(range, filters)).sessions.reduce((sum, row) => sum + row.count, 0) -
    (await getAccountVelocity(prevRange, filters)).sessions.reduce((sum, row) => sum + row.count, 0);

  const factors = [
    ...gameDeltas,
    { factor: "Deposits", contribution: depositDelta },
    { factor: "Payouts", contribution: -payoutDelta },
    { factor: "Sessions", contribution: sessionDelta * 100 },
  ]
    .filter((row) => row.contribution)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 6)
    .map((row) => ({
      factor: row.factor,
      contributionPct: delta ? (row.contribution / delta) * 100 : 0,
      evidence: { contribution: row.contribution },
    }));

  return { metric, delta, factors };
}

async function runAudit(range, filters) {
  const findings = [];
  const whale = await getWhaleDependency(range, filters);
  if (whale.top1Pct > 0.4) {
    findings.push({
      severity: whale.top1Pct > 0.6 ? 5 : 4,
      category: "Revenue concentration",
      title: "Whale dependency risk",
      detail: "Top 1% of players contribute a high share of NGR.",
      evidenceJson: whale,
    });
  }

  const games = await getRevenueByGame(range, filters);
  const totalNgr = games.reduce((sum, row) => sum + row.ngrCents, 0) || 1;
  const topGame = games[0];
  if (topGame && topGame.ngrCents / totalNgr > 0.35) {
    findings.push({
      severity: topGame.ngrCents / totalNgr > 0.5 ? 5 : 3,
      category: "Game fragility",
      title: "Overreliance on a single game",
      detail: "One game dominates NGR.",
      evidenceJson: {
        gameKey: topGame.gameKey,
        share: topGame.ngrCents / totalNgr,
      },
    });
  }

  const revenueSeries = await getRevenueSeries(range, filters);
  const total = revenueSeries.reduce((sum, row) => sum + row.ngrCents, 0) || 1;
  const peak = revenueSeries.reduce(
    (max, row) => (row.ngrCents > (max?.ngrCents || 0) ? row : max),
    null
  );
  if (peak && peak.ngrCents / total > 0.25) {
    findings.push({
      severity: peak.ngrCents / total > 0.4 ? 4 : 3,
      category: "Spike dependence",
      title: "Single-day NGR spike dominates period",
      detail: "One day accounts for a large share of NGR.",
      evidenceJson: { t: peak.t, share: peak.ngrCents / total },
    });
  }

  const rtpRows = await getRtpByGame(range, filters);
  const rtpAnomalies = rtpRows.filter(
    (row) => row.spins >= 100 && row.expectedRtp && Math.abs(row.actualRtp - row.expectedRtp) > 0.08
  );
  if (rtpAnomalies.length) {
    findings.push({
      severity: 4,
      category: "RTP anomaly",
      title: "Actual RTP deviates from expected",
      detail: "One or more games are outside variance bounds.",
      evidenceJson: rtpAnomalies,
    });
  }

  const errorMetrics = await getErrorMetrics(range);
  const prevErrorMetrics = await getErrorMetrics(previousRange(range));
  const currentErrors = errorMetrics.series.reduce((sum, row) => sum + row.errors, 0);
  const prevErrors = prevErrorMetrics.series.reduce((sum, row) => sum + row.errors, 0) || 1;
  if (currentErrors / prevErrors > 1.5 && currentErrors > 20) {
    findings.push({
      severity: 3,
      category: "Operational errors",
      title: "API error rate spike",
      detail: "Error volume is materially higher than previous period.",
      evidenceJson: { currentErrors, prevErrors },
    });
  }

  const cashier = await getCashierPerformance(range);
  const prevCashier = await getCashierPerformance(previousRange(range));
  const expiredRate = cashier.totals.issued
    ? cashier.totals.expired / cashier.totals.issued
    : 0;
  const prevExpiredRate = prevCashier.totals.issued
    ? prevCashier.totals.expired / prevCashier.totals.issued
    : 0;
  if (expiredRate > 0.2 && expiredRate > prevExpiredRate * 1.5) {
    findings.push({
      severity: 3,
      category: "Voucher leakage",
      title: "Expired voucher rate elevated",
      detail: "Voucher expirations are unusually high.",
      evidenceJson: { expiredRate, prevExpiredRate },
    });
  }

  return findings;
}

async function getOverview(range, filters) {
  const [revenueSeries, depositSeries, active, revenueByGame, whale] =
    await Promise.all([
      getRevenueSeries(range, filters),
      getDepositWithdrawalSeries(range, filters),
      getActiveUsers(range, filters),
      getRevenueByGame(range, filters),
      getWhaleDependency(range, filters),
    ]);

  const totals = revenueSeries.reduce(
    (acc, row) => {
      acc.betsCents += row.betsCents;
      acc.winsCents += row.winsCents;
      acc.bonusesCents += row.bonusesCents;
      acc.ngrCents += row.ngrCents;
      return acc;
    },
    { betsCents: 0, winsCents: 0, bonusesCents: 0, ngrCents: 0 }
  );

  const flowTotals = depositSeries.reduce(
    (acc, row) => {
      acc.depositsCents += row.depositsCents;
      acc.withdrawalsCents += row.withdrawalsCents;
      return acc;
    },
    { depositsCents: 0, withdrawalsCents: 0 }
  );

  const revenuePerActiveUser = active.kpis.dau
    ? totals.ngrCents / active.kpis.dau
    : 0;
  const peakShare = revenueSeries.length
    ? Math.max(...revenueSeries.map((row) => row.ngrCents)) /
      (totals.ngrCents || 1)
    : 0;

  return {
    kpis: {
      ngrCents: totals.ngrCents,
      handleCents: totals.betsCents,
      payoutCents: totals.winsCents,
      depositsCents: flowTotals.depositsCents,
      withdrawalsCents: flowTotals.withdrawalsCents,
      dau: active.kpis.dau,
      wau: active.kpis.wau,
      mau: active.kpis.mau,
    },
    truth: {
      revenuePerActiveUser,
      whaleDependency: whale,
      volatilityRiskIndicator: peakShare,
    },
    revenueSeries,
    revenueByGame,
  };
}

module.exports = {
  parseRange,
  getOverview,
  getRevenueSeries,
  getHandlePayoutSeries,
  getDepositWithdrawalSeries,
  getRevenueByGame,
  getActiveUsers,
  getRetention,
  getSessionLengthDistribution,
  getBetSizeDistribution,
  getHighValuePlayers,
  getWinRateOutliers,
  getBonusAbuse,
  getGeoAnomalies,
  getAccountVelocity,
  getRtpByGame,
  getVolatilityHeatmap,
  getSpinVolume,
  getErrorMetrics,
  getCashierPerformance,
  getResolutionTimes,
  getLtvSegments,
  getWhaleDependency,
  getFunnel,
  getAttribution,
  runAudit,
};
