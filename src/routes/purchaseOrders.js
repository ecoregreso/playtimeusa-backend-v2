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

const STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  AWAITING_CREDIT: "awaiting_credit",
  COMPLETED: "completed",
  ACKNOWLEDGED: "acknowledged",
};

async function getOwnerAddress() {
  const row = await OwnerSetting.findByPk("ownerBtcAddress");
  return row?.value || "";
}

async function addMessage({ orderId, sender, senderRole, body }) {
  if (!body) return null;
  return PurchaseOrderMessage.create({
    orderId,
    sender,
    senderRole,
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
      });

      if (note?.trim()) {
        await addMessage({
          orderId: order.id,
          sender: req.staff?.username || "staff",
          senderRole: req.staff?.role || "staff",
          body: note.trim(),
        });
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
        (req.body?.ownerBtcAddress || "").trim() || (await getOwnerAddress());
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

      order.status = STATUS.COMPLETED;
      order.ownerCreditedAt = new Date();
      await order.save();

      const body = (req.body?.note || "").trim() || "Funcoins credited.";
      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "owner",
        senderRole: req.staff?.role || "owner",
        body,
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

      order.status = STATUS.ACKNOWLEDGED;
      order.agentAcknowledgedAt = new Date();
      await order.save();

      const body = (req.body?.note || "").trim() || "Agent confirmed credits received.";
      await addMessage({
        orderId: order.id,
        sender: req.staff?.username || "agent",
        senderRole: req.staff?.role || "agent",
        body,
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
