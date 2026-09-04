// FlyTAP — per-request frontend attribution (v1 vs v2), shared across modules.
// A single AsyncLocalStorage instance is created here so server.js (which sets it from
// the X-App header) and email.js (which reads it to tag the emails table) use the SAME
// context. Default "v1" preserves the legacy app's behaviour when no header is present.
const { AsyncLocalStorage } = require("node:async_hooks");
const appCtx = new AsyncLocalStorage();
const currentApp = () => { const s = appCtx.getStore(); return (s && s.app) || "v1"; };
// The acting user's uid for the current request/timer, stashed into the same store by the
// resolveUid middleware. Lets identity-blind helpers (log/cdpForward) attribute CDP events
// to the real actor. null when no request context (caller should fall back to a default).
const currentUid = () => { const s = appCtx.getStore(); return (s && s.uid) || null; };
module.exports = { appCtx, currentApp, currentUid };
