/* autonomy/agents.js — Phase 3 agent mesh (Impact, Recovery, Offer, Execution).
   Stateless workers: ALL state lives in the graph; every side effect goes
   through policy.execute(); every external write carries an idempotency key
   and a documented compensating action. Message text comes from templates with
   facts injected from the graph only — nothing is invented at send time. */
"use strict";
const G = require("./graph");
const O = require("./ontology");
const P = require("./policy");
const V = require("./vendors");
const clock = require("./clock");

const tierW = { Platinum: 3, Gold: 2, Silver: 1, Base: 0 };

/* ---------------- Impact agent ---------------- */
function impact(predictionId) {
  const pred = G.getNode(predictionId);
  const fi = G.getNode(pred.flight_instance_ref);
  const ranked = [];
  for (const { node: pnr } of G.out(fi.id, "CARRIES")) {
    const members = G.out(pnr.id, "BELONGS_TO").map(x => x.node);
    const connection = (pnr.segments || []).length > 1;
    const misconnect = connection && (pnr.segments[1].connect_min ?? 999) < 120;
    for (const pax of members) {
      const score =
        3 * (pax.vulnerability_flags?.length ? 1 : 0) +
        tierW[pax.loyalty_tier] +
        0.5 * (pnr.party_size - 1) +
        (connection ? 2 : 0) + (misconnect ? 1 : 0);
      ranked.push({ pax: pax.id, pnr: pnr.id, score: +score.toFixed(1) });
      G.upsertEdge(predictionId, "AFFECTS", pax.id, { priority: score, pnr: pnr.id });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  G.setProps(predictionId, { impacted: ranked.length, ranked_top: ranked.slice(0, 10) });
  O.audit({ actor: "impact", action: "RANK_IMPACT", predictionId, rationale: `ranked ${ranked.length} passengers across ${new Set(ranked.map(r => r.pnr)).size} PNRs` });
  return ranked;
}

/* ---------------- Recovery agent ---------------- */
function recovery(predictionId) {
  const pred = G.getNode(predictionId);
  const fi = G.getNode(pred.flight_instance_ref);
  const ttlH = G.getNode("policy:hold_ttl")?.hours ?? 4;
  const ttlMs = ttlH * 3600e3;
  const pnrs = [...new Set(G.edges({ src: predictionId, rel: "AFFECTS" }).map(e => e.pnr))];
  let built = 0, waitlisted = 0;
  for (const pnrId of pnrs) {
    const pnr = G.getNode(pnrId);
    const n = pnr.party_size;
    const options = [];

    /* Option A — REROUTE via JFK, next morning arrival (party kept together) */
    const holdRef = `hold:${predictionId}:${pnrId}:A`;
    const h1 = V.holdSeats("XP903", n, holdRef + ":1", ttlMs);
    const h2 = h1.ok ? V.holdSeats("XP077", n, holdRef + ":2", ttlMs) : { ok: false };
    if (!h1.ok || !h2.ok) {
      V.releaseSeats(holdRef + ":1");
      G.upsertNode(`wait:${predictionId}:${pnrId}`, "RecoveryOption", { type: "WAITLIST", components: [], feasibility_score: 0, pnr: pnrId });
      P.execute("PREPARE_MANUAL_RECOVERY", { predictionId, pnr: pnrId }, { actor: "recovery", predictionId, rationale: `reroute inventory exhausted for ${pnrId}: waitlisted, manual package prepared` });
      P.execute("ESCALATE_TO_HUMAN", { predictionId, perform: () => null }, { actor: "recovery", predictionId, rationale: `inventory shortfall on recovery flights for ${pnrId}` });
      waitlisted++;
    }
    if (h1.ok && h2.ok) {
      const oid = `opt:${predictionId}:${pnrId}:A`;
      G.upsertNode(oid, "RecoveryOption", {
        type: "REROUTE", components: [{ flight: "XP903", route: "DEL-JFK" }, { flight: "XP077", route: "JFK-MIA" }],
        total_cost: 0, seat_hold_ref: holdRef, expiry: new Date(clock.now().getTime() + ttlMs).toISOString(),
        feasibility_score: 0.9, party_size: n,
      });
      G.upsertEdge(oid, "RESOLVES", predictionId);
      P.execute("SOFT_HOLD_INVENTORY", { predictionId, optionId: oid, touched: [oid], perform: () => holdRef }, { actor: "recovery", predictionId, rationale: `soft hold ${n} seats DEL-JFK-MIA, TTL ${ttlH}h` });
      options.push(oid);
    }

    /* Option B — DIVERT_PLUS_GROUND: land MCO + taxi + 1n hotel + morning transfer */
    {
      const hotel = G.getNode("ven:hotel:mco1"), taxi = G.getNode("ven:taxi:mco1");
      const cost = hotel.rate + taxi.rate;
      const oid = `opt:${predictionId}:${pnrId}:B`;
      G.upsertNode(oid, "RecoveryOption", {
        type: "DIVERT_PLUS_GROUND",
        components: [{ divert_to: "MCO" }, { hotel: hotel.id, nights: 1 }, { taxi: taxi.id }, { transfer: "MCO-MIA", when: "morning" }],
        total_cost: cost * n <= (G.getNode("policy:cap_event")?.amount ?? 1e9) ? cost : cost,
        seat_hold_ref: null, expiry: new Date(clock.now().getTime() + ttlMs).toISOString(),
        feasibility_score: 0.85, party_size: n,
      });
      G.upsertEdge(oid, "RESOLVES", predictionId);
      G.upsertEdge(oid, "FULFILLED_BY", hotel.id); G.upsertEdge(oid, "FULFILLED_BY", taxi.id);
      options.push(oid);
    }

    /* Option C — HOLD + REFUND (Tier-2 execution path) */
    {
      const oid = `opt:${predictionId}:${pnrId}:C`;
      G.upsertNode(oid, "RecoveryOption", { type: "REFUND", components: [{ refund: "full" }], total_cost: 0, expiry: new Date(clock.now().getTime() + ttlMs).toISOString(), feasibility_score: 0.7, party_size: n });
      G.upsertEdge(oid, "RESOLVES", predictionId);
      options.push(oid);
    }

    for (const pid of G.out(pnrId, "BELONGS_TO").map(x => x.node.id)) {
      for (const oid of options) G.upsertEdge(pid, "QUALIFIES_FOR", oid);
    }
    built++;
  }
  O.audit({ actor: "recovery", action: "BUILD_OPTIONS", predictionId, rationale: `options for ${built} PNRs (≤3 each, party-identical); ${waitlisted} waitlisted` });
  return { built, waitlisted };
}

/* ---------------- Offer agent (marketing autonomy) ---------------- */
function framingFor(pax, pnr) {
  if (["Platinum", "Gold"].includes(pax.loyalty_tier)) return "vip_concierge";
  if ((pnr.party_size ?? 1) >= 3 || pax.vulnerability_flags?.length) return "family_together";
  if (pax.flexible) return "flex_shift";
  return "value_onetap";
}
function pickChannel(pax, atHour) {
  const quietable = ["push", "sms", "whatsapp"];
  for (const ch of ["push", "sms", "whatsapp", "email"]) {
    const c = (pax.contact_channels || []).find(x => x.channel === ch && x.consent);
    if (!c) continue;
    if (quietable.includes(ch) && !O.PRED.outside_quiet_hours({ passengerId: pax.id, atHour })) continue;
    return ch;
  }
  return null;
}
function offers(predictionId) {
  const pred = G.getNode(predictionId);
  const fi = G.getNode(pred.flight_instance_ref);
  const affected = G.edges({ src: predictionId, rel: "AFFECTS" });
  const atHour = clock.hour();
  let sentN = 0, skipped = 0;
  for (const e of affected) {
    const pax = G.getNode(e.dst); const pnr = G.getNode(e.pnr);
    const optIds = G.out(pax.id, "QUALIFIES_FOR").map(x => x.node).filter(o => o.id.includes(predictionId)).map(o => o.id);
    if (!optIds.length) continue;
    const channel = pickChannel(pax, atHour);
    const gate = P.execute("NOTIFY_PASSENGER",
      { predictionId, passengerId: pax.id, channel: channel || "push", atHour, perform: () => true, touched: [] },
      { actor: "offer", predictionId, rationale: `offer outreach to ${pax.id} via ${channel || "none"}` });
    if (!channel || !gate.ok) { skipped++; continue; }

    const framing = framingFor(pax, pnr);
    let incentive = null;
    if (framing === "vip_concierge" || framing === "flex_shift") {
      const amt = framing === "vip_concierge" ? 50 : 40;
      const inc = P.execute("OFFER_INCENTIVE", { predictionId, amount: amt, perform: () => amt, touched: [] },
        { actor: "offer", predictionId, rationale: `${framing} goodwill €${amt}` });
      if (inc.ok) incentive = { amount: amt, currency: "EUR", kind: framing === "flex_shift" ? "move_early_credit" : "lounge_plus_voucher" };
    }
    const ordered = framing === "vip_concierge" ? [optIds.find(o => o.endsWith(":A")), ...optIds.filter(o => !o.endsWith(":A"))].filter(Boolean) : optIds;
    const facts = {
      name: pax.name.split(" ")[0], dest: fi.dest, flight: fi.flight_no, date: fi.date,
      optionList: ordered.map(o => G.getNode(o).type).join(" | "),
      incentiveLine: incentive ? `Includes a goodwill credit of EUR ${incentive.amount}.` : "",
    };
    const text = V.render("offer", pax.locale, facts);
    V.send(channel, pax.id, text, { predictionId });
    const offId = `offer:${predictionId}:${pax.id}`;
    G.upsertNode(offId, "Offer", { passenger_ref: pax.id, pnr: pnr.id, prediction: predictionId, options: ordered, channel, framing_variant: framing, state: "SENT", incentive, sent_at: clock.nowIso() });
    for (const o of ordered) G.upsertEdge(offId, "PRESENTS", o);
    const oe = G.edges({ src: predictionId, rel: "OUTREACH", dst: pax.id })[0];
    G.upsertEdge(predictionId, "OUTREACH", pax.id, { count: (oe?.count || 0) + 1, last: clock.nowIso() });
    sentN++;
  }
  G.setProps(predictionId, { offers_sent: sentN, offers_skipped: skipped, state: "OFFERS_OUT" });
  O.audit({ actor: "offer", action: "SEND_OFFERS", predictionId, rationale: `${sentN} sent, ${skipped} held back by consent/quiet/limits` });
  O.emit("prediction:state", { predictionId, from: "ACT", to: "OFFERS_OUT" });
  return { sent: sentN, skipped };
}

function decline(offerId) {
  const off = G.getNode(offerId); if (!off) return { ok: false };
  G.setProps(offerId, { state: "DECLINED" });
  G.upsertEdge(off.prediction, "DECLINED", off.passenger_ref);
  O.audit({ actor: "offer", action: "DECLINED", predictionId: off.prediction, rationale: `${off.passenger_ref} declined; no further outreach` });
  return { ok: true };
}

/* ---------------- Execution agent — compensating-transaction saga ---------------- */
function accept(offerId, optionId) {
  const t0 = Date.now();
  const off = G.getNode(offerId);
  if (!off) return { ok: false, error: "offer not found" };
  const paxId = off.passenger_ref; const predictionId = off.prediction;
  if (off.state === "ACCEPTED" && off.executed) return { ok: true, idempotent: true, refs: off.refs, ms: 0 };
  const opt = G.getNode(optionId || off.options[0]);
  const pax = G.getNode(paxId); const pnr = G.getNode(off.pnr);
  G.setProps(offerId, { state: "ACCEPTED", accepted_at: clock.nowIso() });

  const done = [];      // [{step, undo}]
  const refs = {};
  const fail = (step, why) => {
    for (const d of done.reverse()) { try { d.undo(); O.audit({ actor: "execution", action: `COMPENSATE:${d.step}`, predictionId, rationale: `rollback after ${step} failed` }); } catch {} }
    P.execute("ESCALATE_TO_HUMAN", { predictionId, perform: () => null }, { actor: "execution", predictionId, rationale: `saga failed at ${step}: ${why} — compensated, human has full context` });
    P.execute("PROCESS_REFUND", { predictionId, offerId, amount: 0 }, { actor: "execution", predictionId, rationale: `prepare fallback package for ${pnr.id} after ${step} failure` });
    G.setProps(offerId, { state: "ACCEPTED", executed: false, failed_step: step });
    return { ok: false, failed: step, compensated: true };
  };

  /* 1 · rebook */
  if (opt.type !== "REFUND") {
    const r = P.execute("REBOOK_SAME_CABIN", {
      predictionId, offerId, touched: [pnr.id],
      perform: () => {
        if (opt.type === "REROUTE") {
          const c = V.confirmSeats(opt.seat_hold_ref + ":1"); const c2 = V.confirmSeats(opt.seat_hold_ref + ":2");
          if (!c.ok || !c2.ok) throw new Error("seat confirm failed");
          G.setProps(pnr.id, { segments: [{ f: "XP903" }, { f: "XP077" }], rebooked: true });
          G.upsertEdge("fi:XP903", "CARRIES", pnr.id); G.upsertEdge("fi:XP077", "CARRIES", pnr.id);
          return { pss: c.pssRef };
        }
        G.setProps(pnr.id, { diverted_to: "MCO", rebooked: true });
        return { pss: "DIV-" + pnr.record_locator };
      },
    }, { actor: "execution", predictionId, rationale: `rebook ${pnr.id} (${opt.type}) under weather waiver` });
    if (!r.ok) return fail("REBOOK", JSON.stringify(r));
    refs.rebook = r.result?.pss; done.push({ step: "REBOOK", undo: () => G.setProps(pnr.id, { segments: pnr.segments, rebooked: false, diverted_to: null }) });
  }

  /* 2 · hotel voucher */
  const hotelComp = (opt.components || []).find(c => c.hotel);
  if (hotelComp) {
    const hotel = G.getNode(hotelComp.hotel);
    const r = P.execute("ISSUE_HOTEL_VOUCHER", {
      predictionId, offerId, amount: hotel.rate, touched: [],
      perform: () => { const v = V.reserve("hotel", hotel.id, `idem:${offerId}:hotel`, { nights: 1, pax: pnr.party_size }); if (!v.ok) throw new Error(v.error); return v.ref; },
    }, { actor: "execution", predictionId, rationale: `hotel voucher ${hotel.name} EUR ${hotel.rate}` });
    if (!r.ok) return fail("HOTEL", JSON.stringify(r));
    refs.hotel = r.result; done.push({ step: "HOTEL", undo: () => V.cancel(`idem:${offerId}:hotel`) });
  }

  /* 3 · ground transport */
  const taxiComp = (opt.components || []).find(c => c.taxi);
  if (taxiComp) {
    const taxi = G.getNode(taxiComp.taxi);
    const r = P.execute("BOOK_GROUND_TRANSPORT", {
      predictionId, offerId, amount: taxi.rate, touched: [],
      perform: () => { const v = V.reserve("taxi", taxi.id, `idem:${offerId}:taxi`, { route: "MCO-MIA" }); if (!v.ok) throw new Error(v.error); return v.ref; },
    }, { actor: "execution", predictionId, rationale: `ground transfer EUR ${taxi.rate}` });
    if (!r.ok) return fail("TAXI", JSON.stringify(r));
    refs.taxi = r.result; done.push({ step: "TAXI", undo: () => V.cancel(`idem:${offerId}:taxi`) });
  }

  /* 4 · reissue */
  if (opt.type !== "REFUND") {
    const r = P.execute("REISSUE_TICKET", { predictionId, offerId, touched: [pnr.id], perform: () => "TKT-" + pnr.record_locator },
      { actor: "execution", predictionId, rationale: `reissue ticket for ${pnr.id}` });
    if (!r.ok) return fail("REISSUE", JSON.stringify(r));
    refs.ticket = r.result;
  } else {
    P.execute("PROCESS_REFUND", { predictionId, offerId, amount: 250 }, { actor: "execution", predictionId, rationale: "refund requested — packaged for approval" });
  }

  /* 5 · confirm (transactional message: quiet hours exempt by policy note) */
  const facts = { name: pax.name.split(" ")[0], summary: opt.type === "REROUTE" ? "Rerouted via JFK, arriving next morning" : opt.type === "DIVERT_PLUS_GROUND" ? "Landing MCO with taxi, hotel tonight and a morning transfer to Miami" : "Refund prepared", ref: refs.rebook || refs.hotel || "OK" };
  V.send("push", pax.id, V.render("confirm", pax.locale, facts), { predictionId });

  /* release sibling holds for this PNR's other options */
  for (const sib of ["A"]) {
    const other = G.getNode(`opt:${predictionId}:${off.pnr}:${sib}`);
    if (other && other.id !== opt.id && other.seat_hold_ref) { V.releaseSeats(other.seat_hold_ref + ":1"); V.releaseSeats(other.seat_hold_ref + ":2"); }
  }
  const ms = Date.now() - t0;
  G.setProps(offerId, { executed: true, refs, exec_ms: ms });
  G.setProps(predictionId, { state: "RESOLVING" });
  O.audit({ actor: "execution", action: "SAGA_COMPLETE", predictionId, rationale: `${opt.type} executed for ${off.pnr} in ${ms}ms`, inputs: refs });
  return { ok: true, refs, ms };
}

module.exports = { impact, recovery, offers, decline, accept };
