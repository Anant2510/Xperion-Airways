const crypto = require("node:crypto");
const { db } = require("./db");

// The single, explicit default identity for requests that bind NO session and resolve no
// phone — the "demo default" user (uid 1 = Daniel). Env-overridable. This replaces the old
// silent `return 1`: every entry point (web/agent/WhatsApp) now references THIS constant, so
// flipping unbound→guest in the post-step-12 strict cutover is a one-line change here.
const SERVER_DEFAULT_UID = Number(process.env.SERVER_DEFAULT_UID) || 1;
// Admin / demo-console context runs as the demo user explicitly (not via the request default).
const SYSTEM_UID = SERVER_DEFAULT_UID;

// In-memory session→user map. 15-user demo: no external store needed.
// { sessionId: { uid, source } }   source = 'sqlite' | 'adobe' (option b, per-session)
const sessions = new Map();

function newSessionId() { return "s_" + crypto.randomBytes(12).toString("hex"); }

// Bind a session to a user id (called at login / persona-pick / registration).
// `admin` marks an operator session (Admin Console) — gates the ops/all-users endpoints.
function bindSession(sessionId, uid, source = "sqlite", admin = false) {
  sessions.set(sessionId, { uid, source, admin: !!admin });
}

function getSession(sessionId) {
  return sessionId ? sessions.get(sessionId) || null : null;
}

// True when the request's session is an admin/operator session.
function isAdmin(req, opts = {}) {
  const sid = (req && (req.headers["x-session-id"] || (req.body && req.body.sessionId) || (req.query && req.query.sessionId))) || opts.sessionId;
  const s = getSession(sid);
  return !!(s && s.admin);
}

// Unbind a session (logout). Returns true if a binding was removed.
function unbindSession(sessionId) {
  return sessionId ? sessions.delete(sessionId) : false;
}

// THE resolver. Priority:
//   1. explicit session binding (web/chat)         — X-Session-Id header or body.sessionId
//   2. phone→user (WhatsApp)                        — passed in by the WA layer
//   3. fallback to 1 (PRE-MIGRATION SAFETY DEFAULT) — preserves today's behaviour
function resolveUid(req, opts = {}) {
  const sid = (req && (req.headers["x-session-id"] || (req.body && req.body.sessionId) || (req.query && req.query.sessionId))) || opts.sessionId;
  const s = getSession(sid);
  if (s && s.uid) return s.uid;
  if (opts.phone) { const u = userByPhone(opts.phone); if (u) return u.id; }
  return SERVER_DEFAULT_UID; // explicit demo default (model b); flip to a guest sentinel in the strict cutover
}

function userByPhone(raw) {
  const tail = String(raw || "").replace(/[^0-9]/g, "").slice(-9);
  if (!tail) return null;
  const cmp = "replace(replace(replace(phone,' ',''),'+',''),'-','')";
  return db.prepare(`SELECT * FROM users WHERE ${cmp} LIKE ?`).get("%" + tail) || null;
}

function sessionSource(req, opts = {}) {
  const sid = (req && (req.headers["x-session-id"] || (req.body && req.body.sessionId))) || opts.sessionId;
  const s = getSession(sid);
  return (s && s.source) || require("./db").getDataSource(); // global default if unbound
}

module.exports = { newSessionId, bindSession, getSession, unbindSession, resolveUid, sessionSource, isAdmin, userByPhone, SERVER_DEFAULT_UID, SYSTEM_UID, _sessions: sessions };
