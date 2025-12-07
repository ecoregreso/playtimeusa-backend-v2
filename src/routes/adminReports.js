// src/routes/adminReports.js
const express = require("express");
const router = express.Router();
const { Op, fn, col, literal } = require("sequelize");

const {
  sequelize,
  User,
  Voucher,
  Transaction,
  GameRound,
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
  const qsStart = parseDateOnly(req.query.start);
  const qsEnd = parseDateOnly(req.query.end);

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
            "gameCode",
            [fn("COUNT", literal("*")), "rounds"],
            [fn("COUNT", fn("DISTINCT", col("userId"))), "uniquePlayers"],
            [fn("SUM", col("betAmount")), "totalBet"],
            [fn("SUM", col("winAmount")), "totalWin"],
            [fn("SUM", col("net")), "ggr"],
          ],
          group: ["gameCode"],
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
        // If you want exact, you can add another query by GameRound.userId.
      }

      // A more accurate "active from games" query:
      const gamePlayersRaw = await GameRound.findAll({
        where: {
          createdAt: {
            [Op.gte]: startDate,
            [Op.lt]: endDateExclusive,
          },
        },
        attributes: [[fn("DISTINCT", col("userId")), "userId"]],
      }).catch((err) => {
        console.warn(
          "[REPORTS] GameRound active players query failed:",
          err.message
        );
        return [];
      });

      let activeFromGames = 0;
      for (const row of gamePlayersRaw) {
        const id = row.get("userId");
        if (id) {
          activeSet.add(String(id));
          activeFromGames++;
        }
      }

      const playersStats = {
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
        game: g.gameCode,
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

      const result = {
        period: {
          start,
          end,
          label: `${start} → ${end}`,
        },
        vouchers: {
          issued: issuedStats,
          redeemed: redeemedStats,
          breakage: breakageStats,
        },
        players: playersStats,
        transactions: {
          aggregates: txAggregates,
          byType,
        },
        games: gamesBlock,
      };

      res.json(result);
    } catch (err) {
      console.error("[ADMIN_REPORTS_RANGE] error:", err);
      res.status(500).json({ error: "Failed to build range report" });
    }
  }
);

// Optional: daily rollup endpoint (not used by your current UI yet)
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
      // Example: daily net game from transactions (game_bet - game_win)
      const rows = await Transaction.findAll({
        where: {
          createdAt: {
            [Op.gte]: startDate,
            [Op.lt]: endDateExclusive,
          },
          type: { [Op.in]: ["game_bet", "game_win"] },
        },
        attributes: [
          [literal(`DATE("createdAt")`), "day"],
          "type",
          [fn("SUM", col("amount")), "totalAmount"],
        ],
        group: [literal(`DATE("createdAt")`), "type"],
        order: [[literal(`DATE("createdAt")`), "ASC"]],
      });

      const byDay = {};

      for (const r of rows) {
        const day = r.get("day");
        const type = r.type;
        const amt = Number(r.get("totalAmount") || 0);

        if (!byDay[day]) {
          byDay[day] = {
            date: day,
            gameBet: 0,
            gameWin: 0,
          };
        }

        if (type === "game_bet") byDay[day].gameBet += amt;
        if (type === "game_win") byDay[day].gameWin += amt;
      }

      const days = Object.values(byDay).map((d) => ({
        ...d,
        netGame: d.gameBet - d.gameWin,
      }));

      res.json({
        period: { start, end },
        days,
      });
    } catch (err) {
      console.error("[ADMIN_REPORTS_DAILY] error:", err);
      res.status(500).json({ error: "Failed to build daily report" });
    }
  }
);

module.exports = router;
