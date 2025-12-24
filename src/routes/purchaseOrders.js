// src/routes/purchaseOrders.js
const express = require("express");
const { Op } = require("sequelize");
const {
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
} = require("../models");
const { staffAuth, requirePermission } = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();

async function getOwnerAddress() {
  const row = await OwnerSetting.findByPk("ownerBtcAddress");
  return row?.value || "";
}

// GET default owner BTC address
router.get(
  "/owner-address",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const addr = await getOwnerAddress();
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
      await OwnerSetting.upsert({ key: "ownerBtcAddress", value: addr });
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
  async (req, res) => {
    try {
      const { funAmount, btcAmount, btcRate, note } = req.body || {};
      const ownerBtcAddress =
        (req.body?.ownerBtcAddress || "").trim() || (await getOwnerAddress());

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
        ownerBtcAddress,
        requestedBy: req.staff?.username || "agent",
      });

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
      const isOwner = (req.staff?.permissions || []).includes(PERMISSIONS.FINANCE_WRITE);
      const where = isOwner
        ? {}
        : { requestedBy: req.staff?.username || "__none__" };

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
  if (perms.includes(PERMISSIONS.FINANCE_WRITE)) return true;
  return order.requestedBy === staff?.username;
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
        where: { orderId: order.id },
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
      });

      res.status(201).json({ ok: true, message: msg });
    } catch (err) {
      console.error("[PO] message create error:", err);
      res.status(500).json({ ok: false, error: "Failed to post message" });
    }
  }
);

module.exports = router;
