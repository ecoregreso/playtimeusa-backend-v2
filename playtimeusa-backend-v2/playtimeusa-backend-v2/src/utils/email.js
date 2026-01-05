const sgMail = (() => {
  try {
    // eslint-disable-next-line global-require
    return require("@sendgrid/mail");
  } catch (err) {
    console.warn("[EMAIL] @sendgrid/mail not installed");
    return null;
  }
})();

let configured = false;

function ensureConfigured() {
  if (!sgMail) return false;
  if (configured) return true;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return false;
  sgMail.setApiKey(apiKey);
  configured = true;
  return true;
}

function getFromAddress() {
  return process.env.EMAIL_FROM || "";
}

async function sendUrgentEmail(to) {
  if (!to) return false;
  if (!ensureConfigured()) return false;
  const from = getFromAddress();
  if (!from) return false;
  try {
    await sgMail.send({
      to,
      from,
      subject: "Urgent message",
      text: "You have an urgent message.",
    });
    return true;
  } catch (err) {
    console.error("[EMAIL] send error:", err.message || err);
    return false;
  }
}

module.exports = { sendUrgentEmail };
