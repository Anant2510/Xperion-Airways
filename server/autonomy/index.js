/* autonomy/index.js — HTTP surface for the autonomy layer.
   /api/autonomy/* : status + KPIs, graph stats, audit trail, the replayable
   golden simulation, one-tap accept, decline, Tier-2 queue + approve, and the
   kill switch. The ops-controller page at /autonomy/ consumes these. */
"use strict";
const express = require("express");
const G = require("./graph");
const O = require("./ontology");
const P = require("./policy");
const A = require("./agents");
const orch = require("./orchestrator");
const sim = require("./sim");
const V = require("./vendors");
const bridge = require("./bridge");
const research = require("./research");
const briefs = require("./briefs");
const feeds = require("./feeds");
const { db } = require("../db");
/* the golden T-72 step also briefs the linked customers' XP201 trip (cached per city, so one
   research call serves all of them) */
async function briefLinked(reason) {
  const out = [];
  for (const l of bridge.linked()) {
    const b = db.prepare("SELECT * FROM bookings WHERE pnr=? AND user_id=?").get(l.pnr, l.uid);
    if (b) { try { out.push({ uid: l.uid, ...(await briefs.runForBooking(b, { reason })) }); } catch (e) { out.push({ uid: l.uid, ok: false, error: e.message }); } }
  }
  return out;
}

const router = express.Router();
router.use(express.json());
/* sim endpoints can be pressed out of order from the ops page: answer with a
   friendly 409 instead of a stack trace */
const safe = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (!res.headersSent) res.status(409).json({ ok: false, error: e.message }); } };
orch.wire();

router.get("/status", (_req, res) => res.json({ ok: true, ...orch.kpis(), graph: G.stats(), linked: bridge.linked() }));
router.get("/graph", (_req, res) => res.json({ ok: true, stats: G.stats(),
  predictions: G.nodesByKind("DisruptionPrediction"),
  sampleOffers: G.nodesByKind("Offer").slice(0, 5) }));
router.get("/audit", (req, res) => res.json({ ok: true, events: O.auditList(Number(req.query.limit) || 60) }));
router.get("/outbox", (_req, res) => res.json({ ok: true, sent: V.sent().slice(-40) }));

/* every world reset in the server runtime links the app's real customers into the graph
   (the in-process acceptance suite calls sim.reset() directly and stays synthetic-only) */
const resetLinked = () => { const seeded = sim.reset(); const { linked } = bridge.link(); if (bridge.liveTrips()) bridge.syncTrips().catch(() => {}); return { ...seeded, linked }; };
const ensureLinked = () => { if (!bridge.isLinked()) bridge.link(); };
router.post("/sim/reset", safe((_req, res) => res.json({ ok: true, ...resetLinked() })));
router.post("/sim/t72", safe(async (_req, res) => { ensureLinked(); const r = sim.t72(); const briefed = await briefLinked("T-72 (sim)"); res.json({ ok: true, ...r, pred: G.getNode(sim.state.predId), briefs: { sent: briefed.filter((b) => b.ok).length, of: briefed.length } }); }));
router.post("/sim/t48", safe((_req, res) => res.json({ ok: true, ...sim.t48() })));
router.post("/sim/accept", safe((_req, res) => res.json(sim.acceptSample())));
router.post("/sim/t0", safe((_req, res) => res.json({ ok: true, ...sim.t0() })));
router.post("/sim/golden", safe(async (_req, res) => {
  const seeded = resetLinked(); const a = sim.t72(); const briefed = await briefLinked("T-72 (golden)"); const b = sim.t48();
  const acc = sim.acceptSample(); const closed = sim.t0();
  res.json({ ok: true, seeded, watch: { probability: a.p }, act: { probability: b.p }, accepted: acc, closed, kpis: orch.kpis() });
}));

/* ── destination intelligence: live weather feeds, research briefs, T-72 proactive briefs ── */
router.get("/briefs", (_req, res) => res.json({ ok: true, research: research.status(), feeds: feeds.status(), briefs: research.list().map((b) => ({ id: b.id, city: b.city, code: b.code, window: b.window, impact: b.travel_impact, mode: b.mode, sources: b.source_count, generated_at: b.generated_at, summary: b.summary, error: b.error || null })) }));
router.get("/brief/:code", safe(async (req, res) => { const from = req.query.from || new Date().toISOString().slice(0, 10); const to = req.query.to || research.addDays(from, 3); res.json({ ok: true, brief: await research.build(req.params.code, from, to, { force: req.query.force === "1" }) }); }));
router.post("/briefs/run", safe(async (req, res) => res.json({ ok: true, ...(await briefs.run({ uids: req.body?.uids || (req.body?.uid ? [Number(req.body.uid)] : null), force: !!req.body?.force, reason: req.body?.reason || "manual" })) })));
/* brief the customer's NEXT trip only, as a background job the ops page can poll */
const jobs = new Map();
router.post("/briefs/next", (req, res) => {
  const uid = Number(req.body?.uid) || 1;
  const b = req.body?.pnr
    ? db.prepare("SELECT * FROM bookings WHERE pnr=? AND status IN ('confirmed','rebooked') ORDER BY id DESC LIMIT 1").get(String(req.body.pnr).toUpperCase())
    : db.prepare("SELECT * FROM bookings WHERE user_id=? AND status IN ('confirmed','rebooked') AND flight_date >= date('now') ORDER BY flight_date, id LIMIT 1").get(uid);
  if (!b) return res.json({ ok: false, error: req.body?.pnr ? "no_such_booking" : "no_upcoming_trip" });
  const id = "job" + Date.now().toString(36); const job = { id, uid, pnr: b.pnr, flight_no: b.flight_no, date: b.flight_date, status: "running", started_at: new Date().toISOString() };
  jobs.set(id, job);
  briefs.runForBooking(b, { force: !!req.body?.force, reason: "ops" }).then((r) => Object.assign(job, { status: r.ok ? "done" : "refused", result: { ok: r.ok, city: r.brief?.city, impact: r.brief?.travel_impact, mode: r.brief?.mode, sources: r.brief?.source_count, channel: r.channel, refused: r.refused || null } })).catch((e) => Object.assign(job, { status: "failed", error: e.message }));
  res.json({ ok: true, job: { id, pnr: b.pnr, flight_no: b.flight_no, date: b.flight_date, status: "running" } });
});
router.get("/briefs/job/:id", (req, res) => { const j = jobs.get(req.params.id); res.json(j ? { ok: true, job: j } : { ok: false, error: "unknown_job" }); });
router.post("/trips/sync", safe(async (_req, res) => res.json({ ok: true, ...(await bridge.syncTrips()) })));
const alternatives = require("./alternatives");
router.get("/risk/:pnr", (req, res) => { const a = alternatives.forBooking(req.params.pnr); res.json(a ? { ok: true, assessment: a } : { ok: false, error: "not_assessed" }); });
router.post("/risk/assess", safe(async (req, res) => { const b = db.prepare("SELECT * FROM bookings WHERE pnr=?").get(req.body?.pnr || ""); if (!b) return res.json({ ok: false, error: "no_booking" }); res.json({ ok: true, assessment: await alternatives.assess(b) }); }));
router.get("/briefs/due", (_req, res) => res.json({ ok: true, due: briefs.due().map((d) => ({ pnr: d.booking.pnr, uid: d.booking.user_id, dest: d.dest, hours: d.hoursToDeparture })) }));
router.post("/feeds/poll", safe(async (req, res) => res.json({ ok: true, ...(await feeds.poll({ airports: req.body?.airports })) })));
router.post("/customer/brief/:choice", (req, res) => res.json(bridge.briefResponse(req.uid, req.params.choice, "app")));

/* ── customer side (the live app): proactive inbox, one-tap accept, status for the banner ── */
router.get("/customer/status", (req, res) => res.json({ ok: true, ...bridge.status(req.uid) }));
router.get("/customer/inbox", (req, res) => res.json({ ok: true, messages: bridge.inboxList(req.uid, Number(req.query.since) || 0) }));
router.post("/customer/inbox/seen", (req, res) => { bridge.markSeen(req.uid, req.body?.ids); res.json({ ok: true }); });
router.post("/customer/accept", (req, res) => res.json(bridge.acceptForUser(req.uid, req.body?.optionId, req.body?.offerId, { via: "app" })));
router.post("/customer/decline", (req, res) => res.json(bridge.declineForUser(req.uid)));
router.post("/customer/link", safe((_req, res) => res.json({ ok: true, ...bridge.link() })));

router.post("/offer/:id/accept", (req, res) => res.json(A.accept(req.params.id, req.body?.optionId)));
router.post("/offer/:id/decline", (req, res) => res.json(A.decline(req.params.id)));
router.get("/offers", (req, res) => {
  const st = req.query.state;
  res.json({ ok: true, offers: G.nodesByKind("Offer").filter(o => !st || o.state === st).slice(0, 100) });
});

router.get("/tier2", (_req, res) => res.json({ ok: true, items: P.tier2List() }));
router.post("/tier2/:id/approve", (req, res) => res.json(P.tier2Approve(req.params.id)));

router.get("/kill", (_req, res) => res.json({ ok: true, kill: P.killState() }));
router.post("/kill", (req, res) => res.json({ ok: true, kill: P.setKill(req.body || {}) }));

module.exports = { router, bridge, research, briefs, feeds, alternatives };
