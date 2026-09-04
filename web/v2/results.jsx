// FlyTAP v2 — Search Results (outbound → inbound · filter/sort). Built to the
// approved Figma screen and wired to /api/search. Fare brands (Basic/Classic/Plus/
// Executive), badges, the date strip, sort and filters are derived from the real
// flight the engine returns, so it works for any route in the 100-route network.
import React, { useState, useEffect, useMemo } from "react";
import { api, EUR, miles, fmtDate, MILES_RATE } from "./lib.js";
import { Btn, Card, Pill, Icon, cx } from "./ui.jsx";
import { trip, setLeg, pingBasket, resetTrip, setFareHold } from "./trip.js";

const roundTo = (n, s) => Math.round(n / s) * s;

/* fare brands derived from the flight's base (cheapest) fare */
// Fare brands grouped by cabin — the search results show only the brands for the
// cabin the member picked on the home search (Economy / Premium / Business).
const CABIN_BRANDS = {
  Economy: ["Basic", "Classic", "Plus"],
  Premium: ["Premium", "Premium Flex"],
  Business: ["Executive", "Executive Flex"],
};
const CABIN_LABEL = { Economy: "Economy", Premium: "Premium", Business: "Business" };
function deriveFares(price, cabinPrices) {
  // Per-cabin ops override (from flights.cabin_prices): when set, that cabin's entry fare is
  // pinned and its flex sibling scales off it; otherwise the usual multiplier off Economy.
  let cp = cabinPrices; if (typeof cp === "string") { try { cp = JSON.parse(cp); } catch { cp = null; } }
  cp = cp || {};
  const ecoBase = cp.Economy != null ? Math.round(+cp.Economy) : price;
  const classic = Math.round(ecoBase * 1.62), plus = Math.round(ecoBase * 2.81),
        premium = cp.Premium != null ? Math.round(+cp.Premium) : Math.round(price * 3.6),
        premFlex = cp.Premium != null ? Math.round(+cp.Premium * 1.22) : Math.round(price * 4.4),
        exec = cp.Business != null ? Math.round(+cp.Business) : Math.round(price * 7.43),
        execFlex = cp.Business != null ? Math.round(+cp.Business * 1.17) : Math.round(price * 8.7);
  return [
    { key: "Basic", cabin: "Economy", tag: "CHEAPEST", tone: "slate", sub: "Hand luggage only · no changes", price: ecoBase,
      feats: [["Cabin bag · 8kg", 1], ["Checked bag", 0], ["Seat selection", 0], ["Changes", 0], ["Refund", 0], ["Earn 50% miles", 1]] },
    { key: "Classic", cabin: "Economy", tag: "MOST POPULAR", tone: "lime", sub: "1 bag · seat select · 50% refundable", price: classic,
      was: Math.round(classic * 1.2), milesOpt: { mi: roundTo(classic * 110, 500), cash: Math.round(classic * 0.18) },
      feats: [["Cabin bag · 8kg", 1], ["Checked bag · 23kg", 1], ["Standard seat select", 1], ["Changes for €40", 1], ["50% refund", 1], ["Earn 100% miles", 1]] },
    { key: "Plus", cabin: "Economy", tag: "GOLD VALUE", tone: "gold", sub: "2 bags · extra legroom · full flex", price: plus,
      feats: [["Cabin bag + priority", 1], ["2× checked bags · 23kg", 1], ["Extra legroom seat", 1], ["Free changes", 1], ["Full refund · taxes only fee", 1], ["Earn 125% miles", 1]] },
    { key: "Premium", cabin: "Premium", tag: "MORE SPACE", tone: "lime", sub: "Premium cabin · wider seat · priority", price: premium,
      feats: [["Premium wider seat · recline", 1], ["2× checked bags · 23kg", 1], ["Priority check-in & boarding", 1], ["Welcome drink · enhanced meal", 1], ["Changes for €25", 1], ["Earn 150% miles", 1]] },
    { key: "Premium Flex", cabin: "Premium", tag: "FLEXIBLE", tone: "gold", sub: "Premium cabin · fully flexible", price: premFlex,
      feats: [["Premium wider seat · recline", 1], ["2× checked bags · 23kg", 1], ["Priority everything · fast-track", 1], ["Welcome drink · enhanced meal", 1], ["Free changes & full refund", 1], ["Earn 175% miles", 1]] },
    { key: "Executive", cabin: "Business", tag: "BUSINESS", tone: "dark", sub: "Business cabin · lounge · premium meal", price: exec,
      feats: [["Lounge access", 1], ["2× checked bags · 32kg", 1], ["Business seat 1A–3F", 1], ["Changes for €60", 1], ["Priority boarding · fast-track", 1], ["Earn 200% miles", 1]] },
    { key: "Executive Flex", cabin: "Business", tag: "FULL FLEX", tone: "dark", sub: "Business · fully flexible & refundable", price: execFlex,
      feats: [["Lounge access", 1], ["2× checked bags · 32kg", 1], ["Business seat 1A–3F", 1], ["Free changes & full refund", 1], ["Priority boarding · fast-track", 1], ["Earn 250% miles", 1]] },
  ];
}
const depMins = (hhmm) => { const [h, m] = (hhmm || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const durMins = (s) => { if (!s) return 999; const h = /(\d+)h/.exec(s), m = /h?(\d+)m/.exec(s); return (h ? +h[1] * 60 : 0) + (m ? +m[1] : (s.endsWith("m") ? +s.replace(/\D/g, "") : 0)); };
// Best-pairing engine (#Best Pairing): score an inbound flight as a return paired with the already-
// chosen outbound. Lower score = better. Genuinely weighs total round-trip cost, total air time,
// fare-brand compatibility (same brand books cleaner and unlocks the bundle discount), schedule
// convenience (a civilised return departure, not a red-eye), connection/operating quality (direct
// Xperion mainline over a partner-operated codeshare), and loyalty (tier holders get priority/benefits
// that make a paired mainline flight more valuable). Returns { score, reasons, bundle } so the
// winning card can explain itself rather than just being highlighted.
function pairingScore(inb, ob, tier, prevFare) {
  if (!inb || !ob) return { score: Infinity, reasons: [], bundle: 0 };
  const obFare = prevFare || ob.fare || "Classic";
  const inbBrand = (inb._fares || []).find(x => x.key === obFare);
  const sameBrand = !!inbBrand;
  const inbPrice = inbBrand ? inbBrand.price : (inb.price || 0);
  const obPrice = ob.price || 0;
  const bundle = sameBrand ? 15 : 0;
  const totalCost = obPrice + inbPrice - bundle;
  const totalDur = durMins((ob.flight && ob.flight.duration) || ob.duration) + durMins(inb.duration);
  const depHr = depMins(inb.dep) / 60;
  const partner = !!(inb._m && inb._m.partner);
  const tierBoost = /gold|platinum|silver/i.test(tier || "") ? 1 : 0;
  let score = totalCost;
  score += totalDur * 0.15;
  if (!sameBrand) score += 40;
  if (partner) score += 25;
  if (depHr < 6) score += 30;
  else if (depHr > 21) score += 15;
  else if (depHr >= 8 && depHr <= 19) score -= 8;
  if (tierBoost && !partner) score -= 6;
  const reasons = [];
  reasons.push(sameBrand ? ("Same " + obFare + " fare on both legs — books clean") : "Fare-flexible return");
  if (bundle) reasons.push("bundle −" + bundle + " off");
  if (!partner) reasons.push("direct Xperion mainline");
  if (depHr >= 8 && depHr <= 19) reasons.push("convenient daytime return");
  if (tierBoost) reasons.push(tier + " priority both ways");
  return { score, reasons, bundle, totalCost };
}
function meta(f) {
  const partner = /^XP6/.test(f.flight_no);
  const stops = partner ? 1 : 0;
  const airline = partner ? "Partners" : (/^XP1[0-3]/.test(f.flight_no) ? "Xperion Express" : "Xperion Airways");
  const neo = /neo|339|330|787|321LR/i.test(f.aircraft || "");
  const features = partner ? [] : (neo ? ["WiFi", "Power"] : ["WiFi"]);
  return { partner, stops, airline, features, hub: partner ? "SCQ" : null };
}

// outbound/inbound selection lives in the shared trip state (web/v2/trip.js)

// C3 · Configurable retailing display modes — airline-level default, persisted, and
// adaptive to booking complexity. Two axes: bundle presentation (inline vs expand/
// collapse) and round-trip layout (single page vs one screen per bound).
const DISPLAY_KEY = "tap.displayCfg";
function loadDisplayCfg(pax, type) {
  try { const s = JSON.parse(localStorage.getItem(DISPLAY_KEY) || "null"); if (s && s.bundles) return s; } catch { }
  // No saved preference → default adapts to complexity: a simple solo one-way gets the
  // faster inline layout; a multi-passenger / round trip gets expand/collapse to reduce clutter.
  const simple = (pax || 1) === 1 && type === "oneway";
  return { bundles: simple ? "inline" : "expand", layout: "perBound" };
}
function saveDisplayCfg(c) { try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(c)); } catch { } }

export function Results({ shared, params, go }) {
  const type = params.type || "round";
  const _isoPlus = (n) => { const x = new Date("2026-06-15T00:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const shiftISO = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  // B1 · multi-city — an ordered list of legs stepped through one at a time (Flight N of M).
  const isMulti = type === "multi" && Array.isArray(params.legs) && params.legs.length > 0;
  const mLegs = isMulti ? params.legs : [];
  const legIndex = isMulti ? Math.min(+params.legIndex || 0, mLegs.length - 1) : 0;
  const mLeg = isMulti ? (mLegs[legIndex] || mLegs[0]) : null;
  const leg = isMulti ? ("leg" + legIndex) : (params.leg === "inbound" ? "inbound" : "outbound");
  // resolve this leg's route + date
  const origin = isMulti ? (mLeg.origin || "LIS") : ((leg === "inbound" ? params.dest : params.origin) || (leg === "inbound" ? "LIS" : "OPO"));
  const dest = isMulti ? (mLeg.dest || "OPO") : ((leg === "inbound" ? params.origin : params.dest) || (leg === "inbound" ? "OPO" : "LIS"));
  const date = isMulti ? (mLeg.date || _isoPlus(3 + legIndex * 3)) : ((leg === "inbound" ? params.ret : params.date) || _isoPlus(leg === "inbound" ? 5 : 3));
  const retDate = params.ret || _isoPlus(5);
  const pax = +params.pax || 1, cabin = params.cabin || "Economy";
  // The searched traveller count was only ever a URL param: nothing wrote it back to `trip`, so
  // Express Checkout (which skips the Passenger step) and tripTotals() both fell back to 1 adult.
  if (!trip.pnr && trip.pax !== pax) trip.pax = pax;
  const adults = +params.adults || pax, children = +params.children || 0, infants = +params.infants || 0;   // #13 — passenger-type breakdown
  // Pay-with-Miles: when the toggle is on, price each fare as "miles you have + € remaining".
  const payMilesOn = params.payMiles === true || params.payMiles === "true";
  const userMiles = +(shared?.profile?.user?.miles) || 0;
  const tier = shared?.profile?.user?.tier || "";
  const milesFor = (euros) => {
    const worth = userMiles * MILES_RATE;                       // value of the member's balance
    if (worth >= euros) return { miles: Math.round(euros / MILES_RATE), cash: 0, full: true };
    return { miles: userMiles, cash: Math.round(euros - worth), full: false };   // all miles + remaining cash
  };
  const [showMiles, setShowMiles] = useState(payMilesOn);   // results-page control, defaults to the search toggle

  // #56/#57 + My Trip Cart #7 — propagate the user's actual search selections (dates,
  // passenger count, trip type) into the shared trip state as soon as results load, so
  // every downstream screen (View & Customize, basket, cart summary, pricing) reflects
  // what the user chose instead of the module defaults (1 adult / fixed range). Previously
  // this only happened on fare-pick, so screens reached before/around that showed stale
  // defaults. Keyed on the actual values so it re-syncs whenever the search changes.
  useEffect(() => {
    if (isMulti) {
      Object.assign(trip, { type: "multi", pax, cabin, origin: mLegs[0]?.origin, dest: mLegs[mLegs.length - 1]?.dest, outbound: (trip.legs || [])[0] || null, inbound: (trip.legs || [])[1] || null, date: mLegs[0]?.date || date, ret: mLegs[1]?.date || null });
      pingBasket(); return;
    }
    const out = leg === "inbound" ? (params.date || trip.date) : (params.date || date);
    const back = params.ret || (type === "round" ? retDate : null);
    Object.assign(trip, {
      type, pax, cabin,
      origin: params.origin || trip.origin || origin,
      dest: params.dest || trip.dest || dest,
      date: out,
      ret: type === "oneway" ? null : back,
    });
    // Route sync — if the outbound-leg search route changed to something the currently-held
    // outbound flight doesn't match (a leftover from a previous, unrelated search), drop the
    // stale flight so downstream pages show the correct route and the user re-picks for it.
    // Only on the outbound leg: on the inbound leg trip.outbound is legitimately the chosen
    // outbound while the params are the swapped return route.
    if (leg !== "inbound" && trip.outbound?.flight && (trip.outbound.flight.origin !== (params.origin || trip.origin) || trip.outbound.flight.dest !== (params.dest || trip.dest))) {
      trip.outbound = null; trip.inbound = null; trip.legs = [];
    }
    pingBasket(); // notify the nav badge / summaries to re-read trip
  }, [pax, type, cabin, params.origin, params.dest, params.date, params.ret, leg]); // eslint-disable-line react-hooks/exhaustive-deps

  const [flights, setFlights] = useState(null);
  const [week, setWeek] = useState([]);
  const [weekAnchor, setWeekAnchor] = useState(date);   // #20 — window anchor, independent of the selected date
  const [expanded, setExpanded] = useState(null);
  const [sort, setSort] = useState("Best");
  const [clearNonce, setClearNonce] = useState(0);   // #6 — force-remount filter controls on Clear all
  const [filtersOpen, setFiltersOpen] = useState(false);   // J2 — collapsible filters on mobile (always shown on lg+)
  const [sel, setSel] = useState(isMulti ? (trip.legs || [])[legIndex] : trip[leg]);
  const [showAll, setShowAll] = useState(false);
  const [held, setHeld] = useState(() => !!(trip.fareHold && trip.fareHold.until > Date.now()));  // #3 — reflect a live fare hold
  const [holdOpen, setHoldOpen] = useState(false);
  // C3 — display-mode config (persisted; adapts to complexity on first load).
  const [disp, setDisp] = useState(() => loadDisplayCfg(params.pax, type));
  const [dispOpen, setDispOpen] = useState(false);
  const setBundles = (b) => { const c = { ...disp, bundles: b }; setDisp(c); saveDisplayCfg(c); };
  const setLayoutMode = (l) => { const c = { ...disp, layout: l }; setDisp(c); saveDisplayCfg(c); };
  const inlineFares = disp.bundles === "inline" || disp.layout === "single";
  const [F, setF] = useState({ direct: false, oneStop: false, twoStop: false, brands: new Set(CABIN_BRANDS[cabin] || CABIN_BRANDS.Economy), depLo: 0, depHi: 24, airlines: new Set(["Xperion Airways", "Xperion Express", "Partners"]), priceLo: 0, priceHi: 800, wifi: false, useMiles: false, refundable: false, bag: false });

  useEffect(() => {
    setFlights(null); setExpanded(null);
    api.get(`/search?origin=${origin}&dest=${dest}${date ? "&date=" + date : ""}&pax=${pax}`)
      .then(r => {
        const fl = (r.flights || []).map(f => ({ ...f, _m: meta(f), _fares: deriveFares(f.price, f.cabin_prices) }));
        setFlights(fl);
        // fares stay collapsed by default — user expands a flight to compare fares
        // keep the cross-channel journey alive at results stage for this real search
        api.post("/journey", { origin, dest, date, stage: "results", device: "Web app", cabin }).catch(() => {});
      }).catch(() => setFlights([]));
  }, [origin, dest, date]);

  // date strip — cheapest per day for the visible week (parallel, real engine prices)
  useEffect(() => {
    const anchor = weekAnchor || date;
    if (!anchor) return;
    const base = new Date(anchor + "T00:00:00");
    const days = [-3, -2, -1, 0, 1, 2, 3].map(o => { const d = new Date(base); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); });
    Promise.all(days.map(d => api.get(`/search?origin=${origin}&dest=${dest}&date=${d}&bg=1`).then(r => ({ d, p: (r.flights || []).reduce((m, f) => Math.min(m, f.price), Infinity) })).catch(() => ({ d, p: Infinity }))))
      .then(rows => setWeek(rows.map(r => ({ date: r.d, price: isFinite(r.p) ? r.p : null }))));
  }, [origin, dest, weekAnchor]);
  // #20 — selecting a date keeps the window fixed (the tile stays put); only recenter if the date lands outside the visible week.
  useEffect(() => { if (date && week.length && !week.some(d => d.date === date)) setWeekAnchor(date); }, [date]); // eslint-disable-line

  const counts = useMemo(() => {
    const c = { direct: 0, oneStop: 0, twoStop: 0, airline: {}, brand: {}, wifi: 0, useMiles: 0, refundable: 0, bag: 0 };
    (flights || []).forEach(f => {
      if (f._m.stops === 0) c.direct++; else if (f._m.stops === 1) c.oneStop++; else c.twoStop++;
      c.airline[f._m.airline] = (c.airline[f._m.airline] || 0) + 1;
      if (f._m.features.includes("WiFi")) c.wifi++;
      if (f._fares?.find(x => x.key === "Classic")?.feats?.[1]?.[1]) c.bag++;
      c.useMiles++; c.refundable++; (f._fares || []).forEach(x => { c.brand[x.key] = (c.brand[x.key] || 0) + 1; });
    });
    return c;
  }, [flights]);

  const view = useMemo(() => {
    let v = (flights || []).filter(f => {
      const m = f._m;
      const stopOK = (!F.direct && !F.oneStop && !F.twoStop) || (F.direct && m.stops === 0) || (F.oneStop && m.stops === 1) || (F.twoStop && m.stops >= 2);
      const dep = depMins(f.dep) / 60;
      const cabinB = (CABIN_BRANDS[cabin] || CABIN_BRANDS.Economy).filter(b => F.brands.has(b));
      const cheapest = cabinB.length ? Math.min(...cabinB.map(b => f._fares.find(x => x.key === b)?.price ?? Infinity)) : Infinity;
      return stopOK && F.airlines.has(m.airline) && dep >= F.depLo && dep <= F.depHi
        && cheapest >= F.priceLo && cheapest <= F.priceHi
        && (!F.wifi || m.features.includes("WiFi"))
        && (!F.bag || f._fares.find(x => x.key === "Classic")?.feats?.[1]?.[1])
        && (!F.refundable || cabinB.some(b => b !== "Basic"));
    });
    const cls = f => f._fares.find(x => x.key === "Classic").price;
    if (sort === "All") v = [...v].sort((a, b) => depMins(a.dep) - depMins(b.dep));
    else if (sort === "Cheapest") v = [...v].sort((a, b) => a.price - b.price);
    else if (sort === "Fastest") v = [...v].sort((a, b) => durMins(a.duration) - durMins(b.duration));
    else if (sort === "Earliest") v = [...v].sort((a, b) => depMins(a.dep) - depMins(b.dep));
    else if (sort === "Eco") v = [...v].sort((a, b) => (a._m.partner ? 1 : 0) - (b._m.partner ? 1 : 0) || a.price - b.price);
    else if ((leg === "inbound" && trip.outbound) || (isMulti && legIndex > 0 && (trip.legs || [])[legIndex - 1])) {
      // A6 · contextual ranking from the cart — rank this leg by the price IN the fare brand
      // already chosen on the previous leg, so a change to that selection re-ranks these results.
      const prevFare = (isMulti ? (trip.legs || [])[legIndex - 1]?.fare : trip.outbound?.fare) || "Classic";
      const priorLeg = isMulti ? (trip.legs || [])[legIndex - 1] : trip.outbound;
      const brandPrice = f => f._fares.find(x => x.key === prevFare)?.price ?? f.price;
      // Best Pairing: rank by the genuine outbound+inbound pairing score (cost, duration, brand
      // compatibility, connection quality, schedule, loyalty). Other tabs keep their own criteria.
      if (sort === "Best" && priorLeg) {
        v = [...v].sort((a, b) => pairingScore(a, priorLeg, tier, prevFare).score - pairingScore(b, priorLeg, tier, prevFare).score);
      } else {
        v = [...v].sort((a, b) => brandPrice(a) - brandPrice(b) || (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
      }
    }
    else v = [...v].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0) || a.price - b.price); // Best
    return v;
  }, [flights, F, sort, tier]);

  const lowest = useMemo(() => (flights || []).reduce((m, f) => Math.min(m, f.price), Infinity), [flights]);
  const fastest = useMemo(() => (flights || []).reduce((m, f) => Math.min(m, durMins(f.duration)), 999), [flights]);
  const earliest = useMemo(() => (flights || []).map(f => f.dep).sort()[0], [flights]);

  // v35 Search #3 (both legs): results load with every card collapsed; fares appear only after
  // the user clicks "See fares". The previous auto-expand of the top flight is retired.

  function pickFare(f, fare) {
    if (!fare) {                                                // #17 — re-clicking the selected fare deselects (toggle)
      if (isMulti) { const L = [...(trip.legs || [])]; L[legIndex] = null; trip.legs = L; pingBasket(); }
      else setLeg(leg, null);
      setSel(null); return;
    }
    if (trip.pnr) resetTrip();                                 // #18 — picking a flight after a completed booking starts a clean cart
    const choice = { flight: f, fare: fare.key, price: fare.price, leg, origin, dest, date };
    if (isMulti) {
      const L = [...(trip.legs || [])]; L[legIndex] = choice; trip.legs = L;
      // Map the leg list onto outbound/inbound so the existing cart / passenger / payment
      // spine books every leg without a parallel code path (UI supports up to 2 legs).
      Object.assign(trip, { type: "multi", pax, adults, children, infants, cabin, payMiles: payMilesOn, origin: mLegs[0].origin, dest: mLegs[mLegs.length - 1].dest, outbound: L[0] || null, inbound: L[1] || null, date: mLegs[0].date || date, ret: mLegs[1]?.date || null });
      pingBasket();
    } else {
      setLeg(leg, choice);
      Object.assign(trip, { type, pax, adults, children, infants, cabin, payMiles: payMilesOn, origin: params.origin || origin, dest: params.dest || dest, date: params.date || date, ret: params.ret || retDate });
    }
    setSel(choice);
    api.post("/journey", { origin, dest, date, stage: "seat", flight_no: f.flight_no, cabin: fare.cabin || "Economy", device: "Web app" }).catch(() => {});
  }
  function advance() {
    if (!sel) return;                                                   // #28 — current leg must have a selected flight + fare
    if (isMulti) {
      if (legIndex < mLegs.length - 1) { go("results", { ...params, legIndex: legIndex + 1 }); return; }
      go("cart", { ...params }); return;
    }
    if (type === "round" && leg === "outbound") { go("results", { ...params, leg: "inbound" }); return; }
    if (type === "round" && !trip.outbound) { go("results", { ...params, leg: "outbound" }); return; }   // outbound missing → send back to pick it
    go("cart", { ...params });
  }

  const cityOf = (c) => shared.airports?.find(a => a.code === c)?.city || c;

  return (
    <div className="bg-surface-soft min-h-screen pb-6">
      {/* search summary bar */}
      <div className="bg-surface border-b border-line">
        <div className="mx-auto max-w-page px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2">
          {isMulti && <span className="text-[10px] font-bold uppercase tracking-wide rounded-full px-2.5 py-1 bg-tap-greenDeep text-white shrink-0">Flight {legIndex + 1} of {mLegs.length}</span>}
          <Chip label="From" value={`${cityOf(origin)} · ${origin}`} />
          <button onClick={() => go("results", { ...params, origin: params.dest || dest, dest: params.origin || origin })} className="px-1.5 hover:text-tap-greenDeep" style={{ color: "#232323" }} title="Swap origin and destination" aria-label="Swap"><Icon name="swap" size={19} /></button>
          <Chip label="To" value={`${cityOf(dest)} · ${dest}`} />
          <Chip label="Dates" value={
            type !== "round"
              ? fmtDate(date)
              : leg === "inbound"
                ? `Returning ${fmtDate(retDate)}`.replace(/ \d{4}/g, "")            // #34 — return leg: single date, not a range
                : `${fmtDate(date)} — ${fmtDate(retDate)}`.replace(/ \d{4}/g, "")   // outbound: full trip span
          } />
          <Chip label="Pax" value={`${(() => { const a = +params.adults || pax; const c = +params.children || 0; const inf = +params.infants || 0; return [`${a} adult${a !== 1 ? "s" : ""}`, c ? `${c} child${c !== 1 ? "ren" : ""}` : "", inf ? `${inf} infant${inf !== 1 ? "s" : ""}` : ""].filter(Boolean).join(" · "); })()} · ${CABIN_LABEL[cabin] || "Economy"}`} />
          <button onClick={() => go("home")} className="ml-auto inline-flex items-center justify-center text-ink hover:border-tap-green whitespace-nowrap" style={{ height: "36px", padding: "10px 16px", borderRadius: "9999px", border: "1px solid #E2E2E5", fontSize: "13px", fontWeight: 600 }}>Edit search</button>
        </div>
      </div>

      {isMulti && (
        <div className="bg-surface-dark">
          <div className="mx-auto max-w-page px-4 sm:px-6 py-2.5 flex items-center gap-2 overflow-x-auto v2-track">
            <span className="text-[10px] font-bold uppercase tracking-wide text-lime shrink-0 mr-1">Multi-city itinerary</span>
            {mLegs.map((L, i) => {
              const picked = (trip.legs || [])[i];
              const state = i === legIndex ? "current" : picked ? "done" : "todo";
              return <span key={i} className={cx("shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold", state === "current" ? "bg-lime text-ink" : state === "done" ? "bg-white/15 text-white" : "bg-white/5 text-white/50")}>
                {state === "done" && <Icon name="check" size={11} />} Flight {i + 1} · {L.origin}→{L.dest}{picked && <span className={state === "current" ? "text-ink/60" : "text-lime"}> · {EUR(picked.price)}</span>}
              </span>;
            })}
          </div>
        </div>
      )}

      {/* stepper — full booking journey */}
      <div className="bg-surface border-b border-line">
        <div className="mx-auto max-w-page px-4 sm:px-6 py-4 flex items-center justify-between gap-4 text-[13px] font-semibold whitespace-nowrap">
          <div className="flex items-center gap-2 overflow-x-auto v2-track min-w-0">
          {["Select flights", "View & customize cart", "My Trip Basket", "Passenger details", "Payment"].map((s, i) => (
            <React.Fragment key={s}>
              <span className={cx("shrink-0 flex items-center gap-1.5", i === 0 ? "text-ink font-bold" : "text-ink-faint")}>
                <span className={cx("w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px]", i === 0 ? "bg-lime-tint text-tap-greenDeep ring-1 ring-lime" : "bg-surface-mute text-ink-faint")}>{i + 1}</span>{s}
              </span>
              {i < 4 && <span className={cx("w-8 sm:w-12 h-0.5 rounded-full shrink-0", i === 0 ? "bg-ink-700" : "bg-line-strong")} />}
            </React.Fragment>
          ))}
          </div>
          <div className="text-right shrink-0"><div className="text-[12px] text-ink-muted">Step 1 of 5</div><div className="text-[13px] font-bold text-ink">Pick your flight</div></div>
        </div>
      </div>

      <div className="mx-auto max-w-page px-4 sm:px-6 py-6 grid lg:grid-cols-[260px_1fr] gap-6">
        {/* J2 — mobile-only filters toggle (hidden on lg where the sidebar is always visible) */}
        <button onClick={() => setFiltersOpen(o => !o)} className="lg:hidden w-full flex items-center justify-between rounded-xl border border-line-strong bg-surface px-4 py-3 text-[14px] font-semibold text-ink"><span className="flex items-center gap-2"><Icon name="menu" size={16} className="text-ink-muted" /> Filters &amp; sort</span><Icon name={filtersOpen ? "x" : "arrow"} size={16} className="text-ink-muted" /></button>
        {/* filters */}
        <aside className={cx("space-y-5", filtersOpen ? "block" : "hidden lg:block")}>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3"><div className="font-bold text-[15px]">Filters</div><button className="text-[12px] text-ink font-semibold hover:text-tap-greenDeep" onClick={() => { setF({ direct: false, oneStop: false, twoStop: false, brands: new Set(CABIN_BRANDS[cabin] || CABIN_BRANDS.Economy), depLo: 0, depHi: 24, airlines: new Set(["Xperion Airways", "Xperion Express", "Partners"]), priceLo: 0, priceHi: 800, wifi: false, useMiles: false, refundable: false, bag: false }); setSort("Best"); setClearNonce(n => n + 1); }}>Clear all</button></div>
            <FGroup title="Stops">
              <Chk label="Direct only" count={counts.direct} on={F.direct} set={v => setF({ ...F, direct: v })} />
              <Chk label="1 stop" count={counts.oneStop} on={F.oneStop} set={v => setF({ ...F, oneStop: v })} />
              <Chk label="2+ stops" count={counts.twoStop} on={F.twoStop} set={v => setF({ ...F, twoStop: v })} />
            </FGroup>
            <FGroup title={`Fare brand · ${CABIN_LABEL[cabin] || "Economy"}`}>
              {(CABIN_BRANDS[cabin] || CABIN_BRANDS.Economy).map(b => (
                <Chk key={b} label={b} count={counts.brand[b] || 0} on={F.brands.has(b)} set={v => { const s = new Set(F.brands); v ? s.add(b) : s.delete(b); setF({ ...F, brands: s }); }} />
              ))}
            </FGroup>
            <FGroup title="Departure window">
              <DualRange key={`dep-${clearNonce}`} min={0} max={24} lo={F.depLo} hi={F.depHi} onLo={v => setF({ ...F, depLo: v })} onHi={v => setF({ ...F, depHi: v })} fmtLo={`${String(F.depLo).padStart(2, "0")}:00`} fmtHi={`${String(F.depHi).padStart(2, "0")}:00`} />
            </FGroup>
            <FGroup title="Price range">
              <DualRange key={`price-${clearNonce}`} min={0} max={800} step={10} lo={F.priceLo} hi={F.priceHi} onLo={v => setF({ ...F, priceLo: v })} onHi={v => setF({ ...F, priceHi: v })} fmtLo={EUR(F.priceLo)} fmtHi={F.priceHi >= 800 ? "€800+" : EUR(F.priceHi)} />
            </FGroup>
            <FGroup title="Airline">
              {["Xperion Airways", "Xperion Express", "Partners"].map(a => <Chk key={a} label={a} count={counts.airline[a] || 0} on={F.airlines.has(a)} set={v => { const s = new Set(F.airlines); v ? s.add(a) : s.delete(a); setF({ ...F, airlines: s }); }} />)}
            </FGroup>
            <FGroup title="Inclusions" last>
              <Chk label="Bag included" count={counts.bag} on={F.bag} set={v => setF({ ...F, bag: v })} />
              <Chk label="Wi-Fi onboard" count={counts.wifi} on={F.wifi} set={v => setF({ ...F, wifi: v })} />
              <Chk label="Refundable" count={counts.refundable} on={F.refundable} set={v => setF({ ...F, refundable: v })} />
              <Chk label="Use miles" count={counts.useMiles} on={F.useMiles} set={v => setF({ ...F, useMiles: v })} />
            </FGroup>
          </Card>
        </aside>

        {/* results */}
        <div className="space-y-4">
          {leg === "inbound" && trip.outbound && (() => {
            const ob = trip.outbound, of = ob.flight;
            return (
              <>
                {/* selected outbound — shown first, labelled (#2,#3) */}
                <div className="pt-2">
                  <Card className="border border-tap-green/30 overflow-hidden" style={{ background: "#FFFFFF", borderRadius: "14px", boxShadow: "0px 4px 14px 0px rgba(0, 0, 0, 0.05)" }}>
                    <div className="flex items-stretch">
                      {/* left: compact outbound summary */}
                      <div className="flex-1 min-w-0 px-4 py-3">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-ink inline-flex items-center gap-1 mb-2">Outbound <Icon name="check" size={11} className="text-tap-greenDeep" /></div>
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <div className="flex items-center gap-4 min-w-[220px]">
                            <div className="text-center"><div className="text-[20px] font-bold leading-none v2-num">{of.dep}</div><div className="text-[11px] text-ink-faint mt-1">{of.origin}</div></div>
                            <div className="text-center text-ink-faint min-w-[56px]"><div className="text-[11px]">{of.duration}</div><div className="w-14 h-px bg-line-strong my-1.5 mx-auto" /><div className="text-[11px]">Direct</div></div>
                            <div className="text-center"><div className="text-[20px] font-bold leading-none v2-num">{of.arr}</div><div className="text-[11px] text-ink-faint mt-1">{of.dest}</div></div>
                          </div>
                          <div className="min-w-[160px]">
                            <div className="flex items-center gap-2"><img src="/v2/assets/homepage/tap-logo.png" alt="Xperion Airways" className="shrink-0 object-contain" style={{ height: "16px", width: "auto" }} /><span className="text-[13px] font-semibold">{String(of.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")}</span></div>
                            <div className="text-[11px] text-ink-faint mt-0.5">{of.aircraft} · Bag included</div>
                            <div className="text-[11px] font-semibold text-ink-700 mt-1">Earn {miles(Math.round(ob.price * 8))} MI</div>
                          </div>
                        </div>
                      </div>
                      {/* right: full-height green fare panel attached to edge */}
                      <div className="text-right self-stretch flex flex-col justify-center shrink-0" style={{ width: "282px", padding: "22px 24px 22px 20px", gap: "24px", background: "rgba(242, 255, 219, 1)" }}>
                        <div>
                          <div className="text-[10px] font-semibold text-amber-600">OR {miles(Math.round(ob.price * 110 / 500) * 500)} MI + {EUR(Math.round(ob.price * 0.18))}</div>
                          <div className="text-[24px] font-bold v2-num leading-tight mt-0.5">{EUR(ob.price)}</div>
                          <div className="text-[10px] text-ink-faint">1 adult · {ob.fare}</div>
                        </div>
                        <Btn size="sm" variant="primary" className="w-full" style={{ height: "36px", padding: "10px 18px", borderRadius: "9999px" }}>Selected ✓</Btn>
                      </div>
                    </div>
                  </Card>
                </div>
                {/* v35 Inbound #5: the paired-journey fare strip was rendered here AND inside the
                    booking summary module — the same totals twice on one page. The module owns it;
                    the standalone strip (old #22) is retired. */}
                {/* divider (#9) */}
                <div className="flex items-center gap-3 py-1"><div className="flex-1 h-px bg-line-strong" /><span className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Select inbound flight</span><div className="flex-1 h-px bg-line-strong" /></div>
                {/* smart re-rank recommendation band (#10) */}
                <div className="rounded-2xl bg-surface-dark text-white px-5 py-4 flex flex-wrap items-center gap-4">
                  <div className="flex-1 min-w-[260px]">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-lime">Smart re-rank · paired with your outbound</div>
                    <div className="text-[14px] font-semibold mt-1">Re-ordered for the cheapest pairing, best gate-to-gate time, and full {shared?.profile?.user?.tier || "Gold"} benefits on both legs.</div>
                    <div className="flex flex-wrap gap-2 mt-2.5">
                      {["+ Bundle bag −€15", "+ Same-day return", "+ Earn 2× miles"].map(t => <span key={t} className="text-[11px] font-semibold rounded-full border border-white/25 px-2.5 py-1 text-lime">{t}</span>)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#B2B2BF" }}>Why this order?</div>
                    <button onClick={() => go("ai")} className="inline-flex items-center justify-center text-[12px] font-bold text-white hover:brightness-95" style={{ width: "119px", height: "31px", padding: "8px 14px", borderRadius: "9999px", background: "#47A41B" }}>Explain ranking</button>
                  </div>
                </div>
              </>
            );
          })()}
          {/* date strip */}
          <div className="flex items-stretch gap-1" style={{ width: "100%", height: "64px", borderRadius: "14px", border: "1px solid rgba(226, 226, 229, 1)", boxShadow: "0px 4px 14px 0px rgba(0, 0, 0, 0.05)", padding: "0 16px", background: "#fff" }}>
            <button onClick={() => setWeekAnchor(shiftISO(weekAnchor || date, -7))} className="px-2 rounded-xl hover:bg-surface-mute text-ink-muted shrink-0 text-[18px] leading-none" title="Previous week">‹</button>
            <div className="flex-1 flex gap-1 overflow-x-auto v2-track items-stretch">
            {week.map(d => {
              const on = d.date === date;
              return <button key={d.date} onClick={() => go("results", { ...params, [leg === "inbound" ? "ret" : "date"]: d.date })}
                className={cx("text-center transition-colors flex flex-col items-center justify-center gap-1 flex-1 min-w-[84px]", on ? "" : "px-3 rounded-xl hover:bg-surface-mute")} style={on ? { padding: "14px", background: "rgba(242, 255, 219, 1)", borderBottom: "1px solid #2E7D33" } : undefined}>
                <div className={cx(on ? "" : "text-[11px]", on ? "" : "text-ink-muted")} style={on ? { color: "#111111", fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: "11px", lineHeight: "100%", letterSpacing: "0.5px" } : undefined}>{new Date(d.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}</div>
                <div className={cx(on ? "" : "text-[15px] font-bold", "v2-num", !on && "text-ink")} style={on ? { color: "#46A41A", fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: "15px", lineHeight: "100%", letterSpacing: "0.5px" } : undefined}>{d.price ? EUR(d.price) : "—"}</div>
              </button>;
            })}
            </div>
            <button onClick={() => setWeekAnchor(shiftISO(weekAnchor || date, 7))} className="px-2 rounded-xl hover:bg-surface-mute text-ink-muted shrink-0 text-[18px] leading-none" title="Next week">›</button>
          </div>{/* end fare selector */}

          {/* sort tabs — borderless, label-only, green active state */}
          <div className="flex items-center gap-2 overflow-x-auto v2-track">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface p-1 shrink-0">
            {["All flights", "Best", "Cheapest", "Fastest", "Earliest", "Eco-friendly"].map(k => {
              const key = k === "Eco-friendly" ? "Eco" : k === "All flights" ? "All" : k;
              const on = sort === key;
              const label = leg === "inbound" ? ({ "All flights": "All Flights", "Best": "Best Pairing", "Cheapest": "Cheapest", "Fastest": "Quickest", "Earliest": "Latest Return", "Eco-friendly": "Same Day" }[k] || k) : k;
              return <button key={k} onClick={() => setSort(key)} className={cx("shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-bold transition-colors", on ? "bg-tap-green text-white shadow-sm" : "text-ink-muted hover:bg-surface-mute")}>
                {label}
              </button>;
            })}
            </div>
            <div className="ml-auto shrink-0 pr-1 flex items-center gap-2">
              <button onClick={() => setShowMiles(v => !v)} title="Show fares in miles" className={cx("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-semibold transition-colors", showMiles ? "border-tap-green bg-lime-tint text-tap-greenDeep" : "border-line text-ink-muted hover:bg-surface-mute")}>
                <span className={cx("w-7 h-4 rounded-full relative transition-colors shrink-0", showMiles ? "bg-tap-green" : "bg-line-strong")}><span className={cx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all", showMiles ? "left-3.5" : "left-0.5")} /></span>
                <span className="whitespace-nowrap">Show in miles ✦</span>
              </button>
              <button onClick={() => setHoldOpen(true)} className="inline-flex items-center justify-center text-[12px] font-semibold transition-colors hover:brightness-95" style={{ width: "127px", height: "28px", padding: "5px 8px", gap: "4px", borderRadius: "9999px", border: "1px solid #C7F21F", background: "#F2FFDB", color: "#2E7D33" }}>
                <span className="inline-flex items-center justify-center shrink-0" style={{ width: "16px", height: "16px", borderRadius: "8px", background: "#46A41A" }}><Icon name={held ? "check" : "lock"} size={10} className="text-white" /></span> {held ? "Fare held · 72h" : "Hold your fare"}
              </button>
            </div>
          </div>

          {disp.layout === "single" && type === "round" && (
            <div className="rounded-xl border border-tap-green/30 bg-lime-tint/40 px-4 py-2.5 flex items-center gap-2 text-[12px] font-semibold text-tap-greenDark">
              <Icon name="grid" size={14} className="shrink-0" /> Single-page round trip — outbound and return shown in one continuous flow, all fares inline.
            </div>
          )}

          {flights === null && <div className="py-16 text-center text-ink-faint">Searching {cityOf(origin)} → {cityOf(dest)}…</div>}
          {flights && view.length === 0 && <Card className="p-8 text-center text-ink-muted">No flights match these filters. Try widening them.</Card>}

          {(showAll ? view : view.slice(0, 5)).map((f, i) => (
            <FlightCard key={f.flight_no} f={f} expanded={expanded === f.flight_no} sel={sel} lowest={lowest} cabin={cabin} inline={inlineFares}
              pairing={leg === "inbound" && sort === "Best" && i === 0 && !sel} pairingInfo={leg === "inbound" && i === 0 ? pairingScore(f, trip.outbound, tier, trip.outbound?.fare) : null} originCity={cityOf(f.origin)} destCity={cityOf(f.dest)}
              payMilesOn={showMiles} milesFor={milesFor}
              onToggle={() => setExpanded(expanded === f.flight_no ? null : f.flight_no)} onPick={pickFare} />
          ))}

          {flights && view.length > 5 && !showAll &&
            <Card className="p-3.5 text-center text-[13px] font-semibold text-ink-muted cursor-pointer hover:bg-surface-mute" onClick={() => setShowAll(true)}>Show {view.length - 5} more flights</Card>}
        </div>
      </div>

      {/* selection bar — always shown so the next-step CTA is explicit; it stays disabled with a
          validation message until a flight + fare is selected for the current leg (#28). */}
      {/* v33 Outbound #11 — the selection bar appears only AFTER a flight+fare is picked;
          "Change" (#12) deselects and removes it. On the INBOUND leg the bar stays visible once
          the outbound is locked (carried Inbound #10: "OUTBOUND ✓ · INBOUND: select to continue"). */}
      {sel && <div className="h-24" aria-hidden="true" />}
      {sel && <div className="fixed inset-x-0 bottom-4 z-40">
        <div className="mx-auto max-w-page px-4 sm:px-6">
          <div className="bg-surface-dark text-white rounded-2xl shadow-pop px-5 py-3.5 flex items-center gap-4">
            <div className="min-w-0">
              {sel ? <>
                <div className="font-bold" style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", fontWeight: 600, letterSpacing: "1px", color: "#9EFC38" }}>{isMulti ? `FLIGHT ${legIndex + 1} OF ${mLegs.length} SELECTED` : (leg === "inbound" ? "OUTBOUND ✓ · INBOUND: select to continue" : "OUTBOUND SELECTED")}</div>
                {isMulti
                  ? <div className="text-[13px] font-semibold truncate">{String(sel.flight.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")} {sel.flight.origin}→{sel.flight.dest} · {EUR(sel.price)}{(trip.legs || []).filter(Boolean).length > 1 && <> &nbsp;·&nbsp; itinerary <span className="text-lime">{EUR((trip.legs || []).filter(Boolean).reduce((s, l) => s + l.price, 0))}</span></>}</div>
                  : leg === "inbound" && trip.outbound
                  ? <div className="text-[13px] font-semibold truncate">{String(trip.outbound.flight.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")} {trip.outbound.flight.origin}→{trip.outbound.flight.dest} {EUR(trip.outbound.price)} &nbsp;+&nbsp; {String(sel.flight.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")} {sel.flight.origin}→{sel.flight.dest} {EUR(sel.price)} &nbsp;=&nbsp; <span className="text-lime">{EUR(trip.outbound.price + sel.price - 15)}</span> <span className="text-white/60 font-normal">(bundle saved €15)</span></div>
                  : <div className="text-[13px] font-semibold">{String(sel.flight.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")} · {new Date((leg === "inbound" ? retDate : date) + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · {sel.flight.dep} → {sel.flight.arr} · {EUR(sel.price)}</div>}
              </> : <>
                <div className={cx("font-bold", leg !== "inbound" && "text-white/50")} style={leg === "inbound" ? { fontFamily: "Inter, sans-serif", fontSize: "10px", fontWeight: 600, letterSpacing: "1px", color: "#9EFC38" } : { fontSize: "10px", letterSpacing: "1px" }}>{isMulti ? `Select flight ${legIndex + 1} of ${mLegs.length}` : (leg === "inbound" ? "OUTBOUND ✓ · INBOUND: select to continue" : "Select your outbound flight")}</div>
                <div className="text-[13px] font-semibold text-white/80">Choose a flight and fare above to continue.</div>
              </>}
            </div>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {!isMulti && leg === "inbound" && trip.outbound && <button onClick={() => go("express")} className="inline-flex items-center justify-center font-semibold hover:brightness-95 shrink-0" style={{ height: "36px", padding: "10px 16px", borderRadius: "9999px", border: "1px solid #9EFD38", color: "#9EFD38", background: "transparent" }}>Express checkout</button>}
              {!isMulti && !(leg === "inbound" && trip.outbound) && <button onClick={() => { setSel(null); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="inline-flex items-center justify-center font-semibold hover:brightness-95 transition-colors shrink-0" style={{ width: "110px", height: "36px", padding: "10px 14px", borderRadius: "9999px", border: "1px solid #666670", color: "#fff", background: "transparent" }}>Change</button>}
              <Btn variant="lime" className="text-[14px] font-bold" style={{ minWidth: "150px", height: "41px", padding: "0 22px", borderRadius: "9999px", background: "#46A41A", color: "#fff" }} disabled={!sel || (type === "round" && leg === "inbound" && !trip.outbound)} onClick={advance}>{isMulti ? (legIndex < mLegs.length - 1 ? "Next flight" : "Customize your cart") : (type === "round" && leg === "outbound" ? "Pick inbound" : "Customize your cart")} <Icon name="arrow" size={14} /></Btn>
            </div>
          </div>
        </div>
      </div>}
      {holdOpen && (sel?.flight || view[0]) && (
        <HoldFareModal flight={sel?.flight || view[0]} date={date} fare={sel?.fare || "Eco Classic"}
          price={sel?.price ?? (view[0] && view[0]._fares.find(x => x.key === "Classic").price) ?? 0} seat="12A"
          onClose={() => setHoldOpen(false)} onHeld={() => setHeld(true)} onContinue={() => { setHoldOpen(false); advance(); }} />
      )}
    </div>
  );
}

/* Hold-fare dialog (A8) — three windows; every hold decision records a hold and fires a
   confirmation email server-side (/api/hold → sendEmail "hold_confirmation"). */
function HoldFareModal({ flight, date, fare, price, seat, onClose, onHeld, onContinue }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const opts = [
    { dur: "24h", label: "Hold 24 hours", fee: 9, note: "Fully deductible from final fare" },
    { dur: "48h", label: "Hold 48 hours", fee: 18, note: "Fully deductible from final fare", pop: true },
    { dur: "7d", label: "Hold 7 days", fee: 39, note: "Non-deductible" },
  ];
  async function hold(o) {
    setBusy(true);
    try {
      const r = await api.post("/hold", { flight_no: flight.flight_no, duration: o.dur, fee: o.fee, total: price });
      setDone({ ...o, expires: r.expires, to: r.email && r.email.to });
      // #3 — persist the hold so the fare stays locked through checkout (no price-change prompt in-window)
      const ms = o.dur === "7d" ? 7 * 864e5 : o.dur === "48h" ? 48 * 36e5 : 24 * 36e5;
      setFareHold({ flightNo: flight.flight_no, until: Date.now() + ms, price, duration: o.dur });
      onHeld && onHeld();
    }
    catch { setDone({ ...o, error: true }); }
    setBusy(false);
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-pop w-full max-w-[760px] my-6 p-5 sm:p-7" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-lime inline-flex items-center justify-center text-ink"><Icon name="clock" size={20} /></span>
          <div className="text-[22px] font-black">Not ready to book?</div>
        </div>
        <div className="text-[13px] text-ink-muted mt-1">Lock this price for up to 7 days. Fee deductible from final total.</div>
        {done ? (
          <div className="mt-5 rounded-xl border border-tap-green bg-lime-tint/50 p-6 text-center">
            <div className="text-[16px] font-bold text-tap-greenDeep">Fare held ✓ — {done.label.toLowerCase()}</div>
            <div className="text-[13px] text-ink-700 mt-1">{String(flight.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")} locked at {EUR(price)} until <b>{done.expires}</b>. Hold fee {EUR(done.fee)}{done.dur === "7d" ? "" : " (deductible from final fare)"}.</div>
            <div className="text-[12px] text-ink-muted mt-1">{done.error ? "Hold saved — confirmation email pending." : `Confirmation emailed${done.to ? " to " + done.to : ""}.`}</div>
            <div className="flex justify-center gap-2 mt-4">
              <Btn variant="outline" onClick={onClose}>← Back to results</Btn>
              <Btn variant="primary" onClick={onContinue}>Continue to passengers →</Btn>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-xl bg-surface-soft border border-line p-4">
              <div className="text-[14px] font-bold">Your selected flight</div>
              <div className="text-[13px] font-semibold mt-1">{flight.origin}–{flight.dest} · {String(flight.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")} · {fmtDate(date).replace(/ \d{4}/, "")} · {fare} · {EUR(price)}</div>
              <div className="text-[11px] text-ink-faint mt-1">Hold preserves: fare, seat {seat}, bag entitlement, current taxes</div>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 mt-4">
              {opts.map(o => (
                <div key={o.dur} className={cx("relative rounded-xl border p-4 flex flex-col", o.pop ? "border-tap-green bg-lime-tint/40" : "border-line")}>
                  {o.pop && <span className="absolute -top-2 right-3 text-[10px] font-bold uppercase tracking-wide bg-tap-red text-white rounded-full px-2 py-0.5">Most popular</span>}
                  <div className="text-[15px] font-bold">{o.label}</div>
                  <div className="text-[30px] font-black v2-num mt-1 leading-none">{EUR(o.fee)}</div>
                  <div className="text-[11px] text-ink-muted mt-2">{o.note}</div>
                  <ul className="mt-3 space-y-1.5 flex-1">
                    {["Fare locked", "Seat held", "Notifications"].map(t => <li key={t} className="flex items-center gap-2 text-[12px] text-ink-700"><Icon name="check" size={13} className="text-tap-green" />{t}</li>)}
                  </ul>
                  <Btn variant={o.pop ? "lime" : "outline"} className="w-full mt-3" disabled={busy} onClick={() => hold(o)}>Hold for {EUR(o.fee)}</Btn>
                </div>
              ))}
            </div>
            <div className="grid sm:grid-cols-3 gap-2 mt-4 text-[12px]">
              {[["lock", `Price locked at ${EUR(price)} even if fare rises`], ["swap", "Auto-refunded if you decide not to book"], ["clock", "Reminder 6 h before window closes"]].map(([ic, t]) => (
                <div key={t} className="flex items-center gap-2 rounded-lg bg-surface-soft border border-line px-3 py-2 text-ink-700"><Icon name={ic} size={14} className="text-ink-muted shrink-0" />{t}</div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-5">
              <Btn variant="outline" onClick={onClose}>← Back to results</Btn>
              <a className="text-[12px] text-ink-muted underline cursor-pointer">Terms &amp; conditions</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---- sub-components ---- */
const Chip = ({ label, value }) => (
  <div className="flex items-center gap-2 bg-surface border border-line rounded-full px-3.5 py-1.5">
    <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</span>
    <span className="text-[13px] font-semibold">{value}</span>
  </div>
);
const Line = () => <div className="hidden sm:block flex-1 h-px bg-line-strong max-w-[60px]" />;
function Step({ n, title, sub, active, done, dim }) {
  return (
    <div className={cx("flex items-center gap-2.5 rounded-full pl-1.5 pr-4 py-1.5", active ? "bg-lime-tint border border-lime" : done ? "bg-surface" : "bg-surface", dim && "opacity-50")}>
      <span className={cx("inline-flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-bold", active || done ? "bg-surface-dark text-white" : "bg-surface-mute text-ink-muted")}>{done ? "✓" : n}</span>
      <div className="leading-tight"><div className="text-[13px] font-bold">{title}</div><div className="text-[11px] text-ink-muted">{sub}</div></div>
    </div>
  );
}
const FGroup = ({ title, children, last }) => (
  <div className={cx("py-3", !last && "border-b border-line")}><div className="text-[13px] font-bold text-ink mb-2">{title}</div><div className="space-y-1.5">{children}</div></div>
);
const Chk = ({ label, count, on, set }) => (
  <label className="flex items-center gap-2 text-[13px] cursor-pointer">
    <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} className="peer sr-only" />
    <span className={cx("w-[18px] h-[18px] rounded-[6px] border-2 inline-flex items-center justify-center shrink-0 transition-colors", on ? "bg-[#F2FFDB] border-tap-green text-tap-green" : "bg-surface border-line-strong text-transparent")}><Icon name="check" size={12} className="stroke-[3]" /></span>
    <span className="flex-1">{label}</span><span className="text-[11px] text-ink-faint v2-num">{count}</span>
  </label>
);
const DualRange = ({ min, max, step = 1, lo, hi, onLo, onHi, fmtLo, fmtHi }) => {
  const span = (max - min) || 1; const pct = v => ((v - min) / span) * 100;
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] font-semibold v2-num text-ink mb-2"><span>{fmtLo}</span><span>{fmtHi}</span></div>
      <div className="dual-range-wrap">
        <div className="dual-range-track" />
        <div className="dual-range-fill" style={{ left: pct(lo) + "%", right: (100 - pct(hi)) + "%" }} />
        <input type="range" min={min} max={max} step={step} value={lo} onChange={e => onLo(Math.min(+e.target.value, hi))} className="dual-range" style={{ zIndex: lo >= max - step ? 5 : 3 }} aria-label="Minimum" />
        <input type="range" min={min} max={max} step={step} value={hi} onChange={e => onHi(Math.max(+e.target.value, lo))} className="dual-range" style={{ zIndex: 4 }} aria-label="Maximum" />
      </div>
    </div>
  );
};

function Badge({ children, tone = "slate" }) {
  const tones = { lime: "bg-lime-tint text-tap-greenDark", green: "bg-tap-green/10 text-tap-greenDeep", gold: "bg-[#F6E9B8] text-[#7a5c00]", dark: "bg-surface-dark text-white", slate: "bg-surface-mute text-ink-muted" };
  return <span className={cx("inline-flex items-center text-[10px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-full", tones[tone])}>{children}</span>;
}

// Important #3 — full-screen fare comparison modal (Discount/Basic/Classic/Plus/Executive),
// selected column highlighted, per-component disclosure + legend, matching the Figma.
function CompareFareModal({ f, selectedKey, originCity, destCity, onClose, onPick }) {
  const byKey = k => f._fares.find(x => x.key === k);
  const basic = byKey("Basic")?.price ?? f.price;
  const cols = [
    { key: "Basic", price: basic },
    { key: "Classic", price: byKey("Classic")?.price ?? Math.round(basic * 1.62) },
    { key: "Plus", price: byKey("Plus")?.price ?? Math.round(basic * 2.81) },
    { key: "Executive", price: byKey("Executive")?.price ?? Math.round(basic * 7.43) },
  ];
  let selIdx = cols.findIndex(c => c.key === selectedKey);
  if (selIdx < 0) selIdx = 2; // default Classic
  const sel = cols[selIdx];
  const ROWS = [
    { label: "Hand baggage", sub: "Up to 8 kg", cells: ["inc", "inc", "inc", "inc", "inc"] },
    { label: "Checked bag", sub: "1 × 23 kg", cells: ["no", "add:32", "inc", "inc", "inc2"] },
    { label: "Seat selection", sub: "Standard", cells: ["add:8", "add:8", "inc", "inc", "incXL"] },
    { label: "Meal", sub: "Hot · drinks", cells: ["add:14", "Snack", "Hot", "Hot+wine", "Premium menu"] },
    { label: "Refund", sub: "If you cancel", cells: ["pct:0", "pct:0", "ok:80%", "ok:90%", "ok:100%"] },
    { label: "Change fee", sub: "Per change", cells: ["€80", "€55", "€20", "€0", "€0"] },
    { label: "Miles earned", sub: "Status miles", cells: ["25%", "50%", "100%", "150%", "200%"] },
    { label: "Lounge access", sub: "Xperion Premium", cells: ["no", "no", "no", "no", "inc"] },
  ];
  const Cell = ({ v }) => {
    if (v === "inc") return <Icon name="check" size={15} className="text-tap-green" />;
    if (v === "inc2") return <span className="inline-flex items-center gap-0.5 text-tap-green font-semibold"><Icon name="check" size={14} /> ×2</span>;
    if (v === "incXL") return <span className="inline-flex items-center gap-0.5 text-tap-green font-semibold"><Icon name="check" size={14} /> XL</span>;
    if (v === "no") return <span className="text-ink-faint">—</span>;
    if (v.startsWith("add:")) return <span className="text-ink-faint">— €{v.slice(4)}</span>;
    if (v.startsWith("ok:")) return <span className="text-tap-greenDeep font-semibold inline-flex items-center gap-0.5"><Icon name="check" size={13} /> {v.slice(3)}</span>;
    if (v.startsWith("pct:")) return <span className="text-ink-faint">— {v.slice(4)}</span>;
    return <span className="text-ink">{v}</span>;
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-surface rounded-3xl shadow-2xl w-full max-w-[1080px] my-6 p-7" onClick={e => e.stopPropagation()}>
        <h2 className="text-[30px] font-black leading-tight">{sel.key} bundle — {EUR(f.price)}</h2>
        <p className="text-[13px] text-ink-muted mt-1">{originCity}–{destCity} · {f.flight_no} · Single brand price · full per-component disclosure below.</p>
        {(() => {
          // H1 · this single brand is a hybrid of an ATPCO-filed fare + layered ancillaries.
          const atpcoPart = Math.round(basic);
          const ancPart = Math.max(0, Math.round((sel.price ?? f.price) - basic));
          return (
            <div className="mt-4 rounded-2xl border border-tap-green/25 bg-lime-tint/30 p-4">
              <div className="flex items-center gap-2 mb-1"><Icon name="spark" size={14} className="text-tap-greenDeep" /><div className="text-[12px] font-bold text-tap-greenDark">How the {sel.key} bundle is built</div></div>
              <div className="text-[11px] text-ink-muted mb-3">You buy one fare brand. Behind the scenes it's an ATPCO-filed fare plus layered ancillaries, combined into a single price — invisible at checkout.</div>
              <div className="grid sm:grid-cols-2 gap-2.5">
                <div className="rounded-xl bg-surface border border-line p-3">
                  <div className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">Component 1 · ATPCO fare</div>
                  <div className="text-[13px] font-semibold mt-0.5">{sel.key} flight fare</div>
                  <div className="text-[11px] text-ink-faint">Filed fare + fare rules (changes, refundability, baggage allowance)</div>
                  <div className="text-[13px] font-bold v2-num mt-1">{EUR(atpcoPart)}</div>
                </div>
                <div className="rounded-xl bg-surface border border-line p-3">
                  <div className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">Component 2 · Ancillaries</div>
                  <div className="text-[13px] font-semibold mt-0.5">{sel.key === "Basic" ? "None — flight only" : "Seat selection + included extras"}</div>
                  <div className="text-[11px] text-ink-faint">Layered on top of the ATPCO fare, delivered as part of the brand</div>
                  <div className="text-[13px] font-bold v2-num mt-1">{ancPart > 0 ? EUR(ancPart) : "—"}</div>
                </div>
              </div>
              <div className="text-[10px] text-ink-faint mt-2">Presented to you as one brand at <span className="font-semibold text-ink">{EUR(sel.price ?? f.price)}</span> = ATPCO fare {EUR(atpcoPart)}{ancPart > 0 ? ` + ancillaries ${EUR(ancPart)}` : ""}.</div>
            </div>
          );
        })()}
        <div className="mt-5 rounded-2xl border border-line overflow-x-auto v2-track">
          <div className="grid grid-cols-[1.4fr_repeat(5,1fr)] min-w-[600px] bg-surface-soft">
            <div className="p-4"><div className="text-[12px] font-bold">Fare</div><div className="text-[11px] text-ink-faint">Per passenger, one-way</div></div>
            {cols.map((c, i) => (
              <div key={c.key} className={cx("p-4 text-center", i === selIdx && "bg-lime")}>
                <div className="text-[13px] font-bold">{c.key}</div>
                <div className="text-[18px] font-black v2-num">{EUR(c.price)}</div>
                {i === selIdx && <div className="text-[8px] font-bold uppercase tracking-wide bg-surface-dark text-white rounded px-1.5 py-0.5 inline-block mt-1">Selected</div>}
              </div>
            ))}
          </div>
          {ROWS.map((r, ri) => (
            <div key={r.label} className={cx("grid grid-cols-[1.4fr_repeat(5,1fr)] min-w-[600px] border-t border-line", ri % 2 === 1 && "bg-surface-soft/40")}>
              <div className="p-3.5"><div className="text-[13px] font-semibold">{r.label}</div><div className="text-[11px] text-ink-faint">{r.sub}</div></div>
              {r.cells.map((v, ci) => <div key={ci} className={cx("p-3.5 text-center text-[12px] flex items-center justify-center", ci === selIdx && "bg-lime-tint/40")}><Cell v={v} /></div>)}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3 text-[11px] text-ink-muted flex-wrap">
          <span className="inline-flex items-center gap-1"><Icon name="check" size={12} className="text-tap-green" /> Included</span>
          <span className="text-ink-faint">— Not included</span>
          <span className="text-ink-faint">— €N Available as paid add-on</span>
        </div>
        <div className="flex items-center justify-between mt-5 gap-3">
          <Btn variant="outline" onClick={onClose}>← Back to results</Btn>
          <Btn variant="primary" onClick={() => onPick(byKey(sel.key) || byKey("Classic"))}>Continue with {sel.key} · {EUR(sel.price)} →</Btn>
        </div>
      </div>
    </div>
  );
}

function FlightCard({ f, expanded, sel, lowest, pairing, pairingInfo, originCity, destCity, onToggle, onPick, cabin, inline, payMilesOn, milesFor }) {
  const [compare, setCompare] = useState(false);
  const cab = cabin || "Economy";
  const m = f._m, classic = f._fares.find(x => x.key === "Classic");
  // Only the fares for the cabin the member picked on the home search show here.
  const cabinFares = f._fares.filter(x => x.cabin === cab);
  // Collapsed-card headline: the cabin's "most popular" (Economy → Classic) else its entry fare.
  const headline = cabinFares.find(x => x.tag === "MOST POPULAR") || cabinFares[0] || classic;
  const isSelected = sel && sel.flight.flight_no === f.flight_no;
  // deterministic urgency + value cues derived from the flight (no hardcoding)
  const h = [...f.flight_no].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const seatsLeft = (h % 7) + 1, bookedToday = (h % 22) + 6;
  const isCheapest = lowest != null && f.price === lowest;
  // When selected, reflect the chosen fare's price/label/miles (fixes price-not-updating).
  const selFare = isSelected ? (f._fares.find(x => x.key === sel.fare) || headline) : headline;
  const milesEarn = 1000 + (h % 520);   // stable per-flight earn estimate
  return (
    <div className={cx("relative", pairing && "pt-6")}>
      {pairing && <span className="absolute top-0 left-0 z-10 font-bold uppercase text-white inline-flex items-center justify-center gap-1 whitespace-nowrap" style={{ width: "279px", height: "24px", padding: "6px 14px", borderTopLeftRadius: "14px", borderTopRightRadius: "14px", background: "rgba(70, 164, 26, 1)", fontSize: "10px", letterSpacing: "0.5px", boxSizing: "border-box" }}>★ Best Pairing · Recommended for you</span>}
      <Card style={{ borderRadius: "14px", borderColor: pairing ? "rgba(199, 242, 31, 1)" : isSelected ? "#9EFD38" : "#E2E2E5", borderWidth: (pairing || isSelected) ? "2px" : undefined, background: pairing ? "rgba(242, 252, 217, 1)" : undefined }} className={cx("overflow-hidden", pairing && "rounded-tl-none", !pairing && expanded && !isSelected && "ring-2 ring-lime")}>
      {/* header row — compact single-line layout per design */}
      <div className="p-5 flex flex-wrap items-stretch justify-between gap-x-8 gap-y-3">
        {/* flight details — one row that spreads across the full available width so the content
            isn't congested on the left with a gap before the fare panel (approved layout) */}
        <div className="flex items-center gap-6 min-w-0">
        {/* times + route — airport under time, no arrow */}
        <div className="flex items-center gap-4 min-w-[230px]">
          <div className="text-left"><div className="text-[22px] font-bold leading-none v2-num text-left">{f.dep}</div><div className="text-[11px] text-ink-faint mt-1 text-left">{f.origin}</div></div>
          <div className="text-center text-ink-faint min-w-[60px]"><div className="text-[11px]">{f.duration}</div><div className="w-16 h-px bg-line-strong my-1.5 mx-auto" /><div className="text-[11px]">{m.stops ? `1 stop · ${m.hub}` : "Direct"}</div></div>
          <div className="text-left"><div className="text-[22px] font-bold leading-none v2-num text-left">{f.arr}</div><div className="text-[11px] text-ink-faint mt-1 text-left">{f.dest}</div></div>
        </div>
        {/* status — vertical, centered, light weight */}
        <div className="text-center min-w-[92px]">
          {seatsLeft <= 4 && <div className="inline-block text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full full bg-tap-red/10 text-tap-red">{seatsLeft} seats left</div>}
          <div className="text-[10px] text-ink-faint mt-1">Booked {bookedToday}× today</div>
        </div>
        {/* airline block — TP mark + number, aircraft, bag + earn MI */}
        <div className="flex-1 min-w-[180px]">
          <div className="flex items-center gap-2"><img src="/v2/assets/homepage/tap-logo.png" alt="Xperion Airways" className="shrink-0 object-contain" style={{ height: "16px", width: "auto" }} /><span className="text-[13px] font-semibold">{f.flight_no.replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")}</span></div>
          <div className="text-[11px] text-ink-faint mt-0.5">{f.aircraft}{m.features.length ? " · " + m.features.join(" · ") : ""}</div>
          <div className="flex items-center gap-2 mt-1.5">
            {headline.feats[1][1] ? <Badge tone="green">Bag included</Badge> : <Badge>No bag</Badge>}
            <span className="text-[11px] font-semibold text-ink-700">Earn {miles(milesEarn)} MI</span>
          </div>
          {pairing && pairingInfo && <div className="text-[11px] text-tap-greenDeep font-medium mt-1.5 flex items-start gap-1.5"><span className="text-amber-500 leading-none mt-0.5">●</span> {pairingInfo.reasons.slice(0, 3).join(" · ")}</div>}
        </div>
        </div>{/* end flight details row */}
        {/* price panel — light grey, right-aligned */}
        <div className="text-right min-w-[151px] self-stretch flex flex-col justify-center border-l" style={{ borderColor: "#ECECEF", background: isSelected ? "rgba(249,249,250,1)" : "transparent", margin: "-20px -20px -20px 0", padding: "22px 24px 22px 20px", borderTopRightRadius: "14px", borderBottomRightRadius: "14px" }}>
          {pairing && <div className="text-[11px] font-bold text-tap-greenDeep">BUNDLE −€15</div>}
          {payMilesOn && milesFor ? (() => { const mm = milesFor(selFare.price); return (
            <><div className="text-[18px] font-bold text-tap-greenDeep v2-num leading-tight">{mm.full ? `${miles(mm.miles)} mi` : `${miles(mm.miles)} mi + ${EUR(mm.cash)}`}</div>
            <div className="text-[10px] text-ink-faint v2-num">or {EUR(selFare.price)} cash</div></>); })() : (<>
            {selFare.milesOpt && <div className="text-[11px] font-semibold" style={{ color: "#795B0A", letterSpacing: "0.5px" }}>OR {miles(selFare.milesOpt.mi)} MI + {EUR(selFare.milesOpt.cash)}</div>}
            <div className="text-[24px] font-bold v2-num leading-tight">{EUR(selFare.price)}</div>
          </>)}
          <div className="text-[10px] text-ink-faint">1 adult · {isSelected ? sel.fare : `${CABIN_LABEL[cab] || "Economy"} ${headline.key}`}</div>
          <div className="mt-2">
            {isSelected
                ? <Btn size="sm" variant="primary" className="text-[13px] font-semibold" style={{ width: "107px", height: "36px", padding: "10px 18px", borderRadius: "9999px", background: "#46A41A", color: "#fff" }} onClick={onToggle}>{expanded ? "Hide fares ↑" : "Selected ✓"}</Btn>
                : <Btn size="sm" variant="outline" className="w-full" onClick={onToggle}>{expanded ? "Hide fares ↑" : `See ${cabinFares.length} fare${cabinFares.length !== 1 ? "s" : ""} ↓`}</Btn>}
          </div>
        </div>
      </div>

      {/* expanded fare grid — shown whenever the card is expanded, including when a fare is
          already selected, so the user can re-open and switch fares (Outbound #62 / Inbound #15,#33) */}
      {expanded && (
        <div className="border-t border-line bg-surface-soft px-5 py-5">
          <div className="flex items-center justify-between mb-3">
            <div><div className="font-bold text-[15px]">Choose your fare</div><div className="text-[11px] text-ink-muted">All fares earn miles · 24h free cancel · Gold benefits applied</div></div>
            <button onClick={() => setCompare(true)} className="text-[12px] font-semibold text-tap-greenDeep hover:underline">Compare fares</button>
          </div>
          {compare && <CompareFareModal f={f} selectedKey={isSelected ? sel.fare : "Classic"} originCity={originCity} destCity={destCity} onClose={() => setCompare(false)} onPick={(fare) => { setCompare(false); onPick(f, fare); }} />}
          <div className={cx("grid gap-3", cabinFares.length >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : cabinFares.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            {cabinFares.map(fare => {
              const picked = isSelected && sel.fare === fare.key;
              return (
                <div key={fare.key} className={cx("rounded-xl border p-4 flex flex-col", picked ? "border-tap-green ring-1 ring-tap-green" : "border-line bg-surface")} style={picked ? { background: "#F9F9FA" } : undefined}>
                  <div className="flex items-center justify-between"><div className="font-bold text-[14px]">{fare.key}</div><Badge tone={fare.tone}>{fare.tag}</Badge></div>
                  <div className="text-[11px] text-ink-muted mt-1 min-h-[28px]">{fare.sub}</div>
                  {payMilesOn && milesFor ? (() => { const m = milesFor(fare.price); return (
                    <div className="mt-2">
                      <div className="text-[18px] font-bold text-tap-greenDeep v2-num leading-tight">{m.full ? `${miles(m.miles)} mi` : `${miles(m.miles)} mi + ${EUR(m.cash)}`}</div>
                      <div className="text-[11px] text-ink-faint v2-num">or {EUR(fare.price)} in cash</div>
                    </div>); })() : (<>
                    {fare.milesOpt && <div className="text-[11px] font-semibold text-tap-greenDeep mt-2">OR {miles(fare.milesOpt.mi)} MI + {EUR(fare.milesOpt.cash)}</div>}
                    <div className="mt-1 flex items-baseline gap-2"><div className="text-[26px] font-bold v2-num">{EUR(fare.price)}</div>{fare.was && <div className="text-[12px] text-ink-faint line-through">{EUR(fare.was)}</div>}</div>
                  </>)}
                  <ul className="mt-3 space-y-1.5 flex-1">
                    {fare.feats.map(([t, ok], i) => (
                      <li key={i} className={cx("flex items-center gap-2 text-[12px]", ok ? "text-ink-700" : "text-ink-faint")}>
                        <Icon name={ok ? "check" : "arrow"} size={13} className={ok ? "text-tap-green" : "text-ink-faint rotate-45"} />{t}
                      </li>
                    ))}
                  </ul>
                  <Btn variant={picked ? "primary" : "outline"} className="mt-3 w-full" onClick={() => onPick(f, picked ? null : fare)}>{picked ? "Selected ✓" : "Select →"}</Btn>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
    </div>
  );
}
