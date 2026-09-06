/* autonomy/ontology.js — the ontology's executable half.
   Entities live as kg_nodes (kinds listed in KINDS). The ACTION SPACE is data,
   not agent code: each Action declares preconditions (named predicates that run
   against the live graph at EXECUTION time), an autonomy tier, spend cap ref,
   reversibility and its compensating action. Agents may only invoke actions via
   policy.check() in policy.js — never directly.  Tiers per the master prompt:
   0 fully autonomous · 1 autonomous + audited · 2 human approves · 3 forbidden. */
"use strict";
const G = require("./graph");
const { db } = require("../db");

const KINDS = ["Passenger","PNR","FlightSchedule","FlightInstance","Airport","WeatherEvent","DestinationEvent","DestinationBrief",
  "DisruptionPrediction","RecoveryOption","Offer","Vendor","Policy","Action","AuditEvent"];

/* ---------- audit: append-only ---------- */
db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  tier INTEGER, inputs_hash TEXT, rationale TEXT, graph_diff_json TEXT, prediction_id TEXT);`);
function audit({ actor, action, tier = null, inputs = {}, rationale = "", graphDiff = {}, predictionId = null }) {
  db.prepare("INSERT INTO audit_events (at, actor, action, tier, inputs_hash, rationale, graph_diff_json, prediction_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(G.nowIso(), actor, action, tier, G.hash(inputs), rationale, JSON.stringify(graphDiff), predictionId);
}
const auditList = (limit = 50) => db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?").all(limit);

/* ---------- tiny in-process event bus (graph-change announcements only) ---------- */
const listeners = {};
const on = (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); };
const emit = (evt, payload) => { for (const fn of listeners[evt] || []) { try { fn(payload); } catch (e) { audit({ actor: "bus", action: "LISTENER_ERROR", rationale: `${evt}: ${e.message}` }); } } };

/* ---------- precondition predicates (referenced by name from Action nodes) ---------- */
const PRED = {
  prediction_in_act: ({ predictionId }) => (G.getNode(predictionId)?.state === "ACT"),
  prediction_active: ({ predictionId }) => ["WATCH","ACT","OFFERS_OUT","RESOLVING"].includes(G.getNode(predictionId)?.state),
  waiver_active: ({ predictionId }) => {
    const pol = G.getNode("policy:weather_waiver");
    const pred = G.getNode(predictionId);
    return !!(pol?.active && pred && pred.probability >= (pol.min_probability ?? 0.6));
  },
  passenger_consented: ({ passengerId, channel }) => {
    const pax = G.getNode(passengerId);
    const ch = (pax?.contact_channels || []).find(c => c.channel === channel);
    return !!ch?.consent;
  },
  outside_quiet_hours: ({ passengerId, atHour, channel }) => {
    if (channel === "email") return true;   // async channel: quiet hours govern interruptive channels only
    const pax = G.getNode(passengerId);
    const q = pax?.quiet_hours; if (!q) return true;
    const h = atHour ?? new Date().getUTCHours();
    return q.start <= q.end ? (h < q.start || h >= q.end) : (h >= q.end && h < q.start);
  },
  under_outreach_limit: ({ passengerId, predictionId }) => {
    const pol = G.getNode("policy:outreach");
    const sent = G.edges({ rel: "OUTREACH", src: predictionId, dst: passengerId })[0];
    return (sent?.count || 0) < (pol?.max_per_prediction ?? 2);
  },
  not_declined: ({ passengerId, predictionId }) =>
    !G.edges({ rel: "DECLINED", src: predictionId, dst: passengerId }).length,
  hold_capacity_available: ({ optionId }) => {
    const o = G.getNode(optionId); return !!o && o.feasibility_score > 0;
  },
  within_cap: ({ amount, capRef }) => {
    const cap = G.getNode(capRef); return amount <= (cap?.amount ?? 0);
  },
  offer_accepted: ({ offerId }) => G.getNode(offerId)?.state === "ACCEPTED",
  is_reversible_context: () => true,
};

/* ---------- the action space, as data ---------- */
const ACTIONS = [
  { name: "SEND_DESTINATION_BRIEF", tier: 0, preconditions: ["passenger_consented","outside_quiet_hours"], reversible: true, compensating: null, description: "Tier-0 information: destination weather, events and advisories with sources; the customer decides" },
  { name: "NOTIFY_PASSENGER",     tier: 0, preconditions: ["prediction_active","passenger_consented","outside_quiet_hours","under_outreach_limit","not_declined"], reversible: true,  compensating: null },
  { name: "SEND_ALL_CLEAR",       tier: 0, preconditions: ["passenger_consented"], reversible: true, compensating: null },
  { name: "SOFT_HOLD_INVENTORY",  tier: 0, preconditions: ["prediction_in_act","hold_capacity_available"], reversible: true, compensating: "RELEASE_HOLD" },
  { name: "RELEASE_HOLD",         tier: 0, preconditions: [], reversible: true, compensating: null },
  { name: "REBOOK_SAME_CABIN",    tier: 1, preconditions: ["offer_accepted","waiver_active"], reversible: true, compensating: "RESTORE_ORIGINAL_SEGMENTS" },
  { name: "ISSUE_HOTEL_VOUCHER",  tier: 1, preconditions: ["offer_accepted","within_cap"], capRef: "policy:cap_hotel", reversible: true, compensating: "VOID_HOTEL_VOUCHER" },
  { name: "BOOK_GROUND_TRANSPORT",tier: 1, preconditions: ["offer_accepted","within_cap"], capRef: "policy:cap_taxi",  reversible: true, compensating: "CANCEL_GROUND_TRANSPORT" },
  { name: "REISSUE_TICKET",       tier: 1, preconditions: ["offer_accepted"], reversible: true, compensating: "VOID_REISSUE" },
  { name: "OFFER_INCENTIVE",      tier: 1, preconditions: ["prediction_in_act","within_cap"], capRef: "policy:cap_incentive", reversible: true, compensating: null },
  { name: "PROCESS_REFUND",       tier: 2, preconditions: ["offer_accepted"], reversible: false, compensating: null },
  { name: "PREPARE_MANUAL_RECOVERY", tier: 2, preconditions: [], reversible: true, compensating: null },
  { name: "UPGRADE_CABIN",        tier: 2, preconditions: ["offer_accepted"], reversible: true, compensating: "RESTORE_ORIGINAL_SEGMENTS" },
  { name: "ESCALATE_TO_HUMAN",    tier: 0, preconditions: [], reversible: true, compensating: null },
  /* Tier 3 — modelled so the policy check can refuse them by data, not by absence */
  { name: "TOUCH_FLIGHT_OPS",     tier: 3, preconditions: [], reversible: false, compensating: null },
  { name: "CREATE_POLICY",        tier: 3, preconditions: [], reversible: false, compensating: null },
];

function seedActions() {
  for (const a of ACTIONS) G.upsertNode(`action:${a.name}`, "Action", a);
}

/* ---------- policies (machine-readable rules; caps in EUR for the demo) ---------- */
function seedPolicies() {
  G.upsertNode("policy:thresholds",     "Policy", { watch: 0.40, act: 0.60, hysteresis: 0.10 });
  G.upsertNode("policy:weather_waiver", "Policy", { active: true, min_probability: 0.60, scope: "same-cabin rebooking on impacted instances" });
  G.upsertNode("policy:cap_hotel",      "Policy", { amount: 180, currency: "EUR" });
  G.upsertNode("policy:cap_taxi",       "Policy", { amount: 90,  currency: "EUR" });
  G.upsertNode("policy:cap_refund",     "Policy", { amount: 400, currency: "EUR" });
  G.upsertNode("policy:cap_incentive",  "Policy", { amount: 60,  currency: "EUR" });
  G.upsertNode("policy:cap_event",      "Policy", { amount: 60000, currency: "EUR" });
  G.upsertNode("policy:outreach",       "Policy", { max_per_prediction: 2 });
  G.upsertNode("policy:hold_ttl",       "Policy", { hours: 4 });
  G.upsertNode("policy:kill_switch",    "Policy", { global: false, events: {} });
  G.upsertNode("policy:autonomy_gate",  "Policy", { phase: "C", note: "Tier 0-1 enabled on DEL-MIA route only; caps at 50% until Phase D" });
}

module.exports = { KINDS, ACTIONS, PRED, seedActions, seedPolicies, audit, auditList, on, emit };
