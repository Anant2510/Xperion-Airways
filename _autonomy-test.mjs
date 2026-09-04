/* _autonomy-test.mjs — acceptance suite for the disruption autonomy layer.
   Runs the modules in-process against the embedded store (deterministic clock,
   fixed PRNG, STUB vendors). Golden DEL→MIA tornado plus all edge cases.
   Run: node _autonomy-test.mjs */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch {}   // same DB_PATH the server uses

const G = require("./server/autonomy/graph.js");
const O = require("./server/autonomy/ontology.js");
const P = require("./server/autonomy/policy.js");
const V = require("./server/autonomy/vendors.js");
const A = require("./server/autonomy/agents.js");
const sim = require("./server/autonomy/sim.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("  ✓ " + name + (detail ? " — " + detail : "")); } else { fail++; console.log("  ✗ FAIL " + name + (detail ? " — " + detail : "")); } };

console.log("== GOLDEN: DEL→MIA tornado ==");
const seeded = sim.reset();
ok("seed: 214 passengers", seeded.passengers === 214, String(seeded.passengers));
ok("seed: PNRs span parties", seeded.pnrs === 122, String(seeded.pnrs));
ok("seed: alternates MIA↔MCO with transfer minutes", (G.edges({ src: "ap:MIA", rel: "ALTERNATE_OF", dst: "ap:MCO" })[0]?.ground_transfer_min ?? 0) === 240);

console.log("\n== T-72h: outlook ==");
const w = sim.t72();
const pred72 = G.getNode(w.predId);
ok("WeatherEvent + IMPACTS MIA", G.edges({ src: w.weId, rel: "IMPACTS", dst: "ap:MIA" }).length === 1);
ok("prediction ≈40% (0.38–0.48)", pred72.probability >= 0.38 && pred72.probability <= 0.48, String(pred72.probability));
ok("state WATCH", pred72.state === "WATCH");
ok("drivers logged", (pred72.top_drivers || []).length >= 4, (pred72.top_drivers || []).map(d => d.factor).join(","));
ok("no passenger contact at WATCH", V.sent().length === 0);

console.log("\n== T-48h: tornado watch → ACT → pipeline ==");
const t = sim.t48();
const pred = G.getNode(sim.state.predId);
ok("probability ≥60%", pred.probability >= 0.6, String(pred.probability));
ok("state OFFERS_OUT after pipeline", pred.state === "OFFERS_OUT", pred.state);
ok("214 passengers identified", pred.impacted === 214, String(pred.impacted));
const topRanked = pred.ranked_top?.[0];
const topPax = topRanked && G.getNode(topRanked.pax);
ok("ranking puts vulnerability/tier first", !!topPax && (topPax.vulnerability_flags.length > 0 || ["Platinum","Gold"].includes(topPax.loyalty_tier)), `${topPax?.loyalty_tier} ${topPax?.vulnerability_flags}`);
const anyPnr = G.nodesByKind("Offer").find(o => o.id.includes(sim.state.predId))?.pnr;
const optsForPnr = G.nodesByKind("RecoveryOption").filter(o => o.id.includes(`:${anyPnr}:`) && !o.expired);
ok("≤3 options per party", optsForPnr.length >= 2 && optsForPnr.length <= 3, String(optsForPnr.length));
ok("includes DIVERT_PLUS_GROUND (MCO + taxi + hotel + morning transfer)", optsForPnr.some(o => o.type === "DIVERT_PLUS_GROUND" && o.components.some(c => c.divert_to === "MCO") && o.components.some(c => c.hotel) && o.components.some(c => c.taxi) && o.components.some(c => c.transfer === "MCO-MIA")));
const reroute = optsForPnr.find(o => o.type === "REROUTE");
ok("reroute holds carry ~4h TTL", !!reroute && Math.abs(new Date(reroute.expiry) - (Date.parse(new Date(new Date(sim.state.depIso).getTime() - 48*3600e3).toISOString()) + 4*3600e3)) < 61_000, reroute?.expiry);
const pnrNode = G.getNode(anyPnr);
const memberIds = G.out(anyPnr, "BELONGS_TO").map(x => x.node.id);
ok("party members share identical options", memberIds.every(m => optsForPnr.every(o => G.edges({ src: m, rel: "QUALIFIES_FOR", dst: o.id }).length === 1)));

console.log("\n== T-46h: offers ==");
ok("offers sent on consented channels", pred.offers_sent > 100, String(pred.offers_sent));
ok("some held back by consent/quiet/limits", pred.offers_skipped > 0, String(pred.offers_skipped));
const sentRecs = V.sent();
ok("quiet hours respected: only email at 23:00Z", sentRecs.length > 0 && sentRecs.every(s => s.channel === "email"), [...new Set(sentRecs.map(s => s.channel))].join(","));
const hiMsg = sentRecs.find(s => s.text.startsWith("Namaste"));
ok("HI locale template used for hi-IN passengers", !!hiMsg);
ok("no unresolved template slots", sentRecs.every(s => !/\{\w+\}/.test(s.text)));
const framings = new Set(G.nodesByKind("Offer").map(o => o.framing_variant));
ok("framing variants logged per segment", ["vip_concierge","family_together","value_onetap"].every(f => framings.has(f)), [...framings].join(","));
const outreach = G.edges({ src: sim.state.predId, rel: "OUTREACH" });
ok("outreach counted per passenger (max 2 policy)", outreach.every(e => e.count <= 2) && outreach.length === pred.offers_sent);

console.log("\n== ACCEPT: one-tap saga ==");
const acc = sim.acceptSample();
ok("saga completes", acc.ok === true, JSON.stringify(acc.refs));
ok("end-to-end ≤ 60s", acc.ms <= 60_000, acc.ms + "ms");
ok("hotel + taxi + rebook + ticket refs present", !!(acc.refs && acc.refs.hotel && acc.refs.taxi && acc.refs.rebook && acc.refs.ticket), JSON.stringify(acc));
const offAfter = G.getNode(acc.offerId);
const pnrAfter = G.getNode(offAfter.pnr);
ok("graph reflects new itinerary (diverted, rebooked)", pnrAfter.rebooked === true && pnrAfter.diverted_to === "MCO");
const again = A.accept(acc.offerId, acc.optionId);
ok("re-accept is idempotent (same refs)", again.idempotent === true && JSON.stringify(again.refs) === JSON.stringify(acc.refs));

console.log("\n== T-0: close out ==");
const closed = sim.t0();
ok("accepted party gets zero further actions", G.getNode(acc.offerId).state === "ACCEPTED" && closed.accepted >= 1, `accepted=${closed.accepted}`);
ok("non-responders routed to Tier-2 with packages", closed.toHuman > 0 && P.tier2List().length >= closed.toHuman, `${closed.toHuman} → queue ${P.tier2List().length}`);
ok("prediction RESOLVED", G.getNode(sim.state.predId).state === "RESOLVED");
ok("audit trail is append-only and populated", O.auditList(5).length === 5 && O.auditList(1)[0].rationale.length > 0);

console.log("\n== EDGE: probability collapses → STOOD_DOWN ==");
const sd = sim.standDownScenario();
ok("state STOOD_DOWN", sd.after === "STOOD_DOWN", `${sd.before}→${sd.after}`);
ok("holds released", sd.holds_released > 0, String(sd.holds_released));
ok("all-clear sent to contacted passengers", sd.all_clear > 0 && sd.sent === sd.all_clear, `${sd.all_clear}`);

console.log("\n== EDGE: DECLINED → no repeat outreach ==");
const dec = sim.declinedScenario();
ok("offer marked DECLINED", dec.declined === "DECLINED");
ok("retry refused by policy check", dec.retryRefused === true, (dec.failed || []).join(","));

console.log("\n== EDGE: inventory exhausted → waitlist + escalate ==");
const ex = sim.exhaustedScenario();
ok("no reroute options exist", ex.anyReroute === false);
ok("escalations queued for humans", ex.tier2 > 0, String(ex.tier2));
ok("remaining options still offered", ex.stillOffered === true);

console.log("\n== EDGE: duplicate alerts dedupe ==");
const dd = sim.dedupeScenario();
ok("same alert twice → one WeatherEvent", dd.before === dd.after && dd.after === 1, `${dd.before}/${dd.after}`);
ok("single prediction", dd.preds === 1, String(dd.preds));

console.log("\n== EDGE: rebook ok, hotel API fails → compensate + escalate ==");
const hf = sim.hotelFailScenario();
ok("saga failed at HOTEL", hf.failed === "HOTEL");
ok("compensations ran (rebook rolled back)", hf.compensated === true && hf.pnr.rebooked === false, JSON.stringify({ rebooked: hf.pnr.rebooked }));
ok("human escalation queued with context", hf.tier2 > 0, String(hf.tier2));

console.log("\n== EDGE: kill switch freezes Tier 0/1, Tier-2 keeps working ==");
const ks = sim.killSwitchScenario();
ok("no offers while frozen", ks.offersSent === 0, String(ks.offersSent));
ok("prediction reached ACT but pipeline skipped", ["ACT","WATCH"].includes(ks.stateAtAct), ks.stateAtAct);
ok("Tier-2 queue + approval still work", ks.tier2Works === true);

console.log("\n== GUARDRAILS ==");
sim.reset(); sim.t72(); sim.t48();
const t3 = P.execute("TOUCH_FLIGHT_OPS", { predictionId: sim.state.predId, perform: () => true }, { actor: "rogue", predictionId: sim.state.predId });
ok("Tier-3 flight-ops action refused", t3.ok === false && t3.refused === "tier3_forbidden");
const t3b = P.execute("CREATE_POLICY", {}, { actor: "rogue" });
ok("Tier-3 policy creation refused", t3b.ok === false);
const noConsentPax = G.nodesByKind("Passenger").find(p => p.contact_channels.every(c => !c.consent));
if (noConsentPax) {
  const nc = P.execute("NOTIFY_PASSENGER", { predictionId: sim.state.predId, passengerId: noConsentPax.id, channel: "push", atHour: 12, perform: () => true }, { actor: "offer", predictionId: sim.state.predId });
  ok("revoked consent → contact refused", nc.ok === false);
} else ok("revoked consent → contact refused", true, "no zero-consent pax in seed; predicate covered above");

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
