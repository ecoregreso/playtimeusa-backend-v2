// src/routes/adminReports.js
const express = require("express");
const router = express.Router();
const { Op, fn, col, literal } = require("sequelize");
const geoip = require("geoip-lite");

const {
  sequelize,
  User,
  Voucher,
  Transaction,
  GameRound,
  Wallet,
  Session,
  DepositIntent,
  WithdrawalIntent,
  StaffUser,
} = require("../models");

const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");

// Helpers
function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildDateRange(req) {
  const qsStart = parseDateOnly(req.query.start || req.query.from);
  const qsEnd = parseDateOnly(req.query.end || req.query.to);

  let start, end;

  if (!qsStart && !qsEnd) {
    // default: last 7 days including today
    const today = new Date();
    const startD = new Date();
    startD.setDate(today.getDate() - 6);
    start = startD.toISOString().slice(0, 10);
    end = today.toISOString().slice(0, 10);
  } else {
    start = qsStart || qsEnd;
    end = qsEnd || qsStart;
  }

  if (!start || !end) {
    throw new Error("Unable to infer date range");
  }

  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  const startDate = new Date(start + "T00:00:00.000Z");
  const endDateExclusive = new Date(end + "T00:00:00.000Z");
  endDateExclusive.setUTCDate(endDateExclusive.getUTCDate() + 1);

  return { start, end, startDate, endDateExclusive };
}

function toDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toHour(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStaffId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function extractGameIdFromTransaction(tx) {
  const metadata = asObject(tx?.metadata);
  if (metadata.gameId != null && metadata.gameId !== "") {
    return String(metadata.gameId);
  }
  const reference = typeof tx?.reference === "string" ? tx.reference : "";
  const gameRefMatch = reference.match(/^game:([^:]+)$/i);
  if (gameRefMatch && gameRefMatch[1]) {
    return gameRefMatch[1];
  }
  return null;
}

function addDays(day, offset) {
  if (!day) return null;
  const date = new Date(day + "T00:00:00.000Z");
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function buildDayList(startDate, endDateExclusive) {
  const days = [];
  const cursor = new Date(startDate);
  while (cursor < endDateExclusive) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

const SESSION_LENGTH_BINS = [
  { label: "0-2m", min: 0, max: 2 },
  { label: "2-5m", min: 2, max: 5 },
  { label: "5-10m", min: 5, max: 10 },
  { label: "10-20m", min: 10, max: 20 },
  { label: "20-40m", min: 20, max: 40 },
  { label: "40-60m", min: 40, max: 60 },
  { label: "60-120m", min: 60, max: 120 },
  { label: "120m+", min: 120, max: Infinity },
];

const BET_SIZE_BINS = [
  { label: "0-1", min: 0, max: 1 },
  { label: "1-5", min: 1, max: 5 },
  { label: "5-10", min: 5, max: 10 },
  { label: "10-25", min: 10, max: 25 },
  { label: "25-50", min: 25, max: 50 },
  { label: "50-100", min: 50, max: 100 },
  { label: "100-250", min: 100, max: 250 },
  { label: "250+", min: 250, max: Infinity },
];

function buildHistogram(values, bins) {
  const counts = bins.map((bin) => ({ name: bin.label, value: 0 }));
  for (const value of values) {
    for (let i = 0; i < bins.length; i += 1) {
      const bin = bins[i];
      if (value >= bin.min && value < bin.max) {
        counts[i].value += 1;
        break;
      }
    }
  }
  return counts;
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

function normalizeIp(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : String(value);
  let ip = raw.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  return ip || null;
}

const WIN_RATE_MIN_BET = 50;
const WIN_RATE_MIN_ROUNDS = 5;
const WIN_RATE_DEVIATION_THRESHOLD = 0.2;

const BONUS_MIN_TOTAL = 25;
const BONUS_RATIO_THRESHOLD = 0.5;
const BONUS_TO_BET_THRESHOLD = 0.3;
const BONUS_REDEMPTION_THRESHOLD = 5;

const FAILED_BET_STALE_MINUTES = 10;

const DEFAULT_EXPECTED_RTP = 0.96;
const EXPECTED_RTP_BY_GAME = {};

function getExpectedRtp(gameId) {
  if (!gameId) return DEFAULT_EXPECTED_RTP;
  return EXPECTED_RTP_BY_GAME[gameId] ?? DEFAULT_EXPECTED_RTP;
}

// GET /admin/reports/range?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/range",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    let range;
    try {
      range = buildDateRange(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { start, end, startDate, endDateExclusive } = range;

    try {
      // We run several queries in parallel for performance.
      const [
        vouchersIssued,
        vouchersRedeemed,
        playersNew,
        gameRoundsAgg,
        txByType,
        voucherCashoutTx,
        recentVouchers,
        recentTransactions,
        recentRounds,
        staffSessions,
        playerSessions,
        activeStaffCount,
        activePlayerCount,
        totalStaffCount,
        totalPlayerCount,
        totalPlayersCount,
      ] = await Promise.all([
        // All vouchers *created* in the period
        Voucher.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            "id",
            "amount",
            "bonusAmount",
            "status",
            "redeemedAt",
            "redeemedByUserId",
          ],
        }),

        // Vouchers redeemed in the period
        Voucher.findAll({
          where: {
            status: "redeemed",
            redeemedAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            "id",
            "amount",
            "bonusAmount",
            "redeemedAt",
            "redeemedByUserId",
          ],
        }),

        // New players created in the period
        User.findAll({
          where: {
            role: "player",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["id"],
        }),

        // Game performance aggregated by gameCode
        GameRound.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            ["gameId", "gameId"],
            [fn("COUNT", literal("*")), "rounds"],
            [fn("COUNT", fn("DISTINCT", col("playerId"))), "uniquePlayers"],
            [fn("SUM", col("betAmount")), "totalBet"],
            [fn("SUM", col("winAmount")), "totalWin"],
            [literal('SUM("betAmount" - "winAmount")'), "ggr"],
          ],
          group: ["gameId"],
        }).catch((err) => {
          console.warn(
            "[REPORTS] GameRound aggregate failed (adjust columns if needed):",
            err.message
          );
          return [];
        }),

        // Transactions by type in the period
        Transaction.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            "type",
            [fn("COUNT", literal("*")), "count"],
            [fn("SUM", col("amount")), "totalAmount"],
          ],
          group: ["type"],
        }),

        Transaction.findAll({
          where: {
            type: "voucher_debit",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["id", "amount"],
        }),

        // Recent vouchers (dashboard)
        Voucher.findAll({
          order: [["createdAt", "DESC"]],
          limit: 12,
          attributes: ["id", "code", "amount", "bonusAmount", "status", "createdAt"],
        }),

        // Recent transactions (dashboard)
        Transaction.findAll({
          include: [{ model: Wallet, as: "wallet", attributes: ["id", "userId", "currency"] }],
          order: [["createdAt", "DESC"]],
          limit: 12,
        }),

        // Recent rounds (dashboard)
        GameRound.findAll({
          include: [{ model: User, as: "player", attributes: ["id", "username"] }],
          order: [["createdAt", "DESC"]],
          limit: 12,
        }),

        // Recent staff sessions (dashboard)
        Session.findAll({
          where: {
            actorType: "staff",
            revokedAt: { [Op.is]: null },
          },
          order: [["lastSeenAt", "DESC"]],
          limit: 12,
        }),

        // Recent player sessions (dashboard)
        Session.findAll({
          where: {
            actorType: "user",
            revokedAt: { [Op.is]: null },
          },
          order: [["lastSeenAt", "DESC"]],
          limit: 12,
        }),

        // Active session counts
        Session.count({
          where: {
            actorType: "staff",
            revokedAt: { [Op.is]: null },
          },
        }),
        Session.count({
          where: {
            actorType: "user",
            revokedAt: { [Op.is]: null },
          },
        }),
        Session.count({
          where: {
            actorType: "staff",
          },
        }),
        Session.count({
          where: {
            actorType: "user",
          },
        }),
        User.count({
          where: {
            role: "player",
          },
          distinct: true,
          col: "username",
        }),
      ]);

      // --- VOUCHERS ---

      const issuedStats = {
        count: vouchersIssued.length,
        totalAmount: 0,
        totalBonus: 0,
      };

      for (const v of vouchersIssued) {
        issuedStats.totalAmount += Number(v.amount || 0);
        issuedStats.totalBonus += Number(v.bonusAmount || 0);
      }

      const redeemedStats = {
        count: vouchersRedeemed.length,
        totalAmount: 0,
        totalBonus: 0,
        uniquePlayers: new Set(),
      };

      for (const v of vouchersRedeemed) {
        redeemedStats.totalAmount += Number(v.amount || 0);
        redeemedStats.totalBonus += Number(v.bonusAmount || 0);
        if (v.redeemedByUserId) {
          redeemedStats.uniquePlayers.add(String(v.redeemedByUserId));
        }
      }

      redeemedStats.uniquePlayers = redeemedStats.uniquePlayers.size;

      const cashoutStats = {
        count: voucherCashoutTx.length,
        totalAmount: voucherCashoutTx.reduce(
          (sum, tx) => sum + Number(tx.amount || 0),
          0
        ),
      };

      // Simple "breakage" view = issued - redeemed in amount/bonus
      const breakageStats = {
        count: Math.max(0, issuedStats.count - redeemedStats.count),
        totalAmount: Math.max(
          0,
          issuedStats.totalAmount - redeemedStats.totalAmount
        ),
        totalBonus: Math.max(
          0,
          issuedStats.totalBonus - redeemedStats.totalBonus
        ),
      };

      // --- PLAYERS ---

      // New players = new signups in period
      const playerNewCount = playersNew.length;

      // Active players = players who either redeemed a voucher or had game rounds in period
      const activeSet = new Set();

      for (const v of vouchersRedeemed) {
        if (v.redeemedByUserId) {
          activeSet.add(String(v.redeemedByUserId));
        }
      }

      // If GameRound model exists and found anything, add those players too
      if (Array.isArray(gameRoundsAgg) && gameRoundsAgg.length > 0) {
        // We don't have per-row userId here, so we approximate activeFromGames later.
        // If you want exact, you can add another query by GameRound.playerId.
      }

      // A more accurate "active from games" query:
      const gamePlayersRaw = await GameRound.findAll({
        where: {
          createdAt: {
            [Op.gte]: startDate,
            [Op.lt]: endDateExclusive,
          },
        },
        attributes: [[fn("DISTINCT", col("playerId")), "playerId"]],
      }).catch((err) => {
        console.warn(
          "[REPORTS] GameRound active players query failed:",
          err.message
        );
        return [];
      });

      let activeFromGames = 0;
      for (const row of gamePlayersRaw) {
        const id = row.get("playerId");
        if (id) {
          activeSet.add(String(id));
          activeFromGames++;
        }
      }

      const playersStats = {
        total: Number(totalPlayersCount || 0),
        new: playerNewCount,
        active: activeSet.size,
        activeFromGames,
      };

      // --- TRANSACTIONS & GGR ---

      const byType = txByType.map((t) => ({
        type: t.type,
        count: Number(t.get("count") || 0),
        totalAmount: Number(t.get("totalAmount") || 0),
      }));

      const creditTypes = [
        "credit",
        "voucher_credit",
        "game_win",
        "manual_adjustment",
      ];
      const debitTypes = ["debit", "voucher_debit", "game_bet"];

      const totalCredits = byType
        .filter((t) => creditTypes.includes(t.type))
        .reduce((sum, t) => sum + t.totalAmount, 0);
      const totalDebits = byType
        .filter((t) => debitTypes.includes(t.type))
        .reduce((sum, t) => sum + t.totalAmount, 0);

      // Best-effort game GGR from GameRound aggregation
      let ggrTotal = 0;
      for (const g of gameRoundsAgg) {
        ggrTotal += Number(g.get("ggr") || 0);
      }

      // If GameRound doesn't have net column, we can fallback from transactions:
      if (!ggrTotal && byType.length) {
        const bet = byType
          .filter((x) => x.type === "game_bet")
          .reduce((s, t) => s + t.totalAmount, 0);
        const win = byType
          .filter((x) => x.type === "game_win")
          .reduce((s, t) => s + t.totalAmount, 0);
        ggrTotal = bet - win;
      }

      const txAggregates = {
        gameBetTotal: byType
          .filter((x) => x.type === "game_bet")
          .reduce((s, t) => s + t.totalAmount, 0),
        gameWinTotal: byType
          .filter((x) => x.type === "game_win")
          .reduce((s, t) => s + t.totalAmount, 0),
        netGame: ggrTotal,
      };

      // --- GAMES BY GAME ---

      const gamesByGame = (gameRoundsAgg || []).map((g) => ({
        game: g.get("gameId") || g.gameId,
        rounds: Number(g.get("rounds") || 0),
        uniquePlayers: Number(g.get("uniquePlayers") || 0),
        totalBet: Number(g.get("totalBet") || 0),
        totalWin: Number(g.get("totalWin") || 0),
        ggr: Number(g.get("ggr") || 0),
      }));

      const gamesBlock = {
        byGame: gamesByGame,
        ggr: ggrTotal,
      };

      const summary = {
        totalVoucherAmount: issuedStats.totalAmount,
        totalVoucherBonus: issuedStats.totalBonus,
        totalVoucherCashout: cashoutStats.totalAmount,
        totalCredits,
        totalDebits,
        totalBetAmount: txAggregates.gameBetTotal,
        totalWinAmount: txAggregates.gameWinTotal,
        grossGamingRevenue: ggrTotal,
        netCashflow: totalCredits - totalDebits,
      };

      res.json({
        ok: true,
        period: {
          start,
          end,
          label: `${start} → ${end}`,
        },
        sessions: {
          activeStaff: Number(activeStaffCount || 0),
          activePlayers: Number(activePlayerCount || 0),
          totalStaff: Number(totalStaffCount || 0),
          totalPlayers: Number(totalPlayerCount || 0),
          totalStaffSessions: Number(totalStaffCount || 0),
          totalPlayerSessions: Number(totalPlayerCount || 0),
          staffSessions: (staffSessions || []).map((s) => s.toJSON()),
          playerSessions: (playerSessions || []).map((s) => s.toJSON()),
        },
        recent: {
          vouchers: (recentVouchers || []).map((v) => ({
            ...v.toJSON(),
            status: String(v.status || "").toLowerCase(),
          })),
          transactions: (recentTransactions || []).map((t) => ({
            ...t.toJSON(),
            amount: Number(t.amount || 0),
            balanceBefore: Number(t.balanceBefore || 0),
            balanceAfter: Number(t.balanceAfter || 0),
          })),
          rounds: (recentRounds || []).map((r) => ({
            id: r.id,
            gameId: r.gameId,
            betAmount: Number(r.betAmount || 0),
            winAmount: Number(r.winAmount || 0),
            status: r.status,
            createdAt: r.createdAt,
            player: r.player
              ? { id: r.player.id, userCode: r.player.username }
              : null,
          })),
        },
        summary,
        vouchers: {
          issued: issuedStats,
          redeemed: redeemedStats,
          cashedOut: cashoutStats,
          breakage: breakageStats,
        },
        players: playersStats,
        transactions: {
          aggregates: txAggregates,
          byType,
        },
        games: gamesBlock,
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_RANGE] error:", err);
      res.status(500).json({ ok: false, error: "Failed to build range report" });
    }
  }
);

// GET /admin/reports/behavior?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/behavior",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    let range;
    try {
      range = buildDateRange(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { start, end, startDate, endDateExclusive } = range;
    const rangeDays = buildDayList(startDate, endDateExclusive);

    const activityStart = new Date(startDate);
    activityStart.setUTCDate(activityStart.getUTCDate() - 29);
    const activityEnd = new Date(endDateExclusive);
    activityEnd.setUTCDate(activityEnd.getUTCDate() + 30);
    const activityDays = buildDayList(activityStart, activityEnd);
    const activityIndexByDay = Object.fromEntries(
      activityDays.map((day, idx) => [day, idx])
    );

    try {
      const [players, sessionsActivity, sessionsForLength, betTx, activityBetRows] = await Promise.all([
        User.findAll({
          where: {
            role: "player",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["id", "createdAt"],
        }),
        Session.findAll({
          where: {
            actorType: { [Op.in]: ["user", "player"] },
            lastSeenAt: {
              [Op.gte]: activityStart,
              [Op.lt]: activityEnd,
            },
          },
          attributes: ["userId", "createdAt", "lastSeenAt"],
        }),
        Session.findAll({
          where: {
            actorType: { [Op.in]: ["user", "player"] },
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["createdAt", "lastSeenAt"],
        }),
        Transaction.findAll({
          where: {
            type: "game_bet",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["amount"],
        }),
        Transaction.findAll({
          where: {
            type: "game_bet",
            createdAt: {
              [Op.gte]: activityStart,
              [Op.lt]: activityEnd,
            },
            createdByUserId: { [Op.not]: null },
          },
          attributes: [
            [literal(`DATE("createdAt")`), "day"],
            ["createdByUserId", "playerId"],
          ],
          group: [literal(`DATE("createdAt")`), "createdByUserId"],
        }),
      ]);

      const sessionDaySets = Object.fromEntries(
        activityDays.map((day) => [day, new Set()])
      );

      for (const session of sessionsActivity) {
        const day = toDay(session.lastSeenAt || session.createdAt);
        if (!day || !sessionDaySets[day]) continue;
        const userId = session.userId;
        if (userId != null) {
          sessionDaySets[day].add(String(userId));
        }
      }
      for (const row of activityBetRows) {
        const day = toDay(row.get("day"));
        if (!day || !sessionDaySets[day]) continue;
        const playerId = row.get("playerId") || row.playerId;
        if (playerId != null) {
          sessionDaySets[day].add(String(playerId));
        }
      }

      const activeDays = rangeDays.map((day) => {
        const index = activityIndexByDay[day];
        const dau = sessionDaySets[day]?.size || 0;
        const wauSet = new Set();
        const mauSet = new Set();
        if (index != null) {
          const startWau = Math.max(0, index - 6);
          const startMau = Math.max(0, index - 29);
          for (let i = startWau; i <= index; i += 1) {
            sessionDaySets[activityDays[i]]?.forEach((id) => wauSet.add(id));
          }
          for (let i = startMau; i <= index; i += 1) {
            sessionDaySets[activityDays[i]]?.forEach((id) => mauSet.add(id));
          }
        }
        return {
          day,
          dau,
          wau: wauSet.size,
          mau: mauSet.size,
        };
      });

      const cohorts = {};
      for (const player of players) {
        const day = toDay(player.createdAt);
        if (!day) continue;
        if (!cohorts[day]) cohorts[day] = new Set();
        cohorts[day].add(String(player.id));
      }

      const retentionForOffset = (day, cohort, offset) => {
        const targetDay = addDays(day, offset);
        const activeSet = targetDay ? sessionDaySets[targetDay] : null;
        if (!activeSet || !cohort.size) return null;
        let retained = 0;
        cohort.forEach((id) => {
          if (activeSet.has(id)) retained += 1;
        });
        return (retained / cohort.size) * 100;
      };

      let retentionDays = rangeDays.map((day) => {
        const cohort = cohorts[day];
        if (!cohort || !cohort.size) {
          return { day, d1: null, d7: null, d30: null, cohort: 0 };
        }
        return {
          day,
          d1: retentionForOffset(day, cohort, 1),
          d7: retentionForOffset(day, cohort, 7),
          d30: retentionForOffset(day, cohort, 30),
          cohort: cohort.size,
        };
      });

      // Fallback when no players were created in range: cohort by first observed activity day.
      if (!retentionDays.some((entry) => Number(entry.cohort || 0) > 0)) {
        const firstSeenByPlayer = new Map();
        for (const day of rangeDays) {
          const users = sessionDaySets[day];
          if (!users || !users.size) continue;
          for (const playerId of users) {
            if (!firstSeenByPlayer.has(playerId)) {
              firstSeenByPlayer.set(playerId, day);
            }
          }
        }

        const activityCohorts = {};
        for (const [playerId, day] of firstSeenByPlayer.entries()) {
          if (!activityCohorts[day]) activityCohorts[day] = new Set();
          activityCohorts[day].add(String(playerId));
        }

        retentionDays = rangeDays.map((day) => {
          const cohort = activityCohorts[day];
          if (!cohort || !cohort.size) {
            return { day, d1: null, d7: null, d30: null, cohort: 0 };
          }
          return {
            day,
            d1: retentionForOffset(day, cohort, 1),
            d7: retentionForOffset(day, cohort, 7),
            d30: retentionForOffset(day, cohort, 30),
            cohort: cohort.size,
          };
        });
      }

      const sessionLengths = [];
      const sessionLengthSource = (sessionsForLength || []).length ? sessionsForLength : sessionsActivity;
      for (const session of sessionLengthSource) {
        const createdAt = new Date(session.createdAt);
        const lastSeen = new Date(session.lastSeenAt || session.createdAt);
        if (Number.isNaN(createdAt.getTime()) || Number.isNaN(lastSeen.getTime())) {
          continue;
        }
        const durationMinutes = Math.max(0, (lastSeen - createdAt) / 60000);
        sessionLengths.push(durationMinutes);
      }

      const betValues = betTx
        .map((tx) => Math.abs(Number(tx.amount || 0)))
        .filter((value) => Number.isFinite(value));

      res.json({
        ok: true,
        period: { start, end, label: `${start} → ${end}` },
        activeUsers: { days: activeDays },
        retention: { cohorts: retentionDays },
        distributions: {
          sessionLengths: buildHistogram(sessionLengths, SESSION_LENGTH_BINS),
          betSizes: buildHistogram(betValues, BET_SIZE_BINS),
        },
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_BEHAVIOR] error:", err);
      res.status(500).json({ ok: false, error: "Failed to build behavior report" });
    }
  }
);

// GET /admin/reports/risk?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/risk",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    let range;
    try {
      range = buildDateRange(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { start, end, startDate, endDateExclusive } = range;
    const rangeDays = buildDayList(startDate, endDateExclusive);
    const hourList = [];
    const hourCursor = new Date(startDate);
    while (hourCursor < endDateExclusive) {
      hourList.push(hourCursor.toISOString());
      hourCursor.setUTCHours(hourCursor.getUTCHours() + 1);
    }

    try {
      const [
        playerAgg,
        txPlayerAggRows,
        voucherAgg,
        sessionRows,
        dailyRows,
        hourlyRows,
        sessionDailyRows,
        sessionHourlyRows,
      ] = await Promise.all([
        GameRound.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            ["playerId", "playerId"],
            [fn("COUNT", literal("*")), "rounds"],
            [fn("SUM", col("betAmount")), "totalBet"],
            [fn("SUM", col("winAmount")), "totalWin"],
          ],
          group: ["playerId"],
        }),
        Transaction.findAll({
          where: {
            type: { [Op.in]: ["game_bet", "game_win"] },
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
            createdByUserId: { [Op.not]: null },
          },
          attributes: [
            ["createdByUserId", "playerId"],
            "type",
            [fn("COUNT", literal("*")), "events"],
            [fn("SUM", col("amount")), "totalAmount"],
          ],
          group: ["createdByUserId", "type"],
        }),
        Voucher.findAll({
          where: {
            redeemedByUserId: { [Op.not]: null },
            redeemedAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            ["redeemedByUserId", "playerId"],
            [fn("COUNT", literal("*")), "redemptions"],
            [fn("SUM", col("amount")), "totalAmount"],
            [fn("SUM", col("bonusAmount")), "totalBonus"],
          ],
          group: ["redeemedByUserId"],
        }),
        Session.findAll({
          where: {
            actorType: { [Op.in]: ["user", "player"] },
            lastSeenAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["ip"],
        }),
        User.findAll({
          where: {
            role: "player",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("createdAt")`), "day"],
            [fn("COUNT", literal("*")), "count"],
          ],
          group: [literal(`DATE("createdAt")`)],
          order: [[literal(`DATE("createdAt")`), "ASC"]],
        }),
        User.findAll({
          where: {
            role: "player",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE_TRUNC('hour', "createdAt")`), "hour"],
            [fn("COUNT", literal("*")), "count"],
          ],
          group: [literal(`DATE_TRUNC('hour', "createdAt")`)],
          order: [[literal(`DATE_TRUNC('hour', "createdAt")`), "ASC"]],
        }),
        Session.findAll({
          where: {
            actorType: { [Op.in]: ["user", "player"] },
            lastSeenAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("lastSeenAt")`), "day"],
            [literal(`COUNT(DISTINCT "userId")`), "count"],
          ],
          group: [literal(`DATE("lastSeenAt")`)],
          order: [[literal(`DATE("lastSeenAt")`), "ASC"]],
        }),
        Session.findAll({
          where: {
            actorType: { [Op.in]: ["user", "player"] },
            lastSeenAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE_TRUNC('hour', "lastSeenAt")`), "hour"],
            [literal(`COUNT(DISTINCT "userId")`), "count"],
          ],
          group: [literal(`DATE_TRUNC('hour', "lastSeenAt")`)],
          order: [[literal(`DATE_TRUNC('hour', "lastSeenAt")`), "ASC"]],
        }),
      ]);

      let totalBetAll = 0;
      let totalWinAll = 0;
      const betByPlayer = new Map();

      let winRatePlayers = playerAgg.map((row) => {
        const playerId = row.get("playerId");
        const rounds = Number(row.get("rounds") || 0);
        const totalBet = Number(row.get("totalBet") || 0);
        const totalWin = Number(row.get("totalWin") || 0);
        return { playerId, rounds, totalBet, totalWin };
      });

      // Fallback for games that do not persist GameRound rows consistently.
      if (!winRatePlayers.length && (txPlayerAggRows || []).length) {
        const txByPlayer = new Map();
        for (const row of txPlayerAggRows) {
          const playerId = row.get("playerId") || row.playerId;
          if (!playerId) continue;
          const type = row.get("type") || row.type;
          const events = Number(row.get("events") || 0);
          const totalAmount = Math.abs(Number(row.get("totalAmount") || 0));
          const existing = txByPlayer.get(String(playerId)) || {
            playerId: String(playerId),
            rounds: 0,
            totalBet: 0,
            totalWin: 0,
          };
          if (type === "game_bet") {
            existing.rounds += events;
            existing.totalBet += totalAmount;
          } else if (type === "game_win") {
            existing.totalWin += totalAmount;
          }
          txByPlayer.set(String(playerId), existing);
        }
        winRatePlayers = Array.from(txByPlayer.values());
      }

      for (const player of winRatePlayers) {
        totalBetAll += Number(player.totalBet || 0);
        totalWinAll += Number(player.totalWin || 0);
        if (player.playerId != null) {
          betByPlayer.set(String(player.playerId), Number(player.totalBet || 0));
        }
      }

      const baselineRtp = totalBetAll > 0 ? totalWinAll / totalBetAll : 0;

      const winRateOutliers = winRatePlayers
        .filter((p) => Number(p.totalBet || 0) > 0 && Number(p.rounds || 0) > 0)
        .map((p) => {
          const rtp = p.totalBet > 0 ? p.totalWin / p.totalBet : 0;
          const deviation = rtp - baselineRtp;
          const eligible =
            Number(p.totalBet || 0) >= WIN_RATE_MIN_BET &&
            Number(p.rounds || 0) >= WIN_RATE_MIN_ROUNDS;
          return {
            playerId: p.playerId,
            rounds: p.rounds,
            totalBet: p.totalBet,
            totalWin: p.totalWin,
            rtp,
            deviation,
            eligible,
            isOutlier: eligible && Math.abs(deviation) >= WIN_RATE_DEVIATION_THRESHOLD,
          };
        });

      const bonusAccounts = voucherAgg.map((row) => {
        const playerId = row.get("playerId");
        const redemptions = Number(row.get("redemptions") || 0);
        const totalAmount = Number(row.get("totalAmount") || 0);
        const totalBonus = Number(row.get("totalBonus") || 0);
        const bonusRatio = totalAmount > 0 ? totalBonus / totalAmount : 0;
        const totalBet = betByPlayer.get(String(playerId)) || 0;
        const bonusToBetRatio = totalBet > 0 ? totalBonus / totalBet : 0;
        const flagged =
          totalBonus >= BONUS_MIN_TOTAL &&
          (bonusRatio >= BONUS_RATIO_THRESHOLD ||
            bonusToBetRatio >= BONUS_TO_BET_THRESHOLD ||
            redemptions >= BONUS_REDEMPTION_THRESHOLD);
        return {
          playerId,
          redemptions,
          totalAmount,
          totalBonus,
          bonusRatio,
          bonusToBetRatio,
          status: flagged ? "flagged" : "legit",
        };
      });

      const bonusSummary = bonusAccounts.reduce(
        (acc, account) => {
          if (account.status === "flagged") {
            acc.flagged.count += 1;
            acc.flagged.totalBonus += account.totalBonus;
          } else {
            acc.legit.count += 1;
            acc.legit.totalBonus += account.totalBonus;
          }
          return acc;
        },
        { flagged: { count: 0, totalBonus: 0 }, legit: { count: 0, totalBonus: 0 } }
      );

      const countryCounts = {};
      let unknown = 0;
      for (const session of sessionRows) {
        const ip = normalizeIp(session.ip);
        const geo = ip ? geoip.lookup(ip) : null;
        const country = geo?.country || "Unknown";
        if (country === "Unknown") unknown += 1;
        countryCounts[country] = (countryCounts[country] || 0) + 1;
      }

      const countries = Object.entries(countryCounts)
        .map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count);

      const dailyMap = {};
      for (const row of dailyRows) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        dailyMap[day] = Number(row.get("count") || 0);
      }
      const sessionDailyMap = {};
      for (const row of sessionDailyRows) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        sessionDailyMap[day] = Number(row.get("count") || 0);
      }
      const useSessionVelocityDaily = !Object.values(dailyMap).some((value) => Number(value || 0) > 0);
      const daily = rangeDays.map((day) => ({
        day,
        count: useSessionVelocityDaily ? sessionDailyMap[day] || 0 : dailyMap[day] || 0,
      }));

      const hourlyMap = {};
      for (const row of hourlyRows) {
        const hour = toHour(row.get("hour"));
        if (!hour) continue;
        hourlyMap[hour] = Number(row.get("count") || 0);
      }
      const sessionHourlyMap = {};
      for (const row of sessionHourlyRows) {
        const hour = toHour(row.get("hour"));
        if (!hour) continue;
        sessionHourlyMap[hour] = Number(row.get("count") || 0);
      }
      const useSessionVelocityHourly = !Object.values(hourlyMap).some((value) => Number(value || 0) > 0);
      const hourly = hourList.map((hour) => ({
        hour,
        count: useSessionVelocityHourly ? sessionHourlyMap[hour] || 0 : hourlyMap[hour] || 0,
      }));

      res.json({
        ok: true,
        period: { start, end, label: `${start} → ${end}` },
        winRateOutliers: {
          baselineRtp,
          minBet: WIN_RATE_MIN_BET,
          minRounds: WIN_RATE_MIN_ROUNDS,
          deviationThreshold: WIN_RATE_DEVIATION_THRESHOLD,
          players: winRateOutliers,
        },
        bonusAbuse: {
          ...bonusSummary,
          criteria: {
            minBonus: BONUS_MIN_TOTAL,
            bonusRatioThreshold: BONUS_RATIO_THRESHOLD,
            bonusToBetThreshold: BONUS_TO_BET_THRESHOLD,
            redemptionThreshold: BONUS_REDEMPTION_THRESHOLD,
          },
          accounts: bonusAccounts,
        },
        geography: {
          countries,
          unknown,
          total: sessionRows.length,
        },
        accountVelocity: {
          daily,
          hourly,
        },
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_RISK] error:", err);
      res.status(500).json({ ok: false, error: "Failed to build risk report" });
    }
  }
);

// GET /admin/reports/operations?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/operations",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    let range;
    try {
      range = buildDateRange(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { start, end, startDate, endDateExclusive } = range;
    const dayList = buildDayList(startDate, endDateExclusive);
    const now = new Date();
    const rangeEnd = endDateExclusive < now ? endDateExclusive : now;
    const staleCutoff = new Date(rangeEnd.getTime() - FAILED_BET_STALE_MINUTES * 60000);

    try {
      const [
        pendingRounds,
        staleRounds,
        issuedRows,
        redeemedRows,
        expiredRows,
        deposits,
        withdrawals,
        cashoutTxRows,
        redeemedVoucherRows,
        cashoutTxDetailRows,
      ] = await Promise.all([
        GameRound.findAll({
          where: {
            status: { [Op.ne]: "settled" },
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("createdAt")`), "day"],
            [fn("COUNT", literal("*")), "count"],
          ],
          group: [literal(`DATE("createdAt")`)],
          order: [[literal(`DATE("createdAt")`), "ASC"]],
        }),
        staleCutoff > startDate
          ? GameRound.findAll({
              where: {
                status: { [Op.ne]: "settled" },
                createdAt: {
                  [Op.gte]: startDate,
                  [Op.lt]: staleCutoff < endDateExclusive ? staleCutoff : endDateExclusive,
                },
              },
              attributes: [
                [literal(`DATE("createdAt")`), "day"],
                [fn("COUNT", literal("*")), "count"],
              ],
              group: [literal(`DATE("createdAt")`)],
              order: [[literal(`DATE("createdAt")`), "ASC"]],
            })
          : [],
        Voucher.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("createdAt")`), "day"],
            [fn("COUNT", literal("*")), "count"],
          ],
          group: [literal(`DATE("createdAt")`)],
          order: [[literal(`DATE("createdAt")`), "ASC"]],
        }),
        Voucher.findAll({
          where: {
            redeemedAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("redeemedAt")`), "day"],
            [fn("COUNT", literal("*")), "count"],
          ],
          group: [literal(`DATE("redeemedAt")`)],
          order: [[literal(`DATE("redeemedAt")`), "ASC"]],
        }),
        Voucher.findAll({
          where: {
            expiresAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
              [Op.lte]: now,
            },
            redeemedAt: { [Op.is]: null },
          },
          attributes: [
            [literal(`DATE("expiresAt")`), "day"],
            [fn("COUNT", literal("*")), "count"],
          ],
          group: [literal(`DATE("expiresAt")`)],
          order: [[literal(`DATE("expiresAt")`), "ASC"]],
        }),
        DepositIntent.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
            creditedAt: { [Op.not]: null },
          },
          attributes: ["createdAt", "creditedAt", "metadata"],
        }),
        WithdrawalIntent.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
            sentAt: { [Op.not]: null },
          },
          attributes: ["createdAt", "sentAt", "metadata"],
        }),
        Transaction.findAll({
          where: {
            type: "voucher_debit",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("createdAt")`), "day"],
            [fn("COUNT", literal("*")), "count"],
            [fn("SUM", col("amount")), "amount"],
          ],
          group: [literal(`DATE("createdAt")`)],
          order: [[literal(`DATE("createdAt")`), "ASC"]],
        }),
        Voucher.findAll({
          where: {
            redeemedAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["id", "createdAt", "redeemedAt", "metadata"],
        }),
        Transaction.findAll({
          where: {
            type: "voucher_debit",
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["createdAt", "metadata", "reference"],
        }),
      ]);

      const pendingMap = {};
      for (const row of pendingRounds) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        pendingMap[day] = Number(row.get("count") || 0);
      }
      const staleMap = {};
      for (const row of staleRounds) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        staleMap[day] = Number(row.get("count") || 0);
      }

      const systemDays = dayList.map((day) => ({
        day,
        pendingBets: pendingMap[day] || 0,
        failedBets: staleMap[day] || 0,
      }));

      const issuedMap = {};
      for (const row of issuedRows) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        issuedMap[day] = Number(row.get("count") || 0);
      }
      const redeemedMap = {};
      for (const row of redeemedRows) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        redeemedMap[day] = Number(row.get("count") || 0);
      }
      const expiredMap = {};
      for (const row of expiredRows) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        expiredMap[day] = Number(row.get("count") || 0);
      }
      const cashoutMap = {};
      const cashoutAmountMap = {};
      for (const row of cashoutTxRows) {
        const day = toDay(row.get("day"));
        if (!day) continue;
        cashoutMap[day] = Number(row.get("count") || 0);
        cashoutAmountMap[day] = Number(row.get("amount") || 0);
      }

      const cashierDays = dayList.map((day) => ({
        day,
        issued: issuedMap[day] || 0,
        redeemed: redeemedMap[day] || 0,
        expired: expiredMap[day] || 0,
        cashedOut: cashoutMap[day] || 0,
        cashedOutAmount: cashoutAmountMap[day] || 0,
      }));

      const staffIds = new Set();
      const addStaffId = (value) => {
        const id = normalizeStaffId(value);
        if (id) staffIds.add(id);
      };
      for (const intent of deposits) {
        addStaffId(intent?.metadata?.markedByStaffId);
      }
      for (const intent of withdrawals) {
        addStaffId(intent?.metadata?.markedByStaffId);
      }
      for (const voucher of redeemedVoucherRows) {
        const metadata = asObject(voucher?.metadata);
        addStaffId(metadata.redeemedByStaffId || metadata.activatedByStaffId);
      }
      for (const tx of cashoutTxDetailRows) {
        const metadata = asObject(tx?.metadata);
        addStaffId(
          metadata.cashoutByStaffId ||
            metadata.terminatedByStaffId ||
            metadata.deactivatedByStaffId ||
            metadata.markedByStaffId
        );
      }

      const staffRoles = {};
      if (staffIds.size) {
        const staffRows = await StaffUser.findAll({
          where: { id: Array.from(staffIds) },
          attributes: ["id", "role"],
        });
        for (const staff of staffRows) {
          staffRoles[staff.id] = staff.role;
        }
      }

      const supportTimes = [];
      const cashierTimes = [];
      const unknownTimes = [];

      const addResolution = (createdAtRaw, resolvedAtRaw, staffIdRaw) => {
        const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
        const resolved = resolvedAtRaw ? new Date(resolvedAtRaw) : null;
        if (!createdAt || !resolved || Number.isNaN(createdAt.getTime()) || Number.isNaN(resolved.getTime())) {
          return;
        }
        if (resolved < createdAt) return;
        const minutes = Math.max(0, (resolved - createdAt) / 60000);
        const staffId = normalizeStaffId(staffIdRaw);
        const role = staffId ? staffRoles[staffId] : null;
        if (role === "cashier") {
          cashierTimes.push(minutes);
        } else if (role) {
          supportTimes.push(minutes);
        } else {
          unknownTimes.push(minutes);
        }
      };

      const voucherIdsForCashoutResolution = Array.from(
        new Set(
          cashoutTxDetailRows
            .map((tx) => {
              const metadata = asObject(tx?.metadata);
              return metadata.voucherId ? String(metadata.voucherId) : null;
            })
            .filter(Boolean)
        )
      );

      let cashoutResolutionVouchers = [];
      if (voucherIdsForCashoutResolution.length) {
        cashoutResolutionVouchers = await Voucher.findAll({
          where: {
            id: { [Op.in]: voucherIdsForCashoutResolution },
          },
          attributes: ["id", "createdAt", "redeemedAt", "metadata"],
        });
      }
      const cashoutVoucherMap = new Map(
        cashoutResolutionVouchers.map((voucher) => [String(voucher.id), voucher])
      );

      const addIntentResolution = (intent, resolvedAt) => {
        const createdAt = intent.createdAt ? new Date(intent.createdAt) : null;
        const resolved = resolvedAt ? new Date(resolvedAt) : null;
        if (!createdAt || !resolved || Number.isNaN(createdAt.getTime()) || Number.isNaN(resolved.getTime())) {
          return;
        }
        addResolution(createdAt, resolved, intent?.metadata?.markedByStaffId);
      };

      deposits.forEach((intent) => addIntentResolution(intent, intent.creditedAt));
      withdrawals.forEach((intent) => addIntentResolution(intent, intent.sentAt));

      for (const voucher of redeemedVoucherRows) {
        const metadata = asObject(voucher?.metadata);
        addResolution(
          voucher.createdAt,
          voucher.redeemedAt,
          metadata.redeemedByStaffId || metadata.activatedByStaffId
        );
      }

      for (const tx of cashoutTxDetailRows) {
        const metadata = asObject(tx?.metadata);
        const voucherId = metadata.voucherId ? String(metadata.voucherId) : null;
        const voucher = voucherId ? cashoutVoucherMap.get(voucherId) : null;
        const cashoutStartedAt =
          voucher?.redeemedAt ||
          voucher?.createdAt ||
          metadata.redeemedAt ||
          metadata.voucherRedeemedAt ||
          null;
        addResolution(
          cashoutStartedAt,
          tx.createdAt,
          metadata.cashoutByStaffId ||
            metadata.terminatedByStaffId ||
            metadata.deactivatedByStaffId ||
            metadata.markedByStaffId
        );
      }

      res.json({
        ok: true,
        period: { start, end, label: `${start} → ${end}` },
        systemHealth: {
          staleMinutes: FAILED_BET_STALE_MINUTES,
          days: systemDays,
        },
        cashierPerformance: {
          days: cashierDays,
          totals: cashierDays.reduce(
            (acc, day) => {
              acc.issued += day.issued;
              acc.redeemed += day.redeemed;
              acc.expired += day.expired;
              acc.cashedOut += day.cashedOut;
              acc.cashedOutAmount += day.cashedOutAmount;
              return acc;
            },
            { issued: 0, redeemed: 0, expired: 0, cashedOut: 0, cashedOutAmount: 0 }
          ),
        },
        resolution: {
          units: "minutes",
          categories: [
            { name: "Support", ...summarizeDistribution(supportTimes) },
            { name: "Cashier", ...summarizeDistribution(cashierTimes) },
            { name: "Unattributed", ...summarizeDistribution(unknownTimes) },
          ],
        },
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_OPERATIONS] error:", err);
      res.status(500).json({ ok: false, error: "Failed to build operations report" });
    }
  }
);

// GET /admin/reports/performance?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/performance",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    let range;
    try {
      range = buildDateRange(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { start, end, startDate, endDateExclusive } = range;
    const dayList = buildDayList(startDate, endDateExclusive);

    try {
      const [gameAggRows, spinRows, volatilityRows] = await Promise.all([
        GameRound.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            ["gameId", "gameId"],
            [fn("COUNT", literal("*")), "rounds"],
            [fn("SUM", col("betAmount")), "totalBet"],
            [fn("SUM", col("winAmount")), "totalWin"],
          ],
          group: ["gameId"],
        }).catch((err) => {
          console.warn("[REPORTS] GameRound RTP aggregate failed:", err.message);
          return [];
        }),
        GameRound.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            [literal(`DATE("createdAt")`), "day"],
            [fn("COUNT", literal("*")), "spins"],
          ],
          group: [literal(`DATE("createdAt")`)],
          order: [[literal(`DATE("createdAt")`), "ASC"]],
        }).catch((err) => {
          console.warn("[REPORTS] GameRound spin volume failed:", err.message);
          return [];
        }),
        GameRound.findAll({
          where: {
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: [
            ["gameId", "gameId"],
            [literal(`DATE("createdAt")`), "day"],
            [fn("COUNT", literal("*")), "rounds"],
            [literal('SUM("winAmount" - "betAmount")'), "sumNet"],
            [
              literal(
                'SUM(("winAmount" - "betAmount") * ("winAmount" - "betAmount"))'
              ),
              "sumSquares",
            ],
          ],
          group: ["gameId", literal(`DATE("createdAt")`)],
          order: [[literal(`DATE("createdAt")`), "ASC"]],
        }).catch((err) => {
          console.warn("[REPORTS] GameRound volatility aggregate failed:", err.message);
          return [];
        }),
      ]);

      let txFallback = null;
      const needsTxFallback =
        !(gameAggRows || []).length || !(spinRows || []).length || !(volatilityRows || []).length;

      if (needsTxFallback) {
        const txRows = await Transaction.findAll({
          where: {
            type: { [Op.in]: ["game_bet", "game_win"] },
            createdAt: {
              [Op.gte]: startDate,
              [Op.lt]: endDateExclusive,
            },
          },
          attributes: ["type", "amount", "createdAt", "reference", "metadata"],
        }).catch((err) => {
          console.warn("[REPORTS] Transaction fallback aggregate failed:", err.message);
          return [];
        });

        if ((txRows || []).length) {
          const byGame = new Map();
          const spinsByDay = {};
          const volatilityStats = new Map();

          for (const tx of txRows) {
            const gameId = extractGameIdFromTransaction(tx);
            if (!gameId) continue;

            const txType = tx.type || tx.get?.("type");
            const amountRaw = tx.amount ?? tx.get?.("amount");
            const amount = Math.abs(Number(amountRaw || 0));
            if (!Number.isFinite(amount)) continue;

            const day = toDay(tx.createdAt || tx.get?.("createdAt"));
            if (!day) continue;

            const existing = byGame.get(gameId) || {
              gameId,
              rounds: 0,
              txCount: 0,
              totalBet: 0,
              totalWin: 0,
            };
            existing.txCount += 1;

            if (txType === "game_bet") {
              existing.totalBet += amount;
              existing.rounds += 1;
              spinsByDay[day] = (spinsByDay[day] || 0) + 1;
            } else if (txType === "game_win") {
              existing.totalWin += amount;
            }
            byGame.set(gameId, existing);

            const sampleNet =
              txType === "game_win" ? amount : txType === "game_bet" ? -amount : null;
            if (sampleNet == null) continue;

            const volKey = `${gameId}__${day}`;
            const volExisting = volatilityStats.get(volKey) || {
              day,
              gameId,
              rounds: 0,
              sumNet: 0,
              sumSquares: 0,
            };
            volExisting.rounds += 1;
            volExisting.sumNet += sampleNet;
            volExisting.sumSquares += sampleNet * sampleNet;
            volatilityStats.set(volKey, volExisting);
          }

          txFallback = {
            byGame: Array.from(byGame.values()).map((entry) => ({
              gameId: entry.gameId,
              rounds: entry.rounds || entry.txCount || 0,
              totalBet: entry.totalBet || 0,
              totalWin: entry.totalWin || 0,
            })),
            spinsByDay,
            volatilityStats: Array.from(volatilityStats.values()),
          };
        }
      }

      const rtpByGame = ((gameAggRows || []).length
        ? (gameAggRows || []).map((row) => {
            const gameId = row.get("gameId") || row.gameId;
            const rounds = Number(row.get("rounds") || 0);
            const totalBet = Number(row.get("totalBet") || 0);
            const totalWin = Number(row.get("totalWin") || 0);
            const actualRtp = totalBet > 0 ? totalWin / totalBet : 0;
            const expectedRtp = getExpectedRtp(gameId);
            return {
              gameId,
              rounds,
              totalBet,
              totalWin,
              actualRtp,
              expectedRtp,
              deviation: actualRtp - expectedRtp,
            };
          })
        : (txFallback?.byGame || []).map((row) => {
            const gameId = row.gameId;
            const rounds = Number(row.rounds || 0);
            const totalBet = Number(row.totalBet || 0);
            const totalWin = Number(row.totalWin || 0);
            const actualRtp = totalBet > 0 ? totalWin / totalBet : 0;
            const expectedRtp = getExpectedRtp(gameId);
            return {
              gameId,
              rounds,
              totalBet,
              totalWin,
              actualRtp,
              expectedRtp,
              deviation: actualRtp - expectedRtp,
            };
          }))
        .filter((row) => row.gameId)
        .sort((a, b) => b.totalBet - a.totalBet);

      const spinMap = {};
      if ((spinRows || []).length) {
        for (const row of spinRows || []) {
          const day = toDay(row.get("day"));
          if (!day) continue;
          spinMap[day] = Number(row.get("spins") || 0);
        }
      } else if (txFallback?.spinsByDay) {
        Object.assign(spinMap, txFallback.spinsByDay);
      }

      const spinDays = dayList.map((day) => ({
        day,
        spins: spinMap[day] || 0,
      }));

      let maxVolatility = 0;
      const volatilityCells = [];
      const volatilitySourceRows =
        (volatilityRows || []).length ? volatilityRows : txFallback?.volatilityStats || [];
      for (const row of volatilitySourceRows) {
        const day = toDay(row.get ? row.get("day") : row.day);
        const gameId = row.get ? row.get("gameId") || row.gameId : row.gameId;
        if (!day || !gameId) continue;
        const rounds = Number(row.get ? row.get("rounds") : row.rounds || 0);
        const sumNet = Number(row.get ? row.get("sumNet") : row.sumNet || 0);
        const sumSquares = Number(row.get ? row.get("sumSquares") : row.sumSquares || 0);
        let volatility = 0;
        if (rounds > 0) {
          const mean = sumNet / rounds;
          const variance = sumSquares / rounds - mean * mean;
          volatility = variance > 0 ? Math.sqrt(variance) : 0;
        }
        if (volatility > maxVolatility) maxVolatility = volatility;
        volatilityCells.push({
          day,
          gameId,
          volatility,
          rounds,
        });
      }

      const volatilityGameList = rtpByGame.length
        ? rtpByGame.map((game) => String(game.gameId))
        : Array.from(new Set(volatilityCells.map((cell) => String(cell.gameId))));

      res.json({
        ok: true,
        period: { start, end, label: `${start} → ${end}` },
        rtpByGame: {
          games: rtpByGame,
        },
        volatility: {
          days: dayList,
          games: volatilityGameList,
          cells: volatilityCells,
          max: maxVolatility,
        },
        spinVolume: {
          days: spinDays,
        },
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_PERFORMANCE] error:", err);
      res.status(500).json({ ok: false, error: "Failed to build performance report" });
    }
  }
);

// GET /admin/reports/daily?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/daily",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    let range;
    try {
      range = buildDateRange(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { start, end, startDate, endDateExclusive } = range;

    try {
      const depositTypes = ["credit", "voucher_credit"];
      const withdrawalTypes = ["debit", "voucher_debit"];
      const queryTypes = [
        ...depositTypes,
        ...withdrawalTypes,
        "game_bet",
        "game_win",
        "manual_adjustment",
      ];

      const rows = await Transaction.findAll({
        where: {
          createdAt: {
            [Op.gte]: startDate,
            [Op.lt]: endDateExclusive,
          },
          type: { [Op.in]: queryTypes },
        },
        attributes: [
          [literal(`DATE("createdAt")`), "day"],
          "type",
          [fn("SUM", col("amount")), "totalAmount"],
        ],
        group: [literal(`DATE("createdAt")`), "type"],
        order: [[literal(`DATE("createdAt")`), "ASC"]],
      });

      const dayList = buildDayList(startDate, endDateExclusive);
      const byDay = Object.fromEntries(
        dayList.map((day) => [
          day,
          { day, deposits: 0, withdrawals: 0, gameBet: 0, gameWin: 0 },
        ])
      );

      for (const r of rows) {
        const day = toDay(r.get("day"));
        if (!day) continue;
        const type = r.type;
        const amt = Number(r.get("totalAmount") || 0);
        const entry = byDay[day];
        if (!entry) continue;

        if (depositTypes.includes(type)) entry.deposits += amt;
        if (withdrawalTypes.includes(type)) entry.withdrawals += amt;
        if (type === "manual_adjustment") {
          if (amt >= 0) entry.deposits += amt;
          else entry.withdrawals += Math.abs(amt);
        }
        if (type === "game_bet") entry.gameBet += Math.abs(amt);
        if (type === "game_win") entry.gameWin += Math.abs(amt);
      }

      const days = dayList.map((day) => {
        const entry = byDay[day];
        return {
          ...entry,
          netGame: entry.gameBet - entry.gameWin,
          netCashflow: entry.deposits - entry.withdrawals,
        };
      });

      res.json({
        ok: true,
        period: { start, end },
        days,
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_DAILY] error:", err);
      res.status(500).json({ ok: false, error: "Failed to build daily report" });
    }
  }
);

module.exports = router;
