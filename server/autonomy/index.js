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

const router = express.Router();
router.use(express.json());
/* sim endpoints can be pressed out of order from the ops page: answer with a
   friendly 409 instead of a stack trace */
const safe = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(409).json({ ok: false, error: e.message }); } };
orch.wire();

router.get("/status", (_req, res) => res.json({ ok: true, ...orch.kpis(), graph: G.stats(), linked: bridge.linked() }));
router.get("/graph", (_req, res) => res.json({ ok: true, stats: G.stats(),
  predictions: G.nodesByKind("DisruptionPrediction"),
  sampleOffers: G.nodesByKind("Offer").slice(0, 5) }));
router.get("/audit", (req, res) => res.json({ ok: true, events: O.auditList(Number(req.query.limit) || 60) }));
router.get("/outbox", (_req, res) => res.json({ ok: true, sent: V.sent().slice(-40) }));

/* every world reset in the server runtime links the app's real customers into the graph
   (the in-process acceptance suite calls sim.reset() directly and stays synthetic-only) */
const resetLinked = () => { const seeded = sim.reset(); const { linked } = bridge.link(); return { ...seeded, linked }; };
const ensureLinked = () => { if (!bridge.isLinked()) bridge.link(); };
router.post("/sim/reset", safe((_req, res) => res.json({ ok: true, ...resetLinked() })));
router.post("/sim/t72", safe((_req, res) => { ensureLinked(); res.json({ ok: true, ...sim.t72(), pred: G.getNode(sim.state.predId) }); }));
router.post("/sim/t48", safe((_req, res) => res.json({ ok: true, ...sim.t48() })));
router.post("/sim/accept", safe((_req, res) => res.json(sim.acceptSample())));
router.post("/sim/t0", safe((_req, res) => res.json({ ok: true, ...sim.t0() })));
router.post("/sim/golden", safe((_req, res) => {
  const seeded = resetLinked(); const a = sim.t72(); const b = sim.t48();
  const acc = sim.acceptSample(); const closed = sim.t0();
  res.json({ ok: true, seeded, watch: { probability: a.p }, act: { probability: b.p }, accepted: acc, closed, kpis: orch.kpis() });
}));

/* ── customer side (the live app): proactive inbox, one-tap accept, status for the banner ── */
router.get("/customer/status", (req, res) => res.json({ ok: true, ...bridge.status(req.uid) }));
router.get("/customer/inbox", (req, res) => res.json({ ok: true, messages: bridge.inboxList(req.uid, Number(req.query.since) || 0) }));
router.post("/customer/inbox/seen", (req, res) => { bridge.markSeen(req.uid, req.body?.ids); res.json({ ok: true }); });
router.post("/customer/accept", (req, res) => res.json(bridge.acceptForUser(req.uid, req.body?.optionId, req.body?.offerId)));
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

module.exports = { router, bridge };
