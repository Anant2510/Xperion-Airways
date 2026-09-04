#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────────────
   FlyTAP — Goal-B regression + concurrency harness
   ---------------------------------------------------------------------------
   Purpose: establish a GREEN BASELINE of the current single-user app, then
   (once a session→user seam exists) drive N concurrent sessions as DIFFERENT
   users and assert ZERO cross-session contamination.

   This script touches NO production code. It only makes HTTP calls against the
   running server and checks the responses. Run it BEFORE any refactor to record
   known-good behaviour, and after every refactor step to prove nothing broke.

   USAGE (on the VM, with the server running on $PORT):
     node scripts/_qa_multiuser.mjs                 # baseline single-user checks
     node scripts/_qa_multiuser.mjs --base http://localhost:7801
     node scripts/_qa_multiuser.mjs --concurrency   # 15-session bleed test (later phase)
     node scripts/_qa_multiuser.mjs --snapshot out.json   # write a baseline snapshot file
     node scripts/_qa_multiuser.mjs --compare out.json    # diff current behaviour vs a saved snapshot

   The concurrency test is INERT until the server supports per-session identity
   (it will simply report that all sessions resolve to the same user — which is
   the CURRENT, pre-refactor truth — and that becomes a PASS-condition flip once
   the seam lands).
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync } from "node:fs";

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const has = (flag) => args.includes(flag);
const BASE = argVal("--base", process.env.QA_BASE || "http://localhost:7801");
const SNAPSHOT_OUT = argVal("--snapshot", null);
const COMPARE_IN = argVal("--compare", null);
const RUN_CONCURRENCY = has("--concurrency");
const VERBOSE = has("--verbose") || has("-v");

// ── tiny http client ──────────────────────────────────────────────────────
async function call(method, path, { body, headers, sessionId } = {}) {
  const h = { "Content-Type": "application/json", ...(headers || {}) };
  // The seam-to-come: a session id the client passes. Today the server ignores
  // it for identity (everything is user 1); after the refactor it will bind a user.
  if (sessionId) h["X-Session-Id"] = sessionId;
  let res, text, json;
  try {
    res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e), json: null, text: "" };
  }
  return { ok: res.ok, status: res.status, json, text };
}
// After cutover, identity comes from the session — the baseline logs in as Daniel and
// carries that session id on every call (explicit per-call sessionId still wins, so the
// concurrency section's own per-session ids are unaffected).
let BASELINE_SID = null;
const get = (p, opts) => call("GET", p, { ...(opts || {}), sessionId: (opts && opts.sessionId) || BASELINE_SID });
const post = (p, body, opts) => call("POST", p, { ...(opts || {}), body, sessionId: (opts && opts.sessionId) || BASELINE_SID });

// ── result accounting ──────────────────────────────────────────────────────
const results = [];
function check(name, group, condition, detail = "") {
  const ok = !!condition;
  results.push({ name, group, ok, detail });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  [${group}] ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}
function note(msg) { if (VERBOSE) console.log(`        · ${msg}`); }

// ── snapshot capture (records key fields for before/after diffing) ──────────
const snapshot = {};
function record(key, value) { snapshot[key] = value; }

// ───────────────────────────────────────────────────────────────────────────
//  BASELINE — current single-user behaviour. These should all PASS today and
//  must KEEP passing after every refactor step (zero-behaviour-change gates).
// ───────────────────────────────────────────────────────────────────────────
async function baseline() {
  console.log(`\n▶ BASELINE (single-user) against ${BASE}\n`);

  // Cutover: log in as Daniel and carry the session on every baseline check, so this tests
  // "logged-in Daniel" rather than "unbound default". Recorded identity stays PT-990001, so
  // --compare against the existing baseline.json stays green. (No record() here → snapshot
  // is unchanged; this only adds a PASS line.)
  {
    BASELINE_SID = null;   // ensure the login call itself is unbound
    const r = await post("/api/auth/login", { persona: "daniel" });
    BASELINE_SID = r.json && r.json.sessionId;
    check("login as daniel", "auth", !!BASELINE_SID && r.json && r.json.user && r.json.user.member_no === "PT-990001",
      r.json && r.json.user ? `sid=${String(BASELINE_SID).slice(0, 10)}… · ${r.json.user.member_no}` : "login failed");
  }

  // health
  {
    const r = await get("/api/health");
    check("server reachable", "health", r.ok && r.json && r.json.ok === true, r.json ? `db=${r.json.db ? "ok" : "?"}` : r.error);
    record("health", r.json);
  }

  // active persona + profile identity
  let activeMember = null, activeEmail = null, activeTier = null;
  {
    const r = await get("/api/profile");
    const u = r.json && r.json.user;
    activeMember = u && u.member_no; activeEmail = u && u.email; activeTier = u && u.tier;
    check("profile loads with identity", "profile", !!(u && u.member_no && u.email),
      u ? `${u.full_name} · ${u.member_no} · ${u.tier} · ${u.email}` : "no user");
    record("profile.user", u ? { member_no: u.member_no, email: u.email, tier: u.tier, home_airport: u.home_airport, miles: u.miles } : null);
    record("profile.pattern", r.json && r.json.pattern ? { topRoute: r.json.pattern.topRoute, topFlight: r.json.pattern.topFlight } : null);
  }

  // personas list + which is active
  {
    const r = await get("/api/personas");
    const list = r.json && r.json.personas;
    check("personas list present", "persona", Array.isArray(list) && list.length >= 3, list ? `${list.length} personas, active=${r.json.active}` : "none");
    record("personas.active", r.json && r.json.active);
    record("personas.count", Array.isArray(list) ? list.length : 0);
  }

  // bookings belong to the active user
  {
    const r = await get("/api/bookings");
    const rows = Array.isArray(r.json) ? r.json : [];
    check("bookings load", "bookings", rows.length >= 1, `${rows.length} bookings`);
    record("bookings.count", rows.length);
    record("bookings.pnrs", rows.slice(0, 5).map(b => b.pnr));
  }

  // search returns flights + logs a journey
  {
    const r = await get("/api/search?origin=OPO&dest=LIS&date=2026-06-15");
    const flights = r.json && r.json.flights;
    check("search OPO→LIS returns flights", "search", Array.isArray(flights) && flights.length > 0, `${flights ? flights.length : 0} flights`);
    record("search.opo_lis.count", Array.isArray(flights) ? flights.length : 0);
  }
  {
    const r = await get("/api/journey");
    check("journey reflects last search", "journey", r.json && (r.json.stage === "results" || r.json.dest === "LIS"),
      r.json ? `stage=${r.json.stage} dest=${r.json.dest}` : "none");
    record("journey.afterSearch", r.json ? { stage: r.json.stage, origin: r.json.origin, dest: r.json.dest } : null);
  }

  // wallet via agent (read-only, no mutation)
  {
    const r = await post("/api/ai/agent", { messages: [{ role: "user", content: "what's my miles balance" }], sessionId: "qa-baseline" });
    const reply = r.json && r.json.reply;
    check("agent wallet query answers", "agent", !!reply && /mile/i.test(reply), reply ? reply.slice(0, 80) : "no reply");
    record("agent.wallet.tools", r.json && r.json.tools);
  }

  // offers tiles derive from the active user
  {
    const r = await get("/api/offers/tiles");
    const tiles = r.json && r.json.tiles;
    check("offer tiles build", "offers", Array.isArray(tiles) && tiles.length > 0, tiles ? `${tiles.length} tiles, tier=${r.json.tier}` : "none");
    record("offers.tier", r.json && r.json.tier);
    record("offers.tileCount", Array.isArray(tiles) ? tiles.length : 0);
  }

  // CDP admin view — capture the userId stamped on track events (the contamination canary)
  {
    const r = await get("/api/admin/cdp");
    const ev = r.json && Array.isArray(r.json.events) ? r.json.events : [];
    const sampleUserId = ev.find(e => e.cdpPayload)?.cdpPayload?.userId;
    check("cdp admin view loads", "cdp", !!(r.json && r.json.counts), r.json ? `users=${r.json.counts && r.json.counts.users}` : "none");
    // NOTE: today this is hardcoded "user_1" — after the refactor it must be the real member.
    record("cdp.track.userId", sampleUserId || null);
    record("cdp.counts.users", r.json && r.json.counts && r.json.counts.users);
    note(`track.userId currently = ${sampleUserId} (must become per-user after refactor)`);
  }

  // self-test endpoint (the app's own 17 checks)
  {
    const r = await get("/api/admin/selftest");
    check("app self-test green", "selftest", r.json && r.json.ok === true, r.json ? `${r.json.passed}/${r.json.total} passed` : "no result");
    record("selftest", r.json ? { ok: r.json.ok, passed: r.json.passed, total: r.json.total } : null);
  }

  // datasource current state
  {
    const r = await get("/api/datasource");
    check("datasource endpoint", "datasource", r.json && !!r.json.source, r.json ? `source=${r.json.source} persona=${r.json.persona}` : "none");
    record("datasource.source", r.json && r.json.source);
  }

  record("_activeIdentity", { member: activeMember, email: activeEmail, tier: activeTier });
}

// ───────────────────────────────────────────────────────────────────────────
//  CONCURRENCY — the Goal-B proof. Drives N sessions as DIFFERENT users and
//  asserts isolation. INERT/expected-to-show-shared today; becomes the gate
//  once the session→user seam lands.
// ───────────────────────────────────────────────────────────────────────────
async function concurrency() {
  console.log(`\n▶ CONCURRENCY (per-session isolation) against ${BASE}\n`);
  console.log("  Each session binds to its own user, then ALL sessions concurrently read");
  console.log("  their own profile/wallet/journey. Isolation = every session sees exactly");
  console.log("  the user it bound to (got === want), with zero cross-session bleed.\n");

  // Discover the personas we can bind sessions to (list payload has id, not member_no).
  const personasRes = await get("/api/personas");
  const personas = (personasRes.json && personasRes.json.personas) || [];
  if (personas.length < 2) {
    check("enough users to test isolation", "concurrency", false, "need ≥2 seeded users; run after multi-user seed lands");
    return;
  }

  // One session per available persona (so each 'want' is a distinct user), plus extra
  // sessions cycling the same personas to exercise concurrent same-user sessions too.
  const SESSIONS = Math.max(personas.length, Math.min(15, personas.length * 3));
  const sessions = Array.from({ length: SESSIONS }, (_, i) => ({
    sessionId: `qa-sess-${i}-${Math.random().toString(36).slice(2, 8)}`,
    wantPersona: personas[i % personas.length].id,
  }));

  // Phase 1 — BIND each session to its persona and capture the member it resolved to,
  // straight from the bind response (which returns uid + user). This is the session's
  // ground-truth 'want': the member the server says this session now IS.
  async function bind(s) {
    const r = await post("/api/persona", { persona: s.wantPersona }, { sessionId: s.sessionId });
    const j = r.json || {};
    // Bind response shape: { ok, sessionId, uid, persona, user:{...} }. member_no may not be
    // in the trimmed user object, so confirm via a profile read with the same session id.
    const prof = await get("/api/profile", { sessionId: s.sessionId });
    const member = prof.json && prof.json.user && prof.json.user.member_no;
    return { ...s, uid: j.uid, want: member, boundPersona: j.persona };
  }
  const bound = await Promise.all(sessions.map(bind));

  // Phase 2 — CONCURRENT reads. Fire every session's profile + wallet + journey at once,
  // interleaved, and check each response carries that session's OWN identity.
  async function readAll(s) {
    const [prof, wallet, journey] = await Promise.all([
      get("/api/profile", { sessionId: s.sessionId }),
      post("/api/ai/agent", { messages: [{ role: "user", content: "what is my miles balance" }], sessionId: s.sessionId }),
      get("/api/journey", { sessionId: s.sessionId }),
    ]);
    const gotMember = prof.json && prof.json.user && prof.json.user.member_no;
    return { sessionId: s.sessionId, want: s.want, got: gotMember, uid: s.uid,
      walletOk: !!(wallet.json && wallet.json.reply) };
  }
  const observed = await Promise.all(bound.map(readAll));

  // Assertions ---------------------------------------------------------------
  const allBound = observed.every(o => o.want);                  // every session got a member at bind
  const isolated = observed.filter(o => o.got && o.want && o.got === o.want).length;
  const distinctWant = new Set(observed.map(o => o.want)).size;
  const distinctGot = new Set(observed.map(o => o.got)).size;

  note(`sessions: ${observed.length}, distinct users bound: ${distinctWant}, distinct users observed: ${distinctGot}`);
  observed.forEach(o => note(`session ${o.sessionId.slice(0, 14)} uid=${o.uid} want=${o.want} got=${o.got} ${o.got === o.want ? "OK" : "MISMATCH"}`));

  // Gate 1 — every session bound to a real user (sanity that binding works at all).
  check("every session bound to a user", "concurrency", allBound,
    allBound ? `${observed.length}/${observed.length} bound` : `${observed.filter(o=>o.want).length}/${observed.length} bound — bind/persona issue`);

  // Gate 2 — THE Goal-B isolation gate: each session sees exactly its own bound user.
  check("each session sees its OWN user (no bleed)", "concurrency", isolated === observed.length,
    `${isolated}/${observed.length} sessions correctly isolated` + (isolated === observed.length ? "" : " — CROSS-SESSION BLEED"));

  // Gate 3 — the test actually exercised multiple distinct users (not a trivial pass).
  check("multiple distinct users exercised", "concurrency", distinctWant >= 2,
    `${distinctWant} distinct users bound across ${observed.length} sessions`);
}

// ───────────────────────────────────────────────────────────────────────────
//  snapshot compare
// ───────────────────────────────────────────────────────────────────────────
function compareSnapshot(savedPath) {
  let saved;
  try { saved = JSON.parse(readFileSync(savedPath, "utf8")); }
  catch (e) { console.log(`\n✖ could not read snapshot ${savedPath}: ${e.message}`); return; }
  console.log(`\n▶ COMPARE vs ${savedPath}\n`);
  const keys = new Set([...Object.keys(saved), ...Object.keys(snapshot)]);
  let diffs = 0;
  for (const k of keys) {
    const a = JSON.stringify(saved[k]); const b = JSON.stringify(snapshot[k]);
    if (a !== b) {
      diffs++;
      console.log(`  \x1b[33mDIFF\x1b[0m ${k}`);
      console.log(`        was: ${a}`);
      console.log(`        now: ${b}`);
    }
  }
  if (!diffs) console.log("  \x1b[32mNo differences\x1b[0m — behaviour matches the saved baseline.");
  else console.log(`\n  ${diffs} field(s) changed vs baseline. Review whether each is intended.`);
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(72));
  console.log("FlyTAP Goal-B harness  ·  " + new Date().toISOString());
  console.log("═".repeat(72));

  await baseline();
  if (RUN_CONCURRENCY) await concurrency();

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log("\n" + "─".repeat(72));
  console.log(`RESULT: ${passed}/${total} checks passed`);
  const fails = results.filter(r => !r.ok);
  if (fails.length) {
    console.log("\nFailures:");
    fails.forEach(f => console.log(`  ✖ [${f.group}] ${f.name}${f.detail ? " — " + f.detail : ""}`));
  }

  if (SNAPSHOT_OUT) {
    writeFileSync(SNAPSHOT_OUT, JSON.stringify(snapshot, null, 2));
    console.log(`\n✓ snapshot written to ${SNAPSHOT_OUT}`);
  }
  if (COMPARE_IN) compareSnapshot(COMPARE_IN);

  console.log("─".repeat(72) + "\n");
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error("harness error:", e); process.exit(2); });
