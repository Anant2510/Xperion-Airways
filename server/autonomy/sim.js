/* autonomy/sim.js — the replayable acceptance simulator (golden DEL→MIA tornado).
   Deterministic: fixed PRNG in seed.js, injected clock, STUB vendors. */
"use strict";
const G = require("./graph");
const O = require("./ontology");
const P = require("./policy");
const S = require("./seed");
const sensing = require("./sensing");
const A = require("./agents");
const orch = require("./orchestrator");
const V = require("./vendors");
const clock = require("./clock");
const { db } = require("../db");

const state = { fiId: null, depIso: null, predId: null };

function reset() {
  G.wipe(); V.resetVendors(); db.exec("DELETE FROM audit_events;"); clock.reset();
  O.seedActions(); O.seedPolicies(); orch.wire();
  const dep = new Date(Date.now() + 96 * 3600e3); dep.setUTCHours(23, 0, 0, 0);   // T-48h = 23:00Z → quiet hours bite
  const depIso = dep.toISOString();
  const { fiId } = S.seedWorld({ depIso });
  const seeded = S.seedPassengers(fiId);
  state.fiId = fiId; state.depIso = depIso; state.predId = null;
  O.audit({ actor: "sim", action: "RESET", rationale: `seeded ${seeded.passengers} passengers / ${seeded.pnrs} PNRs on XP201 ${depIso.slice(0, 10)}` });
  return { fiId, depIso, ...seeded };
}

const depMs = () => new Date(state.depIso).getTime();
const arrIso = () => G.getNode(state.fiId).sched_arr;

function t72() {
  if (!state.fiId || !G.getNode(state.fiId)) reset();   // step pressed on a fresh boot: seed first
  clock.set(new Date(depMs() - 72 * 3600e3).toISOString());
  const arr = new Date(arrIso()).getTime();
  const { weId } = sensing.ingestAlert({
    source: "SPC", type: "convective_outlook", severity: 3,
    geometry: { lat: 25.9, lon: -80.4, radius_km: 120 },
    valid: { from: new Date(arr - 6 * 3600e3).toISOString(), to: new Date(arr + 6 * 3600e3).toISOString() },
    raw: "STUB: SPC day-3 outlook",
  });
  const res = sensing.evaluate();
  state.predId = res.find(r => r.predId.includes("XP201"))?.predId || res[0]?.predId;
  return { weId, ...res.find(r => r.predId === state.predId) };
}

function t48() {
  if (!state.predId) throw new Error('No active scenario — press "Reset world" then run the steps in order, or use "Run full golden timeline".');
  clock.set(new Date(depMs() - 48 * 3600e3).toISOString());
  const arr = new Date(arrIso()).getTime();
  sensing.ingestAlert({
    source: "NWS", type: "tornado_watch", severity: 4,
    geometry: { lat: 25.85, lon: -80.35, radius_km: 100 },
    valid: { from: new Date(arr - 4 * 3600e3).toISOString(), to: new Date(arr + 4 * 3600e3).toISOString() },
    raw: "STUB: NWS tornado watch",
  });
  const res = sensing.evaluate();               // ACT → bus → orchestrator pipeline runs
  const mine = res.find(r => r.predId.includes("tornado") || (G.getNode(r.predId)?.probability ?? 0) >= 0.6) || res[0];
  state.predId = res.map(r => r.predId).find(id => (G.getNode(id)?.state === "OFFERS_OUT")) || mine.predId;
  return { ...mine, pred: G.getNode(state.predId) };
}

function sampleOffer(pred = state.predId, { minParty = 2 } = {}) {
  const offers = G.nodesByKind("Offer").filter(o => o.id.includes(pred) && o.state === "SENT");
  return offers.find(o => (G.getNode(o.pnr)?.party_size || 1) >= minParty) || offers[0];
}

function acceptSample() {
  if (!state.predId) throw new Error('No active scenario — press "Reset world" then run the steps in order, or use "Run full golden timeline".');
  const off = sampleOffer();
  if (!off) throw new Error('No offers out yet — run "T-48h · tornado watch" first, then accept.');
  const opt = off.options.find(o => G.getNode(o)?.type === "DIVERT_PLUS_GROUND") || off.options[0];
  const r = A.accept(off.id, opt);
  return { offerId: off.id, optionId: opt, ...r };
}

function t0() {
  if (!state.predId) throw new Error('No active scenario — press "Reset world" then run the steps in order, or use "Run full golden timeline".');
  clock.set(state.depIso);
  return orch.closeOut(state.predId);
}

/* ---------- edge scenarios (each self-contained on a fresh reset) ---------- */
function standDownScenario() {
  reset(); t72(); t48();
  const before = G.getNode(state.predId);
  clock.advance(2 * 3600e3);
  const arr = new Date(arrIso()).getTime();
  sensing.ingestAlert({                          // watch cancelled → outlook only, off-window
    source: "NWS", type: "convective_outlook", severity: 1,
    geometry: { lat: 25.85, lon: -80.35, radius_km: 100 },
    valid: { from: new Date(arr + 30 * 3600e3).toISOString(), to: new Date(arr + 40 * 3600e3).toISOString() },
    raw: "STUB: downgrade",
  });
  /* downgrade the driving event by re-scoring: emulate expiry of the watch */
  const watch = G.nodesByKind("WeatherEvent").find(w => w.type === "tornado_watch");
  G.upsertNode(watch.id, "WeatherEvent", { ...watch, type: "convective_outlook", severity: 1, valid: { from: new Date(arr + 30 * 3600e3).toISOString(), to: new Date(arr + 40 * 3600e3).toISOString() } });
  const res = sensing.evaluate();
  return { before: before.state, after: G.getNode(state.predId)?.state, holds_released: G.getNode(state.predId)?.holds_released, all_clear: G.getNode(state.predId)?.all_clear_sent, sent: V.sent().filter(s => s.text.includes("passed") || s.text.includes("tal gaya")).length };
}

function declinedScenario() {
  reset(); t72(); t48();
  const off = sampleOffer();
  A.decline(off.id);
  const again = P.execute("NOTIFY_PASSENGER", { predictionId: state.predId, passengerId: off.passenger_ref, channel: "email", atHour: 12, perform: () => true }, { actor: "offer", predictionId: state.predId, rationale: "retry after decline (must be refused)" });
  return { declined: G.getNode(off.id).state, retryRefused: !again.ok, failed: again.failed };
}

function exhaustedScenario() {
  reset(); V.seedSeats({ XP903: 0, XP077: 0 });   // no reroute seats at all
  t72(); t48();
  const anyReroute = G.nodesByKind("RecoveryOption").some(o => o.type === "REROUTE");
  return { anyReroute, tier2: P.tier2List().length, stillOffered: G.nodesByKind("Offer").length > 0 };
}

function dedupeScenario() {
  reset(); t72();
  const before = G.nodesByKind("WeatherEvent").length;
  t72();                                          // exact same alert again
  const after = G.nodesByKind("WeatherEvent").length;
  const preds = G.nodesByKind("DisruptionPrediction").length;
  return { before, after, preds };
}

function hotelFailScenario() {
  reset(); t72(); t48();
  V.setFailure("hotel", true);
  const off = sampleOffer();
  const opt = off.options.find(o => G.getNode(o)?.type === "DIVERT_PLUS_GROUND");
  const r = A.accept(off.id, opt);
  return { failed: r.failed, compensated: r.compensated, tier2: P.tier2List().length, pnr: G.getNode(off.pnr) };
}

function killSwitchScenario() {
  reset(); t72();
  P.setKill({ global: true });
  const res = t48();                              // ACT fires but pipeline must refuse
  const offersSent = G.nodesByKind("Offer").length;
  const tier2Before = P.tier2List().length;
  const q = P.execute("PREPARE_MANUAL_RECOVERY", { predictionId: state.predId, pnr: "manual" }, { actor: "controller", predictionId: state.predId, rationale: "manual package while frozen" });
  const approve = q.queued ? P.tier2Approve(q.queued) : { ok: false };
  P.setKill({ global: false });
  return { stateAtAct: G.getNode(state.predId)?.state, offersSent, tier2Works: !!(q.ok && q.queued && approve.ok), tier2Before };
}

module.exports = { reset, t72, t48, acceptSample, sampleOffer, t0, standDownScenario, declinedScenario, exhaustedScenario, dedupeScenario, hotelFailScenario, killSwitchScenario, state };
