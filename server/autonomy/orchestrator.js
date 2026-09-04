/* autonomy/orchestrator.js — one state machine per DisruptionPrediction:
   WATCH → ACT → OFFERS_OUT → RESOLVING → RESOLVED / STOOD_DOWN.
   Driven by graph events on the bus; never by agents calling each other.
   Owns stand-down (release holds + optional all-clear) and T-0 closure
   (accepted parties untouched; non-responders → Tier-2 queue, package ready). */
"use strict";
const G = require("./graph");
const O = require("./ontology");
const P = require("./policy");
const A = require("./agents");
const V = require("./vendors");
const clock = require("./clock");

let wired = false;
function wire() {
  if (wired) return; wired = true;
  O.on("prediction:state", ({ predictionId, to }) => {
    if (to === "ACT") pipeline(predictionId);
    if (to === "STOOD_DOWN") standDown(predictionId);
  });
}

function pipeline(predictionId) {
  if (P.frozen(predictionId)) {
    O.audit({ actor: "orchestrator", action: "PIPELINE_SKIPPED", predictionId, rationale: "kill switch active" });
    return;
  }
  A.impact(predictionId);
  A.recovery(predictionId);
  A.offers(predictionId);
}

function standDown(predictionId) {
  /* release every hold behind this prediction's options */
  let released = 0;
  for (const opt of G.nodesByKind("RecoveryOption").filter(o => o.id.includes(predictionId))) {
    if (opt.seat_hold_ref) { V.releaseSeats(opt.seat_hold_ref + ":1"); V.releaseSeats(opt.seat_hold_ref + ":2"); released++; }
    G.setProps(opt.id, { expired: true });
  }
  P.execute("RELEASE_HOLD", { predictionId, perform: () => released }, { actor: "orchestrator", predictionId, rationale: `stood down: released ${released} holds` });
  /* optional all-clear, only to passengers we actually contacted */
  const contacted = G.edges({ src: predictionId, rel: "OUTREACH" });
  let cleared = 0;
  for (const e of contacted) {
    const pax = G.getNode(e.dst);
    const fi = G.getNode(G.getNode(predictionId).flight_instance_ref);
    const gate = P.execute("SEND_ALL_CLEAR", { predictionId, passengerId: pax.id, channel: "email", perform: () => true }, { actor: "orchestrator", predictionId, rationale: `all clear to ${pax.id}` });
    if (gate.ok) { V.send("email", pax.id, V.render("all_clear", pax.locale, { name: pax.name.split(" ")[0], flight: fi.flight_no, date: fi.date }), { predictionId }); cleared++; }
  }
  G.setProps(predictionId, { stood_down_at: clock.nowIso(), holds_released: released, all_clear_sent: cleared });
  O.audit({ actor: "orchestrator", action: "STOOD_DOWN", predictionId, rationale: `${released} holds released, ${cleared} all-clear messages` });
}

/* T-0: the disruption realises (or the window closes). Accepted parties get no
   further actions; everyone contacted-but-unresolved becomes a Tier-2 package. */
function closeOut(predictionId) {
  const offers = G.nodesByKind("Offer").filter(o => o.id.includes(predictionId));
  const accepted = offers.filter(o => o.state === "ACCEPTED" && o.executed);
  const pending = offers.filter(o => o.state === "SENT");
  for (const off of pending) {
    P.execute("PREPARE_MANUAL_RECOVERY", { predictionId, offerId: off.id, pnr: off.pnr, options: off.options.map(o => G.getNode(o)?.type) },
      { actor: "orchestrator", predictionId, rationale: `non-responder ${off.passenger_ref}: package (${off.options.map(o => G.getNode(o)?.type).join("/")}) ready for controller` });
    G.setProps(off.id, { state: "EXPIRED" });
  }
  G.setProps(predictionId, { state: "RESOLVED", closed_at: clock.nowIso(), accepted: accepted.length, to_human: pending.length });
  O.audit({ actor: "orchestrator", action: "RESOLVED", predictionId, rationale: `closed: ${accepted.length} executed autonomously, ${pending.length} routed to controllers` });
  return { accepted: accepted.length, toHuman: pending.length };
}

function kpis() {
  const preds = G.nodesByKind("DisruptionPrediction");
  const offers = G.nodesByKind("Offer");
  const sent = offers.length;
  const acc = offers.filter(o => o.state === "ACCEPTED" && o.executed);
  const impacted = preds.reduce((s, p) => s + (p.impacted || 0), 0);
  const msAvg = acc.length ? Math.round(acc.reduce((s, o) => s + (o.exec_ms || 0), 0) / acc.length) : 0;
  return {
    predictions: preds.map(p => ({ id: p.id, state: p.state, probability: p.probability, impacted: p.impacted || 0 })),
    offers_sent: sent, offers_accepted: acc.length,
    acceptance_rate: sent ? +(acc.length / sent).toFixed(2) : 0,
    proactive_resolution_rate: impacted ? +(acc.reduce((s, o) => s + (G.getNode(o.pnr)?.party_size || 1), 0) / impacted).toFixed(2) : 0,
    mean_saga_ms: msAvg,
    tier2_pending: P.tier2List().length,
    kill: P.killState(),
  };
}

module.exports = { wire, pipeline, standDown, closeOut, kpis };
