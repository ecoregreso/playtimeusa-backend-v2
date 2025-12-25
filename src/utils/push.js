const webPush = (() => {
  try {
    return require("web-push");
  } catch (err) {
    console.warn("[PUSH] web-push not installed");
    return null;
  }
})();

const firebaseAdmin = (() => {
  try {
    return require("firebase-admin");
  } catch (err) {
    console.warn("[PUSH] firebase-admin not installed");
    return null;
  }
})();

const apn = (() => {
  try {
    return require("apn");
  } catch (err) {
    console.warn("[PUSH] apn not installed");
    return null;
  }
})();

const { decryptString } = require("./pushCrypto");
const { StaffPushDevice } = require("../models");

let webPushConfigured = false;
let fcmConfigured = false;
let apnProvider = null;
let apnTopic = null;

function initWebPush() {
  if (!webPush) return false;
  if (webPushConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!publicKey || !privateKey) return false;
  webPush.setVapidDetails(subject, publicKey, privateKey);
  webPushConfigured = true;
  return true;
}

function initFcm() {
  if (!firebaseAdmin) return false;
  if (fcmConfigured) return true;
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
  try {
    if (raw) {
      const json = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(json) });
      fcmConfigured = true;
      return true;
    }
    if (path) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const json = require(path);
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(json) });
      fcmConfigured = true;
      return true;
    }
  } catch (err) {
    console.error("[PUSH] FCM init error:", err.message || err);
  }
  return false;
}

function initApn() {
  if (!apn) return null;
  if (apnProvider) return apnProvider;
  const key = process.env.APNS_PRIVATE_KEY;
  const keyPath = process.env.APNS_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!keyId || !teamId || !bundleId || (!key && !keyPath)) return null;
  const token = {
    key: key ? Buffer.from(key, "base64").toString("utf8") : keyPath,
    keyId,
    teamId,
  };
  apnProvider = new apn.Provider({
    token,
    production: process.env.APNS_PRODUCTION === "true",
  });
  apnTopic = bundleId;
  return apnProvider;
}

function buildPayload({ title, body, data }) {
  return JSON.stringify({
    title: title || "New update",
    body: body || "You have a new update.",
    data: data || {},
  });
}

async function sendToWebPush(device, payload) {
  if (!initWebPush()) return false;
  try {
    const subscription = JSON.parse(decryptString(device.encryptedToken));
    await webPush.sendNotification(subscription, payload);
    return true;
  } catch (err) {
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      await device.update({ isActive: false });
    }
    console.warn("[PUSH] web send error:", err.message || err);
    return false;
  }
}

async function sendToFcm(device, payload) {
  if (!initFcm()) return false;
  try {
    const token = decryptString(device.encryptedToken);
    const data = JSON.parse(payload);
    await firebaseAdmin.messaging().send({
      token,
      notification: {
        title: data.title,
        body: data.body,
      },
      data: data.data || {},
    });
    return true;
  } catch (err) {
    const code = err?.errorInfo?.code;
    if (code === "messaging/registration-token-not-registered") {
      await device.update({ isActive: false });
    }
    console.warn("[PUSH] FCM send error:", err.message || err);
    return false;
  }
}

async function sendToApn(device, payload) {
  const provider = initApn();
  if (!provider) return false;
  try {
    const token = decryptString(device.encryptedToken);
    const data = JSON.parse(payload);
    const note = new apn.Notification();
    note.alert = { title: data.title, body: data.body };
    note.payload = data.data || {};
    note.topic = apnTopic;
    const result = await provider.send(note, token);
    if (result.failed?.length) {
      const bad = result.failed.find((f) => f.status === "410");
      if (bad) await device.update({ isActive: false });
    }
    return true;
  } catch (err) {
    console.warn("[PUSH] APNs send error:", err.message || err);
    return false;
  }
}

async function sendPushToStaffIds({ tenantId, staffIds, title, body, data }) {
  if (!staffIds || staffIds.length === 0) return { ok: true, sent: 0 };
  const devices = await StaffPushDevice.findAll({
    where: {
      tenantId,
      staffId: staffIds,
      isActive: true,
    },
  });
  if (!devices.length) return { ok: true, sent: 0 };
  const payload = buildPayload({ title, body, data });
  let sent = 0;
  for (const device of devices) {
    let ok = false;
    if (device.deviceType === "web") ok = await sendToWebPush(device, payload);
    if (device.deviceType === "fcm") ok = await sendToFcm(device, payload);
    if (device.deviceType === "apns") ok = await sendToApn(device, payload);
    if (ok) {
      sent += 1;
      await device.update({ lastUsedAt: new Date() });
    }
  }
  return { ok: true, sent };
}

module.exports = { sendPushToStaffIds, buildPayload };
