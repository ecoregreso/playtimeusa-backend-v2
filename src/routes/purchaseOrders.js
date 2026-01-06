// src/routes/purchaseOrders.js
const express = require("express");
const { Op } = require("sequelize");
const {
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
  StaffUser,
  StaffMessage,
} = require("../models");
const { sequelize } = require("../db");
const { sendPushToStaffIds } = require("../utils/push");
const { sendUrgentEmail } = require("../utils/email");
const { staffAuth, requirePermission } = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");
const { getJson } = require("../utils/ownerSettings");

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
};

async function getEffectiveConfig(tenantId) {
  const system = await getJson(SYSTEM_CONFIG_KEY, DEFAULT_SYSTEM_CONFIG);
  if (!tenantId) return { ...DEFAULT_SYSTEM_CONFIG, ...(system || {}) };
  const tenant = await getJson(tenantConfigKey(tenantId), {});
  return { ...DEFAULT_SYSTEM_CONFIG, ...(system || {}), ...(tenant || {}) };
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

async function addMessage({ orderId, sender, senderRole, body, tenantId }) {
  if (!body) return null;
  return PurchaseOrderMessage.create({
    orderId,
    sender,
    senderRole,
    tenantId,
    body,
  });
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
  const perms = staff?.permissions || [];
  if (order.tenantId && staff?.tenantId && order.tenantId !== staff.tenantId) return false;
  if (perms.includes(PERMISSIONS.FINANCE_WRITE)) return true;
  return order.requestedById === staff?.id || order.requestedBy === staff?.username;
}

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

      const ownerBtcAddress =
        (req.body?.ownerBtcAddress || "").trim() || (await getOwnerAddress(order.tenantId));
      if (!ownerBtcAddress) {
        return res.status(400).json({ ok: false, error: "Wallet address required" });
      }

      order.ownerBtcAddress = ownerBtcAddress;
      order.status = STATUS.APPROVED;
      await order.save();

      const message =
        (req.body?.note || "").trim() ||
        `Owner shared wallet: ${ownerBtcAddress}`;
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
      if (order.tenantId && req.staff?.tenantId && order.tenantId !== req.staff.tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const isOwner = (req.staff?.permissions || []).includes(PERMISSIONS.FINANCE_WRITE);
      const isRequester = order.requestedBy === (req.staff?.username || "");
      if (!isOwner && !isRequester) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const confirmationCode = (req.body?.confirmationCode || "").trim();
      if (!confirmationCode) {
        return res.status(400).json({ ok: false, error: "Confirmation required" });
      }

      order.confirmationCode = confirmationCode;
      order.status = STATUS.AWAITING_CREDIT;
      await order.save();

      const body =
        (req.body?.note || "").trim() ||
        `Payment sent. Confirmation: ${confirmationCode}`;
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
      const order = await PurchaseOrder.findByPk(req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: "Not found" });
      if (order.status !== STATUS.AWAITING_CREDIT) {
        return res.status(400).json({ ok: false, error: "Order not awaiting credit" });
      }
      if (order.tenantId && req.staff?.tenantId && order.tenantId !== req.staff.tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      order.status = STATUS.COMPLETED;
      order.ownerCreditedAt = new Date();
      await order.save();

      const body = (req.body?.note || "").trim() || "Funcoins credited.";
      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "owner",
        senderRole: req.staff?.role || "owner",
        body,
        tenantId: order.tenantId,
      });

      await notifyOrderStatusByEmail({
        tenantId: order.tenantId,
        order,
      });

      res.json({ ok: true, order });
    } catch (err) {
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
      const isOwner = (req.staff?.permissions || []).includes(PERMISSIONS.FINANCE_WRITE);
      const isRequester = order.requestedBy === (req.staff?.username || "");
      if (!isOwner && !isRequester) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      if (order.status !== STATUS.COMPLETED) {
        return res.status(400).json({ ok: false, error: "Order not completed yet" });
      }
      if (order.tenantId && req.staff?.tenantId && order.tenantId !== req.staff.tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      order.status = STATUS.ACKNOWLEDGED;
      order.agentAcknowledgedAt = new Date();
      await order.save();

      const body = (req.body?.note || "").trim() || "Agent confirmed credits received.";
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
