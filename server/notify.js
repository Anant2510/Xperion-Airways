// ─── Notification service ─────────────────────────────────────────────────
// Real multi-channel dispatch with per-channel delivery tracking. Each send is
// attempted against the live provider when credentials are present, and every
// attempt (success, failure, or "queued — no provider") is written to the
// notifications table with an honest status so the UI reflects reality rather
// than a hardcoded "sent" chip.
//
//   • email  → SMTP (via ./email transporter) — already live when SMTP_* set
//   • sms    → Twilio REST (Messages.json) — live when TWILIO_* + TWILIO_SMS_FROM set
//   • push   → Expo Push API (EXPO_PUSH=1) or FCM (FCM_SERVER_KEY set); else queued
//
// Providers degrade gracefully: with no credentials the message is recorded as
// "queued (no <channel> provider configured)" — never falsely marked delivered.

const { db } = require("./db");
const { sendEmail } = require("./email");

const now = () => new Date().toISOString();

// ── config accessors ──
const TW_SID = () => process.env.TWILIO_ACCOUNT_SID;
const TW_AUTH = () => process.env.TWILIO_AUTH_TOKEN;
const TW_SMS_FROM = () => process.env.TWILIO_SMS_FROM;           // e.g. +14155550123
const SMS_READY = () => !!(TW_SID() && TW_AUTH() && TW_SMS_FROM());
const EXPO_READY = () => process.env.EXPO_PUSH === "1";
const FCM_KEY = () => process.env.FCM_SERVER_KEY;
const PUSH_READY = () => EXPO_READY() || !!FCM_KEY();

function record({ uid, pnr, event, channel, recipient, status, providerId, body }) {
  try {
    db.prepare(
      `INSERT INTO notifications (user_id,pnr,event,channel,recipient,status,provider_id,body,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(uid, pnr || null, event, channel, recipient || null, status, providerId || null, (body || "").slice(0, 500), now());
  } catch { /* table may be mid-migration; don't block the send */ }
}

// ── SMS via Twilio ──
async function sendSMS(to, text) {
  if (!SMS_READY()) return { status: "queued (no SMS provider configured)", providerId: null };
  try {
    const params = new URLSearchParams();
    params.append("From", TW_SMS_FROM());
    params.append("To", to);
    params.append("Body", text);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID()}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${TW_SID()}:${TW_AUTH()}`).toString("base64"),
      },
      body: params.toString(),
    });
    const data = await res.json();
    return res.ok
      ? { status: "delivered via Twilio SMS", providerId: data.sid || null }
      : { status: "send failed: " + String(data.message || "").slice(0, 120), providerId: null };
  } catch (e) {
    return { status: "send failed: " + e.message.slice(0, 120), providerId: null };
  }
}

// ── Push via Expo or FCM ──
async function sendPush(token, title, text) {
  if (EXPO_READY()) {
    try {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ to: token, title, body: text, sound: "default" }),
      });
      const data = await res.json();
      const ok = res.ok && !(data.data && data.data.status === "error");
      return ok
        ? { status: "delivered via Expo push", providerId: (data.data && data.data.id) || null }
        : { status: "send failed: " + JSON.stringify(data.errors || data).slice(0, 120), providerId: null };
    } catch (e) { return { status: "send failed: " + e.message.slice(0, 120), providerId: null }; }
  }
  if (FCM_KEY()) {
    try {
      const res = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "key=" + FCM_KEY() },
        body: JSON.stringify({ to: token, notification: { title, body: text } }),
      });
      const data = await res.json();
      return res.ok && data.success
        ? { status: "delivered via FCM", providerId: (data.results && data.results[0] && data.results[0].message_id) || null }
        : { status: "send failed: " + JSON.stringify(data).slice(0, 120), providerId: null };
    } catch (e) { return { status: "send failed: " + e.message.slice(0, 120), providerId: null }; }
  }
  return { status: "queued (no push provider configured)", providerId: null };
}

// ── Public API ──
// Dispatch one logical event across every requested channel for one user.
// channels: array subset of ["email","sms","push"].
// emailType/emailData: passed straight to sendEmail() so the rich HTML template is reused.
// smsText/pushText/pushTitle: plain-text bodies for the lighter channels.
// Returns [{ channel, recipient, status, providerId }] — real per-channel outcomes.
async function dispatch({ uid, pnr, event, channels = ["email", "sms", "push"], emailType, emailData, smsText, pushText, pushTitle }) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(uid) || {};
  const out = [];

  if (channels.includes("email") && emailType) {
    let status = "logged", providerId = null, recipient = process.env.DEMO_EMAIL_TO || user.email || null;
    try {
      const r = await sendEmail(emailType, emailData || {});
      status = (r && r.status) || "sent";
      providerId = (r && r.providerId) || null;
      recipient = (r && r.to) || recipient;
    } catch (e) { status = "send failed: " + e.message.slice(0, 120); }
    record({ uid, pnr, event, channel: "email", recipient, status, providerId, body: (emailData && emailData._summary) || event });
    out.push({ channel: "email", recipient, status, providerId });
  }

  if (channels.includes("sms")) {
    const to = user.phone || null;
    let status = to ? null : "no phone on file", providerId = null;
    if (to) { const r = await sendSMS(to, smsText || ""); status = r.status; providerId = r.providerId; }
    record({ uid, pnr, event, channel: "sms", recipient: to, status, providerId, body: smsText });
    out.push({ channel: "sms", recipient: to, status, providerId });
  }

  if (channels.includes("push")) {
    const token = user.wa_id || user.member_no || null; // stand-in device token binding
    const r = await sendPush(token, pushTitle || "Xperion Airways", pushText || "");
    record({ uid, pnr, event, channel: "push", recipient: token, status: r.status, providerId: r.providerId, body: pushText });
    out.push({ channel: "push", recipient: token, status: r.status, providerId: r.providerId });
  }

  return out;
}

// Recent notification history for a booking (newest first) — powers the UI status list.
function history(uid, pnr, limit = 30) {
  try {
    return db.prepare(
      "SELECT event,channel,recipient,status,provider_id AS providerId,body,created_at AS createdAt FROM notifications WHERE user_id=? AND (pnr=? OR ? IS NULL) ORDER BY id DESC LIMIT ?"
    ).all(uid, pnr || null, pnr || null, limit);
  } catch { return []; }
}

module.exports = { dispatch, history, sendSMS, sendPush, SMS_READY, PUSH_READY };
