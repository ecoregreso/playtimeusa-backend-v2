// src/routes/vouchers.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Op } = require("sequelize");
const { sequelize } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { staffAuth } = require("../middleware/staffAuth");
const { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } = require("../constants/permissions");
const {
  Voucher,
  Wallet,
  Transaction,
  User,
  Session,
  RefreshToken,
  TenantVoucherPool,
  TenantWallet,
  StaffUser,
} = require("../models");
const { generateVoucherQrPng } = require("../utils/qr");
const { getJson } = require("../utils/ownerSettings");
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");
const { resolveVoucherMaxCashout } = require("../services/voucherOutcomeService");
const {
  WIN_CAP_MODES,
  DEFAULT_VOUCHER_WIN_CAP_POLICY,
  normalizeVoucherWinCapPolicy,
  resolveVoucherWinCapSelection,
  computeMaxCashoutFromPercent,
} = require("../services/voucherWinCapPolicyService");
const {
  OUTCOME_MODES,
  DEFAULT_OUTCOME_MODE,
  normalizeOutcomeMode,
  isVoucherControlledOutcomeMode,
} = require("../services/outcomeModeService");
const { applyPendingBonusIfEligible, buildBonusState } = require("../services/bonusService");
const { logEvent } = require("../services/auditService");
const { emitSecurityEvent, maskCode } = require("../lib/security/events");
const { buildLimiter } = require("../utils/rateLimit");
const { getLock, recordFailure, recordSuccess } = require("../utils/lockout");
const { normalizeTenantIdentifier, resolveTenantUuid } = require("../services/tenantIdentifierService");

const router = express.Router();

const redeemLimiter = buildLimiter({ windowMs: 15 * 60 * 1000, max: 30, message: "Too many voucher redeem attempts" });

function toMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function normalizeStaffId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireStaffRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.staff.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

function getStaffPermissions(staff) {
  if (Array.isArray(staff?.permissions)) return staff.permissions;
  const role = staff?.role || null;
  return ROLE_DEFAULT_PERMISSIONS[role] || [];
}

function requireStaffPermission(permission) {
  return (req, res, next) => {
    const perms = getStaffPermissions(req.staff);
    if (!perms.includes(permission)) {
      return res.status(403).json({ error: "Forbidden: insufficient permissions" });
    }
    return next();
  };
}

const SYSTEM_CONFIG_KEY = "system_config";
function tenantConfigKey(tenantId) {
  return `tenant:${tenantId}:config`;
}

const DEFAULT_SYSTEM_CONFIG = {
  maintenanceMode: false,
  purchaseOrdersEnabled: true,
  vouchersEnabled: true,
  depositsEnabled: true,
  withdrawalsEnabled: true,
  messagingEnabled: true,
  pushEnabled: true,
  outcomeMode: DEFAULT_OUTCOME_MODE,
  voucherWinCapPolicy: { ...DEFAULT_VOUCHER_WIN_CAP_POLICY },
};

async function getEffectiveConfig(tenantId) {
  const system = await getJson(SYSTEM_CONFIG_KEY, DEFAULT_SYSTEM_CONFIG);
  if (!tenantId) {
    const effectiveNoTenant = { ...DEFAULT_SYSTEM_CONFIG, ...(system || {}) };
    effectiveNoTenant.outcomeMode = normalizeOutcomeMode(
      effectiveNoTenant.outcomeMode,
      DEFAULT_OUTCOME_MODE
    );
    effectiveNoTenant.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(
      effectiveNoTenant.voucherWinCapPolicy
    );
    return effectiveNoTenant;
  }
  const tenant = await getJson(tenantConfigKey(tenantId), {});
  const effective = { ...DEFAULT_SYSTEM_CONFIG, ...(system || {}), ...(tenant || {}) };
  effective.outcomeMode = normalizeOutcomeMode(effective.outcomeMode, DEFAULT_OUTCOME_MODE);
  effective.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(
    effective.voucherWinCapPolicy
  );
  return effective;
}

async function resolveTenantId(req) {
  if (req.staff?.role !== "owner") {
    return req.staff?.tenantId || null;
  }
  const raw = req.query?.tenantId || req.body?.tenantId || req.staff?.tenantId || null;
  const tenantIdentifier = normalizeTenantIdentifier(raw);
  if (!tenantIdentifier) return null;
  return resolveTenantUuid(tenantIdentifier);
}

function sanitizeVoucher(voucher) {
  const safe = voucher.toJSON ? voucher.toJSON() : { ...voucher };
  if (safe && typeof safe === "object") {
    delete safe.pin;
  }
  return safe;
}

function enforceVouchersEnabled() {
  return async (req, res, next) => {
    try {
      const tenantId = await resolveTenantId(req);
      const cfg = await getEffectiveConfig(tenantId);
      req.effectiveConfig = cfg;
      if (cfg.maintenanceMode && req.staff?.role !== "owner") {
        return res.status(503).json({ error: "System is in maintenance mode" });
      }
      if (!cfg.vouchersEnabled && req.staff?.role !== "owner") {
        return res.status(403).json({ error: "Vouchers are currently disabled" });
      }
      return next();
    } catch (err) {
      console.error("[VOUCHERS] config gate error:", err);
      return res.status(500).json({ error: "Failed to load tenant config" });
    }
  };
}

function randomNumeric(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out;
}

function computeVoucherMaxCashout({
  amount,
  bonusAmount,
  requestedMaxCashout,
  requestedWinCapMode,
  requestedWinCapPercent,
  policyRaw,
}) {
  const normalizedPolicy = normalizeVoucherWinCapPolicy(policyRaw);
  const totalCredit = Number(amount || 0) + Number(bonusAmount || 0);

  if (requestedMaxCashout != null) {
    return {
      maxCashout: resolveVoucherMaxCashout(
        {
          amount,
          bonusAmount,
          maxCashout: requestedMaxCashout,
          totalCredit,
        },
        totalCredit
      ),
      capMode: "manual_amount",
      capPercent: null,
      capSource: "request_manual",
      normalizedPolicy,
    };
  }

  const selection = resolveVoucherWinCapSelection({
    policyRaw: normalizedPolicy,
    mode: requestedWinCapMode,
    percent: requestedWinCapPercent,
  });

  return {
    maxCashout: computeMaxCashoutFromPercent({
      amount,
      bonusAmount,
      selectedPercent: selection.selectedPercent,
    }),
    capMode: selection.mode,
    capPercent: selection.selectedPercent,
    capSource: selection.source,
    normalizedPolicy: selection.policy,
  };
}

async function getOrCreateWallet(userId, tenantId, currency = "FUN", transaction = undefined) {
  let wallet = await Wallet.findOne({
    where: { userId, tenantId, currency },
    transaction,
  });

  if (!wallet) {
    wallet = await Wallet.create({
      userId,
      tenantId,
      currency,
      balance: 0,
      bonusPending: 0,
      bonusUnacked: 0,
    }, { transaction });
  }

  return wallet;
}

async function creditVoucherToWallet({
  voucher,
  userId,
  staff,
  transaction,
  effectiveOutcomeMode = DEFAULT_OUTCOME_MODE,
}) {
  const t = transaction;
  const currency = voucher.currency || "FUN";
  const wallet = await getOrCreateWallet(userId, voucher.tenantId, currency, t);
  const amount = Number(voucher.amount || 0);
  const bonus = Number(voucher.bonusAmount || 0);
  const before = Number(wallet.balance || 0);
  const normalizedOutcomeMode = normalizeOutcomeMode(
    effectiveOutcomeMode,
    DEFAULT_OUTCOME_MODE
  );
  const outcomesControlledByVoucher = isVoucherControlledOutcomeMode(
    normalizedOutcomeMode
  );
  const maxCashout = outcomesControlledByVoucher
    ? resolveVoucherMaxCashout(voucher, amount + bonus)
    : 0;

  wallet.balance = before + amount;
  wallet.bonusPending = Number(wallet.bonusPending || 0) + bonus;
  wallet.activeVoucherId = voucher.id;
  await wallet.save({ transaction: t });

  await Transaction.create(
    {
      tenantId: voucher.tenantId,
      walletId: wallet.id,
      type: "voucher_credit",
      amount,
      balanceBefore: before,
      balanceAfter: wallet.balance,
      reference: `voucher:${voucher.code}`,
      metadata: {
        voucherId: voucher.id,
        bonusPending: bonus,
        maxCashout,
        outcomeMode: normalizedOutcomeMode,
        outcomesControlledByVoucher,
        activeVoucherId: voucher.id,
        redeemedByStaffId: staff?.id || null,
        redeemerRole: staff?.role || null,
      },
      createdByUserId: staff?.id || null,
    },
    { transaction: t }
  );

  const bonusResult = await applyPendingBonusIfEligible({
    wallet,
    transaction: t,
    reference: `bonus:${voucher.code}:redeem`,
    metadata: { voucherId: voucher.id, redeemedByStaffId: staff?.id || null },
  });

  voucher.status = "redeemed";
  voucher.redeemedAt = new Date();
  voucher.redeemedByUserId = userId;
  const priorPolicy =
    voucher.metadata && voucher.metadata.voucherPolicy && typeof voucher.metadata.voucherPolicy === "object"
      ? voucher.metadata.voucherPolicy
      : {};
  voucher.maxCashout = maxCashout;
  const nextVoucherPolicy = outcomesControlledByVoucher
    ? {
        ...priorPolicy,
        maxCashout,
        capReachedAt: priorPolicy.capReachedAt || null,
        decayMode: Boolean(priorPolicy.decayMode),
        decayRounds: Math.max(0, Number(priorPolicy.decayRounds || 0)),
        decayRate: Number(priorPolicy.decayRate || DEFAULT_VOUCHER_WIN_CAP_POLICY.decayRate),
        minDecayAmount: Number(
          priorPolicy.minDecayAmount || DEFAULT_VOUCHER_WIN_CAP_POLICY.minDecayAmount
        ),
        stakeDecayMultiplier: Number(
          priorPolicy.stakeDecayMultiplier || DEFAULT_VOUCHER_WIN_CAP_POLICY.stakeDecayMultiplier
        ),
        trackedBalance: Number(priorPolicy.trackedBalance || amount),
      }
    : {
        ...priorPolicy,
        maxCashout: 0,
        capReachedAt: null,
        decayMode: false,
        decayRounds: 0,
        trackedBalance: null,
        lastMode: OUTCOME_MODES.PURE_RNG,
      };
  voucher.metadata = {
    ...(voucher.metadata || {}),
    maxCashout,
    voucherPolicy: nextVoucherPolicy,
    outcomeMode: normalizedOutcomeMode,
    outcomesControlledByVoucher,
    capStrategy: outcomesControlledByVoucher
      ? voucher.metadata?.capStrategy
      : { mode: OUTCOME_MODES.PURE_RNG, percent: null, source: "outcome_mode" },
    redeemedByStaffId: staff?.id || null,
    redeemedByRole: staff?.role || null,
  };
  await voucher.save({ transaction: t });

  return { wallet, bonusResult };
}

// GET /vouchers/qr/:id.png (admin) – serve QR by voucher id
router.get(
  "/qr/:id.png",
  staffAuth,
  requireStaffRole("owner", "operator", "agent", "distributor", "cashier"),
  requireStaffPermission(PERMISSIONS.VOUCHER_READ),
  async (req, res) => {
    try {
      const voucher = await Voucher.findByPk(req.params.id);
      if (!voucher) {
        return res.status(404).json({ error: "Voucher not found" });
      }

      let qrPath = voucher.metadata?.qrPath || null;
      if (!qrPath) {
        try {
          qrPath = await generateVoucherQrPng({
            code: voucher.code,
            pin: voucher.pin,
            userCode: voucher.metadata?.userCode || null,
          });
          voucher.metadata = { ...(voucher.metadata || {}), qrPath };
          await voucher.save();
        } catch (qrErr) {
          console.error("[VOUCHERS] QR generation failed:", qrErr);
          return res.status(500).json({ error: "Failed to generate QR" });
        }
      }

      const projectRoot = path.resolve(__dirname, "..", "..");
      const qrRoot = path.resolve(projectRoot, "exports", "qr");
      const resolved = path.resolve(projectRoot, qrPath);
      if (!resolved.startsWith(`${qrRoot}${path.sep}`)) {
        return res.status(400).json({ error: "Invalid QR path" });
      }

      await fs.promises.access(resolved);
      return res.sendFile(resolved);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return res.status(404).json({ error: "QR not found" });
      }
      console.error("[VOUCHERS] GET /qr error:", err);
      return res.status(500).json({ error: "Failed to load QR" });
    }
  }
);

// GET /vouchers (admin) – list latest vouchers
router.get(
  "/",
  staffAuth,
  requireStaffRole("owner", "operator", "agent", "distributor", "cashier"),
  requireStaffPermission(PERMISSIONS.VOUCHER_READ),
  enforceVouchersEnabled(),
  async (req, res) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit || "200", 10),
        500
      );
      const tenantId = await resolveTenantId(req);
      const where = tenantId ? { tenantId } : undefined;

      const vouchers = await Voucher.findAll({
        ...(where ? { where } : {}),
        order: [["createdAt", "DESC"]],
        limit,
      });

      const redeemedUserIds = Array.from(
        new Set(
          vouchers
            .map((voucher) =>
              voucher?.redeemedByUserId ? String(voucher.redeemedByUserId) : ""
            )
            .filter(Boolean)
        )
      );
      const walletRows = redeemedUserIds.length
        ? await Wallet.findAll({
            where: {
              userId: { [Op.in]: redeemedUserIds },
              ...(tenantId ? { tenantId } : {}),
            },
            attributes: ["id", "userId", "tenantId", "currency", "balance", "activeVoucherId"],
          })
        : [];
      const walletsByUserId = new Map();
      walletRows.forEach((wallet) => {
        const row = wallet.toJSON ? wallet.toJSON() : { ...wallet };
        const userId = row?.userId ? String(row.userId) : "";
        if (!userId) return;
        if (!walletsByUserId.has(userId)) walletsByUserId.set(userId, []);
        walletsByUserId.get(userId).push(row);
      });

      const staffIds = new Set();
      vouchers.forEach((voucher) => {
        const metadata = voucher.metadata && typeof voucher.metadata === "object"
          ? voucher.metadata
          : {};
        const creatorId = normalizeStaffId(
          voucher.createdByUserId || metadata.createdByStaffId || metadata.voucherCreatedByStaffId
        );
        const cashoutById = normalizeStaffId(
          metadata.cashoutByStaffId || metadata.terminatedByStaffId
        );
        if (creatorId) staffIds.add(creatorId);
        if (cashoutById) staffIds.add(cashoutById);
      });

      const staffRows = staffIds.size
        ? await StaffUser.findAll({
            where: {
              id: { [Op.in]: Array.from(staffIds) },
              ...(tenantId ? { tenantId } : {}),
            },
            attributes: ["id", "username", "role"],
          })
        : [];
      const staffMap = new Map(
        staffRows.map((staff) => [
          staff.id,
          { id: staff.id, username: staff.username, role: staff.role },
        ])
      );

      // Normalize status casing for front-end filters
      const normalized = vouchers.map((voucher) => {
        const data = voucher.toJSON ? voucher.toJSON() : { ...voucher };
        const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
        const status = String(data.status || "").toLowerCase();
        const voucherId = data.id ? String(data.id) : "";
        const redeemedUserId = data.redeemedByUserId ? String(data.redeemedByUserId) : "";
        const walletCandidates = redeemedUserId ? walletsByUserId.get(redeemedUserId) || [] : [];
        const matchedWallet =
          walletCandidates.find((w) => String(w.activeVoucherId || "") === voucherId) ||
          walletCandidates.find(
            (w) =>
              String(w.currency || "").toUpperCase() === String(data.currency || "").toUpperCase()
          ) ||
          walletCandidates[0] ||
          null;
        const isWalletLinkedToVoucher =
          matchedWallet && String(matchedWallet.activeVoucherId || "") === voucherId;
        const finalAmountSettled = toMoney(
          metadata.finalAmountSettled ?? metadata.cashoutAmount ?? 0
        );
        const currentVoucherValue = toMoney(
          status === "terminated"
            ? finalAmountSettled
            : isWalletLinkedToVoucher || status === "redeemed"
            ? Math.max(0, toMoney(matchedWallet?.balance || 0))
            : 0
        );
        const createdByStaffId = normalizeStaffId(
          data.createdByUserId || metadata.createdByStaffId || metadata.voucherCreatedByStaffId
        );
        const cashoutByStaffId = normalizeStaffId(
          metadata.cashoutByStaffId || metadata.terminatedByStaffId
        );
        const deactivatedByStaffId = normalizeStaffId(
          metadata.deactivatedByStaffId || metadata.terminatedByStaffId || metadata.cashoutByStaffId
        );

        return {
          ...data,
          status,
          createdByStaffId,
          createdByStaff: createdByStaffId ? staffMap.get(createdByStaffId) || null : null,
          currentVoucherValue,
          finalAmountSettled: status === "terminated" ? finalAmountSettled : 0,
          finalAmountSettledAt:
            metadata.finalAmountSettledAt || metadata.cashoutAt || metadata.terminatedAt || null,
          voucherLedgerRows: [
            {
              key: "current_voucher_value",
              label: "Current Voucher Value",
              amount: currentVoucherValue,
            },
            ...(status === "terminated"
              ? [
                  {
                    key: "final_amount_settled",
                    label: "Final Amount Settled",
                    amount: finalAmountSettled,
                    at:
                      metadata.finalAmountSettledAt ||
                      metadata.cashoutAt ||
                      metadata.terminatedAt ||
                      null,
                  },
                ]
              : []),
          ],
          cashoutAmount: toMoney(metadata.cashoutAmount || 0),
          cashoutAt: metadata.cashoutAt || metadata.terminatedAt || null,
          cashoutByStaffId,
          cashoutByStaff: cashoutByStaffId ? staffMap.get(cashoutByStaffId) || null : null,
          cashoutTransactionId: metadata.cashoutTransactionId || null,
          cashoutBalanceBefore: toMoney(metadata.cashoutBalanceBefore || 0),
          cashoutBonusPendingVoided: toMoney(metadata.cashoutBonusPendingVoided || 0),
          profileDeactivated: Boolean(metadata.profileDeactivated),
          deactivatedAt: metadata.deactivatedAt || null,
          deactivatedReason: metadata.deactivatedReason || metadata.terminatedReason || null,
          deactivatedByStaffId,
          deactivatedByStaff: deactivatedByStaffId ? staffMap.get(deactivatedByStaffId) || null : null,
          revokedSessionCount: Number(metadata.revokedSessionCount || 0),
          revokedRefreshTokenCount: Number(metadata.revokedRefreshTokenCount || 0),
        };
      });

      return res.json(normalized);
    } catch (err) {
      console.error("[VOUCHERS] GET / error:", err);
      return res.status(500).json({ error: "Failed to list vouchers" });
    }
  }
);

// POST /vouchers (admin) – create voucher + PIN + userCode + QR
router.post(
  "/",
  staffAuth,
  requireStaffRole("owner", "operator", "agent", "distributor", "cashier"),
  requireStaffPermission(PERMISSIONS.VOUCHER_WRITE),
  enforceVouchersEnabled(),
  async (req, res) => {
    let tenantId = req.staff?.tenantId || null;
    try {
      const { amount, bonusAmount, currency, maxCashout, winCapMode, winCapPercent } = req.body;

      const valueAmount = Number(amount || 0);
      const valueBonus = Number(bonusAmount || 0);
      const valueMaxCashoutRaw =
        maxCashout === undefined || maxCashout === null || maxCashout === ""
          ? null
          : Number(maxCashout);
      const valueWinCapPercentRaw =
        winCapPercent === undefined || winCapPercent === null || winCapPercent === ""
          ? null
          : Number(winCapPercent);
      const valueWinCapMode =
        winCapMode === undefined || winCapMode === null || winCapMode === ""
          ? null
          : String(winCapMode);
      const normalizedOutcomeMode = normalizeOutcomeMode(
        req.effectiveConfig?.outcomeMode,
        DEFAULT_OUTCOME_MODE
      );
      const outcomesControlledByVoucher = isVoucherControlledOutcomeMode(
        normalizedOutcomeMode
      );

      if (!Number.isFinite(valueAmount) || valueAmount <= 0) {
        await logEvent({
          eventType: "VOUCHER_ISSUE",
          success: false,
          tenantId: req.staff?.tenantId || null,
          requestId: req.requestId,
          actorType: "staff",
          actorId: req.staff?.id || null,
          actorRole: req.staff?.role || null,
          actorUsername: req.staff?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "invalid_amount", amount, bonusAmount, currency },
        });
        return res.status(400).json({ error: "Invalid amount" });
      }

      if (
        outcomesControlledByVoucher &&
        valueMaxCashoutRaw !== null &&
        (!Number.isFinite(valueMaxCashoutRaw) || valueMaxCashoutRaw <= 0)
      ) {
        return res.status(400).json({ error: "Invalid maxCashout" });
      }
      if (
        outcomesControlledByVoucher &&
        valueWinCapMode !== null &&
        valueWinCapMode !== WIN_CAP_MODES.FIXED &&
        valueWinCapMode !== WIN_CAP_MODES.RANDOM
      ) {
        return res.status(400).json({ error: "Invalid winCapMode" });
      }
      if (
        outcomesControlledByVoucher &&
        valueWinCapPercentRaw !== null &&
        (!Number.isFinite(valueWinCapPercentRaw) || valueWinCapPercentRaw <= 0)
      ) {
        return res.status(400).json({ error: "Invalid winCapPercent" });
      }

      // Keep voucher code numeric so players can log in with the visible userCode
      const code = randomNumeric(6);
      const pin = randomNumeric(6);
      const userCode = code; // mirrors code; not stored separately
      const totalCredit = valueAmount + valueBonus;
      const capResolution = outcomesControlledByVoucher
        ? computeVoucherMaxCashout({
            amount: valueAmount,
            bonusAmount: valueBonus,
            requestedMaxCashout: valueMaxCashoutRaw,
            requestedWinCapMode: valueWinCapMode,
            requestedWinCapPercent: valueWinCapPercentRaw,
            policyRaw: req.effectiveConfig?.voucherWinCapPolicy || DEFAULT_VOUCHER_WIN_CAP_POLICY,
          })
        : {
            maxCashout: 0,
            capMode: null,
            capPercent: null,
            capSource: "outcome_mode_pure_rng",
            normalizedPolicy: normalizeVoucherWinCapPolicy(
              req.effectiveConfig?.voucherWinCapPolicy || DEFAULT_VOUCHER_WIN_CAP_POLICY
            ),
          };
      const valueMaxCashout = capResolution.maxCashout;

      if (outcomesControlledByVoucher && valueMaxCashout < totalCredit) {
        return res.status(400).json({ error: "maxCashout must be greater than or equal to total voucher credit" });
      }

      const ownerTenantIdentifier =
        req.staff?.role === "owner"
          ? normalizeTenantIdentifier(req.body?.tenantId)
          : null;
      if (ownerTenantIdentifier) {
        const ownerTenantId = await resolveTenantUuid(ownerTenantIdentifier);
        if (!ownerTenantId) {
          return res.status(404).json({ error: "Tenant not found" });
        }
        tenantId = ownerTenantId;
      }

      if (!tenantId) {
        return res.status(400).json({ error: "Tenant ID is required" });
      }

      const currencyCode = (typeof currency === "string" && currency.trim()
        ? currency.trim()
        : "FUN"
      ).toUpperCase();

      const t = await sequelize.transaction({ transaction: req.transaction });
      let voucher;
      try {
        let pool = await TenantVoucherPool.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!pool) {
          pool = await TenantVoucherPool.create(
            { tenantId, poolBalanceCents: 0, currency: currencyCode },
            { transaction: t }
          );
        }

        // Auto-top-up pool from tenant wallet if needed
        let wallet = await TenantWallet.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!wallet) {
          wallet = await TenantWallet.create(
            { tenantId, balanceCents: 0, currency: currencyCode },
            { transaction: t }
          );
        }

        const neededCents = toCents(totalCredit);
        const poolBalance = Number(pool.poolBalanceCents || 0);

        if (poolBalance < neededCents) {
          const shortfall = neededCents - poolBalance;
          const walletBalance = Number(wallet.balanceCents || 0);
          if (walletBalance >= shortfall) {
            wallet.balanceCents = walletBalance - shortfall;
            pool.poolBalanceCents = poolBalance + shortfall;
            await wallet.save({ transaction: t });
          } else if (req.staff?.role === "owner") {
            // Owner override: mint shortfall directly into the pool for emergency issuance.
            pool.poolBalanceCents = poolBalance + shortfall;
          }
        }

        if (Number(pool.poolBalanceCents || 0) < neededCents) {
          await logEvent({
            eventType: "VOUCHER_ISSUE",
            success: false,
            tenantId,
            requestId: req.requestId,
            actorType: "staff",
            actorId: req.staff?.id || null,
            actorRole: req.staff?.role || null,
            actorUsername: req.staff?.username || null,
            route: req.originalUrl,
            method: req.method,
            statusCode: 400,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            meta: { reason: "insufficient_voucher_pool", amount: valueAmount, bonusAmount: valueBonus },
          });
          await t.rollback();
          return res.status(400).json({ error: "Insufficient voucher pool balance" });
        }

        pool.poolBalanceCents = Number(pool.poolBalanceCents || 0) - toCents(totalCredit);
        await pool.save({ transaction: t });

        const voucherMetadata = {
          userCode,
          maxCashout: valueMaxCashout,
          createdByStaffId: req.staff?.id || null,
          createdByStaffUsername: req.staff?.username || null,
          createdByStaffRole: req.staff?.role || null,
          capStrategy: outcomesControlledByVoucher
            ? {
                mode: capResolution.capMode,
                percent: capResolution.capPercent,
                source: capResolution.capSource,
                voucherAmountBase: valueAmount,
              }
            : {
                mode: OUTCOME_MODES.PURE_RNG,
                percent: null,
                source: "outcome_mode",
                voucherAmountBase: valueAmount,
              },
          voucherPolicy: outcomesControlledByVoucher
            ? {
                maxCashout: valueMaxCashout,
                capReachedAt: null,
                decayMode: false,
                decayRounds: 0,
                capMode: capResolution.capMode,
                capPercent: capResolution.capPercent,
                decayRate: capResolution.normalizedPolicy.decayRate,
                minDecayAmount: capResolution.normalizedPolicy.minDecayAmount,
                stakeDecayMultiplier: capResolution.normalizedPolicy.stakeDecayMultiplier,
                trackedBalance: valueAmount,
              }
            : {
                maxCashout: 0,
                capReachedAt: null,
                decayMode: false,
                decayRounds: 0,
                capMode: null,
                capPercent: null,
                trackedBalance: null,
                lastMode: OUTCOME_MODES.PURE_RNG,
              },
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          source: "admin_panel",
        };

        // Retry a few times to avoid rare collision on the unique constraint
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            voucher = await Voucher.create(
              {
                tenantId,
                code: attempt === 0 ? code : randomNumeric(6),
                pin,
                amount: valueAmount,
                bonusAmount: valueBonus,
                totalCredit,
                maxCashout: valueMaxCashout,
                currency: currencyCode,
                status: "new",
                metadata: voucherMetadata,
              },
              { transaction: t }
            );
            break;
          } catch (err) {
            if (err.name === "SequelizeUniqueConstraintError" && attempt < 4) {
              continue;
            }
            throw err;
          }
        }

        await t.commit();
      } catch (err) {
        await t.rollback();
        throw err;
      }

      let qrPath = null;
      try {
        qrPath = await generateVoucherQrPng({ code: voucher.code, pin, userCode });
      } catch (qrErr) {
        console.error("[VOUCHERS] QR generation failed:", qrErr);
      }

      if (qrPath) {
        voucher.metadata = { ...(voucher.metadata || {}), qrPath };
        try {
          await voucher.save();
        } catch (metaErr) {
          console.error("[VOUCHERS] failed to persist qr metadata:", metaErr);
        }
      }

      const response = {
        voucher: {
          ...voucher.toJSON(),
          status: "new", // front-end expects lowercase
          maxCashout: outcomesControlledByVoucher ? valueMaxCashout : null,
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          winCapMode: capResolution.capMode,
          winCapPercent: capResolution.capPercent,
        },
        pin,       // for operator printing / handoff
        userCode,  // explicit top-level
        qr: qrPath
          ? {
              path: qrPath,
            }
          : null,
      };

      const staffMeta = buildRequestMeta(req, { staffRole: req.staff?.role || null });
      await recordLedgerEvent({
        ts: new Date(),
        eventType: "VOUCHER_ISSUED",
        actionId: voucher.id,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        cashierId: req.staff?.role === "cashier" ? req.staff?.id || null : null,
        amountCents: toCents(valueAmount + valueBonus),
        source: "vouchers.issue",
        meta: {
          ...staffMeta,
          voucherId: voucher.id,
          amountCents: toCents(valueAmount),
          bonusCents: toCents(valueBonus),
          maxCashoutCents: toCents(valueMaxCashout),
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          winCapMode: capResolution.capMode,
          winCapPercent: capResolution.capPercent,
          currency: voucher.currency || "FUN",
        },
      });

      await logEvent({
        eventType: "VOUCHER_ISSUE",
        success: true,
        tenantId,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 201,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          voucherId: voucher.id,
          amount: valueAmount,
          bonusAmount: valueBonus,
          maxCashout: valueMaxCashout,
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          winCapMode: capResolution.capMode,
          winCapPercent: capResolution.capPercent,
          currency: voucher.currency || "FUN",
        },
      });

      return res.status(201).json(response);
    } catch (err) {
      console.error("[VOUCHERS] POST / error:", err);
      await logEvent({
        eventType: "VOUCHER_ISSUE",
        success: false,
        tenantId: tenantId || req.staff?.tenantId || null,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", message: err.message },
      });
      return res.status(500).json({ error: "Failed to create voucher" });
    }
  }
);

// POST /vouchers/staff/redeem – staff-assisted redeem into a player's wallet
router.post(
  "/staff/redeem",
  redeemLimiter,
  staffAuth,
  requireStaffRole("owner", "operator", "agent", "distributor", "cashier"),
  requireStaffPermission(PERMISSIONS.VOUCHER_WRITE),
  enforceVouchersEnabled(),
  async (req, res) => {
    const { code, pin, userId } = req.body || {};
    const tenantId = await resolveTenantId(req);

    if (!code || !pin || !userId) {
      return res.status(400).json({ error: "code, pin, and userId are required" });
    }

    const lock = await getLock("voucher_redeem", code, tenantId);
    if (lock.locked) {
      return res.status(429).json({ error: "Voucher locked", lockUntil: lock.lockUntil });
    }

    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const voucher = await Voucher.findOne({
        where: {
          tenantId,
          code: { [Op.iLike]: code },
          pin: { [Op.iLike]: pin },
          status: { [Op.in]: ["new", "NEW"] },
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!voucher) {
        await recordFailure({ subjectType: "voucher_redeem", subjectId: code, tenantId, ip: req.auditContext?.ip, userAgent: req.auditContext?.userAgent });
        await t.rollback();
        return res.status(404).json({ error: "Voucher not found or already redeemed" });
      }

      const { wallet } = await creditVoucherToWallet({
        voucher,
        userId,
        staff: req.staff,
        transaction: t,
        effectiveOutcomeMode: req.effectiveConfig?.outcomeMode || DEFAULT_OUTCOME_MODE,
      });

      await recordLedgerEvent({
        ts: new Date(),
        playerId: userId,
        cashierId: req.staff?.role === "cashier" ? req.staff.id : null,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        sessionId: null,
        actionId: voucher.id,
        eventType: "VOUCHER_REDEEMED",
        amountCents: toCents(Number(voucher.amount || 0) + Number(voucher.bonusAmount || 0)),
        source: "vouchers.staff_redeem",
        meta: {
          ...(buildRequestMeta(req, { staffRole: req.staff?.role || null }) || {}),
          voucherId: voucher.id,
          code: voucher.code,
          amountCents: toCents(voucher.amount || 0),
          bonusCents: toCents(voucher.bonusAmount || 0),
          staffId: req.staff?.id || null,
        },
      });

      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: true,
        tenantId,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 200,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { code: voucher.code, voucherId: voucher.id, userId },
      });

      await t.commit();
      await recordSuccess({ subjectType: "voucher_redeem", subjectId: code, tenantId });
      emitSecurityEvent({
        tenantId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        eventType: "voucher_redeem_success",
        severity: 1,
        details: { code: voucher.code, userId },
      });
      const safeVoucher = sanitizeVoucher(voucher);
      return res.json({ ok: true, voucher: safeVoucher, wallet });
    } catch (err) {
      await t.rollback();
      console.error("[VOUCHERS] POST /staff/redeem error:", err);
      emitSecurityEvent({
        tenantId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        eventType: "voucher_redeem_failed",
        severity: 2,
        details: { code: code || null, reason: err.message || "unknown" },
      });
      return res.status(500).json({ error: "Failed to redeem voucher" });
    }
  }
);

// POST /vouchers/terminate – staff cashout/terminate a voucher (ledgered as withdraw)
router.post(
  "/terminate",
  staffAuth,
  requireStaffRole("owner", "operator", "agent", "distributor", "cashier"),
  requireStaffPermission(PERMISSIONS.VOUCHER_TERMINATE),
  enforceVouchersEnabled(),
  async (req, res) => {
    const { code, reason } = req.body || {};
    const tenantId = await resolveTenantId(req);
    if (!code) {
      return res.status(400).json({ error: "code is required" });
    }

    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const voucher = await Voucher.findOne({
        where: {
          tenantId,
          code: { [Op.iLike]: code },
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!voucher) {
        await t.rollback();
        return res.status(404).json({ error: "Voucher not found" });
      }

      if (String(voucher.status || "").toLowerCase() === "terminated") {
        await t.rollback();
        return res.status(400).json({ error: "Voucher already terminated" });
      }

      const now = new Date();
      const voucherMeta =
        voucher.metadata && typeof voucher.metadata === "object" ? { ...voucher.metadata } : {};
      const voucherCreatedByStaffId = normalizeStaffId(
        voucher.createdByUserId || voucherMeta.createdByStaffId || voucherMeta.voucherCreatedByStaffId
      );
      const voucherCreatedByStaffUsername = voucherMeta.createdByStaffUsername || null;

      let wallet = null;
      if (voucher.redeemedByUserId) {
        wallet = await Wallet.findOne({
          where: {
            tenantId,
            userId: voucher.redeemedByUserId,
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      }

      let player = null;
      if (voucher.redeemedByUserId) {
        player = await User.findOne({
          where: {
            id: voucher.redeemedByUserId,
            tenantId,
            role: "player",
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      }

      const balanceBefore = toMoney(wallet ? wallet.balance : 0);
      const bonusPendingBefore = toMoney(wallet ? wallet.bonusPending : 0);
      const bonusUnackedBefore = toMoney(wallet ? wallet.bonusUnacked : 0);
      const cashoutAmount = Math.max(0, balanceBefore);
      const finalAmountSettled = cashoutAmount;

      let cashoutTx = null;
      if (wallet) {
        const activeVoucherIdBefore = wallet.activeVoucherId || null;
        wallet.balance = 0;
        wallet.bonusPending = 0;
        wallet.bonusUnacked = 0;
        wallet.activeVoucherId = null;
        await wallet.save({ transaction: t });

        cashoutTx = await Transaction.create(
          {
            tenantId,
            walletId: wallet.id,
            type: "voucher_debit",
            amount: cashoutAmount,
            balanceBefore,
            balanceAfter: toMoney(wallet.balance || 0),
            reference: `voucher:${voucher.code}:cashout`,
            metadata: {
              voucherId: voucher.id,
              code: voucher.code,
              reason: reason || "cashout",
              cashoutAmount,
              finalAmountSettled,
              cashoutByStaffId: req.staff?.id || null,
              cashoutByRole: req.staff?.role || null,
              voucherCreatedByStaffId,
              voucherCreatedByStaffUsername,
              bonusPendingBefore,
              bonusPendingVoided: bonusPendingBefore,
              bonusUnackedBefore,
              activeVoucherIdBefore,
            },
          },
          { transaction: t }
        );
      }

      let profileDeactivated = false;
      let revokedSessionCount = 0;
      let revokedRefreshCount = 0;
      if (player) {
        if (player.isActive) {
          player.isActive = false;
          await player.save({ transaction: t });
        }
        profileDeactivated = true;
        const [sessionCount] = await Session.update(
          { revokedAt: now },
          {
            where: {
              tenantId,
              actorType: "user",
              userId: String(player.id),
              revokedAt: { [Op.is]: null },
            },
            transaction: t,
          }
        );
        revokedSessionCount = Number(sessionCount || 0);
        const [refreshCount] = await RefreshToken.update(
          { revokedAt: now, revokedReason: "voucher_terminated" },
          {
            where: {
              tenantId,
              userId: player.id,
              revokedAt: { [Op.is]: null },
            },
            transaction: t,
          }
        );
        revokedRefreshCount = Number(refreshCount || 0);
      }

      voucher.status = "terminated";
      voucher.metadata = {
        ...voucherMeta,
        terminatedAt: now.toISOString(),
        terminatedByStaffId: req.staff?.id || null,
        terminatedReason: reason || null,
        cashoutAt: now.toISOString(),
        cashoutAmount,
        finalAmountSettled,
        finalAmountSettledAt: now.toISOString(),
        cashoutByStaffId: req.staff?.id || null,
        cashoutByRole: req.staff?.role || null,
        cashoutPlayerId: voucher.redeemedByUserId || wallet?.userId || null,
        cashoutWalletId: wallet?.id || null,
        cashoutBalanceBefore: balanceBefore,
        cashoutBalanceAfter: toMoney(wallet ? wallet.balance : 0),
        cashoutBonusPendingBefore: bonusPendingBefore,
        cashoutBonusPendingVoided: bonusPendingBefore,
        cashoutBonusUnackedBefore: bonusUnackedBefore,
        cashoutTransactionId: cashoutTx?.id || null,
        voucherCreatedByStaffId,
        voucherCreatedByStaffUsername,
        profileDeactivated,
        deactivatedPlayerId: player?.id || voucher.redeemedByUserId || null,
        deactivatedAt: now.toISOString(),
        deactivatedByStaffId: req.staff?.id || null,
        deactivatedReason: reason || "voucher_terminated",
        revokedSessionCount,
        revokedRefreshTokenCount: revokedRefreshCount,
      };
      await voucher.save({ transaction: t });

      await recordLedgerEvent({
        ts: now,
        playerId: voucher.redeemedByUserId || wallet?.userId || null,
        cashierId: req.staff?.role === "cashier" ? req.staff.id : null,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        eventType: "WITHDRAW",
        actionId: voucher.id,
        amountCents: toCents(-cashoutAmount),
        source: "vouchers.terminate",
        meta: {
          ...(buildRequestMeta(req, { staffRole: req.staff?.role || null }) || {}),
          voucherId: voucher.id,
          code: voucher.code,
          reason: reason || "terminated",
          cashoutAmount,
          cashoutAmountCents: toCents(cashoutAmount),
          finalAmountSettled,
          finalAmountSettledCents: toCents(finalAmountSettled),
          cashoutTransactionId: cashoutTx?.id || null,
          bonusPendingVoided: bonusPendingBefore,
          bonusUnackedBefore,
          voucherCreatedByStaffId,
          voucherCreatedByStaffUsername,
          profileDeactivated,
          deactivatedPlayerId: player?.id || voucher.redeemedByUserId || null,
          revokedSessionCount,
          revokedRefreshTokenCount: revokedRefreshCount,
        },
      });

      await recordLedgerEvent({
        ts: now,
        playerId: voucher.redeemedByUserId || wallet?.userId || null,
        cashierId: req.staff?.role === "cashier" ? req.staff.id : null,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        eventType: "VOUCHER_SETTLED",
        actionId: voucher.id,
        amountCents: toCents(finalAmountSettled),
        source: "vouchers.terminate.final_settlement",
        meta: {
          ...(buildRequestMeta(req, { staffRole: req.staff?.role || null }) || {}),
          voucherId: voucher.id,
          code: voucher.code,
          ledgerRowType: "final_amount_settled",
          finalAmountSettled,
          finalAmountSettledCents: toCents(finalAmountSettled),
          cashoutTransactionId: cashoutTx?.id || null,
          voucherCreatedByStaffId,
          voucherCreatedByStaffUsername,
        },
      });

      await logEvent({
        eventType: "VOUCHER_TERMINATE",
        success: true,
        tenantId,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 200,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          voucherId: voucher.id,
          code: voucher.code,
          reason,
          cashoutAmount,
          finalAmountSettled,
          cashoutTransactionId: cashoutTx?.id || null,
          voucherCreatedByStaffId,
          voucherCreatedByStaffUsername,
          profileDeactivated,
          deactivatedPlayerId: player?.id || voucher.redeemedByUserId || null,
          revokedSessionCount,
          revokedRefreshTokenCount: revokedRefreshCount,
        },
      });

      await t.commit();
      return res.json({
        ok: true,
        voucher: sanitizeVoucher(voucher),
        cashout: {
          amount: cashoutAmount,
          finalAmountSettled,
          walletBalanceBefore: balanceBefore,
          walletBalanceAfter: toMoney(wallet ? wallet.balance : 0),
          bonusPendingVoided: bonusPendingBefore,
          transactionId: cashoutTx?.id || null,
        },
        profile: {
          playerId: player?.id || voucher.redeemedByUserId || null,
          deactivated: profileDeactivated,
          deactivatedAt: profileDeactivated ? now.toISOString() : null,
          revokedSessionCount,
          revokedRefreshTokenCount: revokedRefreshCount,
        },
      });
    } catch (err) {
      await t.rollback();
      console.error("[VOUCHERS] POST /terminate error:", err);
      return res.status(500).json({ error: "Failed to terminate voucher" });
    }
  }
);

// POST /vouchers/redeem (player) – redeem voucher into wallet
router.post(
  "/redeem",
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    try {
      const { code, pin } = req.body;

      if (!code || !pin) {
        await logEvent({
          eventType: "VOUCHER_REDEEM",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "missing_code_or_pin" },
        });
        return res
          .status(400)
          .json({ error: "code and pin are required" });
      }

      const voucher = await Voucher.findOne({
        where: {
          code,
          pin,
          status: "new",
        },
      });

      if (!voucher) {
        emitSecurityEvent({
          tenantId: req.auth?.tenantId || null,
          actorType: "player",
          actorId: req.user?.id || null,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          method: req.method,
          path: req.originalUrl,
          requestId: req.requestId,
          eventType: "voucher_pin_failed",
          severity: 2,
          details: {
            maskedCode: maskCode(code, 2),
          },
        });
        await logEvent({
          eventType: "VOUCHER_REDEEM",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 404,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_not_found", code },
        });
        await logEvent({
          eventType: "VOUCHER_VOID",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 404,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_not_found", code },
        });
        return res.status(404).json({ error: "Voucher not found" });
      }

      if (
        voucher.expiresAt &&
        new Date(voucher.expiresAt) < new Date()
      ) {
        await logEvent({
          eventType: "VOUCHER_REDEEM",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_expired", code, voucherId: voucher.id },
        });
        await logEvent({
          eventType: "VOUCHER_VOID",
          success: true,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_expired", code, voucherId: voucher.id },
        });
        return res.status(400).json({ error: "Voucher expired" });
      }

      const userId = req.user.id;
      const currency = voucher.currency || "FUN";
      const effectiveConfig = await getEffectiveConfig(req.auth?.tenantId || null);
      const normalizedOutcomeMode = normalizeOutcomeMode(
        effectiveConfig?.outcomeMode,
        DEFAULT_OUTCOME_MODE
      );
      const outcomesControlledByVoucher = isVoucherControlledOutcomeMode(
        normalizedOutcomeMode
      );

      const wallet = await getOrCreateWallet(userId, req.auth?.tenantId || null, currency);

      const before = Number(wallet.balance || 0);
      const amount = Number(voucher.amount || 0);
      const bonus = Number(voucher.bonusAmount || 0);
      const totalCredit = amount + bonus;
      const maxCashout = outcomesControlledByVoucher
        ? resolveVoucherMaxCashout(voucher, amount + bonus)
        : 0;

      wallet.balance = before + amount;
      wallet.bonusPending = Number(wallet.bonusPending || 0) + bonus;
      wallet.activeVoucherId = voucher.id;
      await wallet.save();

      const tx = await Transaction.create({
        tenantId: req.auth?.tenantId || null,
        walletId: wallet.id,
        type: "voucher_credit",
        amount,
        balanceBefore: before,
        balanceAfter: wallet.balance,
        reference: `voucher:${voucher.code}`,
        metadata: {
          voucherId: voucher.id,
          amount,
          bonusPending: bonus,
          maxCashout,
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          activeVoucherId: voucher.id,
        },
        createdByUserId: userId,
      });

      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = userId;
      const priorPolicy =
        voucher.metadata && voucher.metadata.voucherPolicy && typeof voucher.metadata.voucherPolicy === "object"
          ? voucher.metadata.voucherPolicy
          : {};
      voucher.maxCashout = maxCashout;
      const nextVoucherPolicy = outcomesControlledByVoucher
        ? {
            ...priorPolicy,
            maxCashout,
            capReachedAt: priorPolicy.capReachedAt || null,
            decayMode: Boolean(priorPolicy.decayMode),
            decayRounds: Math.max(0, Number(priorPolicy.decayRounds || 0)),
            decayRate: Number(priorPolicy.decayRate || DEFAULT_VOUCHER_WIN_CAP_POLICY.decayRate),
            minDecayAmount: Number(
              priorPolicy.minDecayAmount || DEFAULT_VOUCHER_WIN_CAP_POLICY.minDecayAmount
            ),
            stakeDecayMultiplier: Number(
              priorPolicy.stakeDecayMultiplier || DEFAULT_VOUCHER_WIN_CAP_POLICY.stakeDecayMultiplier
            ),
            trackedBalance: Number(priorPolicy.trackedBalance || amount),
          }
        : {
            ...priorPolicy,
            maxCashout: 0,
            capReachedAt: null,
            decayMode: false,
            decayRounds: 0,
            trackedBalance: null,
            lastMode: OUTCOME_MODES.PURE_RNG,
          };
      voucher.metadata = {
        ...(voucher.metadata || {}),
        maxCashout,
        voucherPolicy: nextVoucherPolicy,
        outcomeMode: normalizedOutcomeMode,
        outcomesControlledByVoucher,
        capStrategy: outcomesControlledByVoucher
          ? voucher.metadata?.capStrategy
          : { mode: OUTCOME_MODES.PURE_RNG, percent: null, source: "outcome_mode" },
      };
      await voucher.save();

      await applyPendingBonusIfEligible({
        wallet,
        transaction: null,
        reference: `bonus:${voucher.code}`,
        metadata: { voucherId: voucher.id },
      });

      const bonusState = buildBonusState(wallet);

      const sessionId = req.headers["x-session-id"] || null;
      await recordLedgerEvent({
        ts: new Date(),
        playerId: userId,
        sessionId: sessionId ? String(sessionId) : null,
        eventType: "VOUCHER_REDEEMED",
        actionId: voucher.id,
        amountCents: toCents(totalCredit),
        source: "vouchers.redeem",
        meta: {
          ...buildRequestMeta(req),
          voucherId: voucher.id,
          amountCents: toCents(amount),
          bonusCents: toCents(bonus),
          maxCashoutCents: toCents(maxCashout),
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          currency,
        },
      });

      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: true,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 200,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          voucherId: voucher.id,
          code,
          amount,
          bonus,
          maxCashout,
          outcomeMode: normalizedOutcomeMode,
          outcomesControlledByVoucher,
          currency,
        },
      });

      return res.json({
        voucher,
        wallet,
        transaction: tx,
        bonus: bonusState,
      });
    } catch (err) {
      console.error("[VOUCHERS] POST /redeem error:", err);
      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: false,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", message: err.message },
      });
      return res
        .status(500)
        .json({ error: "Failed to redeem voucher" });
    }
  }
);

module.exports = router;
