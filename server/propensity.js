"use strict";
/* ──────────────────────────────────────────────────────────────────────────
   FlyTAP — ancillary propensity models (Modern Retailing engine)
   ----------------------------------------------------------------------------
   Trains one small logistic-regression model PER ANCILLARY CODE from the real
   rows already in SQLite (bookings.items_json × users), at boot and on demand.
   No dependencies — plain-JS gradient descent over ~7 features. Training takes
   milliseconds at demo scale.

   Honesty rules (these matter for the showcase):
   • The model is trained ONLY on rows that exist in the DB. `info()` reports
     the row count per code; nothing is fabricated.
   • Historical attach rate is computed LEAVE-ONE-OUT during training so the
     label never leaks into its own feature.
   • When a code has too few rows (< MIN_ROWS) the score is blended toward the
     global attach prior and flagged `low_confidence: true`.
   • Every score ships with `drivers[]` — the top signed feature contributions
     in plain language — so the demo can show WHY, not just a number.
   ────────────────────────────────────────────────────────────────────────── */

const { db } = require("./db");

const MIN_ROWS = 8;          // per-code rows below this → blend with prior
const EPOCHS = 400;
const LR = 0.4;
const L2 = 1e-3;

const TIER_ORD = { Bronze: 0, Silver: 1, Gold: 2, Platinum: 3 };
const sig = (z) => 1 / (1 + Math.exp(-z));
const codeOf = (i) => (typeof i === "string" ? i : (i && (i.code || i.id || i.name)) || "").toString().toLowerCase();

/* Feature vector — order is the contract between train() and score().
   [0] bias
   [1] tier (0..1)
   [2] miles (log-scaled 0..1)
   [3] shortHaul (1 = ≤150 min / domestic hop)
   [4] tripCount (0..1, capped at 20)
   [5] histAttach — this customer's past attach rate for THIS code (leave-one-out in training)
   [6] affinityMatch — customer affinity maps to this code (lounge↔golf, etc.)              */
const FEATURE_LABELS = [
  "baseline",
  "loyalty tier",
  "miles balance",
  "short-haul trip",
  "travel frequency",
  "your past trips",
  "interest match",
];

const AFFINITY_CODE = { golf: ["lounge", "fast", "xbag"], football: ["fast", "meal"], music: ["lounge", "meal"] };

function userFeatures(u) {
  return {
    tier: (TIER_ORD[u.tier] ?? 0) / 3,
    miles: Math.min(1, Math.log10((u.miles || 0) + 1) / 6),
    affinity: String(u.affinity || "").toLowerCase(),
  };
}

function featVec(uf, ctx, code, histAttach) {
  const aff = (AFFINITY_CODE[uf.affinity] || []).includes(code) ? 1 : 0;
  return [1, uf.tier, uf.miles, ctx.shortHaul ? 1 : 0, Math.min(1, (ctx.tripCount || 0) / 20), histAttach, aff];
}

/* ── training-set assembly from real rows ── */
function dataset() {
  const users = {};
  for (const u of db.prepare("SELECT id, tier, miles, affinity, home_airport FROM users").all()) users[u.id] = u;
  const codes = db.prepare("SELECT code FROM ancillaries").all().map((r) => r.code.toLowerCase());
  const rows = db.prepare("SELECT user_id, flight_no, items_json, meta_json FROM bookings WHERE status!='cancelled'").all();

  // per-user per-code attach counts (for leave-one-out)
  const attach = {}, trips = {};
  const parsed = rows.map((r) => {
    let items = []; try { items = (JSON.parse(r.items_json || "[]") || []).map(codeOf); } catch {}
    trips[r.user_id] = (trips[r.user_id] || 0) + 1;
    for (const c of new Set(items)) {
      attach[r.user_id] = attach[r.user_id] || {};
      attach[r.user_id][c] = (attach[r.user_id][c] || 0) + 1;
    }
    let shortHaul = 0.5;
    try { const m = JSON.parse(r.meta_json || "null"); if (m && m.duration) shortHaul = /^\s*(\d+)h/.test(m.duration) && Number(RegExp.$1) >= 2 ? 0 : 1; } catch {}
    return { uid: r.user_id, items: new Set(items), shortHaul };
  });

  const sets = {};
  for (const code of codes) {
    const X = [], Y = [];
    for (const b of parsed) {
      const u = users[b.uid]; if (!u) continue;
      const uf = userFeatures(u);
      const y = b.items.has(code) ? 1 : 0;
      const n = trips[b.uid] || 1;
      const a = ((attach[b.uid]?.[code] || 0) - y) / Math.max(1, n - 1);   // leave-one-out
      X.push(featVec(uf, { shortHaul: b.shortHaul, tripCount: n }, code, a));
      Y.push(y);
    }
    sets[code] = { X, Y };
  }
  return { sets, codes, users, attach, trips };
}

/* ── plain gradient descent ── */
function fit(X, Y) {
  const d = X[0]?.length || 7;
  const w = new Array(d).fill(0);
  for (let e = 0; e < EPOCHS; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const err = sig(X[i].reduce((s, x, j) => s + x * w[j], 0)) - Y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= LR * (g[j] / Math.max(1, X.length) + L2 * w[j]);
  }
  return w;
}

const MODEL = { ready: false, trainedAt: null, perCode: {}, prior: {}, globalRows: 0 };

function train() {
  try {
    const { sets, codes } = dataset();
    let total = 0;
    for (const code of codes) {
      const { X, Y } = sets[code];
      const pos = Y.reduce((s, y) => s + y, 0);
      MODEL.prior[code] = Y.length ? pos / Y.length : 0.3;
      MODEL.perCode[code] = { w: X.length ? fit(X, Y) : null, rows: X.length, positives: pos };
      total += X.length;
    }
    MODEL.globalRows = total;
    MODEL.trainedAt = new Date().toISOString();
    MODEL.ready = true;
  } catch (e) {
    MODEL.ready = false;
    MODEL.error = String((e && e.message) || e);
  }
  return info();
}

function info() {
  return {
    ready: MODEL.ready,
    algorithm: "logistic regression (per ancillary), leave-one-out history feature",
    trained_at: MODEL.trainedAt,
    training_rows: MODEL.globalRows,
    features: FEATURE_LABELS,
    per_code: Object.fromEntries(Object.entries(MODEL.perCode).map(([c, m]) => [c, { rows: m.rows, positives: m.positives, low_confidence: m.rows < MIN_ROWS }])),
    error: MODEL.error || null,
  };
}

/* Score every catalogue code for one customer + trip context. */
function scoreAll(user, ctx = {}) {
  if (!MODEL.ready) train();
  const uf = userFeatures(user);
  const n = db.prepare("SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status!='cancelled'").get(user.id)?.c || 0;
  const out = {};
  for (const [code, m] of Object.entries(MODEL.perCode)) {
    const hist = histAttach(user.id, code, n);
    const x = featVec(uf, { shortHaul: ctx.shortHaul, tripCount: n }, code, hist);
    let p, drivers = [];
    if (m.w) {
      const contrib = x.map((v, j) => v * m.w[j]);
      p = sig(contrib.reduce((s, c) => s + c, 0));
      drivers = contrib
        .map((c, j) => ({ label: FEATURE_LABELS[j], c }))
        .filter((d, j) => j > 0 && Math.abs(d.c) > 0.15)
        .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
        .slice(0, 3)
        .map((d) => ({ label: d.label, direction: d.c > 0 ? "+" : "−" }));
    } else p = MODEL.prior[code] ?? 0.3;
    const low = (m.rows || 0) < MIN_ROWS;
    if (low) p = 0.5 * p + 0.5 * (MODEL.prior[code] ?? 0.3);
    if (hist > 0) drivers.unshift({ label: `added on ${Math.round(hist * n)} of ${n} past trips`, direction: "+" });
    out[code] = { p: +p.toFixed(3), low_confidence: low, drivers: drivers.slice(0, 3) };
  }
  return out;
}

function histAttach(uid, code, n) {
  if (!n) return 0;
  const rows = db.prepare("SELECT items_json FROM bookings WHERE user_id=? AND status!='cancelled'").all(uid);
  let c = 0;
  for (const r of rows) { try { if ((JSON.parse(r.items_json || "[]") || []).map(codeOf).includes(code)) c++; } catch {} }
  return c / n;
}

module.exports = { train, scoreAll, info, MODEL };
