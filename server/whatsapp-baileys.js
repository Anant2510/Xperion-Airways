"use strict";
/* whatsapp-baileys.js — WhatsApp transport over Baileys (WhatsApp's multi-device protocol on a
   WebSocket). The server dials OUT to WhatsApp and holds the connection: no webhook, no public
   URL, no tunnel, no Twilio account. Conversation logic lives in whatsapp.js and is untouched;
   this module only moves bytes and resolves who sent them.

   Activation: WA_MODE=baileys (server.js boots it after listen). Anything else keeps the Twilio
   webhook path. Pairing credentials persist in data/baileys-auth/ (gitignored); delete the folder
   to force a new QR scan. Baileys is an unofficial client and runs against WhatsApp's terms —
   only ever pair a burner number.

   Identity: a sender whose number matches a persona is served as that member; anyone else is
   provisioned as an anonymous guest (real user row, no member number, tier, points or history).

   LID addressing: WhatsApp increasingly addresses chats by an opaque LID (…@lid) instead of a
   phone number. The real number is recovered from key.remoteJidAlt, falling back to the signal
   lidMapping store; replies always go to the JID a message actually arrived on, because a JID
   rebuilt from the phone number is not deliverable for a LID chat. */

const fs = require("fs");
const path = require("path");

const AUTH_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "baileys-auth");
const state = { sock: null, connected: false, me: null, lastQrAt: null, attempts: 0, stopping: false };
const jidBySender = new Map();   // bare phone digits → the JID their last message arrived on
let onInbound = null;            // async ({ from, text, pushName }) => void, injected by start()

const digits = (s) => String(s || "").replace(/[^0-9]/g, "");
const pnJid = (phone) => `${digits(phone)}@s.whatsapp.net`;
const isGroup = (jid) => /@g\.us$/.test(jid || "");
const isBroadcast = (jid) => /@broadcast$/.test(jid || "") || jid === "status@broadcast";
const isLid = (jid) => /@lid$/.test(jid || "");

/* text from whichever message shape arrived */
function extractText(msg) {
  if (!msg) return "";
  const m = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText || m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title || m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText || m.templateButtonReplyMessage?.selectedId ||
    m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption ||
    ""
  ).trim();
}

/* resolve the real phone number for a message key (LID → PN) */
async function phoneFor(key) {
  const jid = key.remoteJid || "";
  if (!isLid(jid)) return digits(jid.split("@")[0]);
  if (key.remoteJidAlt) return digits(String(key.remoteJidAlt).split("@")[0]);
  try {
    const store = state.sock?.signalRepository?.lidMapping;
    const pn = store?.getPNForLID ? await store.getPNForLID(jid) : null;
    if (pn) return digits(String(pn).split("@")[0]);
  } catch {}
  return null;
}

/* Pure dispatcher (testable without a socket): normalise one upsert and hand it to the app. */
async function dispatch(m, opts = {}) {
  if (!m?.message || m.key?.fromMe) return null;
  const jid = m.key?.remoteJid || "";
  if (isGroup(jid) || isBroadcast(jid)) return null;
  const text = extractText(m.message);
  if (!text) return null;
  const phone = opts.phone || (await phoneFor(m.key));
  if (!phone) { console.warn("[wa:baileys] could not resolve sender for", jid); return null; }
  jidBySender.set(phone, jid);
  const from = "whatsapp:+" + phone;
  if (onInbound) await onInbound({ from, text, pushName: m.pushName || null, jid });
  return { from, text, jid };
}

/* Outbound: to may be "whatsapp:+91…", "+91…", digits, or a JID. Returns an honest status. */
async function send(to, text) {
  if (!state.sock || !state.connected) return "queued (WhatsApp not connected)";
  const raw = String(to || "");
  const jid = /@/.test(raw) ? raw : (jidBySender.get(digits(raw)) || pnJid(raw));
  try {
    await state.sock.sendMessage(jid, { text });
    return "delivered via WhatsApp (Baileys)";
  } catch (e) { return "send failed: " + String(e?.message || e).slice(0, 120); }
}

async function start({ onMessage, log = console.log } = {}) {
  onInbound = onMessage || onInbound;
  const baileys = require("baileys");
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  const pino = (() => { try { return require("pino")({ level: "silent" }); } catch { return undefined; } })();

  const sock = makeWASocket({
    version, auth, logger: pino, printQRInTerminal: false,
    browser: ["Xperion Airways", "Chrome", "1.0"], markOnlineOnConnect: false, syncFullHistory: false,
  });
  state.sock = sock; state.stopping = false;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      state.lastQrAt = new Date().toISOString();
      log("\n   WhatsApp pairing — scan with the burner phone: WhatsApp → Settings → Linked Devices → Link a Device");
      try { require("qrcode-terminal").generate(qr, { small: true }); } catch { log("   (qrcode-terminal missing; raw QR data) " + qr); }
      log("   The QR refreshes about every 20 seconds.\n");
    }
    if (connection === "open") {
      state.connected = true; state.attempts = 0;
      state.me = "+" + digits((sock.user?.id || "").split(":")[0].split("@")[0]);
      log(`   ✓ WhatsApp connected via Baileys as ${state.me}`);
    }
    if (connection === "close") {
      state.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (state.stopping) return;
      if (code === DisconnectReason.loggedOut) {
        log("   WhatsApp session logged out — delete data/baileys-auth and restart to pair again");
        return;
      }
      /* 515 right after pairing is WhatsApp forcing one reconnect for a new device; other codes are network */
      const wait = Math.min(30000, 3000 * Math.max(1, ++state.attempts));
      log(`   WhatsApp connection closed (${code || "unknown"}); reconnecting in ${wait / 1000}s`);
      setTimeout(() => start({ onMessage: onInbound, log }).catch((e) => log("   WhatsApp reconnect failed: " + e.message)), wait);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) { try { await dispatch(m); } catch (e) { console.error("[wa:baileys] inbound error:", e.message); } }
  });
  return sock;
}

async function stop() { state.stopping = true; try { state.sock?.end?.(); } catch {} state.connected = false; }
function status() { return { mode: "baileys", connected: state.connected, me: state.me, authDir: AUTH_DIR, paired: fs.existsSync(path.join(AUTH_DIR, "creds.json")), lastQrAt: state.lastQrAt }; }

module.exports = { start, stop, send, status, dispatch, extractText, _state: state, _jidBySender: jidBySender };
