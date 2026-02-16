// src/routes/purchaseOrders.js
const express = require("express");
const { Op } = require("sequelize");
const {
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
  StaffUser,
  StaffMessage,
  TenantWallet,
  CreditLedger,
} = require("../models");
const { sequelize } = require("../db");
const { sendPushToStaffIds } = require("../utils/push");
const { sendUrgentEmail } = require("../utils/email");
const { staffAuth, requirePermission } = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");
const { getJson } = require("../utils/ownerSettings");
const { DEFAULT_VOUCHER_WIN_CAP_POLICY } = require("../services/voucherWinCapPolicyService");
const { DEFAULT_OUTCOME_MODE, normalizeOutcomeMode } = require("../services/outcomeModeService");

const router = express.Router();

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
    return effectiveNoTenant;
  }
  const tenant = await getJson(tenantConfigKey(tenantId), {});
  const effective = { ...DEFAULT_SYSTEM_CONFIG, ...(system || {}), ...(tenant || {}) };
  effective.outcomeMode = normalizeOutcomeMode(effective.outcomeMode, DEFAULT_OUTCOME_MODE);
  return effective;
}

function enforcePurchaseOrdersEnabled() {
  return async (req, res, next) => {
    try {
      const tenantId = req.staff?.role === "owner" ? resolveTenantIdForOwner(req) : req.staff?.tenantId;
      const cfg = await getEffectiveConfig(tenantId);
      req.effectiveConfig = cfg;
      if (cfg.maintenanceMode && req.staff?.role !== "owner") {
        return res.status(503).json({ ok: false, error: "System is in maintenance mode" });
      }
      if (!cfg.purchaseOrdersEnabled && req.staff?.role !== "owner") {
        return res.status(403).json({ ok: false, error: "Purchase orders are currently disabled" });
      }
      return next();
    } catch (err) {
      console.error("[PO] config gate error:", err);
      return res.status(500).json({ ok: false, error: "Failed to load system config" });
    }
  };
}


const STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  AWAITING_CREDIT: "awaiting_credit",
  COMPLETED: "completed",
  ACKNOWLEDGED: "acknowledged",
};

const WALLET_PROVIDER_WASABI = "wasabi";

function ownerKey(tenantId) {
  return `${tenantId}:ownerBtcAddress`;
}

function threadIdForPair(a, b) {
  const [minId, maxId] = [a, b].sort((x, y) => x - y);
  return `thread:${minId}:${maxId}`;
}

function normalizeTenantId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function resolveTenantIdForOwner(req) {
  if (req.staff?.role !== "owner") {
    return req.staff?.tenantId || null;
  }
  return normalizeTenantId(req.query?.tenantId || req.body?.tenantId || req.staff?.tenantId);
}

function canPlaceOrder(staff) {
  if (!staff) return false;
  return staff.role === "agent" || staff.role === "distributor" || staff.role === "owner";
}

async function getOwnerAddress(tenantId) {
  const row = await OwnerSetting.findByPk(ownerKey(tenantId));
  return row?.value || "";
}

async function getOwners(tenantId) {
  return StaffUser.findAll({
    where: {
      tenantId,
      isActive: true,
      [Op.or]: [
        { role: "owner" },
        sequelize.where(
          sequelize.cast(sequelize.col("permissions"), "text"),
          { [Op.iLike]: `%${PERMISSIONS.FINANCE_WRITE}%` }
        ),
      ],
    },
  });
}

async function notifyOwnersByEmail(owners) {
  const unique = new Set();
  for (const owner of owners) {
    const email = owner?.email ? String(owner.email).trim() : "";
    if (!email) continue;
    const key = email.toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    await sendUrgentEmail(email);
  }
}

async function notifyOrderStatusByEmail({ tenantId, order }) {
  const owners = await getOwners(tenantId);
  const requester = order?.requestedById ? await StaffUser.findByPk(order.requestedById) : null;
  const recipients = [...owners, requester].filter(Boolean);
  const unique = new Set();
  for (const user of recipients) {
    const email = user?.email ? String(user.email).trim() : "";
    if (!email) continue;
    const key = email.toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    await sendUrgentEmail(email);
  }
}

async function addMessage({ orderId, sender, senderRole, body, tenantId, transaction = undefined }) {
  if (!body) return null;
  return PurchaseOrderMessage.create({
    orderId,
    sender,
    senderRole,
    tenantId,
    body,
  }, { transaction });
}

function isFinanceManager(staff) {
  return Boolean((staff?.permissions || []).includes(PERMISSIONS.FINANCE_WRITE));
}

function isRequester(order, staff) {
  if (!order || !staff) return false;
  if (order.requestedById != null && staff.id != null) {
    return Number(order.requestedById) === Number(staff.id);
  }
  return String(order.requestedBy || "") === String(staff.username || "");
}

function toCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function formatFunAmountFromCents(cents) {
  const amount = Number(cents || 0) / 100;
  return amount.toFixed(2);
}

function normalizeWalletProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function buildReceiptCode(orderId, now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = String(orderId || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase();
  return `PO-${stamp}-${suffix || "NA"}`;
}

// GET default owner BTC address
router.get(
  "/owner-address",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const tenantId = resolveTenantIdForOwner(req);
      if (!tenantId) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }
      const addr = await getOwnerAddress(tenantId);
      res.json({ ok: true, ownerBtcAddress: addr });
    } catch (err) {
      console.error("[PO] owner addr get error:", err);
      res.status(500).json({ ok: false, error: "Failed to load address" });
    }
  }
);

// SET owner BTC address
router.post(
  "/owner-address",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    try {
      const addr = (req.body?.ownerBtcAddress || "").trim();
      const tenantId = resolveTenantIdForOwner(req);
      if (!tenantId) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }
      await OwnerSetting.upsert({
        key: ownerKey(tenantId),
        value: addr,
      });
      res.json({ ok: true, ownerBtcAddress: addr });
    } catch (err) {
      console.error("[PO] owner addr set error:", err);
      res.status(500).json({ ok: false, error: "Failed to save address" });
    }
  }
);

// CREATE purchase order (agent/operator)
router.post(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  enforcePurchaseOrdersEnabled(),
  async (req, res) => {
    try {
      if (!canPlaceOrder(req.staff)) {
        return res.status(403).json({ ok: false, error: "Only agents, distributors, or owners can place orders" });
      }
      const tenantId = req.staff?.role === "owner" ? resolveTenantIdForOwner(req) : req.staff?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }
      const { funAmount, btcAmount, btcRate, note } = req.body || {};

      const fun = Number(funAmount);
      const btc = Number(btcAmount);
      if (!Number.isFinite(fun) || fun <= 0 || !Number.isFinite(btc) || btc <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid amounts" });
      }

      const order = await PurchaseOrder.create({
        funAmount: fun,
        btcAmount: btc,
        btcRate: btcRate || null,
        note: note || "",
        requestedBy: req.staff?.username || "agent",
        requestedById: req.staff?.id || null,
        tenantId,
        ownerApprovedAt: null,
        paymentConfirmedAt: null,
        paymentWalletProvider: null,
        creditedAmountCents: null,
        receiptCode: null,
        receiptIssuedAt: null,
      });

      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "staff",
        senderRole: req.staff?.role || "staff",
        body: `Stage 1 initiated: tenant requested ${fun.toFixed(2)} FUN for ${btc.toFixed(8)} BTC.`,
        tenantId,
      });
      if (note?.trim()) {
        await addMessage({
          orderId: order.id,
          sender: req.staff?.username || "staff",
          senderRole: req.staff?.role || "staff",
          body: note.trim(),
          tenantId,
        });
      }

       // Send a plain-text inbox notification to owners in this tenant
       try {
         const owners = await getOwners(tenantId);
         const senderId = req.staff?.id;
         const summary = `New funcoin order #${order.id} by ${order.requestedBy}: ${order.funAmount} FC -> ${order.btcAmount} BTC @ ${order.btcRate || "n/a"} (status: ${order.status})`;
         const ownerIds = owners.map((o) => o.id).filter(Boolean);
         for (const owner of owners) {
           if (!senderId || !owner.id) continue;
           const threadId = threadIdForPair(senderId, owner.id);
           await StaffMessage.create({
             threadId,
             fromId: senderId,
             toId: owner.id,
             tenantId,
             type: "purchase_order",
             ciphertext: summary,
             createdAt: new Date(),
           });
         }
         if (ownerIds.length) {
           await sendPushToStaffIds({
             tenantId,
             staffIds: ownerIds,
             title: "New update",
             body: "You have a new funcoin order.",
             data: { type: "purchase_order", id: order.id },
           });
         }
         await notifyOwnersByEmail(owners);
       } catch (notifyErr) {
         console.error("[PO] notify owner error:", notifyErr);
       }

      res.status(201).json({ ok: true, order });
    } catch (err) {
      console.error("[PO] create error:", err);
      res.status(500).json({ ok: false, error: "Failed to create order" });
    }
  }
);

// LIST purchase orders
router.get(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const perms = req.staff?.permissions || [];
      const isOwnerRole = req.staff?.role === "owner";
      const isManager = perms.includes(PERMISSIONS.FINANCE_WRITE);
      const tenantId = isOwnerRole ? normalizeTenantId(req.query?.tenantId) : req.staff?.tenantId;

      let where = {};
      if (isOwnerRole) {
        if (tenantId) where.tenantId = tenantId;
      } else if (isManager) {
        where = { tenantId: req.staff?.tenantId };
      } else {
        where = {
          tenantId: req.staff?.tenantId,
          requestedById: req.staff?.id || -1,
        };
      }

      const orders = await PurchaseOrder.findAll({
        where,
        order: [["createdAt", "DESC"]],
      });
      res.json({ ok: true, orders });
    } catch (err) {
      console.error("[PO] list error:", err);
      res.status(500).json({ ok: false, error: "Failed to list orders" });
    }
  }
);

async function canAccessOrder(order, staff) {
  if (!order) return false;
  if (staff?.role !== "owner" && order.tenantId && staff?.tenantId && order.tenantId !== staff.tenantId) {
    return false;
  }
  if (staff?.role === "owner") return true;
  if (isFinanceManager(staff)) return true;
  return isRequester(order, staff);
}

// OWNER/FINANCE inbox for funcoin orders only
router.get(
  "/owner-inbox",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const isOwnerRole = req.staff?.role === "owner";
      const statusFilter = String(req.query?.status || "").trim();
      const tenantId = isOwnerRole ? normalizeTenantId(req.query?.tenantId) : req.staff?.tenantId;

      const where = {};
      if (tenantId) where.tenantId = tenantId;
      if (statusFilter) where.status = statusFilter;

      if (!isOwnerRole && !isFinanceManager(req.staff)) {
        where.requestedById = req.staff?.id || -1;
      }

      const orders = await PurchaseOrder.findAll({
        where,
        order: [["createdAt", "DESC"]],
        limit: 250,
      });
      const orderIds = orders.map((order) => order.id);

      let messages = [];
      if (orderIds.length) {
        messages = await PurchaseOrderMessage.findAll({
          where: {
            orderId: { [Op.in]: orderIds },
            ...(tenantId ? { tenantId } : {}),
          },
          order: [["createdAt", "ASC"]],
        });
      }

      const messagesByOrder = new Map();
      for (const msg of messages) {
        const key = String(msg.orderId);
        if (!messagesByOrder.has(key)) messagesByOrder.set(key, []);
        messagesByOrder.get(key).push(msg);
      }

      const inbox = orders.map((order) => {
        const key = String(order.id);
        const thread = messagesByOrder.get(key) || [];
        const lastMessage = thread.length ? thread[thread.length - 1] : null;
        return {
          ...order.toJSON(),
          messageCount: thread.length,
          lastMessage,
          messages: thread,
        };
      });

      return res.json({ ok: true, orders: inbox });
    } catch (err) {
      console.error("[PO] owner inbox error:", err);
      return res.status(500).json({ ok: false, error: "Failed to load owner inbox" });
    }
  }
);

// GET messages for an order
router.get(
  "/:id/messages",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!(await canAccessOrder(order, req.staff))) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const messages = await PurchaseOrderMessage.findAll({
        where: { orderId: order.id, tenantId: order?.tenantId || req.staff?.tenantId },
        order: [["createdAt", "ASC"]],
      });
      res.json({ ok: true, messages });
    } catch (err) {
      console.error("[PO] messages list error:", err);
      res.status(500).json({ ok: false, error: "Failed to load messages" });
    }
  }
);

// POST message on an order
router.post(
  "/:id/messages",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const body = (req.body?.body || "").trim();
      if (!body) return res.status(400).json({ ok: false, error: "Message body required" });

      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!(await canAccessOrder(order, req.staff))) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const msg = await PurchaseOrderMessage.create({
        orderId: order.id,
        sender: req.staff?.username || "staff",
        senderRole: req.staff?.role || "staff",
        body,
        tenantId: order?.tenantId || req.staff?.tenantId,
      });

      res.status(201).json({ ok: true, message: msg });
    } catch (err) {
      console.error("[PO] message create error:", err);
      res.status(500).json({ ok: false, error: "Failed to post message" });
    }
  }
);

// OWNER: approve and provide wallet
router.post(
  "/:id/approve",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    try {
      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: "Not found" });
      if (order.status !== STATUS.PENDING) {
        return res.status(400).json({ ok: false, error: "Order is not pending" });
      }
      if (req.staff?.role !== "owner") {
        return res.status(403).json({
          ok: false,
          error: "Only owners can approve and send Stage 2 wallet instructions",
        });
      }

      const ownerBtcAddress =
        (req.body?.ownerBtcAddress || "").trim() || (await getOwnerAddress(order.tenantId));
      if (!ownerBtcAddress) {
        return res.status(400).json({ ok: false, error: "Wallet address required" });
      }

      order.ownerBtcAddress = ownerBtcAddress;
      order.status = STATUS.APPROVED;
      order.ownerApprovedAt = new Date();
      order.paymentConfirmedAt = null;
      order.paymentWalletProvider = null;
      order.ownerCreditedAt = null;
      order.receiptCode = null;
      order.receiptIssuedAt = null;
      order.creditedAmountCents = null;
      await order.save();

      const message =
        (req.body?.note || "").trim() ||
        `Stage 2 verified by owner: BTC address shared (${ownerBtcAddress}). Tenant must send BTC via Wasabi wallet and submit confirmation.`;
      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "owner",
        senderRole: req.staff?.role || "owner",
        body: message,
        tenantId: order.tenantId,
      });

      await notifyOrderStatusByEmail({
        tenantId: order.tenantId,
        order,
      });

      res.json({ ok: true, order });
    } catch (err) {
      console.error("[PO] approve error:", err);
      res.status(500).json({ ok: false, error: "Failed to approve order" });
    }
  }
);

// AGENT: submit payment proof/confirmation
router.post(
  "/:id/confirm-payment",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: "Not found" });
      if (order.status !== STATUS.APPROVED) {
        return res.status(400).json({ ok: false, error: "Order not approved yet" });
      }
      if (req.staff?.role !== "owner" && order.tenantId && req.staff?.tenantId && order.tenantId !== req.staff.tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      if (!isRequester(order, req.staff)) {
        return res.status(403).json({ ok: false, error: "Only the requesting tenant can confirm payment" });
      }
      const confirmationCode = (req.body?.confirmationCode || "").trim();
      if (!confirmationCode) {
        return res.status(400).json({ ok: false, error: "Confirmation required" });
      }
      const walletProvider = normalizeWalletProvider(
        req.body?.walletProvider || req.body?.paymentWalletProvider || req.body?.wallet || ""
      );
      if (walletProvider !== WALLET_PROVIDER_WASABI) {
        return res.status(400).json({
          ok: false,
          error: "Payments must be sent via Wasabi wallet for this workflow",
          requiredWalletProvider: WALLET_PROVIDER_WASABI,
        });
      }

      order.confirmationCode = confirmationCode;
      order.paymentWalletProvider = WALLET_PROVIDER_WASABI;
      order.paymentConfirmedAt = new Date();
      order.status = STATUS.AWAITING_CREDIT;
      await order.save();

      const body =
        (req.body?.note || "").trim() ||
        `Stage 3 verified by tenant: BTC sent via Wasabi. Confirmation: ${confirmationCode}.`;
      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "agent",
        senderRole: req.staff?.role || "agent",
        body,
        tenantId: order.tenantId,
      });

      await notifyOrderStatusByEmail({
        tenantId: order.tenantId,
        order,
      });

      res.json({ ok: true, order });
    } catch (err) {
      console.error("[PO] confirm-payment error:", err);
      res.status(500).json({ ok: false, error: "Failed to submit confirmation" });
    }
  }
);

// OWNER: mark credits delivered
router.post(
  "/:id/mark-credited",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    try {
      const transaction = req.transaction || null;
      if (!transaction) {
        return res.status(500).json({ ok: false, error: "Missing tenant transaction context" });
      }

      const result = await (async (t) => {
        const order = await PurchaseOrder.findByPk(req.params.id, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!order) {
          const err = new Error("NOT_FOUND");
          err.status = 404;
          throw err;
        }
        if (order.status !== STATUS.AWAITING_CREDIT) {
          const err = new Error("ORDER_NOT_AWAITING_CREDIT");
          err.status = 400;
          throw err;
        }
        if (req.staff?.role !== "owner") {
          const err = new Error("OWNER_ONLY");
          err.status = 403;
          throw err;
        }
        if (normalizeWalletProvider(order.paymentWalletProvider) !== WALLET_PROVIDER_WASABI) {
          const err = new Error("WALLET_PROVIDER_NOT_VERIFIED");
          err.status = 400;
          throw err;
        }
        if (!order.confirmationCode || !order.paymentConfirmedAt) {
          const err = new Error("PAYMENT_NOT_CONFIRMED");
          err.status = 400;
          throw err;
        }

        const creditCents = toCents(order.funAmount);
        if (!Number.isFinite(creditCents) || creditCents <= 0) {
          const err = new Error("INVALID_FUN_AMOUNT");
          err.status = 400;
          throw err;
        }
        const requestedCreditCents =
          req.body?.creditedAmountCents != null
            ? Number(req.body.creditedAmountCents)
            : req.body?.creditedAmountFun != null
            ? toCents(req.body.creditedAmountFun)
            : null;
        if (
          requestedCreditCents != null &&
          (Number.isNaN(requestedCreditCents) || Number(requestedCreditCents) !== Number(creditCents))
        ) {
          const err = new Error("CREDIT_AMOUNT_MISMATCH");
          err.status = 400;
          throw err;
        }

        let wallet = await TenantWallet.findOne({
          where: { tenantId: order.tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!wallet) {
          wallet = await TenantWallet.create(
            { tenantId: order.tenantId, balanceCents: 0, currency: "FUN" },
            { transaction: t }
          );
        }
        const walletBefore = Number(wallet.balanceCents || 0);
        const walletAfter = walletBefore + creditCents;
        if (walletAfter - walletBefore !== creditCents) {
          const err = new Error("CREDIT_AMOUNT_MISMATCH");
          err.status = 400;
          throw err;
        }
        wallet.balanceCents = walletAfter;
        await wallet.save({ transaction: t });

        const creditLedger = await CreditLedger.create(
          {
            tenantId: order.tenantId,
            actorUserId: req.staff?.id || null,
            actionType: "purchase_order_credit",
            amountCents: creditCents,
            memo: `purchase_order:${order.id}`,
          },
          { transaction: t }
        );
        if (Number(creditLedger.amountCents || 0) !== Number(creditCents)) {
          const err = new Error("CREDIT_AMOUNT_MISMATCH");
          err.status = 400;
          throw err;
        }

        const now = new Date();
        const receiptCode = buildReceiptCode(order.id, now);

        order.status = STATUS.COMPLETED;
        order.ownerCreditedAt = now;
        order.creditedAmountCents = creditCents;
        order.receiptCode = receiptCode;
        order.receiptIssuedAt = now;
        await order.save({ transaction: t });

        const ownerNote = (req.body?.note || "").trim();
        if (ownerNote) {
          await addMessage({
            orderId: order.id,
            sender: req.staff?.username || "owner",
            senderRole: req.staff?.role || "owner",
            body: ownerNote,
            tenantId: order.tenantId,
            transaction: t,
          });
        }

        await addMessage({
          orderId: order.id,
          sender: req.staff?.username || "owner",
          senderRole: req.staff?.role || "owner",
          body:
            `Stage 4 verified by owner: payment received and account credited ${formatFunAmountFromCents(creditCents)} FUN. ` +
            `Order marked paid. Receipt ${receiptCode}.`,
          tenantId: order.tenantId,
          transaction: t,
        });

        await addMessage({
          orderId: order.id,
          sender: "system",
          senderRole: "system",
          body:
            `Auto payment receipt\n` +
            `Receipt: ${receiptCode}\n` +
            `Order: ${order.id}\n` +
            `Tenant: ${order.tenantId}\n` +
            `BTC confirmation: ${order.confirmationCode}\n` +
            `Wallet provider: ${WALLET_PROVIDER_WASABI}\n` +
            `FUN credited: ${formatFunAmountFromCents(creditCents)}\n` +
            `Credited at: ${now.toISOString()}`,
          tenantId: order.tenantId,
          transaction: t,
        });

        return { order, wallet };
      })(transaction);

      await notifyOrderStatusByEmail({
        tenantId: result.order.tenantId,
        order: result.order,
      });

      res.json({
        ok: true,
        order: result.order,
        receipt: {
          code: result.order.receiptCode,
          issuedAt: result.order.receiptIssuedAt,
          creditedAmountCents: Number(result.order.creditedAmountCents || 0),
          creditedAmountFun: formatFunAmountFromCents(result.order.creditedAmountCents || 0),
        },
      });
    } catch (err) {
      if (err?.message === "NOT_FOUND") {
        return res.status(404).json({ ok: false, error: "Not found" });
      }
      if (err?.message === "ORDER_NOT_AWAITING_CREDIT") {
        return res.status(400).json({ ok: false, error: "Order not awaiting credit" });
      }
      if (err?.message === "FORBIDDEN") {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      if (err?.message === "OWNER_ONLY") {
        return res.status(403).json({
          ok: false,
          error: "Only owners can complete Stage 4 payout and crediting",
        });
      }
      if (err?.message === "WALLET_PROVIDER_NOT_VERIFIED") {
        return res.status(400).json({
          ok: false,
          error: "Tenant confirmation must be from Wasabi wallet before crediting",
        });
      }
      if (err?.message === "PAYMENT_NOT_CONFIRMED") {
        return res.status(400).json({ ok: false, error: "Payment confirmation is missing" });
      }
      if (err?.message === "INVALID_FUN_AMOUNT") {
        return res.status(400).json({ ok: false, error: "Invalid FUN amount on order" });
      }
      if (err?.message === "CREDIT_AMOUNT_MISMATCH") {
        return res.status(400).json({
          ok: false,
          error: "Credited amount must exactly match the tenant requested FUN amount",
        });
      }
      console.error("[PO] mark-credited error:", err);
      res.status(500).json({ ok: false, error: "Failed to mark credited" });
    }
  }
);

// AGENT: acknowledge receipt
router.post(
  "/:id/acknowledge",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: "Not found" });
      if (req.staff?.role !== "owner" && order.tenantId && req.staff?.tenantId && order.tenantId !== req.staff.tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      if (!isRequester(order, req.staff)) {
        return res.status(403).json({ ok: false, error: "Only the requesting tenant can acknowledge this order" });
      }
      if (order.status !== STATUS.COMPLETED) {
        return res.status(400).json({ ok: false, error: "Order not completed yet" });
      }

      order.status = STATUS.ACKNOWLEDGED;
      order.agentAcknowledgedAt = new Date();
      await order.save();

      const body =
        (req.body?.note || "").trim() ||
        "Requester acknowledged the credited balance and receipt.";
      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "agent",
        senderRole: req.staff?.role || "agent",
        body,
        tenantId: order.tenantId,
      });

      await notifyOrderStatusByEmail({
        tenantId: order.tenantId,
        order,
      });

      res.json({ ok: true, order });
    } catch (err) {
      console.error("[PO] acknowledge error:", err);
      res.status(500).json({ ok: false, error: "Failed to acknowledge" });
    }
  }
);

// Delete order (owner only)
router.delete(
  "/:id",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    try {
      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: "Not found" });
      if (order.tenantId && req.staff?.tenantId && order.tenantId !== req.staff.tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      await PurchaseOrderMessage.destroy({ where: { orderId: order.id } });
      await order.destroy();
      res.json({ ok: true });
    } catch (err) {
      console.error("[PO] delete error:", err);
      res.status(500).json({ ok: false, error: "Failed to delete order" });
    }
  }
);

module.exports = router;
