// FlyTAP v2 — booking spine rebuilt to the approved Figma: Cart (View & customize,
// 8 modules) → Passenger details (identity + travel doc + loyalty + GDPR consents)
// → Payment (card + secure banner + billing + grouped basket) → Confirmation.
// A booking completes for real via /api/pay (DB row + email + CDP "booked").
import React, { useState, useEffect, useRef } from "react";
import { api, EUR, miles, fmtDate, MILES_RATE, downloadFile, buildICS, money, eurRef, getCurrency } from "./lib.js";
import { getQueue, setQueue, clearQueue as clearBasketQueue, toggleSavedExtra, savedExtraOn, savedAllExtras, trip, tripTotals, toggleExtra, hasExtra, extrasByCategory, bundleSavings, setLeg, pingBasket, clearBasket, resetTrip, syncTripRoute, saveTrip, tripSnapshot, extrasBySource, SOURCE_META, SOURCE_ORDER, PER_PAX_CATS, getBasketTrips, saveTripToBasket, removeBasketTrip, resumeBasketTrip, basketTripTotal } from "./trip.js";
import { Btn, Card, Pill, Eyebrow, Field, Input, Icon, Divider, Img, imageFor, WhyChip, cx } from "./ui.jsx";

const EARN = (t) => Math.round(t * 2.88);
const BRL = (eur) => eurRef(eur);   // A7 — secondary line now shows the EUR reference when a non-EUR currency is active
const CAT_ORDER = ["Hotels", "Cars & transfers", "Insurance", "Lounge & services", "Onboard", "Experiences", "Seats & baggage", "Carbon offset", "Extras"];
const CAT_ICON = { Hotels: "home", "Cars & transfers": "arrow", Insurance: "shield", "Lounge & services": "star", Onboard: "bag", Experiences: "star", "Seats & baggage": "seat", "Carbon offset": "leaf", Extras: "cart" };
const CAT_SUB = (pax = 1, nights = 8) => ({ Hotels: `${nights} night${nights !== 1 ? "s" : ""} · ${pax} adult${pax > 1 ? "s" : ""}`, "Cars & transfers": "Private sedan · 1-way", Insurance: `${pax} traveler${pax > 1 ? "s" : ""}`, "Lounge & services": `Pre-flight · ${pax} adult${pax > 1 ? "s" : ""}`, Onboard: "Both flights", Experiences: `${pax} traveler${pax > 1 ? "s" : ""}`, "Seats & baggage": "Both flights", "Carbon offset": "This trip" });
const CAT_QTY = { Insurance: true, "Lounge & services": true, Experiences: true };
// V&C #1 — selected/unselected add-on CTA styling shared across all modules (hotels, transfers, experiences, cross-sell).
const ADDED_CTA = { background: "rgba(255,255,255,1)", border: "1.5px solid rgba(158,253,56,1)", color: "rgba(51,102,20,1)", borderRadius: "9999px" };
const ADD_CTA = { background: "rgba(255,255,255,1)", border: "1px solid rgba(51,102,20,1)", color: "rgba(51,102,20,1)", borderRadius: "9999px" };
// My Trip Cart UI-17 — enhance-card default add button is a solid black pill (selected state still uses ADDED_CTA).
const BLACK_CTA = { background: "#0A0A0A", color: "#FFFFFF", border: "none", borderRadius: "9999px", padding: "8px 12px" };

// Live session countdown — ticks every second so "price locked" reflects real remaining time (Split #4).
function SessionTimer({ minutes = 15, prefix = "price locked", suffix = "", className }) {
  const [s, setS] = useState(minutes * 60);
  useEffect(() => { const id = setInterval(() => setS(x => (x > 0 ? x - 1 : 0)), 1000); return () => clearInterval(id); }, []);
  const mm = String(Math.floor(s / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return <span className={className}>{prefix ? prefix + " " : ""}<span className="v2-num font-semibold">{mm}:{ss}</span>{suffix}</span>;
}

/* seed the default extras so the basket reads like the Figma. Each carries a source so the
   basket can classify them: system-recommended add-ons for Daniel's stopover + one auto-added
   default (insurance). Anything the member adds themselves comes in as source "user". */
function seedExtras() {
  if (trip.pnr || trip.seeded || trip.extras.length) return;   // #18 — once per fresh trip; never re-seed a confirmed booking, a cleared basket, or on re-render
  const px = trip.pax || 1;
  // [code, name, per-unit price, category, source]. Per-traveller categories (Insurance,
  // Lounge, Experiences) are multiplied by pax so the stored total matches the cart's
  // "× pax" hint — at 1 pax these are unchanged; at 3 pax lounge $90 → $270 (#2).
  // Seed a representative recommended basket (stay + lounge + experience) alongside the mandatory
  // insurance so the cart/payment summaries match the reference design — a stay + lounge together
  // also earns the cross-sell bundle discount. Names are destination-neutral (never hardcoded).
  // v33 View&Customize #2 — recommended products are OFFERED, never auto-added; they enter the
  // cart only when the member explicitly clicks Add (toggleExtra dedupes by code — no duplicates).
  [["ins-plus", "Travel Insurance · Plus", 38, "Insurance", "auto"]].forEach(([code, name, price, cat, source]) =>
     trip.extras.push({ code, name, price: PER_PAX_CATS.has(cat) ? price * px : price, qty: 1, cat, source }));
  trip.seeded = true;
  pingBasket();
}

/* ── stepper ── */
const STEPS = ["Select flights", "View & customize cart", "My Trip Basket", "Passenger details", "Payment"];
const eur2 = (n) => money(n, { dp: 2 });
const eurC = (n) => money(n, { dp: 2 });
// #9 — when no seat was explicitly chosen, the default follows the fare/cabin entitlement:
// Executive → front business zone, Premium → premium cabin, Plus → extra-legroom row, else economy standard.
const seatForFare = (fare) => /exec/i.test(fare || "") ? "1A" : /premium/i.test(fare || "") ? "6A" : /plus/i.test(fare || "") ? "22D" : "22C";
// Cabin/zone label that matches the fare entitlement (paired with seatForFare for #9).
const seatZone = (fare) => /exec/i.test(fare || "") ? "Business cabin" : /premium/i.test(fare || "") ? "Premium cabin" : /plus/i.test(fare || "") ? "Extra-legroom row" : "Standard · window";
// Seat-class chip label and adjacent-seat assignment for extra passengers on the same booking.
const seatClassLabel = (fare) => /exec/i.test(fare || "") ? "Business seat" : /premium/i.test(fare || "") ? "Premium seat" : /plus/i.test(fare || "") ? "Extra-legroom seat" : "Standard seat";
// Cabin name from the fare brand (Economy / Premium / Business) — used for the seat module, seat map, and the booking record.
const fareCabin = (fare) => /exec/i.test(fare || "") ? "Business" : /premium/i.test(fare || "") ? "Premium" : "Economy";
// An explicitly chosen seat from the seat-map ("Seats · 8A") always wins over the fare default / recommendation.
const chosenSeat = () => { const sm = (trip.extras || []).find(e => e.code === "seat-map"); const m = sm && String(sm.name).match(/\b(\d{1,2}[A-K])\b/); return m ? m[1] : null; };
const SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"];
const adjSeat = (lead, n = 0) => { const m = String(lead || "22A").match(/^(\d+)\s*([A-Fa-f])/); if (!m) return lead || "22A"; const li = SEAT_LETTERS.indexOf(m[2].toUpperCase()); return m[1] + SEAT_LETTERS[((li < 0 ? 0 : li) + n) % 6]; };
function Stepper({ active }) {
  return (
    <div className="bg-surface border-b border-line">
      <div className="mx-auto max-w-page px-4 sm:px-6 py-4 flex items-center gap-2 overflow-x-auto v2-track text-[13px] font-semibold whitespace-nowrap">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <span className={cx("shrink-0 flex items-center gap-1.5", i < active ? "text-tap-greenDeep" : i === active ? "text-ink font-bold" : "text-ink-faint")}>
              <span className={cx("w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px]", i < active ? "bg-tap-green text-white" : i === active ? "bg-lime-tint text-tap-greenDeep ring-1 ring-lime" : "bg-surface-mute text-ink-faint")}>{i < active ? "✓" : i + 1}</span>{s}
            </span>
            {i < STEPS.length - 1 && <span className={cx("w-8 sm:w-12 h-0.5 rounded-full shrink-0", i < active ? "bg-ink-700" : "bg-line-strong")} />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
const Chip = ({ children, dot }) => <span className="px-3 py-1.5 rounded-[8px] bg-surface border border-line text-[12px] font-semibold inline-flex items-center gap-1.5">{dot && <span className="w-1.5 h-1.5 rounded-full bg-lime" />}{children}</span>;
const Req = () => <span className="text-tap-red ml-0.5">*</span>;

/* ── basket summary (right rail) — grouped by category like the Figma ── */
/* Mandatory-field input carrying a real validation state: the right-aligned tick appears once the
   field holds a valid value and disappears again if it is cleared, rather than being a permanent
   decoration. Declared at module scope so React keeps the same component identity between renders
   - defining it inside a screen would remount it on every keystroke and drop what was typed. */
function ValidatedInput({ defaultValue = "", validate, className = "", left = null, right = null, ...p }) {
  const [v, setV] = useState(String(defaultValue == null ? "" : defaultValue));
  const good = validate ? !!validate(v) : String(v).trim().length > 0;
  return (
    <div className="relative">
      {left ? <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">{left}</span> : null}
      <Input value={v} onChange={(e) => setV(e.target.value)} className={cx(left ? "pl-11" : "", right ? "pr-16" : "pr-9", className)} {...p} />
      <span className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 pointer-events-none">
        {right}
        {good ? <Icon name="check" size={14} className="text-tap-green" /> : null}
      </span>
    </div>
  );
}

function BasketSummary({ step, cta, onCta, disabled, secondary, onSecondary, note, milesSwitch, onMilesSwitch, basket, user, onClear, breakdown, hideMiles, grouped, footer, bigTotal, carded }) {
  const t = tripTotals();
  const u = milesSwitch || {};
  const tier = u.tier || user?.tier || "Gold";
  const firstName = user?.first_name || (user?.name || "").split(" ")[0] || "there";
  const milesNeeded = Math.round(t.total * 0.9 / MILES_RATE);
  const milesTax = Math.round(t.total * 0.1);
  const showMiles = !basket && !hideMiles && (!!user || !!milesSwitch);
  const groups = extrasBySource();
  const lastCode = trip.extras[trip.extras.length - 1]?.code;
  // Category-grouped basket (Passenger + Payment pages) — one line per category, per Figma.
  const catTotals = {};
  trip.extras.forEach(e => { catTotals[e.cat] = (catTotals[e.cat] || 0) + (e.price || 0); });
  const gnights = (() => { try { const d = Math.round((new Date(trip.ret) - new Date(trip.date)) / 864e5); return d > 0 ? d : 8; } catch { return 8; } })();
  const GTag = { Hotels: `${gnights} nights`, Flights: `${trip.pax} pax` };
  const GRow = ({ icon, label, sub, tag, amt, green, muted, qty }) => (
    <div className="flex items-center gap-3" style={{ minHeight: "72px", padding: "12px 0", borderBottom: "1px solid #E8E8E5" }}>
      <span className="inline-flex items-center justify-center shrink-0 rounded-[10px] bg-surface-mute" style={{ width: "36px", height: "36px" }}><Icon name={icon} size={18} className={muted ? "text-ink-faint" : green ? "text-tap-greenDeep" : "text-ink-muted"} /></span>
      <div className="flex-1 min-w-0">
        <div className={cx("font-semibold text-[15px] flex items-center gap-1.5 truncate", green ? "text-tap-greenDeep" : muted ? "text-ink-muted" : "text-ink")}>{label}{tag ? <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-surface-mute text-ink-muted shrink-0">{tag}</span> : null}</div>
        {sub ? <div className="text-[12px] text-ink-faint mt-0.5 truncate">{sub}</div> : null}
      </div>
      <span className="shrink-0 text-right">
        <span className={cx("block font-semibold v2-num text-[14px]", green ? "text-tap-greenDeep" : muted ? "text-ink-muted" : "text-ink")}>{amt < 0 ? "\u2212" : ""}{eur2(Math.abs(amt))}</span>
        {qty ? <span className="block text-[11px] text-ink-faint mt-0.5 whitespace-nowrap">{qty}</span> : null}
      </span>
    </div>
  );
  return (
    <aside className="space-y-[14px]">
      <Card className="p-5" style={{ borderColor: "#e0e3e8", boxShadow: "0 4px 16px rgba(0,0,0,0.06)" }}>
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><div className="text-[20px] font-semibold">{basket ? "Basket summary" : "My trip basket"}</div><span className="w-[22px] h-[22px] rounded-full bg-tap-red text-white text-[11px] font-bold inline-flex items-center justify-center">{trip.extras.length + 1}</span></div>{basket ? <Pill tone="slate">EUR</Pill> : <span className="text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-tap-red text-white">Step {step}/5</span>}</div>
        <div className="text-[11px] text-ink-faint mt-0.5">{trip.origin}–{trip.dest} · {trip.pax} adult{trip.pax > 1 ? "s" : ""} · {fmtDate(trip.date).replace(/ \d{4}/, "")} – {fmtDate(trip.ret).replace(/ \d{4}/, "")}</div>

        <div className="mt-4">
          {grouped ? (
            <div>
              {(() => {
                const gsub = CAT_SUB(trip.pax, gnights);
                const paxLbl = `${trip.pax} traveller${trip.pax > 1 ? "s" : ""}`;
                const fNos = [trip.outbound?.flight?.flight_no, trip.inbound?.flight?.flight_no].filter(Boolean).join(" / ");
                // One row per PRODUCT (not per category): the traveller sees the actual items they
                // bought - each with its own name, metadata and quantity - rather than a rolled-up
                // "Hotels / Insurance" bucket that hides what is in the basket.
                const rows = [
                  { icon: "plane", label: `Flights · ${trip.origin}–${trip.dest}`, sub: [fNos, trip.outbound?.fare || "Classic", paxLbl].filter(Boolean).join(" · "), amt: t.flights, qty: paxLbl },
                  ...trip.extras.map((e, n) => ({
                    key: e.code || ("x" + n),
                    icon: CAT_ICON[e.cat] || "cart",
                    label: e.name,
                    sub: gsub[e.cat] || e.cat || "",
                    amt: e.price || 0,
                    qty: CAT_QTY[e.cat] ? `× ${trip.pax}` : (e.cat === "Hotels" ? `${gnights} night${gnights !== 1 ? "s" : ""}` : ""),
                  })),
                  { icon: "doc", label: "Taxes & fees", sub: "Airport & carrier charges", amt: t.taxes, muted: true },
                  ...(t.bundle > 0 ? [{ icon: "spark", label: "Bundle savings", sub: "Multi-item discount applied", amt: -t.bundle, green: true }] : []),
                ];
                return rows.map((r, i) => { const { key: rk, ...rest } = r; return <GRow key={rk || r.label} {...rest} />; });
              })()}
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-line overflow-hidden mt-3">
                <div className="bg-surface-soft px-3 py-2 flex items-baseline gap-1.5"><span className="text-[10px] font-bold uppercase tracking-wide text-ink">Anchor</span><span className="text-[11px] text-ink-faint">· Locked in from Step 1</span></div>
                <div className="px-3 py-1.5">
                  <SummaryItem big={bigTotal} icon="plane" name={`Flights · ${trip.origin}–${trip.dest}`} sub={`${trip.outbound?.flight?.flight_no || ""}${trip.inbound ? " / " + trip.inbound.flight.flight_no : ""} · ${trip.outbound?.fare || "Classic"}`} price={t.flights} qty={`${trip.pax} traveler${trip.pax > 1 ? "s" : ""}`} />
                </div>
              </div>
              {SOURCE_ORDER.filter(s => groups[s] && groups[s].length).map(s => (
                <div key={s} className={cx("mt-3", carded && "rounded-xl border border-line overflow-hidden")}>
                  <div className={cx("flex items-center justify-between", carded ? "bg-surface-soft px-3 py-2" : "mb-0.5")}>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{SOURCE_META[s].label} · {groups[s].length}</div>
                    <span className={cx("inline-flex items-center text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full", s === "user" ? "bg-lime text-ink" : s === "recommended" ? "bg-tap-green/10 text-tap-greenDeep" : "bg-surface-mute text-ink-muted")}>{SOURCE_META[s].tag}</span>
                  </div>
                  <div className={carded ? "px-3 py-1.5" : ""}>{groups[s].map(e => <SummaryItem big={bigTotal} key={e.code} icon={CAT_ICON[e.cat] || "cart"} name={e.name} sub={CAT_SUB(trip.pax, gnights)[e.cat] || e.cat} price={e.price} qty={CAT_QTY[e.cat] ? `× ${trip.pax}` : ""} isNew={e.code === lastCode && e.source === "user"} />)}</div>
                </div>
              ))}
              {onClear && trip.extras.length > 0 && <button onClick={onClear} className="mt-3 w-full rounded-full border border-line-strong py-2 text-[12px] font-semibold text-ink-muted hover:text-tap-red hover:border-tap-red inline-flex items-center justify-center gap-1.5"><Icon name="x" size={12} /> Clear basket</button>}
              <div className="mt-2.5 space-y-1 text-[12px] rounded-lg px-3 py-2.5" style={{ background: "rgba(250,250,247,1)" }}>
                <div className="flex items-center justify-between"><span className="text-ink-muted">Subtotal extras</span><span className="font-semibold v2-num text-ink">{eur2(t.extras)}</span></div>
                <div className="flex items-center justify-between"><span className="text-ink-muted">Taxes & fees</span><span className="font-semibold v2-num text-ink">{eur2(t.taxes)}</span></div>
                {t.bundle > 0 && <div className="flex items-center justify-between"><span className="text-tap-greenDeep font-semibold flex items-center gap-1"><Icon name="spark" size={12} /> Bundle savings</span><span className="font-semibold v2-num text-tap-greenDeep">−{eur2(t.bundle)}</span></div>}
              </div>
            </>
          )}
          {breakdown && breakdown.length > 0 && <div className="mt-3 pt-3 border-t border-line space-y-1 text-[12px]"><div className="text-[12px] mb-1" style={{ color: "#667080" }}>Payment breakdown</div>{breakdown.map(b => <div key={b.label} className="flex items-center justify-between"><span className="text-ink-muted">{b.label}</span><span className={cx("font-semibold v2-num", b.green ? "text-tap-greenDeep" : b.red ? "text-tap-red" : b.muted ? "text-ink-faint" : "text-ink")}>{b.text}</span></div>)}</div>}
        </div>

        {grouped ? <div style={{ height: "16px" }} /> : <Divider className="my-3.5" />}
        <div className={bigTotal ? "mt-5" : ""} style={bigTotal ? { borderRadius: "16px", border: "1px solid #E8E8E5", padding: "18px" } : undefined}>
        <div className="flex items-end justify-between gap-3 flex-wrap"><div className="shrink-0"><div className="text-[13px] text-ink font-bold whitespace-nowrap">{step === 2 ? "Subtotal" : "Total"} <span className="text-ink-muted font-medium">(in {getCurrency().label})</span></div><div className="text-[10px] text-ink-muted mt-0.5 whitespace-nowrap">{getCurrency().code !== "USD" ? "Charged in EUR · rate applied at checkout (MCP)" : (step === 2 ? "No charge yet" : "One-time charge · taxes included")}</div></div><div className="text-right shrink-0 ml-auto"><div className={cx("v2-num text-ink whitespace-nowrap", bigTotal ? "text-[32px] sm:text-[40px] font-bold leading-none" : "text-[28px] sm:text-[34px] font-bold")}>{eurC(t.total)}</div><div className="text-[11px] v2-num" style={{ color: "#9A9A9A" }}>{BRL(t.total)}</div></div></div>
        <div className="mt-3 bg-lime-tint text-tap-greenDark flex items-center justify-between" style={{ borderRadius: "10px", padding: "10px 12px" }}><span className="flex items-center gap-1.5 text-[12px] font-medium"><Icon name="plane" size={12} /> You'll earn</span><span className="v2-num text-[14px] font-bold">{miles(EARN(t.total))} miles</span></div>
        </div>
        {breakdown && <div className="mt-3 flex items-center justify-between gap-2" style={{ background: "#F2FCD9", borderRadius: "12px", padding: "10px 12px", border: "1px solid #E8E8E5" }}><div><div className="text-[12px] font-semibold">Save this mix as default?</div><div className="text-[10px] text-ink-faint">Auto-apply for future bookings · editable any time</div></div><button className="shrink-0 text-[11px] font-bold text-tap-greenDeep hover:brightness-95" style={{ borderRadius: "14px", border: "1px solid #2E7D33", padding: "7px 32px" }}>Save mix</button></div>}

        <Btn size="lg" className="w-full mt-4 text-[15px] font-bold" style={{ height: "60px", borderRadius: "9999px" }} disabled={disabled} onClick={onCta}>{cta}</Btn>
        {step === 2 && <div className="text-[11px] text-ink-muted text-center mt-2 flex items-center justify-center gap-1"><Icon name="globe" size={11} className="text-ink-faint" /> You'll be able to adjust all items on the next step.</div>}
        {note && <div className="text-[11px] text-center mt-2" style={{ color: "#9A9A9A" }}>{note}</div>}
        {secondary && <button onClick={onSecondary} className="w-full mt-2 rounded-full border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink hover:border-tap-green inline-flex items-center justify-center gap-1.5">{secondary}{!/^[←]/.test(String(secondary)) && <Icon name="arrow" size={13} />}</button>}
        {footer}
      </Card>

      {showMiles && (
        <div className="rounded-2xl text-white shadow-card flex items-center gap-3" style={{ background: "linear-gradient(135deg, #14331a, #2e7d33)", padding: "14px 16px" }}>
          <span className="inline-flex items-center justify-center shrink-0 rounded-lg bg-white/15" style={{ width: "38px", height: "38px" }}><Icon name="spark" size={18} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold leading-tight">Pay with miles</div>
            <div className="text-[11px] text-white/80 truncate">Cover this trip with <span className="font-semibold v2-num">{miles(milesNeeded)}</span> miles + <span className="v2-num">{EUR(milesTax)}</span> taxes</div>
          </div>
          <button onClick={onMilesSwitch || (() => { })} className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-white/15 border border-white/25 text-[12px] font-semibold hover:bg-white/25" style={{ padding: "8px 14px" }}><span>Use miles</span><Icon name="arrow" size={13} /></button>
        </div>
      )}

      <div className="rounded-[14px] border" style={{ background: "#FFFFFF", borderColor: "#E8E8E5", padding: "16px" }}>
        <div className="grid grid-cols-2 gap-2.5">
          {[["lock", "PCI-DSS Level 1"], ["clock", "Free cancellation"], ["star", "Customer Care"], ["check", "Instant confirmation"]].map(([ic, a]) => (
            <div key={a} className="flex items-center gap-2"><span className="inline-flex items-center justify-center shrink-0" style={{ width: "28px", height: "28px", borderRadius: "8px", background: "#F5FFEB" }}><Icon name={ic} size={14} className="text-tap-greenDeep" /></span><div className="text-[12px] font-semibold" style={{ color: "#1A1F29" }}>{a}</div></div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between" style={{ background: "#0A0A0A", borderRadius: "14px", padding: "14px" }}><div className="flex items-center gap-2.5"><span className="inline-flex items-center justify-center text-white text-[12px] font-bold shrink-0" style={{ width: "36px", height: "36px", borderRadius: "10px", background: "#635bff" }}>S</span><div><div className="text-[12px] font-semibold text-white">Verified by Stripe</div><div className="text-[10px] text-white/60">Trusted by millions of businesses.</div></div></div><span className="font-medium" style={{ fontSize: "11px", color: "#9EFD38" }}>Learn more →</span></div>
    </aside>
  );
}
const SummaryItem = ({ icon, name, sub, price, qty, isNew, big }) => (
  <div className={cx("flex items-center gap-3 border-b border-line last:border-0", big ? "" : "py-2.5", isNew && "bg-lime-tint/50 -mx-2 px-2 rounded-lg border-0")} style={big ? { minHeight: "72px", paddingTop: "12px", paddingBottom: "12px", borderColor: "#E8E8E5" } : undefined}>
    <span className={cx("rounded-lg bg-surface-mute inline-flex items-center justify-center shrink-0 text-ink-muted", big ? "w-9 h-9" : "w-8 h-8")}><Icon name={icon} size={big ? 18 : 16} /></span>
    <div className="flex-1 min-w-0"><div className={cx("font-semibold flex items-center gap-1.5 truncate", big ? "text-[15px]" : "text-[12.5px]")}>{name}{isNew && <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded bg-lime text-ink shrink-0">New</span>}</div><div className={cx("text-ink-faint truncate", big ? "text-[12px] mt-0.5" : "text-[10px]")}>{sub}</div></div>
    <div className="text-right shrink-0"><div className={cx("v2-num", big ? "text-[14px] font-semibold" : "text-[12.5px] font-bold")}>{eur2(price)}</div>{qty && <div className="text-[9px] text-ink-faint v2-num">{qty}</div>}</div>
  </div>
);

const noTrip = (go) => <div className="mx-auto max-w-content px-6 py-16"><Card className="p-10 text-center"><div className="text-[18px] font-bold">Your cart is empty</div><div className="text-[13px] text-ink-muted mt-2">Search and pick a flight to start a booking.</div><Btn className="mt-4" onClick={() => go("home")}>Start a search →</Btn></Card></div>;

/* ── flight summary ── */
function FlightSummary({ go }) {
  const o = trip.outbound, i = trip.inbound; if (!o) return null;
  const Leg = ({ label, c, date }) => c && (
    <div className="py-2"><div className="flex items-center gap-3 mb-1"><span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label} · {fmtDate(date).replace(/(\w+) (\d+) \d+/, "$1 $2")}</span><span className="text-[11px] text-ink-faint">{c.flight.flight_no} · {c.flight.aircraft}</span></div>
      <div className="flex flex-wrap items-center gap-4"><div><div className="text-[20px] font-bold v2-num">{c.flight.dep}</div><div className="text-[11px] text-ink-faint text-left">{c.flight.origin} · {cityOf(c.flight.origin)}</div></div><div className="flex-1 min-w-[120px] text-center text-[11px] text-ink-muted">{c.flight.duration} · Nonstop · Direct<div className="h-px bg-line-strong my-1" /></div><div className="text-right"><div className="text-[20px] font-bold v2-num">{c.flight.arr}</div><div className="text-[11px] text-ink-faint text-left">{c.flight.dest} · {cityOf(c.flight.dest)}</div></div></div>
    </div>
  );
  // Important #4 — when a New York stopover is added, show the outbound as two segments (origin → JFK → dest)
  const StopoverLegs = ({ c, date }) => {
    const f = c.flight;
    const sh = (hm, m) => { const [h, mm] = String(hm || "00:00").split(":").map(Number); const t = ((h * 60 + mm + m) % 1440 + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
    const lisArr = sh(f.arr, -125), lisDep = sh(f.arr, -70);
    const Row = ({ dep, from, arr, to, num }) => (
      <div className="py-2"><div className="flex items-center gap-3 mb-1"><span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{num} · {fmtDate(date).replace(/(\w+) (\d+) \d+/, "$1 $2")}</span></div>
        <div className="flex flex-wrap items-center gap-4"><div><div className="text-[20px] font-bold v2-num">{dep}</div><div className="text-[11px] text-ink-faint text-left">{from} · {cityOf(from)}</div></div><div className="flex-1 min-w-[120px] text-center text-[11px] text-ink-muted">Segment<div className="h-px bg-line-strong my-1" /></div><div className="text-right"><div className="text-[20px] font-bold v2-num">{arr}</div><div className="text-[11px] text-ink-faint text-left">{to} · {cityOf(to)}</div></div></div>
      </div>
    );
    return (<>
      <Row dep={f.dep} from={f.origin} arr={lisArr} to="JFK" num="Outbound · Segment 1" />
      <div className="flex items-center gap-2 py-1.5 my-1 text-[12px] font-semibold text-tap-greenDeep" style={{ borderTop: "1px dashed #DCDCD8", borderBottom: "1px dashed #DCDCD8" }}><Icon name="clock" size={13} /> Stopover · {trip.stopover.nights} night{trip.stopover.nights > 1 ? "s" : ""} in New York</div>
      <Row dep={lisDep} from="JFK" arr={f.arr} to={f.dest} num="Outbound · Segment 2" />
    </>);
  };
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-2"><div className="flex items-center gap-2 flex-wrap"><img src="/v2/assets/homepage/tap-logo.png" alt="Xperion Airways" className="shrink-0 object-contain" style={{ height: "15px", width: "auto" }} /><Pill tone="slate">{o.fare} · Economy</Pill>{trip.stopover?.viaHub && <Pill tone="lime">Via New York · {trip.stopover.nights}n stopover</Pill>}</div><button className="text-[12px] font-semibold text-tap-greenDeep" onClick={() => go("results", { origin: trip.origin, dest: trip.dest, date: trip.date, ret: trip.ret, type: trip.type })}>Change flight</button></div>
      {trip.stopover?.viaHub ? <StopoverLegs c={o} date={trip.date} /> : <Leg label={trip.type === "multi" ? "Flight 1" : "Outbound"} c={o} date={trip.date} />}<Divider /><Leg label={trip.type === "multi" ? "Flight 2" : "Inbound"} c={i} date={trip.ret} />
      <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-3 text-[11px] text-ink-muted"><span className="flex items-center gap-1"><Icon name="check" size={12} className="text-tap-green" /> 1× carry-on (8kg)</span><span className="flex items-center gap-1"><Icon name="check" size={12} className="text-tap-green" /> 1× checked bag (23kg)</span><span className="flex items-center gap-1"><Icon name="check" size={12} className="text-tap-green" /> Seat selection</span><span className="flex items-center gap-1"><Icon name="check" size={12} className="text-tap-green" /> Changes for fee</span><span className="ml-auto text-ink-faint">BOOKING REF · PENDING</span></div>
    </Card>
  );
}

/* ── module shell ── */
function Module({ n, kicker, title, sub, right, badge, children, icon }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3"><span className={cx("shrink-0 w-9 h-9 rounded-lg inline-flex items-center justify-center text-[12px] font-bold", icon ? "bg-lime-tint text-tap-greenDeep" : "bg-surface-mute text-ink-faint")}>{icon ? <Icon name={icon} size={18} className="text-tap-greenDeep" /> : n}</span>
          <div><div className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{icon ? `${n} · ${kicker}` : kicker}</div><div className="font-bold text-[16px] flex items-center gap-2">{title}{badge && <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-lime text-ink"><Icon name="check" size={10} /> {badge}</span>}</div>{sub && <div className="text-[12px] text-ink-muted mt-0.5">{sub}</div>}</div>
        </div>{right}
      </div>
      <div className="h-px bg-line -mx-5 mb-4" />
      {children}
    </Card>
  );
}

/* ── Full Cabin View · seat-map modal — physically distinct layout & pricing per cabin ── */
// Each cabin has its own layout (abreast count), seat sizing, pricing chips and legend:
// Economy 3-3 · Premium 2-2 (wider) · Business 1-1 lie-flat suites.
const SEAT_CABINS = {
  Economy: {
    aircraftFallback: "A320neo", blocks: [["A", "B", "C"], ["D", "E", "F"]],
    startRow: 20, rows: 13,
    seatW: "w-9 h-9", colW: "w-9", colGap: "gap-1.5", rowGap: "space-y-1.5", blockGap: "gap-6",
    fee: (row) => (row === 20 || row === 31) ? { price: 18, tag: "Exit row · extra leg" } : { price: 0, tag: "Standard seat" },
    taken: ["22C-0", "23A-0", "25B-0", "26D-1", "28E-1", "30A-0", "31F-1"],
    window: ["20A-0", "24A-0", "29A-0"], legroom: ["20D-1", "31A-0"],
    types: [
      { code: "std", name: "Standard", price: 0, sub: "Pick any available seat", note: "Free for Star members" },
      { code: "nsf", name: "Next Seat Free", price: 48, sub: "Adjacent seat blocked", note: "Privacy & space" },
      { code: "couple", name: "Couple seat", price: 36, sub: "Auto-paired window+aisle", note: "Travel together" },
      { code: "legroom", name: "Extra legroom", price: 18, sub: "Exit rows · +10cm pitch", note: "Stretch out" },
      { code: "win", name: "Window+", price: 68, sub: "Window + free middle + legroom", note: "Premium experience" },
    ],
    legend: [["bg-surface border border-line", "Pick"], ["bg-lime", "Selected"], ["bg-[#E8C75A]/60", "Window"], ["bg-tap-green/50", "Extra legroom"], ["bg-lime-tint ring-1 ring-tap-green/50", "Kept free"], ["bg-surface-mute", "Taken"]],
    upsell: true,
  },
  Premium: {
    aircraftFallback: "A330neo", blocks: [["A", "C"], ["D", "F"]],
    startRow: 6, rows: 6,
    seatW: "w-12 h-11", colW: "w-12", colGap: "gap-2.5", rowGap: "space-y-2.5", blockGap: "gap-12",
    fee: (row) => row === 6 ? { price: 25, tag: "Bulkhead · extra legroom" } : { price: 0, tag: "Premium seat · included" },
    taken: ["7C-0", "8D-1", "9A-0", "10F-1"],
    window: ["6A-0", "8A-0", "11A-0"], legroom: ["6D-1"],
    types: [
      { code: "std", name: "Premium seat", price: 0, sub: "Wider seat · recline · included", note: "Included with Premium" },
      { code: "legroom", name: "Extra legroom", price: 0, sub: "Bulkhead & front rows", note: "Included with Premium" },
      { code: "solo", name: "Solo · no neighbour", price: 40, sub: "Block the seat beside you", note: "Space to work & rest" },
      { code: "front", name: "Front row · priority", price: 25, sub: "First off the aircraft", note: "Priority deplane" },
    ],
    legend: [["bg-surface border border-line", "Pick"], ["bg-lime", "Selected"], ["bg-[#E8C75A]/60", "Window"], ["bg-tap-green/50", "Bulkhead"], ["bg-lime-tint ring-1 ring-tap-green/50", "Kept free"], ["bg-surface-mute", "Taken"]],
    upsell: false,
  },
  Business: {
    aircraftFallback: "A330neo", blocks: [["A"], ["D"]],
    startRow: 1, rows: 5,
    seatW: "w-16 h-12", colW: "w-16", colGap: "gap-3", rowGap: "space-y-3", blockGap: "gap-16",
    fee: (row) => ({ price: 0, tag: row === 1 ? "Front suite · first served" : "Business suite · lie-flat" }),
    taken: ["2A-0", "4D-1"],
    window: ["1A-0", "2A-0", "3A-0", "5A-0"], legroom: ["1D-1"],
    types: [
      { code: "std", name: "Business seat", price: 0, sub: "Lie-flat suite · direct aisle · lounge · included", note: "Included with Business — no other seat types" },
    ],
    legend: [["bg-surface border border-line", "Pick"], ["bg-lime", "Selected"], ["bg-[#E8C75A]/60", "Window suite"], ["bg-tap-green/50", "Front row"], ["bg-surface-mute", "Taken"]],
    upsell: false,
  },
};
const SEAT_PAX_NAMES = ["Daniel", "Mariana", "Sofia", "Lars", "Guest"];

function SeatMapModal({ pax = 1, cabin = "Economy", aircraft, initialType, onClose, onConfirm }) {
  const cfg = SEAT_CABINS[cabin] || SEAT_CABINS.Economy;
  const rowsArr = Array.from({ length: cfg.rows }, (_, i) => cfg.startRow + i);
  const takenSet = new Set(cfg.taken), winSet = new Set(cfg.window || []), legSet = new Set(cfg.legroom || []);
  const [type, setType] = useState(() => (initialType && cfg.types.some(t => t.code === initialType)) ? initialType : cfg.types[0].code);
  const seatLabel = (id) => id.split("-")[0];
  const seatRow = (id) => parseInt(id, 10);
  const blockOf = (id) => parseInt(id.split("-")[1], 10);
  const letterOf = (id) => id.split("-")[0].replace(/^\d+/, "");
  // Derive window / aisle / middle from the cabin's own block layout, so the rules below work for
  // every cabin (3-3 Economy, 2-2 Premium, 1-1 Business) without hard-coded seat letters.
  const roleOf = (id) => {
    const b = blockOf(id), blk = cfg.blocks[b] || [], i = blk.indexOf(letterOf(id)), last = blk.length - 1;
    if (blk.length === 1) return "window";
    if ((b === 0 && i === 0) || (b === cfg.blocks.length - 1 && i === last)) return "window";
    if (i === 0 || i === last) return "aisle";
    return "middle";
  };
  const neighboursOf = (id) => {
    const b = blockOf(id), blk = cfg.blocks[b] || [], i = blk.indexOf(letterOf(id)), row = seatRow(id);
    return [blk[i - 1], blk[i + 1]].filter(Boolean).map(c => row + c + "-" + b);
  };
  const pairOf = (id) => {
    const b = blockOf(id), row = seatRow(id), ids = (cfg.blocks[b] || []).map(c => row + c + "-" + b);
    return [ids.find(x => roleOf(x) === "window"), ids.find(x => roleOf(x) === "aisle")].filter(Boolean);
  };
  // Each seat product drives its own seat-map behaviour: which seats may be picked, whether a
  // neighbouring seat is held free, and whether seats are booked as a pair.
  const RULES = {
    std: { hint: "Pick any available seat." },
    legroom: { ok: (id) => legSet.has(id) || cfg.fee(seatRow(id)).price > 0, hint: "Extra-legroom rows only \u2014 other rows are unavailable for this product." },
    win: { ok: (id) => roleOf(id) === "window", holds: true, hint: "Window seats only \u2014 the seat beside you is kept free." },
    front: { ok: (id) => seatRow(id) === cfg.startRow, hint: "Front row only \u2014 first off the aircraft." },
    nsf: { holds: true, hint: "Pick your seat \u2014 the seat next to you is blocked so nobody can book it." },
    solo: { holds: true, hint: "Pick your seat \u2014 the seat beside you is blocked." },
    couple: { ok: (id) => roleOf(id) !== "middle", pairs: true, hint: "Window + aisle are booked together \u2014 the middle seat between you stays free." },
  };
  const ruleFor = (t) => RULES[t] || RULES.std;
  const okUnder = (t) => (id) => !takenSet.has(id) && (!ruleFor(t).ok || ruleFor(t).ok(id));
  const selectable = okUnder(type);
  const firstFreeUnder = (t, n) => {
    const ok = okUnder(t), out = [];
    for (const row of rowsArr) for (let b = 0; b < cfg.blocks.length; b++) for (const c of cfg.blocks[b]) {
      const id = row + c + "-" + b;
      if (ok(id)) { out.push(id); if (out.length >= n) return out; }
    }
    return out;
  };
  const wanted = (t) => ruleFor(t).pairs ? 2 * Math.max(1, pax) : Math.max(1, pax);
  const [picks, setPicks] = useState(() => firstFreeUnder(type, wanted(type)));
  // Switching product re-validates the current seats: anything the new product cannot use is
  // dropped, and if nothing survives we seed a valid selection so the map is never left empty.
  useEffect(() => {
    const ok = okUnder(type);
    setPicks((cur) => { const kept = cur.filter(ok); return kept.length ? kept : firstFreeUnder(type, wanted(type)); });
  }, [type]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Seats the chosen product keeps empty beside you (Next Seat Free / Solo / Window+).
  const heldSet = (() => {
    if (!ruleFor(type).holds) return new Set();
    const h = new Set();
    picks.forEach(id => neighboursOf(id).forEach(n => { if (!picks.includes(n) && !takenSet.has(n)) h.add(n); }));
    return h;
  })();
  const feeInfo = (id) => cfg.fee(seatRow(id));
  const feeOf = (id) => feeInfo(id).price;
  const toggle = (id) => {
    if (!selectable(id) || heldSet.has(id)) return;
    const r = ruleFor(type);
    const group = r.pairs ? pairOf(id).filter(selectable) : [id];
    if (!group.length) return;
    setPicks((cur) => {
      if (group.every(g => cur.includes(g))) return cur.filter(s => !group.includes(s));
      const merged = [...cur.filter(s => !group.includes(s)), ...group];
      const cap = wanted(type);
      return merged.length > cap ? merged.slice(merged.length - cap) : merged;
    });
  };
  const typeFee = (cfg.types.find(t => t.code === type)?.price || 0) * Math.max(1, pax);   // per traveller, not per seat
  const total = picks.reduce((s, id) => s + feeOf(id), 0) + typeFee;
  const label = picks.map(seatLabel).join(", ");
  const seatClass = (id) => {
    if (picks.includes(id)) return "bg-lime text-ink ring-2 ring-tap-green";
    if (takenSet.has(id)) return "bg-surface-mute text-ink-faint cursor-not-allowed";
    if (heldSet.has(id)) return "bg-lime-tint text-tap-greenDeep ring-1 ring-tap-green/50 cursor-not-allowed";
    if (!selectable(id)) return "bg-surface-mute/40 text-ink-faint/50 cursor-not-allowed";
    if (winSet.has(id)) return "bg-[#E8C75A]/60 text-ink";
    if (legSet.has(id)) return "bg-tap-green/50 text-white";
    return "bg-surface border border-line hover:border-tap-green text-ink";
  };
  const abreast = cfg.blocks.reduce((s, b) => s + b.length, 0);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-[1080px] my-6 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-bold">Choose your seat</h2>
            <p className="text-[13px] text-ink-muted mt-0.5">Pick seats for every traveller — we confirm the fare difference before you pay.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 w-9 h-9 rounded-full hover:bg-surface-mute inline-flex items-center justify-center"><Icon name="x" size={18} /></button>
        </div>

        <div className={cx("grid gap-3 mt-4", cfg.types.length === 1 ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-4")}>
          {cfg.types.map((s) => {
            const on = type === s.code;
            return (
              <button key={s.code} onClick={() => setType(s.code)} className={cx("text-left rounded-xl border p-3 relative", on ? "border-tap-green ring-1 ring-tap-green bg-surface" : "border-line")}>
                {on && <span className="absolute top-2.5 right-2.5 text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-tap-green text-white">Selected</span>}
                <div className="text-[13px] font-bold">{s.name}</div>
                <div className="text-[20px] font-black v2-num mt-0.5">{s.price ? eur2(s.price) : "Included"}</div>
                <div className="text-[11px] text-ink-faint mt-1">{s.sub}</div>
                <div className="text-[11px] text-tap-greenDeep font-semibold mt-2">{s.note}</div>
                <span className={cx("mt-2 inline-flex items-center justify-center w-full rounded-full py-1.5 text-[12px] font-semibold", on ? "bg-tap-green text-white" : "border border-line-strong text-ink")}>{on ? "Active" : "Switch"}</span>
              </button>
            );
          })}
        </div>

        {/* the rule the selected product applies to the cabin map */}
        <div className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: "rgba(242,255,219,1)", border: "1px solid rgba(158,253,56,0.5)" }}>
          <Icon name="check" size={14} className="text-tap-greenDeep shrink-0 mt-0.5" />
          <span className="text-[12px] font-semibold text-tap-greenDeep">{cfg.types.find(t => t.code === type)?.name}: <span className="font-normal text-ink-muted">{ruleFor(type).hint}</span></span>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5 mt-5 items-start">
          <div className="rounded-2xl border border-line p-4 overflow-x-auto v2-track">
            <div className="text-center text-[15px] font-bold">{aircraft || cfg.aircraftFallback} · {cabin} cabin</div>
            <div className="text-center text-[11px] font-semibold text-ink-faint mt-1">{cfg.blocks.map(b => b.length).join("-")} layout · {abreast} across</div>
            <div className="text-center text-[11px] font-semibold text-ink-faint mb-3">Front</div>
            <div className={cx("flex justify-center", cfg.blockGap)}>
              {cfg.blocks.map((cols, b) => (
                <div key={b} className={cfg.rowGap}>
                  <div className={cx("flex justify-center text-[11px] font-bold text-ink-faint", cfg.colGap)}>{cols.map((c, i) => <span key={i} className={cx(cfg.colW, "text-center")}>{c}</span>)}</div>
                  {rowsArr.map((row) => (
                    <div key={row} className={cx("flex items-center relative", cfg.colGap)}>
                      {b === 0 && <span className="absolute -left-5 text-[10px] text-ink-faint w-3 text-right">{row}</span>}
                      {cols.map((c, ci) => {
                        const id = row + c + "-" + b;
                        return <button key={ci} disabled={takenSet.has(id)} onClick={() => toggle(id)} className={cx(cfg.seatW, "rounded-lg text-[10px] font-bold inline-flex items-center justify-center", seatClass(id))}>{row}{c}</button>;
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="h-px bg-line my-3" />
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-ink-muted justify-center">
              {cfg.legend.map(([cl, lb]) => <span key={lb} className="inline-flex items-center gap-1.5"><span className={cx("w-3.5 h-3.5 rounded", cl)} />{lb}</span>)}
            </div>
          </div>

          <div className="space-y-4">
            {cfg.upsell
              ? <div className="rounded-2xl border-2 border-lime bg-lime-tint/60 p-4">
                  <span className="inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-surface-dark text-lime">New · Non-status flyer</span>
                  <div className="text-[16px] font-bold mt-2">Buy premium without status</div>
                  <p className="text-[11px] text-ink-muted mt-1">Get every status-only perk for one flight — front cabin, priority boarding, lounge, hot meal, +2× miles.</p>
                  <div className="mt-2"><span className="text-[22px] font-black v2-num">$89</span> <span className="text-[11px] text-ink-faint">per passenger · vs $189 cabin</span></div>
                  <button className="mt-3 w-full rounded-full bg-tap-greenDeep text-white py-2.5 text-[13px] font-semibold">Unlock NSF · {eur2(89 * pax)} for {pax}</button>
                </div>
              : <div className="rounded-2xl border border-tap-green/40 bg-lime-tint/40 p-4">
                  <span className="inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-2 py-1 rounded-full bg-tap-greenDeep text-white">{cabin} cabin</span>
                  <div className="text-[15px] font-bold mt-2">{cabin === "Business" ? "Lie-flat suites · all included" : "Wider seats · all included"}</div>
                  <p className="text-[11px] text-ink-muted mt-1">{cabin === "Business" ? "Every seat is a lie-flat suite with direct aisle access — lounge & priority included, no extra seat fee." : "Premium seats include extra legroom and recline. Pick any open seat at no extra charge."}</p>
                </div>}
            <div className="rounded-2xl border border-line p-4">
              <div className="text-[14px] font-bold">Your selection</div>
              <div className="mt-2 space-y-2">
                {picks.length === 0 && <div className="text-[12px] text-ink-faint">Xperion a seat to assign it.</div>}
                {picks.map((id, i) => (
                  <div key={id} className="flex items-center justify-between text-[12px]">
                    <span className="inline-flex items-center gap-2"><span className="w-6 h-6 rounded-full bg-lime text-ink text-[10px] font-bold inline-flex items-center justify-center">{seatLabel(id)}</span><span>{SEAT_PAX_NAMES[i] || `Passenger ${i + 1}`} · {feeInfo(id).tag}</span></span>
                    <span className="font-semibold v2-num">{feeOf(id) ? eur2(feeOf(id)) : "Free"}</span>
                  </div>
                ))}
              </div>
              <div className="h-px bg-line my-3" />
              <div className="flex items-center justify-between"><span className="text-[13px] font-bold">Seats total</span><span className="text-[16px] font-black v2-num">{eurC(total)}</span></div>
              <Btn size="lg" className="w-full mt-3" disabled={picks.length === 0} onClick={() => onConfirm(label, total, type)}>Confirm seats →</Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ CART · View & customize (8 modules) ═══════════ */
/* #22 — basket line-item editors: every modification link opens a real, functional editor. */
const EDIT_CONFIG = {
  "Change room": { title: "Change room type", kind: "select", opts: [
    { name: "Classic Double", sub: "City view · 22m² · breakfast", delta: -90 },
    { name: "Deluxe Room", sub: "Garden view · 28m² · breakfast", delta: 0 },
    { name: "Junior Suite", sub: "Terrace · 40m² · breakfast + minibar", delta: 150 },
  ] },
  "Change vehicle": { title: "Change vehicle", kind: "select", opts: [
    { name: "Airport transfer · Private sedan", sub: "Up to 3 pax · 3 bags", delta: 0 },
    { name: "Airport transfer · Premium SUV", sub: "Up to 5 pax · 5 bags", delta: 22 },
    { name: "Airport transfer · Minivan", sub: "Up to 7 pax · 7 bags", delta: 38 },
  ] },
  "Change plan": { title: "Change insurance plan", kind: "select", opts: [
    { name: "Travel Insurance · Standard", sub: "Medical $25K · baggage", delta: -12 },
    { name: "Travel Insurance · Plus", sub: "Medical $50K · cancellation · 24/7", delta: 0 },
    { name: "Travel Insurance · Premium", sub: "Medical $150K · cancel for any reason", delta: 24 },
  ] },
  "Change lounge": { title: "Change lounge", kind: "select", opts: [
    { name: "Standard lounge", sub: "Hot meals · showers · Wi-Fi", delta: 0 },
    { name: "Premium lounge", sub: "À la carte · quiet zone · spa chairs", delta: 16 },
  ] },
  "Edit time": { title: "Edit pickup time", kind: "time", field: "time", def: "14:15" },
  "Change date": { title: "Change activity date", kind: "date", field: "date" },
  "View hotel": { title: "Your hotel", kind: "info", body: [
    "Boutique hotel in a central location with a rooftop pool, spa and fine-dining restaurant.",
    "9.2 Excellent · 1,240 reviews · Free cancellation up to 48h before check-in.",
    "Walking distance to the historic centre, gardens and the best restaurants in town.",
  ] },
  "Compare plans": { title: "Compare insurance plans", kind: "compare", cols: ["Standard", "Plus", "Premium"], rows: [
    ["Medical cover", "$25K", "$50K", "$150K"],
    ["Trip cancellation", "—", "✓", "✓ any reason"],
    ["Baggage protection", "✓", "✓", "✓"],
    ["24/7 assistance", "—", "✓", "✓"],
  ] },
  "Compare plans ": null,
};
function ItemEditModal({ item, link, onClose, onApply }) {
  const cfg = EDIT_CONFIG[link] || { title: link, kind: "info", body: ["This option isn't editable in the demo."] };
  const [val, setVal] = useState(item[cfg.field] || cfg.def || "");
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-[460px] p-6" onClick={ev => ev.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <h2 className="text-[18px] font-bold leading-tight">{cfg.title}</h2>
          <button onClick={onClose} aria-label="Close" className="shrink-0 w-8 h-8 rounded-full hover:bg-surface-mute inline-flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        {cfg.kind === "select" && <div className="space-y-2">
          {cfg.opts.map((o, i) => {
            const cur = item.name === o.name;
            return (
              <button key={i} onClick={() => { onApply(item, { name: o.name, price: Math.max(0, +(item.price + o.delta).toFixed(2)) }); onClose(); }} className={cx("w-full text-left rounded-xl border p-3 flex items-center justify-between gap-3 transition-colors hover:border-tap-green", cur ? "border-tap-green bg-lime-tint/30 ring-1 ring-tap-green" : "border-line")}>
                <div className="min-w-0"><div className="text-[14px] font-bold truncate">{o.name.replace(/^[^·]+· /, "")}</div><div className="text-[11px] text-ink-faint mt-0.5">{o.sub}</div></div>
                <span className="text-[13px] font-bold v2-num shrink-0">{o.delta === 0 ? (cur ? "Current" : "Included") : (o.delta > 0 ? "+" : "−") + eur2(Math.abs(o.delta))}</span>
              </button>
            );
          })}
        </div>}
        {(cfg.kind === "time" || cfg.kind === "date") && <div>
          <input type={cfg.kind} value={val} onChange={ev => setVal(ev.target.value)} className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] outline-none focus:border-tap-green" />
          <Btn className="w-full mt-3" disabled={!val} onClick={() => { onApply(item, { [cfg.field]: val }); onClose(); }}>Save</Btn>
        </div>}
        {cfg.kind === "info" && <div className="space-y-2 text-[13px] text-ink-muted">{cfg.body.map((b, i) => <p key={i}>{b}</p>)}<Btn variant="outline" className="w-full mt-3" onClick={onClose}>Close</Btn></div>}
        {cfg.kind === "compare" && <div>
          <div className="overflow-hidden rounded-xl border border-line"><table className="w-full text-[12px]"><thead><tr className="bg-surface-mute"><th className="text-left p-2 font-semibold" /> {cfg.cols.map(c => <th key={c} className="p-2 font-bold text-center">{c}</th>)}</tr></thead><tbody>{cfg.rows.map((row, i) => <tr key={i} className="border-t border-line"><td className="p-2 font-semibold text-ink-muted">{row[0]}</td>{row.slice(1).map((v, j) => <td key={j} className="p-2 text-center">{v}</td>)}</tr>)}</tbody></table></div>
          <Btn variant="outline" className="w-full mt-3" onClick={onClose}>Close</Btn>
        </div>}
      </div>
    </div>
  );
}

// F8/F9 — destination-aware inventory. Hotels, experiences, transfers and the lounge follow the
// booked destination (trip.dest) / origin instead of always showing New York. City-name generators
// give any route sensible, destination-specific content; the hotel/exp codes embed the city so
// imageFor() also resolves a city-relevant photo.
const slugCity = (c) => String(c || "city").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const PIMG = "/v2/assets/photos/";   // #14 — approved photos
const AIC = "/v2/assets/icons/";     // #14 — approved icons
function destHotels(city) {
  const s = slugCity(city);
  return [
    { code: `htl-${s}-1`, name: `${city} Grand Hotel`, stars: 5, tags: ["City centre", "Free cancellation", "Breakfast"], rating: "9.2", reviews: "1,284", pn: 120, rec: true, img: PIMG + "memmo-principe.jpg" },
    { code: `htl-${s}-2`, name: `${city} Boutique Suites`, stars: 4, tags: ["Central", "Free cancellation"], rating: "8.7", reviews: "962", pn: 88, img: PIMG + "bairro-alto.jpg" },
    { code: `htl-${s}-3`, name: `${city} Riverside Resort`, stars: 4, tags: ["Pool", "Spa", "Resort"], rating: "9.0", reviews: "538", pn: 150, img: PIMG + "quinta-marinha.jpg" },
    { code: `htl-${s}-4`, name: `${city} Park Plaza`, stars: 5, tags: ["Landmark", "Spa", "Free cancellation"], rating: "9.4", reviews: "2,015", pn: 210 },
    { code: `htl-${s}-5`, name: `${city} Old Town Inn`, stars: 4, tags: ["Historic", "City view"], rating: "8.5", reviews: "744", pn: 96 },
  ];
}
function destExp(city) {
  const s = slugCity(city);
  return [
    [`xp-${s}-1`, `${city} food walking tour`, "Small group · local tastings · English guide", 65, "Food", PIMG + "wine-tour.jpg"],
    [`xp-${s}-2`, `${city} highlights full-day`, "Top sights · skip-the-line · guided", 89, "Day trip · popular", PIMG + "sintra.jpg"],
    [`xp-${s}-3`, `${city} sunset experience`, "Evening tour · welcome drink included", 75, "Evening"],
    [`xp-${s}-4`, `${city} museums & art pass`, "Priority entry · flexible full day", 45, "Culture"],
    [`xp-${s}-5`, `${city} day-trip by rail`, "Nearby gems · 1st class · day-trip ready", 55, "Excursion"],
    [`xp-${s}-6`, `${city} local flavours class`, "Hands-on cooking · market visit", 70, "Hands-on"],
  ];
}

function CartView({ go, mode = "cart", shared }) {
  const isBasket = mode === "basket";
  useEffect(() => { if (trip.outbound) api.post("/journey", { origin: trip.origin, dest: trip.dest, date: trip.date, stage: isBasket ? "basket" : "cart", device: "Web app" }).catch(() => {}); }, []); // eslint-disable-line
  const [, force] = useState(0); const r = () => force(x => x + 1);
  const [carbonOn, setCarbonOn] = useState(() => hasExtra("carbon"));
  // v35 View&Customize #1: carbon offset is auto-selected and in the basket the moment the page
  // opens; OPT-OUT removes it. trip.carbonOptOut remembers an opt-out for this itinerary so we
  // don't force it back on every re-visit.
  useEffect(() => {
    if (!trip.carbonOptOut && !hasExtra("carbon")) { toggleExtra({ code: "carbon", name: "Carbon offset", price: 10, cat: "Carbon offset", source: "auto" }); setCarbonOn(true); save(); r(); }
  }, []);
  // H2 — a fare change can surface as early as the cart step (and on resume, via the force flag).
  // Only in the checkout "cart" step, not the standalone basket view.
  const [reval, setReval] = usePriceReval(!isBasket);
  // Don't re-seed a recommended basket if the member explicitly cleared it last time; an open
  // saved basket has already been restored on login, so seedExtras() is a no-op in that case.
  useEffect(() => { if (trip.outbound && shared?.basket?.status !== "cleared") seedExtras(); r(); }, []);
  // v35: carbon offset auto-adds on cart load (see effect above); OPT-OUT removes it for this trip.
  // Insurance is mandatory and pre-selected to the recommended Plus plan. Reflect that pre-selection
  // in the basket/total from first render (not only after the user re-picks a plan) so any extra
  // that is pre-selected for the user is counted in the summary from the start.
  useEffect(() => { if (trip.outbound && !hasExtra("ins-plus") && !hasExtra("ins-std")) { const px = trip.pax || 1; toggleExtra({ code: "ins-plus", name: `Travel Insurance · Plus × ${px}`, price: 38 * px, cat: "Insurance", source: "auto" }); r(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!trip.outbound) return noTrip(go);
  const save = () => api.post("/basket", { flight_no: trip.outbound.flight.flight_no, items: trip.extras.map(e => e.code), snapshot: tripSnapshot() }).catch(() => {});
  const add = (code, name, price, cat, meta) => { toggleExtra({ code, name, price, cat, ...(meta || {}) }); save(); r(); };
  const clear = () => { clearBasket(); api.post("/basket/clear", { flight_no: trip.outbound?.flight?.flight_no }).catch(() => {}); r(); };
  const seat = trip.extras.find(e => e.cat === "Seats & baggage" && /^seat-(?!map)/.test(e.code || ""));   // seat TYPE only — seat-map (picked seats) is a separate line   // View&Customize #1 — only a seat upgrade counts as "seat"; bags (bag-*) are independent ancillaries
  const pax = trip.pax || 1;
  const cityOf = (c) => shared?.airports?.find(a => a.code === c)?.city || c;   // F8/F9 — resolve booked-destination city
  const destCity = cityOf(trip.dest) || "your destination";
  const origCode = trip.origin || "MIA";
  const HOTELS = destHotels(destCity);
  const cab = fareCabin(trip.outbound?.fare);                 // Economy / Premium / Business
  const fareLabel = trip.outbound?.fare || "Classic";
  const seatIncluded = { Economy: { name: "Standard", sub: "Standard 78cm pitch · auto-assigned" }, Premium: { name: "Premium seat", sub: "Wider seat · recline · priority · included" }, Business: { name: "Business seat", sub: "Lie-flat · lounge access · included" } }[cab] || { name: "Standard", sub: "Standard 78cm pitch · auto-assigned" };
  // #33 — within the selected cabin, keep the included seat AND still offer cabin-appropriate upgrades.
  const SEAT_TYPE_OPTS = {
    // v33 View&Customize #4 — the selector shows the SAME seat products as the Full Cabin View
    Economy: [
      { code: "seat-nsf", name: "Next Seat Free", sub: "Adjacent seat blocked · privacy & space", price: 48 },
      { code: "seat-couple", name: "Couple seat", sub: "Auto-paired window+aisle · travel together", price: 36 },
      { code: "seat-legroom", name: "Extra legroom", sub: "Exit rows · +10cm pitch", price: 18 },
      { code: "seat-win", name: "Window+", sub: "Window + free middle + legroom", price: 68 }],
    Premium: [{ code: "seat-legroom", name: "Extra legroom", sub: "Bulkhead & front rows · more recline", price: 20 }, { code: "seat-solo", name: "Solo · no neighbour", sub: "Block the seat beside you", price: 40 }],
    Business: [{ code: "seat-throne", name: "Throne seat", sub: "Extra-wide solo suite · single aisle", price: 45 }, { code: "seat-winsuite", name: "Window suite", sub: "Window · do-not-disturb divider", price: 30 }],
  }[cab] || [];
  // #34 — baggage entitlement follows the FARE, not just the cabin: Basic = 0 checked, Classic/Plus = 1, Premium/Executive = 2.
  const fareBags = /exec|premium/i.test(fareLabel) ? 2 : /basic/i.test(fareLabel) ? 0 : 1;
  const tripDays = (() => { try { if (trip.date && trip.ret) { const d = Math.round((new Date(trip.ret) - new Date(trip.date)) / 864e5); if (d > 0) return d; } } catch { } return 5; })();
  const catCount = (cat) => trip.extras.filter(e => e.cat === cat).length;
  const catBadge = (cat) => { const n = catCount(cat); return n ? `${n} added` : null; };
  const [meal, setMeal] = useState("Standard meal");
  const [allHotels, setAllHotels] = useState(false);
  const [ins, setIns] = useState(() => hasExtra("ins-std") ? "standard" : hasExtra("ins-plus") ? "plus" : "plus");
  const [seatMapOpen, setSeatMapOpen] = useState(false);
  const confirmSeats = (lbl, tot, typeCode) => {
    const ex = trip.extras.find(e => e.code === "seat-map");
    if (ex) toggleExtra(ex);
    toggleExtra({ code: "seat-map", name: `Seats · ${lbl}`, price: tot, cat: "Seats & baggage" });
    // v33 View&Customize #4 — the seat TYPE chosen inside the Full Cabin View syncs back to the
    // selector tiles (and persists), so both components always agree.
    if (typeCode !== undefined) {
      const t = SEAT_TYPE_OPTS.find(o => o.code === "seat-" + typeCode);
      if (seat && (!t || seat.code !== t.code)) toggleExtra(seat);                       // clear old type
      if (t && (!seat || seat.code !== t.code)) toggleExtra({ code: t.code, name: t.name, price: 0, cat: "Seats & baggage", note: "included in seat total" });
    }
    save(); r(); setSeatMapOpen(false);
  };

  // A seat picked in the Full Cabin View should only ever carry the ROW surcharge (exit row etc.).
  // The seat-TYPE price belongs to its own extra. Recomputing it here means switching type - above
  // all, switching back to Standard / Included - can never leave a stale type fee attached to the
  // seat assignment, which is what made an "Included" seat still show up as a paid ancillary.
  const seatMapRowFee = (sm) => {
    if (!sm) return 0;
    const cfg = SEAT_CABINS[cab] || SEAT_CABINS.Economy;
    return String(sm.name).replace(/^[^\u00b7]*\u00b7\s*/, "").split(",")
      .map(x => parseInt(String(x).trim(), 10)).filter(n => !isNaN(n))
      .reduce((acc, row) => acc + ((cfg.fee(row) || {}).price || 0), 0);
  };
  const SeatType = ({ code, name, sub, price }) => {
    const on = code === "std" ? !seat : hasExtra(code);
    return <button onClick={() => { if (seat) toggleExtra(seat); if (code !== "std") toggleExtra({ code, name, price, cat: "Seats & baggage" }); const sm = trip.extras.find(e => e.code === "seat-map"); if (sm) { const rowFee = seatMapRowFee(sm); if (sm.price !== rowFee) { toggleExtra(sm); toggleExtra({ ...sm, price: rowFee }); } } save(); r(); }} className={cx("shrink-0 snap-start text-left flex flex-col overflow-hidden", on ? "border-2" : "border")} style={{ width: "272px", height: "151px", borderRadius: "12px", padding: "14px", gap: "10px", boxSizing: "border-box", ...(on ? { background: "rgba(242,255,219,1)", borderColor: "rgba(158,253,56,1)" } : { borderColor: "rgba(232, 232, 229, 1)", borderStyle: "solid", borderWidth: "1px" }) }}>
      <div className="rounded-xl border border-line bg-surface p-3 flex justify-center gap-1.5 shrink-0">{[0, 1, 2, 3, 4].map(i => { const yours = on && i === 2; const free = on && code !== "std" && i === 3; return <span key={i} className={cx("w-6 h-6 rounded", yours ? "bg-lime" : free ? "bg-lime/40" : "bg-surface-mute")} />; })}</div>
      <div className="flex items-center gap-2">
        <span className={cx("w-4 h-4 rounded-full border-2 inline-flex items-center justify-center shrink-0", on ? "border-tap-green" : "border-line-strong")}>{on && <span className="w-2 h-2 rounded-full bg-tap-green" />}</span>
        <span className="text-[13px] font-semibold flex-1">{name}</span>
        {price ? <span className="text-[13px] font-bold v2-num">{eur2(price)}</span> : <span className="text-[13px] font-semibold text-[rgba(10,10,10,1)]">Included</span>}
      </div>
      <div className="text-[11px] text-ink-faint pl-6 leading-snug">{sub}</div>
    </button>;
  };
  const Bag = ({ code, name, sub, price, locked }) => { const on = locked || hasExtra(code); const toggle = () => { if (!locked) add(code, name, price, "Seats & baggage"); }; return (
    <div onClick={toggle} className={cx("flex items-center gap-3 rounded-xl p-3", locked ? "opacity-95" : "cursor-pointer", on ? "border" : "border border-line")} style={on ? { background: "rgba(250,250,247,1)", borderColor: "rgba(158,253,56,1)" } : undefined}>
      <span className="w-5 h-5 rounded-md inline-flex items-center justify-center shrink-0" style={on ? { background: "rgba(10,10,10,1)", border: "1px solid rgba(232,232,229,1)" } : { background: "rgba(255,255,255,1)", border: "1px solid rgba(232,232,229,1)" }}>{on && <Icon name="check" size={12} className="stroke-[3] text-[rgba(158,253,56,1)]" />}</span>
      <div className="flex-1"><div className="text-[13px] font-semibold flex items-center gap-2">{name} {locked && <span className="inline-flex items-center uppercase rounded px-1.5 py-0.5" style={{ background: "rgba(158,253,56,1)", color: "rgba(51,102,20,1)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.27px" }}>Included</span>}</div><div className="text-[11px] text-ink-faint">{sub}</div></div>
      <div className="text-right"><div className="text-[13px] font-bold v2-num">{locked ? "Included" : eur2(price)}</div>{!locked && <div className="text-[10px] text-ink-faint">per bag · per flight</div>}</div>
    </div>
  ); };
  const featBadge = (t) => <span key={t} className="inline-flex items-center justify-center rounded-[4px]" style={{ background: "rgba(242,242,238,1)", color: "rgba(107,107,107,1)", padding: "3px 8px", fontSize: "10px", fontWeight: 400, letterSpacing: "0.2px", lineHeight: 1 }}>{t}</span>;
  const HotelRow = ({ code, name, stars, tags, rating, reviews, pn, total, rec, img }) => { const on = hasExtra(code); const nn = tripDays; const tot = pn > 0 ? pn * nn : total; return (
    <div className="flex rounded-[14px] overflow-hidden w-full" style={on ? { background: "rgba(250,250,247,1)", border: "2px solid rgba(158,253,56,1)" } : { background: "rgba(255,255,255,1)", border: "1px solid rgba(232,232,229,1)" }}>
      <Img seed={"hotel-" + code} src={img || imageFor("hotel-" + code)} alt={name} className="w-[116px] sm:w-[200px] self-stretch shrink-0 object-cover" />
      <div className="flex-1 min-w-0 flex items-center justify-between gap-3 sm:gap-6 p-3 sm:p-4 sm:pl-5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-[15px] font-bold">{name}</span><span className="text-[#E8C75A]">{"★".repeat(stars)}</span>{rec && <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-surface-dark text-lime">Recommended</span>}</div>
          <div className="flex flex-wrap gap-1.5 mt-2">{tags.map(featBadge)}</div>
          <div className="text-[11px] text-ink-muted mt-2">★ {rating} Excellent · {reviews} reviews</div>
        </div>
        <div className="text-right shrink-0 flex flex-col items-end">
          <div className="v2-num"><span className="text-[11px] font-bold text-ink">From </span><span className="text-[16px] font-bold text-ink">{eur2(pn)}</span><span className="text-[11px] font-medium text-ink-faint"> / night</span></div>
          <div className="text-[11px] text-ink-faint v2-num">{eur2(tot)} total for {nn} night{nn !== 1 ? "s" : ""}</div>
          <button onClick={() => add(code, name, tot, "Hotels", { rate: pn, nights: nn })} className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-full font-semibold" style={on
            ? { width: "124px", height: "33px", padding: "9px 14px", background: "rgba(255,255,255,1)", border: "1.5px solid rgba(158,253,56,1)", color: "rgba(51,102,20,1)", fontSize: "12px" }
            : { width: "108px", height: "33px", padding: "9px 14px", background: "rgba(255,255,255,1)", border: "1px solid rgba(51,102,20,1)", color: "rgba(51,102,20,1)", fontSize: "12px" }}>{on ? "✓ Added to cart" : "+ Add to cart"}</button>
        </div>
      </div>
    </div>
  ); };
  const Row = ({ code, name, sub, rate, unit, cat, tag }) => {
    const on = hasExtra(code);
    const mult = unit === "per person" ? pax : unit === "per day" ? tripDays : 1;
    const total = rate * mult;
    const multLabel = unit === "per person" ? `× ${pax} = ${eur2(total)}` : unit === "per day" ? `${tripDays} days = ${eur2(total)}` : unit === "per car" ? "per car" : "";
    return (
      <div className={cx("flex items-center gap-3 rounded-xl p-3", on ? "border-2" : "border border-line")} style={on ? { background: "rgba(242,255,219,1)", borderColor: "rgba(158,253,56,1)" } : undefined}>
        <Img seed={"xfer-" + code} src={imageFor(code)} alt={name} className="w-20 h-16 rounded-lg shrink-0 object-cover" />
        <div className="flex-1"><div className="text-[13px] font-semibold flex items-center gap-2">{name}{tag && <span className="text-[9px] font-bold uppercase tracking-wide text-ink-faint bg-surface-mute rounded px-1.5 py-0.5">{tag}</span>}</div><div className="text-[11px] text-ink-faint">{sub}</div></div>
        <div className="text-right shrink-0">
          <div className="text-[14px] font-bold v2-num">{eur2(rate)}</div>
          {multLabel && <div className="text-[10px] text-ink-faint v2-num">{multLabel}</div>}
          <Btn size="sm" variant="outline" className="mt-1" style={on ? ADDED_CTA : ADD_CTA} onClick={() => add(code, name, total, cat)}>{on ? "✓ Added" : "+ Add to cart"}</Btn>
        </div>
      </div>
    );
  };
  const ServiceRow = ({ code, name, sub, rate, tag, icon }) => {
    const on = hasExtra(code); const tot = rate * pax;
    return (
      <div className={cx("flex items-center gap-3 rounded-xl p-3", on ? "border-2" : "border border-line")} style={on ? { background: "rgba(242,255,219,1)", borderColor: "rgba(158,253,56,1)" } : undefined}>
        <button onClick={() => add(code, name, tot, "Lounge & services")} className={cx("w-10 h-6 rounded-full relative transition-colors shrink-0", on ? "bg-tap-green" : "bg-surface-mute")}><span className={cx("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all", on ? "right-0.5" : "left-0.5")} /></button>
        <span className="w-9 h-9 rounded-lg bg-surface-mute text-ink-slate inline-flex items-center justify-center shrink-0"><Icon name={icon} size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-[13px] font-semibold">{name}</span><span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-mute text-ink-faint">{tag}</span></div>
          <div className="text-[11px] text-ink-faint">{sub}</div>
        </div>
        <div className="text-right shrink-0"><div className="text-[14px] font-bold v2-num">{eur2(tot)}</div><div className="text-[10px] text-ink-faint v2-num">{eur2(rate)} / pax</div></div>
      </div>
    );
  };
  const Plan = ({ v, name, kicker, price, total, points, badge }) => {
    const on = ins === v;
    const select = () => {
      setIns(v);
      const cur = trip.extras.find(x => x.code === "ins-plus" || x.code === "ins-std");
      if (cur) toggleExtra(cur);
      if (v === "plus") toggleExtra({ code: "ins-plus", name: `Travel Insurance · Plus × ${pax}`, price: 38 * pax, cat: "Insurance" });
      else if (v === "standard") toggleExtra({ code: "ins-std", name: `Travel Insurance · Standard × ${pax}`, price: 19 * pax, cat: "Insurance" });
      save(); r();
    };
    return (
      <div className={cx("flex-1 rounded-xl p-4 flex flex-col", on ? "border-2" : "border border-line")} style={on ? { background: "rgba(242,255,219,1)", borderColor: "rgba(158,253,56,1)" } : undefined}>
        <button onClick={select} className="flex items-start gap-2.5 text-left w-full">
          <span className={cx("mt-0.5 w-4 h-4 rounded-full border-2 inline-flex items-center justify-center shrink-0", on ? "border-tap-green" : "border-line-strong")}>{on && <span className="w-2 h-2 rounded-full bg-tap-green" />}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2"><div className="text-[15px] font-bold leading-tight">{name}</div>{badge && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-surface-dark text-lime">{badge}</span>}</div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-faint mt-0.5">{kicker}</div>
          </div>
        </button>
        <ul className="mt-3 space-y-1.5 text-[12px] flex-1">{points.map(([ok, p]) => <li key={p} className={cx("flex items-center gap-2", !ok && "text-ink-faint")}><Icon name={ok ? "check" : "x"} size={13} className={ok ? "text-tap-green" : "text-ink-faint"} /> {p}</li>)}</ul>
        <div className="h-px bg-line my-3" />
        {price != null
          ? <div className="flex items-end justify-between"><div className="text-[18px] font-bold v2-num">{eur2(price)}<span className="text-[10px] font-medium text-ink-faint"> per traveler</span></div>{total != null && <div className="text-right"><div className="text-[14px] font-bold v2-num text-tap-greenDeep">{eur2(total)}</div><div className="text-[9px] uppercase tracking-wide text-ink-faint">Total · {pax} {pax > 1 ? "adults" : "adult"}</div></div>}</div>
          : <div className="text-[12px] text-ink-muted">No charge — you confirm you're covered elsewhere.</div>}
      </div>
    );
  };

  return (
    <div className="bg-[rgba(255,255,255,1)] min-h-screen">
      <RevalGate reval={reval} setReval={setReval} go={go} />
      {seatMapOpen && <SeatMapModal pax={pax} cabin={cab} aircraft={trip.outbound?.flight?.aircraft} initialType={(seat && String(seat.code || "").replace(/^seat-/, "")) || "std"} onClose={() => setSeatMapOpen(false)} onConfirm={confirmSeats} />}
      {isBasket
        ? <div className="mx-auto max-w-page px-4 sm:px-6 pt-5 text-[12px] text-ink-faint"><button onClick={() => go("home")} className="hover:text-ink">Homepage</button> › <span className="text-ink-muted">My trip basket</span></div>
        : <Stepper active={1} />}
      <div className="mx-auto max-w-page px-4 sm:px-6 py-6">
        <div className="flex items-center gap-3"><h1 className="text-[26px] font-bold">{isBasket ? "My trip basket" : "View & customize cart"}</h1><span className="inline-flex items-center text-[10px] font-bold tracking-wide uppercase px-2.5 py-1 rounded-full bg-surface-mute text-ink-slate border border-line">{isBasket ? `${trip.extras.length + 1} items` : "8 modules"}</span></div>
        <p className="text-[13px] text-ink-muted mt-1">{isBasket ? "Review and customize everything you've added to your trip before checkout." : "Choose hotels, transfers, protection and experiences to complete your trip. Everything you add flows into your cart."}</p>
        <div className="flex flex-wrap gap-2 mt-3"><Chip>{trip.origin}–{trip.dest}</Chip><Chip>{trip.pax} adult{trip.pax > 1 ? "s" : ""}</Chip><Chip>{fmtDate(trip.date).replace(/ \d{4}/, "")} – {fmtDate(trip.ret).replace(/ \d{4}/, "")}</Chip><Chip dot>All extras optional</Chip></div>
        {isBasket && <div className="mt-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-[12px] flex items-center gap-2 flex-wrap"><Pill tone="lime">Pinned</Pill><span className="font-semibold">Your core flight stays in the basket</span><span className="text-ink-faint">— extras below are optional and can be removed.</span></div>}

        {/* v33 View&Customize #1 — the flight itinerary summary is not part of this screen in the
            approved design; flight details live in the basket, My Trips and itinerary pages. */}

        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 mt-6 items-start">
          {/* v35 feedback: minmax(0,..) + min-w-0 let this column shrink below the seat-type row's
              intrinsic width, so the row's own overflow-x-auto engages as a scroller instead of
              the whole column growing and pushing My Trip Basket off-viewport at 100%. */}
          <div className="space-y-5 min-w-0">
            <Module n="01" icon="seat" kicker="Seats & baggage" title="Seats & baggage" sub="Pick where you sit and what you bring.">
              <div className="flex items-center justify-between mb-2"><Eyebrow>Choose your seat type · per passenger · both flights</Eyebrow><button onClick={() => setSeatMapOpen(true)} className="text-[12px] font-semibold text-tap-greenDeep shrink-0 hover:underline">Full Cabin View</button></div>
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x scroll-smooth"><SeatType code="std" name={seatIncluded.name} sub={seatIncluded.sub} />{SEAT_TYPE_OPTS.map(o => <SeatType key={o.code} code={o.code} name={o.name} sub={o.sub} price={o.price} />)}</div>
              <Eyebrow className="mt-4 mb-2">Baggage · what's included with {fareLabel} fare</Eyebrow>
              <div className="space-y-2"><Bag name="Carry-on bag · 8kg" sub="1 piece per traveller · 55×40×20 cm" locked />{fareBags >= 1 ? <Bag name={fareBags === 2 ? "2× Checked bags · 23kg" : "Checked bag · 23kg"} sub={`${fareBags} piece${fareBags > 1 ? "s" : ""} per traveller · included with ${fareLabel} fare`} locked /> : <Bag code="bag-checked" name="Checked bag · 23kg" sub={`Not included in ${fareLabel} · add one`} price={30} />}<Bag code="bag-extra" name={fareBags >= 1 ? "Extra checked bag · 23kg" : "Second checked bag · 23kg"} sub="Add another bag · saves $15 vs airport" price={55} /></div>
            </Module>

            {/* Carbon offset — ONE unified card (no internal divider): icon, title, price, note,
                auto-added state, opt-out badge and climate notice all share a single container. */}
            <div className="flex items-center gap-3" style={{ width: "100%", minHeight: "87px", borderRadius: "18px", border: "1px solid rgba(232, 232, 229, 1)", background: "#FFFFFF", boxShadow: "0px 4px 16px 0px rgba(0, 0, 0, 0.06)", padding: "12px 18px", boxSizing: "border-box" }}>
              <span className="shrink-0 w-9 h-9 rounded-lg bg-lime-tint text-tap-greenDeep inline-flex items-center justify-center"><Icon name="leaf" size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">02 · Carbon offset</span>
                  <span className="text-[14px] font-bold v2-num">{eur2(10)}</span>
                  <span className="text-[12px] text-ink-muted">{carbonOn ? "Auto-checked · uncheck if you wish" : "Optional · offset this trip's CO₂"}</span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 cursor-pointer w-fit" onClick={() => { const next = !carbonOn; trip.carbonOptOut = !next; setCarbonOn(next); if (next !== hasExtra("carbon")) toggleExtra({ code: "carbon", name: "Carbon offset", price: 10, cat: "Carbon offset", source: "auto" }); save(); r(); }}>
                  <span className="w-5 h-5 rounded-md inline-flex items-center justify-center shrink-0" style={carbonOn ? { background: "rgba(10,10,10,1)", border: "1px solid rgba(232,232,229,1)" } : { background: "rgba(255,255,255,1)", border: "1px solid rgba(232,232,229,1)" }}>{carbonOn && <Icon name="check" size={12} className="stroke-[3] text-[rgba(158,253,56,1)]" />}</span>
                  <span className="text-[13px] font-semibold">{carbonOn ? "Auto-added" : "Offset this trip's emissions"}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                {carbonOn && <><button onClick={() => { trip.carbonOptOut = true; setCarbonOn(false); if (hasExtra("carbon")) toggleExtra({ code: "carbon", name: "Carbon offset", price: 10, cat: "Carbon offset", source: "auto" }); save(); r(); }} className="inline-flex items-center text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#fff4d6] text-[#9a6b00] hover:brightness-95">Opt-out</button>
                <div className="text-[10px] text-tap-greenDeep font-semibold mt-1">Default ON in EU (climate)</div></>}
              </div>
            </div>

            <Module n="03" icon="home" kicker="Hotels" title={`Stay in ${destCity}`} badge={catBadge("Hotels")} sub={`Recommended hotels in ${destCity} for your dates.`} right={<button onClick={() => setAllHotels(v => !v)} className="text-[12px] font-semibold text-tap-greenDeep">{allHotels ? "Show less ↑" : "View all hotels →"}</button>}>
              <div className="space-y-2">
                {(allHotels ? HOTELS : HOTELS.slice(0, 3)).map(h => <HotelRow key={h.code} code={h.code} name={h.name} stars={h.stars} tags={h.tags} rating={h.rating} reviews={h.reviews} pn={h.pn} total={h.pn * tripDays} rec={h.rec} img={h.img} />)}
              </div>
            </Module>

            <Module n="04" icon="swap" kicker="Cars & transfers" title="Getting to and from the airport" badge={catBadge("Cars & transfers")} sub={`Pick how you move between ${trip.dest || "the airport"} and your hotel.`}>
              <div className="space-y-2">
                <Row code="car-dest" name={`Private transfer · ${trip.dest || "airport"} → hotel`} sub="Sedan · meet & greet · up to 3 bags" rate={25} unit="per car" cat="Cars & transfers" tag="1-way" />
                <Row code="car-shuttle" name="Shared shuttle" sub="8-seat van · scheduled · 30 min wait max" rate={15} unit="per person" cat="Cars & transfers" tag="per person" />
                <Row code="car-rental" name={`Car rental from ${trip.dest || "airport"}`} sub="Compact, automatic · free 24h cancellation" rate={40} unit="per day" cat="Cars & transfers" tag="per day" />
              </div>
            </Module>

            <Module n="05" icon="shield" kicker="Insurance" title="Protect your trip" badge={`${ins === "none" ? "No plan" : ins === "plus" ? "Plus" : "Standard"} · ${pax} pax`} sub="Choose a plan that covers cancellation, medical, and baggage." right={<div className="text-right"><span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-md" style={{ background: "rgba(255,240,240,1)", color: "rgba(224,10,10,1)" }}>Mandatory</span><div className="text-[10px] text-ink-faint font-semibold mt-1">EU package travel rules</div></div>}>
              <div className="grid sm:grid-cols-3 gap-3">
                <Plan v="none" name="I already have coverage" kicker="My travel insurance is sorted" points={[[true, "Health coverage"], [true, "Trip cancellation protection"], [true, "Baggage loss"], [false, "COVID-19 protection"], [false, "24/7 support service"]]} />
                <Plan v="standard" name="Standard" kicker="Essential cover" price={19} total={19 * pax} points={[[true, "Medical · $25K"], [true, "Trip cancellation"], [true, "Lost baggage"], [false, "COVID-19 cover"], [false, "24/7 concierge"]]} />
                <Plan v="plus" name="Plus" kicker="Comprehensive cover" badge="Recommended" price={38} total={38 * pax} points={[[true, "Medical · $50K"], [true, "Trip cancellation"], [true, "Lost baggage"], [true, "COVID-19 cover"], [true, "24/7 concierge"]]} />
              </div>
              {ins !== "none"
                ? <button onClick={() => { setIns("none"); const cur = trip.extras.find(x => x.code === "ins-plus" || x.code === "ins-std"); if (cur) { toggleExtra(cur); save(); } r(); }} className="mt-3 w-full rounded-full border border-line-strong py-2.5 text-[13px] font-semibold text-ink-muted hover:border-tap-green hover:text-tap-greenDeep inline-flex items-center justify-center gap-1.5">Proceed without insurance</button>
                : <div className="mt-3 text-[12px] text-tap-greenDeep font-semibold inline-flex items-center gap-1.5"><Icon name="check" size={14} /> Proceeding without Xperion insurance — you confirm you're covered elsewhere.</div>}
            </Module>

            <Module n="06" icon="star" kicker="Lounge & priority" title="Relax and skip the queues" badge={catBadge("Lounge & services")} sub="Quality time before the flight — drinks, food, fast-track lanes.">
              <div className="space-y-2">
                <ServiceRow code="lounge-opo" icon="star" name={`Xperion Lounge · ${origCode}`} sub="Hot meals · drinks · showers · Wi-Fi · up to 3h pre-flight" rate={90} tag={`${origCode} outbound`} />
                <ServiceRow code="priority" icon="bolt" name="Priority boarding" sub="Skip the queue · board first · stow your bag first" rate={16} tag="both flights" />
                <ServiceRow code="fasttrack" icon="shield" name={`Fast-track security · ${trip.dest || "arrival"} arrival`} sub={`Dedicated immigration lane on arrival in ${destCity}`} rate={18} tag={`${trip.dest || "arrival"} arrival`} />
              </div>
            </Module>

            <Module n="07" icon="bag" kicker="Meals" title="Meals & onboard extras" badge={catCount("Onboard") ? catBadge("Onboard") : null} sub="Pick a meal for each traveller. We confirm 24h before departure.">
              <div className="grid sm:grid-cols-4 gap-3">
                {[["Standard meal", "Chef-curated 3-course", 0, "meal.svg"], ["Vegetarian", "Plant-based · seasonal", 0, "veg-meal.svg"], ["Premium meal", "Tasting menu", 28, "premium-meal.svg"], ["Skip meal", "No meal · sleep", 0, "skip-meal.svg"]].map(([n, s, p, ic]) => {
                  const on = meal === n;
                  const select = () => {
                    setMeal(n);
                    const e = trip.extras.find(x => x.code === "meal-prem");
                    if (n === "Premium meal") { if (!hasExtra("meal-prem")) { toggleExtra({ code: "meal-prem", name: `Premium meal × ${pax}`, price: 28 * pax, cat: "Onboard" }); save(); } }
                    else if (e) { toggleExtra(e); save(); }
                    r();
                  };
                  return <button key={n} onClick={select} className={cx("text-left rounded-xl p-3 flex flex-col", on ? "border-2" : "border border-line")} style={on ? { background: "rgba(242,255,219,1)", borderColor: "rgba(158,253,56,1)" } : undefined}><div className="flex items-start justify-between gap-2"><span className="w-9 h-9 rounded-lg bg-surface-mute inline-flex items-center justify-center shrink-0"><img src={"/v2/assets/extras/" + ic} alt="" className="w-[26px] h-[26px]" style={{ objectFit: "contain" }} /></span><span className={cx("w-4 h-4 rounded-full border-2 inline-flex items-center justify-center shrink-0", on ? "border-tap-green" : "border-line-strong")}>{on && <span className="w-2 h-2 rounded-full bg-tap-green" />}</span></div><div className="text-[13px] font-bold mt-2">{n}</div><div className="text-[10px] text-ink-faint flex-1 mt-0.5">{s}</div><div className="h-px bg-line my-2" /><div className="text-[11px] font-semibold">{p ? <span className="v2-num">{eur2(p)} <span className="text-[10px] text-ink-faint font-normal">per pax</span></span> : on ? <span className="text-[rgba(10,10,10,1)]">Included</span> : <span className="text-ink-faint font-normal">{n === "Skip meal" ? "No meal" : "Free"}</span>}</div></button>;
                })}
              </div>
            </Module>

            <Module n="08" icon="globe" kicker="Experiences" title={`Experiences in ${destCity}`} badge={catBadge("Experiences")} sub="Curated tours and tastings for your dates. Skip the lines.">
              <div className="grid sm:grid-cols-3 gap-3">
                {destExp(destCity).map(([code, name, sub, price, tag, img]) => {
                  const on = hasExtra(code); const tot = price * (trip.pax || 2);
                  const parts = String(tag).split("·").map(s => s.trim()); const popular = parts.some(p => /popular/i.test(p)); const catLabel = parts.filter(p => !/popular/i.test(p)).join(" · ") || parts[0];
                  return <div key={code} className={cx("rounded-xl overflow-hidden", on ? "border-2" : "border border-line")} style={on ? { background: "rgba(242,255,219,1)", borderColor: "rgba(158,253,56,1)" } : undefined}><Img seed={"exp-" + code} src={img || imageFor(code)} alt={name} className="h-28 w-full object-cover" /><div className="p-3"><div className="flex items-center gap-1.5"><Pill tone="slate">{catLabel}</Pill>{popular && <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-[4px] bg-surface-dark text-lime">Popular</span>}</div><div className="text-[13px] font-bold mt-1">{name}</div><div className="text-[10px] text-ink-faint">{sub}</div><div className="flex items-end justify-between mt-2 gap-2"><div><div className="text-[14px] font-bold v2-num">{eur2(price)}</div><div className="text-[10px] text-ink-faint">per person</div>{on && <div className="text-[10px] text-ink-faint v2-num">× {trip.pax || 2} = {eur2(tot)}</div>}</div><Btn size="sm" variant="outline" className="shrink-0" style={on ? ADDED_CTA : ADD_CTA} onClick={() => add(code, name, price * (trip.pax || 2), "Experiences")}>{on ? "✓ Added" : "+ Add to cart"}</Btn></div></div></div>;
                })}
              </div>
            </Module>
          </div>
          {isBasket
            ? <BasketSummary basket onClear={clear} cta={`Checkout and pay ${EUR(tripTotals().total)}`} onCta={() => go("payment")} secondary="Continue browsing flights" onSecondary={() => go("home")} note="Price locked for 15 min · free 24h cancellation" />
            : <BasketSummary step={2} user={shared?.profile?.user} onClear={clear} onMilesSwitch={() => go("payment")} cta="Review my trip basket →" onCta={() => go("basket")} secondary="Skip review & continue to passenger" onSecondary={() => go("passenger")} />}
        </div>
      </div>
    </div>
  );
}

// Two journeys share the same trip + modules:
//  • Cart   — step 3 of the linear booking flow → continues to passenger details.
//  • Basket — the persistent basket opened from the nav → checks out & pays directly.
export function Cart(props) { return <CartView {...props} mode="cart" />; }
// My Trip Basket — a read-only review of the whole trip (flights anchor + extras grouped by
// section), step 3 of the linear flow and the page the nav cart opens. Continues to passenger.
export function Basket({ shared, go }) {
  const [, force] = useState(0); const r = () => force(x => x + 1);
  const [editItem, setEditItem] = useState(null);   // #22 — { item, link } for the active line-item editor (hook must precede any early return)
  const enhanceRef = useRef(null);   // UI-18 — carousel scroll target for nav controls
  useEffect(() => { if (trip.pnr) resetTrip(); }, []);   // #32 — a confirmed booking must not linger as a stale basket on a direct revisit
  // Route sync — self-correct if a loaded trip has a flight whose route no longer matches the
  // searched route (stale cross-search data), so the header and the flight card always agree.
  useEffect(() => { syncTripRoute(); }, []);
  // My Trip Basket #1 — the basket must show PARKED trips even when there's no trip currently
  // in the linear flow. If the active trip is empty but the basket holds parked trips, promote
  // the most recent one into the active slot so the full basket UI renders it (the rest stay
  // parked and appear as trip cards). Only a genuinely empty basket shows the empty state.
  useEffect(() => {
    if (!trip.outbound && !trip.pnr) {
      const parked = getBasketTrips();
      if (parked.length) { resumeBasketTrip(parked[0].id); r(); }
    }
  }, []); // eslint-disable-line
  if (!trip.outbound) return noTrip(go);
  const t = tripTotals();
  const ob = trip.outbound, ib = trip.inbound;
  const obf = ob?.flight || {}, ibf = ib?.flight || {};
  const xCity = (shared?.airports?.find(a => a.code === trip.dest)?.city) || "your destination";   // F8/F9 — destination-aware cross-sell
  const xCode = trip.dest || "airport";
  // These "not added yet" prompts must reflect what the basket actually holds. The same product
  // can be added from more than one module under a different code - a day-trip from the
  // Experiences rail is xp-<city>-N while the cross-sell rail uses xsell-<city>-tour, and a
  // transfer can arrive as "transfer" or "stopover-transfer". Matching a single SKU meant the
  // prompt kept saying "no day-trip added yet" while the trip was sitting in the basket right
  // above it, so match on intent instead.
  const xSlug = slugCity(xCity);
  const hasDayTrip = (trip.extras || []).some(e => {
    const code = String(e.code || ""), name = String(e.name || "");
    return code === `xsell-${xSlug}-tour`
      || (code.startsWith(`xp-${xSlug}-`) && /day[\s-]?trip|excursion|full[\s-]?day|highlights/i.test(name));
  });
  const hasTransferItem = (trip.extras || []).some(e => {
    const code = String(e.code || ""), name = String(e.name || "");
    return code === "xsell-xfer-return" || code === "transfer" || code === "stopover-transfer" || /transfer/i.test(name);
  });
  const nights = (() => { try { if (trip.date && trip.ret) { const d = Math.round((new Date(trip.ret) - new Date(trip.date)) / 864e5); if (d > 0) return d; } } catch { } return 8; })();
  const itemCount = trip.extras.length + 1;
  const clear = () => { clearBasket(); api.post("/basket/clear", { flight_no: trip.outbound?.flight?.flight_no }).catch(() => {}); r(); };
  const SECTIONS = [
    ["Hotels", "Stay & accommodation", "home"],
    ["Cars & transfers", "Getting around", "swap"],
    ["Lounge & services", "Lounge & priority", "star"],
    ["Onboard", "Meals & onboard", "bag"],
    ["Seats & baggage", "Seats & baggage", "seat"],
    ["Experiences", "Experiences & tours", "globe"],
    ["Insurance", "Travel protection", "shield"],
    ["Carbon offset", "Carbon offset", "leaf"],
    ["Extras", "Other extras", "cart"],
  ];
  const byCat = (c) => trip.extras.filter(e => e.cat === c);
  const cityOf = (c) => shared?.airports?.find(a => a.code === c)?.city || c;
  const persist = () => api.post("/basket", { flight_no: trip.outbound?.flight?.flight_no, items: trip.extras.map(e => e.code), snapshot: tripSnapshot() }).catch(() => {});
  const remove = (e) => { toggleExtra(e); persist(); r(); };
  const setQty = (e, d) => { e.qty = Math.max(1, (e.qty || 1) + d); pingBasket(); persist(); r(); };
  const applyEdit = (item, changes) => { Object.assign(item, changes); pingBasket(); persist(); r(); };   // #22 — mutate the basket line in place
  // Important #5 — multi-trip basket: park the current trip and manage several at once.
  const savedTrips = getBasketTrips();
  // Multi-trip checkout: every trip in the basket is selected by default (checking out the
  // whole basket is the common case); un-tick a trip to leave it parked, or expand it to drop
  // individual line items before paying.
  const [selTrips, setSelTrips] = useState(() => ({}));      // id -> false when un-ticked
  const [openTrip, setOpenTrip] = useState(null);
  const [curOn, setCurOn] = useState(true);                  // the active trip itself
  const isSel = (id) => selTrips[id] !== false;
  const toggleSel = (id) => setSelTrips(m => ({ ...m, [id]: m[id] === false }));
  const chosen = savedTrips.filter(x => isSel(x.id));
  const chosenTotal = (curOn ? t.total : 0) + chosen.reduce((a, x) => a + basketTripTotal(x.snap), 0);
  const chosenCount = (curOn ? 1 : 0) + chosen.length;
  const checkoutChosen = () => {
    if (!chosenCount) return;
    if (curOn) { setQueue(chosen.map(x => x.snap)); chosen.forEach(x => removeBasketTrip(x.id)); }
    else {                                            // active trip left behind → lead with the first picked trip
      const [lead, ...rest] = chosen;
      setQueue(rest.map(x => x.snap));
      rest.forEach(x => removeBasketTrip(x.id));
      resumeBasketTrip(lead.id);
    }
    go("passenger");
  };
  const park = () => { if (saveTripToBasket()) { resetTrip(); go("home"); } };
  const resumeSaved = (id) => { resumeBasketTrip(id); r(); };
  const removeSaved = (id) => { removeBasketTrip(id); r(); };
  const basketAllTotal = t.total + savedTrips.reduce((s, x) => s + basketTripTotal(x.snap), 0);
  const dateRange = `${fmtDate(trip.date).replace(/ \d{4}/, "")} – ${fmtDate(trip.ret).replace(/ \d{4}/, "")}`;
  const dateOne = fmtDate(trip.date).replace(/ \d{4}/, "");
  // per-category card detail (sub, chips, action links, per-unit price, quantity-editable) — Tab 6 #3/#5
  const cardMeta = (e, cat) => {
    const px = trip.pax || 1, plural = px > 1 ? "s" : "";
    switch (cat) {
      case "Hotels": { const nn = e.nights || nights, rt = e.rate || (nn > 0 ? Math.round(e.price / nn) : e.price);
        return { sub: `Deluxe room · ${px} adult${plural} · Breakfast included · Free cancellation`, chips: [dateRange, `${nn} nights`, "★ 9.2 Excellent"], links: ["Change room", "View hotel"], perUnit: `${eur2(rt)} × ${nn} nights`, qty: false }; }
      case "Cars & transfers":
        return { sub: "Private sedan · Meet & greet · Up to 3 bags · English-speaking driver", chips: [`${dateOne} · ${e.time || "14:15"}`, "One-way", `${px} pax`], links: ["Change vehicle"], perUnit: `${eur2(e.price)} per car`, qty: true };
      case "Insurance":
        return { sub: "Medical up to $50K · Baggage protection · Trip cancellation · 24/7 assistance", chips: [dateRange, `${px} traveler${plural}`, "Recommended"], links: ["Change plan", "Compare plans"], perUnit: `${eur2(Math.round(e.price / px))} × ${px} traveler${plural}`, qty: true };
      case "Lounge & services":
        return { sub: "Pre-flight access · Hot meals · Showers · Wi-Fi · 3-hour stay", chips: [dateOne, `${px} adult${plural}`], links: ["Change lounge"], perUnit: `${eur2(Math.round(e.price / px))} × ${px} traveler${plural}`, qty: true };
      case "Experiences":
        return { sub: "Small group · English guide · Local tastings included", chips: [`${e.date ? fmtDate(e.date).replace(/ \d{4}/, "") : dateOne} · 10:00`, `${px} traveler${plural}`], links: ["Change date"], perUnit: `${eur2(Math.round(e.price / px))} × ${px} traveler${plural}`, qty: true };
      default:
        return { sub: CAT_SUB(px, nights)[cat] || cat, chips: [], links: ["Edit"], perUnit: "", qty: false };
    }
  };

  // Itinerary-style journey timeline (replaces the boxed data row): flight meta above, large
  // departure/arrival times with their cities at each end, and a route line between them carrying
  // the duration and stop count.
  // Fare inclusions shown in the card footer, derived from the booked fare brand rather than
  // hard-coded, so a Classic basket never advertises a checked bag it does not have.
  const fareInclusions = (() => {
    const fare = ob?.fare || "Classic";
    const bags = /exec|business/i.test(fare) ? 2 : /plus|premium|flex/i.test(fare) ? 1 : 0;
    return [
      "1× carry-on (8kg)",
      bags ? bags + "× checked bag (23kg)" : "Checked bag not included",
      "Seat selection",
      /flex|exec/i.test(fare) ? "Free changes" : "Changes for fee",
    ];
  })();
  const Leg = ({ label, f, date }) => (
    <div className="py-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-ink">{label} · {fmtDate(date)}</div>
        <div className="text-[11px] text-ink-faint v2-num">{f.flight_no}{f.aircraft ? " \u00b7 " + f.aircraft : ""}</div>
      </div>
      <div className="flex items-center gap-3 sm:gap-5">
        <div className="shrink-0">
          <div className="text-[24px] font-bold v2-num leading-none">{f.dep || "\u2014"}</div>
          <div className="text-[11px] text-ink-muted mt-1 whitespace-nowrap">{f.origin}{cityOf(f.origin) && cityOf(f.origin) !== f.origin ? " · " + cityOf(f.origin) : ""}</div>
        </div>
        <div className="flex-1 min-w-[70px]">
          <div className="text-[11px] text-ink-faint text-center mb-1">{f.duration || ""}</div>
          <div className="flex items-center">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#0A0A0A" }} />
            <span className="flex-1 h-px" style={{ background: "#E0E3E8" }} />
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-surface" style={{ border: "1px solid #0A0A0A" }} />
          </div>
          <div className="text-[11px] text-ink-faint text-center mt-1 whitespace-nowrap">Nonstop · Direct</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[24px] font-bold v2-num leading-none">{f.arr || "\u2014"}</div>
          <div className="text-[11px] text-ink-muted mt-1 whitespace-nowrap">{f.dest}{cityOf(f.dest) && cityOf(f.dest) !== f.dest ? " · " + cityOf(f.dest) : ""}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="bg-[rgba(255,255,255,1)] min-h-screen">
      {editItem && <ItemEditModal item={editItem.item} link={editItem.link} onClose={() => setEditItem(null)} onApply={applyEdit} />}
      <Stepper active={2} />
      <div className="mx-auto max-w-content px-6 py-6">
        <div className="flex items-center gap-3"><h1 className="text-[36px] font-bold">My Trip Basket</h1><span className="inline-flex items-center font-semibold" style={{ borderRadius: "9999px", padding: "6px 12px", fontSize: "13px", background: "#F2F2EE", color: "#1A1F29" }}>{itemCount} items</span></div>
        <p className="text-[16px] leading-6 mt-1" style={{ color: "#6B6B6B" }}>{savedTrips.length > 0 ? `${savedTrips.length + 1} trips bundled${savedTrips.length >= 2 ? " · you save " + eur2(15 * savedTrips.length) + " with the multi-trip discount" : ""} · review and customize before checkout.` : "Review and customize everything in your basket before continuing."}</p>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          <Chip dot>{trip.dest ? `${cityOf(trip.dest)} trip` : "Your trip"}</Chip>
          <Chip>{cityOf(trip.origin)}–{cityOf(trip.dest)}</Chip>
          <Chip>{trip.pax} adult{trip.pax > 1 ? "s" : ""}</Chip>
          <Chip>{dateRange}</Chip>
          <button onClick={park} title="Save this trip to your basket and start a new search" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-tap-greenDeep rounded-full border px-3 py-1 hover:bg-lime-tint transition-colors" style={{ borderColor: "rgba(70,164,26,0.4)", background: "rgba(242,255,219,0.5)" }}><span className="text-[14px] leading-none">＋</span> Park trip &amp; start another</button>
        </div>

        {savedTrips.length > 0 && (
          <div className="mt-5 rounded-2xl border border-line p-4" style={{ background: "rgba(250,250,247,1)" }}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <div className="flex items-center gap-2"><Icon name="cart" size={15} className="text-tap-greenDeep" /><h2 className="text-[15px] font-bold">Trips in your basket</h2><span className="text-[11px] font-semibold text-ink-faint">{savedTrips.length + 1} trips · resume any to edit</span></div>
              <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-ink-faint">Basket total · all trips{savedTrips.length >= 2 ? " · saves " + eur2(15 * savedTrips.length) : ""}</div><div className="text-[16px] font-bold v2-num">{eur2(basketAllTotal - (savedTrips.length >= 2 ? 15 * savedTrips.length : 0))}</div></div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {savedTrips.map(x => {
                const s = x.snap, of = s.outbound?.flight || {}, nX = (s.extras || []).length;
                return (
                  <div key={x.id} className={cx("rounded-xl border bg-white p-3", isSel(x.id) ? "border-tap-green" : "border-line")}>
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={isSel(x.id)} onChange={() => toggleSel(x.id)} aria-label={`Include this trip in checkout`} className="w-4 h-4 accent-[#46A41A] shrink-0 cursor-pointer" />
                    <span className="w-9 h-9 rounded-lg bg-lime-tint inline-flex items-center justify-center text-tap-greenDeep shrink-0"><Icon name="plane" size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-bold truncate">{cityOf(s.origin)} → {cityOf(s.dest)} <span className="text-[10px] font-semibold text-tap-greenDeep uppercase">{s.outbound?.fare || "Classic"}</span></div>
                      <div className="text-[11px] text-ink-faint truncate">{of.flight_no || "Flight"} · {s.date ? fmtDate(s.date).replace(/ \d{4}/, "") : ""} · {s.pax || 1} pax · {nX} extra{nX !== 1 ? "s" : ""}</div>
                    </div>
                    <div className="text-[13px] font-bold v2-num shrink-0">{eur2(basketTripTotal(s))}</div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button onClick={() => resumeSaved(x.id)} className="text-[11px] font-semibold text-white bg-tap-green rounded-full px-3 py-1 hover:opacity-90 transition-opacity">Resume</button>
                      <button onClick={() => removeSaved(x.id)} className="text-[11px] font-semibold text-ink-muted hover:text-tap-red transition-colors">Remove</button>
                    </div>
                  </div>
                  {/* line-item level: drop individual extras from a parked trip before paying */}
                  {savedAllExtras(s).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-line">
                      <button onClick={() => setOpenTrip(o => o === x.id ? null : x.id)} className="text-[11px] font-semibold text-tap-greenDeep hover:underline">
                        {openTrip === x.id ? "Hide items" : `${nX} item${nX === 1 ? "" : "s"} · edit`}
                      </button>
                      {openTrip === x.id && (
                        <div className="mt-2 space-y-1">
                          {savedAllExtras(s).map(e => {
                            const on = savedExtraOn(s, e.code);
                            return (
                              <label key={e.code} className="flex items-center gap-2 text-[11px] cursor-pointer">
                                <input type="checkbox" checked={on} onChange={() => { toggleSavedExtra(x.id, e.code); r(); }} className="w-3.5 h-3.5 accent-[#46A41A] shrink-0" />
                                <span className={cx("flex-1 truncate", on ? "text-ink" : "text-ink-faint line-through")}>{e.name}</span>
                                <span className={cx("v2-num shrink-0", on ? "font-semibold" : "text-ink-faint")}>{eur2(e.price || 0)}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
            {/* The whole basket checks out in ONE payment; each itinerary is still issued as its
                own PNR, which is how an airline order actually works. */}
            <div className="mt-3 rounded-xl border border-line bg-white p-3 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[12px] font-semibold cursor-pointer">
                <input type="checkbox" checked={curOn} onChange={() => setCurOn(v => !v)} className="w-4 h-4 accent-[#46A41A]" />
                <span>This trip ({cityOf(trip.origin)} → {cityOf(trip.dest)}) · <span className="v2-num">{eur2(t.total)}</span></span>
              </label>
              <div className="flex-1" />
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-ink-faint">Selected · {chosenCount} trip{chosenCount === 1 ? "" : "s"}</div>
                <div className="text-[16px] font-bold v2-num">{eur2(chosenTotal)}</div>
              </div>
              <Btn onClick={checkoutChosen} disabled={!chosenCount}>Check out {chosenCount} trip{chosenCount === 1 ? "" : "s"} <Icon name="arrow" size={14} /></Btn>
            </div>
            <p className="text-[11px] text-ink-faint mt-2">One payment covers everything selected · each itinerary is issued as its own PNR. Un-tick a trip to leave it parked, or expand it to drop individual items.</p>
          </div>
        )}

        {/* two-column: scrollable content + right-side sticky basket panel (Tab 6 #6) */}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_376px] gap-8 mt-6 items-start">
          <div className="space-y-6 min-w-0">
            {/* flights anchor — tinted header (#1) + zebra benefits row (#2) */}
            <div>
              <div className="flex items-center gap-2 mb-2"><h2 className="text-[18px] font-semibold">Your flights</h2></div>
              <Card className="overflow-hidden" style={{ borderRadius: "18px" }}>
                <div className="flex items-center justify-between flex-wrap gap-3 px-5 border-b border-line" style={{ background: "#FAFAF7", paddingTop: "12px", paddingBottom: "12px" }}>
                  <div className="flex items-center gap-3 flex-wrap min-w-0">
                    <img src="/v2/assets/homepage/tap-logo.png" alt="Xperion Airways" className="shrink-0 object-contain" style={{ height: "18px", width: "auto" }} />
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted"><Icon name="lock" size={11} />{ob?.fare || "Classic"} · {trip.cabin || "Economy"}</span>
                    {trip.stopover?.viaHub && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-tap-greenDeep"><Icon name="clock" size={11} />Stopover included</span>}
                  </div>
                  <button onClick={() => go("results", { origin: trip.origin, dest: trip.dest, date: trip.date, ret: trip.ret, type: trip.type, pax: trip.pax, cabin: trip.cabin })} className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold text-ink-muted hover:text-tap-greenDeep"><Icon name="search" size={12} />Change flight</button>
                </div>
                <div className="px-5 pt-1 pb-2">
                  {trip.stopover?.viaHub ? (() => {
                    const sh = (hm, m) => { const [h, mm] = String(hm || "00:00").split(":").map(Number); const t = ((h * 60 + mm + m) % 1440 + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
                    return (<>
                      <Leg label="Outbound · Segment 1" f={{ ...obf, dest: "JFK", arr: sh(obf.arr, -125), duration: "7h 15m" }} date={trip.date} />
                      <div className="flex items-center gap-2 px-1 py-2 my-1 text-[12px] font-semibold text-tap-greenDeep" style={{ borderTop: "1px dashed #DCDCD8", borderBottom: "1px dashed #DCDCD8" }}><Icon name="clock" size={13} /> Stopover · {trip.stopover.nights} night{trip.stopover.nights > 1 ? "s" : ""} in New York</div>
                      <Leg label="Outbound · Segment 2" f={{ ...obf, origin: "JFK", dep: sh(obf.arr, -70), duration: "1h 05m" }} date={trip.date} />
                    </>);
                  })() : <Leg label={trip.type === "multi" ? "Flight 1" : "Outbound"} f={obf} date={trip.date} />}
                  {ib && <><Divider className="my-1" /><Leg label={trip.type === "multi" ? "Flight 2" : "Inbound"} f={ibf} date={trip.ret} /></>}
                </div>
                {/* footer: fare inclusions (left) + flights subtotal and quick actions (right) */}
                <div className="border-t border-line flex items-start justify-between flex-wrap gap-3" style={{ background: "#FAFAF7", padding: "14px 20px" }}>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-semibold text-ink-muted min-w-0">
                    {fareInclusions.map(t => <span key={t} className="inline-flex items-center gap-1 whitespace-nowrap"><span className="text-tap-greenDeep">✓</span>{t}</span>)}
                  </div>
                  <div className="text-right shrink-0">
                    <span className="block text-[10px] uppercase tracking-wide text-ink-faint">Flights subtotal</span>
                    <span className="block text-[22px] font-bold v2-num leading-none mt-0.5" style={{ color: "#0A0A0A" }}>{eur2((ob?.price || 0) + (ib?.price || 0))}</span>
                    <span className="block text-[11px] text-ink-faint v2-num mt-1">{eur2(((ob?.price || 0) + (ib?.price || 0)) / Math.max(1, trip.pax || 1))} per traveller</span>
                    <span className="flex justify-end gap-3 mt-2 text-[12px] font-semibold text-tap-greenDeep">
                      <button onClick={() => go("cart")} className="hover:underline">Seat selection</button>
                      <button onClick={() => go("cart")} className="hover:underline">Add baggage</button>
                    </span>
                  </div>
                </div>
              </Card>
            </div>

            {/* extras grouped by section — detailed cards w/ links, qty, Remove (#3,#5) */}
            {SECTIONS.map(([cat, title, icon]) => {
              const items = byCat(cat);
              if (!items.length) return null;
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-2"><h2 className="text-[18px] font-semibold">{title}</h2></div>
                  <div className="space-y-3">
                    {items.map(e => {
                      const meta = cardMeta(e, cat);
                      return (
                        <Card key={e.code} className="p-4">
                          <div className="flex items-start gap-3">
                            {cat === "Hotels"
                              ? <Img seed={e.code} src={imageFor(e.code)} alt={e.name} className="w-14 h-14 rounded-lg shrink-0 object-cover" />
                              : <span className="w-11 h-11 rounded-lg bg-lime-tint inline-flex items-center justify-center shrink-0"><Icon name={icon} size={18} className="text-tap-greenDeep" /></span>}
                            <div className="flex-1 min-w-0">
                              <div className="text-[14px] font-bold">{e.name}</div>
                              <div className="text-[11px] text-ink-faint mt-0.5">{meta.sub}</div>
                              {meta.chips.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{meta.chips.map((c, i) => <span key={i} className="text-[10px] font-medium text-ink-muted bg-surface-mute rounded px-2 py-0.5">{c}</span>)}</div>}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-[16px] font-bold v2-num">{eurC(e.price * (e.qty || 1))}</div>
                              {meta.perUnit && <div className="text-[10px] text-ink-faint v2-num">{meta.perUnit}</div>}
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-3 flex-wrap mt-3 pt-3 border-t border-line">
                            <div className="flex gap-4 text-[12px] font-semibold text-tap-greenDeep">{meta.links.map(l => <button key={l} className="hover:underline" onClick={() => setEditItem({ item: e, link: l })}>{l}</button>)}</div>
                            <div className="flex items-center gap-2.5">
                              {meta.qty && <div className="inline-flex items-center rounded-full border border-line"><button onClick={() => setQty(e, -1)} className="w-7 h-7 inline-flex items-center justify-center text-ink-muted hover:text-ink text-[15px] leading-none">−</button><span className="w-7 text-center text-[13px] font-semibold v2-num">{e.qty || 1}</span><button onClick={() => setQty(e, 1)} className="w-7 h-7 inline-flex items-center justify-center text-ink-muted hover:text-ink text-[15px] leading-none">+</button></div>}
                              <button onClick={() => remove(e)} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink-muted hover:text-tap-red hover:border-tap-red"><Icon name="x" size={12} /> Remove</button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* UI-09 — empty-state prompts for high-value extras not yet in the cart */}
            {(!hasTransferItem || !hasDayTrip) && (
              <div className="grid sm:grid-cols-2 gap-4">
                {!hasTransferItem && (
                  <div className="flex items-center justify-between gap-3 p-4" style={{ borderRadius: "18px", border: "1.5px dashed #DCDCD8" }}>
                    <div className="flex items-center gap-2.5 min-w-0"><span className="w-9 h-9 rounded-lg bg-surface-mute inline-flex items-center justify-center shrink-0"><Icon name="swap" size={15} className="text-ink-faint" /></span><div className="min-w-0"><div className="text-[13px] font-bold">No return transfer added yet</div><div className="text-[11px] text-ink-faint">Private door-to-airport ride from $25</div></div></div>
                    <span className="text-[12px] font-semibold text-tap-greenDeep shrink-0">Add →</span>
                  </div>
                )}
                {!hasDayTrip && (
                  <div className="flex items-center justify-between gap-3 p-4" style={{ borderRadius: "18px", border: "1.5px dashed #DCDCD8" }}>
                    <div className="flex items-center gap-2.5 min-w-0"><span className="w-9 h-9 rounded-lg bg-surface-mute inline-flex items-center justify-center shrink-0"><Icon name="globe" size={15} className="text-ink-faint" /></span><div className="min-w-0"><div className="text-[13px] font-bold">No {xCity} day-trip added yet</div><div className="text-[11px] text-ink-faint">Guided highlights tour from $89</div></div></div>
                    <span className="text-[12px] font-semibold text-tap-greenDeep shrink-0">Add →</span>
                  </div>
                )}
              </div>
            )}
            {/* Enhance your trip — curated cross-sell, image-on-top vertical cards: image → badges → title → desc → price/CTA (#4) */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2"><h2 className="text-[15px] font-bold">Enhance your trip</h2><span className="text-[10px] font-bold uppercase tracking-wide text-tap-greenDeep bg-lime-tint rounded-full px-2 py-0.5">Cross-sell</span></div>
                <div className="hidden sm:flex items-center gap-2">
                  <button onClick={() => enhanceRef.current?.scrollBy({ left: -336, behavior: "smooth" })} className="w-10 h-10 rounded-full border border-line-strong bg-surface inline-flex items-center justify-center hover:border-tap-green" aria-label="Previous"><Icon name="arrow" size={16} className="rotate-180" /></button>
                  <button onClick={() => enhanceRef.current?.scrollBy({ left: 336, behavior: "smooth" })} className="w-10 h-10 rounded-full border border-line-strong bg-surface inline-flex items-center justify-center hover:border-tap-green" aria-label="Next"><Icon name="arrow" size={16} /></button>
                </div>
              </div>
              <p className="text-[12px] text-ink-muted mb-3">Hand-picked extras that pair well with your trip. Each adds to your cart instantly.</p>
              <div ref={enhanceRef} className="flex gap-4 overflow-x-auto v2-track pb-1 -mx-1 px-1">
                {[
                  [`xsell-${slugCity(xCity)}-tour`, `${xCity} highlights full-day`, `Top sights · skip-the-line · guided.`, 89, "per person", "Day trip", "Experiences", PIMG + "sintra.jpg", null],
                  [`xsell-${slugCity(xCity)}-food`, `${xCity} food & flavours tour`, `Local tastings & market visit. Half day.`, 65, "per person", "Food", "Experiences", PIMG + "wine-tour.jpg", null],
                  ["xsell-xfer-return", `Return transfer hotel → ${xCode}`, "Private sedan · save 10% when paired.", 25, "per car", "Transfer", "Cars & transfers", PIMG + "return-transfer.jpg", "Bundle −10%"],
                  ["xsell-late-checkout", "Guaranteed late checkout", "Stay until 16:00 on departure day.", 40, "one-time", "Hotel add-on", "Extras", PIMG + "late-checkout.jpg", null],
                ].map(([code, name, sub, base, unit, badge, cat, imgkey, accent]) => {
                  const on = hasExtra(code);
                  const px = trip.pax || 1;
                  const addX = () => { toggleExtra({ code, name, price: unit === "per person" ? base * px : base, cat }); persist(); r(); };
                  return (
                    <div key={code} className={cx("overflow-hidden flex flex-col transition-colors shrink-0", on ? "border-tap-green bg-lime-tint/40 ring-1 ring-tap-green" : "border-line hover:border-tap-green/50")} style={{ width: "312px", height: "340px", borderRadius: "18px", borderWidth: "1px", borderStyle: "solid" }}>
                      <div className="relative h-[148px] w-full overflow-hidden bg-surface-mute shrink-0">
                        <Img seed={code} src={imgkey} alt={name} className="w-full h-full object-cover" />
                        <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-ink bg-white/90 backdrop-blur-sm rounded px-2 py-0.5 shadow-sm">{badge}</span>
                          {accent && <span className="text-[10px] font-bold uppercase tracking-wide text-white bg-tap-green rounded px-2 py-0.5 shadow-sm">{accent}</span>}
                        </div>
                      </div>
                      <div className="flex flex-col flex-1 p-4">
                        <div className="text-[14px] font-bold leading-tight">{name}</div>
                        <div className="text-[11px] text-ink-faint mt-1 flex-1">{sub}</div>
                        <div className="flex items-end justify-between gap-2 mt-3">
                          <div className="leading-tight"><span className="text-[15px] font-bold v2-num">{eurC(base)}</span> <span className="text-[10px] text-ink-faint">{unit}</span></div>
                          <Btn size="sm" variant="outline" className="shrink-0" style={on ? ADDED_CTA : BLACK_CTA} onClick={addX}>{on ? "✓ Added" : "+ Add to cart"}</Btn>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* UI-19 — secondary "also popular" mini-card rail */}
              <div className="mt-4">
                <div className="text-[12px] font-bold text-ink mb-2">Also popular for {xCity} trips</div>
                <div className="flex gap-3 overflow-x-auto v2-track pb-1 -mx-1 px-1">
                  {[["eSIM data · 5GB", "Stay connected on arrival", 12], ["Airport fast-track", "Skip security queues", 18], ["Extra 23kg bag", "More room for souvenirs", 38]].map(([ti, de, pr]) => (
                    <div key={ti} className="shrink-0 flex items-center gap-3 rounded-[12px] border border-line px-3" style={{ width: "318px", height: "72px" }}>
                      <span className="w-9 h-9 rounded-lg bg-surface-mute inline-flex items-center justify-center shrink-0"><Icon name="spark" size={15} className="text-tap-greenDeep" /></span>
                      <div className="min-w-0 flex-1"><div className="text-[12px] font-bold truncate">{ti}</div><div className="text-[10px] text-ink-faint truncate">{de}</div></div>
                      <div className="text-[13px] font-bold v2-num shrink-0">{eurC(pr)}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-4 rounded-xl bg-lime-tint/60 text-tap-greenDark text-[12px] font-semibold px-4 py-2.5 inline-flex items-center gap-2"><Icon name="clock" size={13} /> Price locked for 15 min</div>
            </div>
          </div>

          {/* RIGHT — sticky basket summary (#6) */}
          <div className="lg:sticky lg:top-6 space-y-4">
            <Card style={{ padding: "24px", borderRadius: "18px" }}>
              <div className="flex items-start justify-between">
                <div><h2 className="text-[16px] font-bold">My trip basket</h2><div className="text-[11px] text-ink-muted">All amounts in {getCurrency().label}</div></div>
                <span className="text-[10px] font-bold uppercase tracking-wide bg-tap-red text-white rounded px-2 py-1">Step 3/5</span>
              </div>
              <div className="rounded-lg bg-surface-soft px-3 py-2 mt-3">
                <div className="text-[12px] font-semibold">{cityOf(trip.origin)}–{cityOf(trip.dest)} · {trip.pax} adult{trip.pax > 1 ? "s" : ""} · {dateRange}</div>
                <div className="text-[11px] text-ink-faint mt-0.5">{itemCount} items in your trip cart</div>
              </div>
              <div className="space-y-1.5 text-[13px] mt-3">
                <div className="flex items-center justify-between"><span className="text-ink-muted inline-flex items-center gap-1.5">Flights <span className="text-[9px] font-bold uppercase tracking-wide bg-surface-mute text-ink-faint rounded px-1.5 py-0.5">{trip.pax} pax</span></span><span className="font-semibold v2-num">{eur2(t.flights)}</span></div>
                {Object.entries(extrasByCategory()).map(([c, v]) => (
                  <div key={c} className="flex items-center justify-between"><span className="text-ink-muted inline-flex items-center gap-1.5">{c}{c === "Hotels" && <span className="text-[9px] font-bold uppercase tracking-wide bg-surface-mute text-ink-faint rounded px-1.5 py-0.5">{nights} nights</span>}</span><span className="font-semibold v2-num">{eur2(v)}</span></div>
                ))}
                <div className="flex items-center justify-between"><span className="text-ink-muted">Taxes & fees</span><span className="font-semibold v2-num">{eur2(t.taxes)}</span></div>
                {t.bundle > 0 && <div className="flex items-center justify-between"><span className="text-tap-greenDeep font-semibold inline-flex items-center gap-1"><Icon name="spark" size={12} /> Bundle savings</span><span className="font-semibold v2-num text-tap-greenDeep">−{eur2(t.bundle)}</span></div>}
              </div>
              <Divider className="my-3" />
              <div className="flex items-end justify-between">
                <div><div className="text-[14px] font-bold">Total <span className="text-ink-muted font-medium">(in {getCurrency().label})</span></div><div className="text-[11px] text-ink-muted">No charge yet</div></div>
                <div className="text-right"><div className="text-[28px] font-bold v2-num" style={{ letterSpacing: "-0.03em" }}>{eurC(t.total)}</div><div className="text-[10px] text-ink-faint v2-num">{BRL(t.total)}</div></div>
              </div>
              <div className="mt-3 rounded-lg bg-lime-tint text-tap-greenDark text-[12px] font-semibold px-3 py-2 flex items-center justify-between"><span className="flex items-center gap-1.5"><Icon name="plane" size={12} /> You'll earn</span><span className="v2-num">{miles(EARN(t.total))} miles</span></div>
              <div className="text-[11px] text-ink-faint mt-3 flex items-center gap-1.5"><Icon name="lock" size={12} /> Secure checkout · Payments by Stripe · Encrypted card data</div>
              <Btn size="lg" className="w-full mt-3" style={{ height: "56px", borderRadius: "9999px", fontSize: "15px" }} onClick={() => go("passenger")}>Continue to passenger details →</Btn>
              <div className="text-[11px] text-ink-faint text-center mt-2">We won't charge you anything yet · <SessionTimer prefix="price locked" /></div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => go("cart")} className="flex-1 rounded-full border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink hover:border-tap-green inline-flex items-center justify-center gap-1.5">Continue browsing flights →</button>
                {trip.extras.length > 0 && <button onClick={clear} title="Clear all extras" className="rounded-full border border-line-strong px-3 py-2.5 text-[13px] font-semibold text-ink-muted hover:text-tap-red hover:border-tap-red inline-flex items-center justify-center"><Icon name="x" size={13} /></button>}
              </div>
            </Card>
            <Card className="p-4 text-[12px] space-y-2.5" style={{ borderRadius: "14px" }}>
              {[["lock", "Price lock", "Total held for 15 min while you decide."], ["shield", "Free cancellation", "24h free cancellation on flights & most extras."], ["heart", "24/7 support", "Chat with Xperion Care anytime."]].map(([ic, ti, de]) => <div key={ti} className="flex items-start gap-2.5"><span className="text-tap-green mt-0.5"><Icon name={ic} size={15} /></span><div><div className="font-semibold" style={{ color: "#0A0A0A" }}>{ti}</div><div style={{ color: "#667080" }}>{de}</div></div></div>)}
            </Card>
            <div className="rounded-2xl p-4 text-white flex items-center justify-between gap-3" style={{ background: "#0A0A0A" }}>
              <div><div className="text-[13px] font-bold">Need a hand?</div><div className="text-[11px] text-white/60">Our team replies in ~2 min.</div></div>
              <button className="shrink-0 inline-flex items-center gap-1.5 font-bold text-[12px] rounded-full px-3.5 py-2" style={{ background: "#D4F25E", color: "#0A0A0A" }}><Icon name="send" size={13} /> Chat</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ PASSENGER DETAILS ═══════════ */
const FLAG_CTRY = { Portugal: "🇵🇹", Brazil: "🇧🇷", Spain: "🇪🇸", France: "🇫🇷", Germany: "🇩🇪", "United Kingdom": "🇬🇧", Italy: "🇮🇹", "United States": "🇺🇸" };
const FLAG_NAT = { Portuguese: "🇵🇹", Brazilian: "🇧🇷", Spanish: "🇪🇸", French: "🇫🇷", German: "🇩🇪", British: "🇬🇧", Italian: "🇮🇹", American: "🇺🇸" };
const PHONE_CODES = [["+1", "🇺🇸"], ["+55", "🇧🇷"], ["+34", "🇪🇸"], ["+33", "🇫🇷"], ["+49", "🇩🇪"], ["+44", "🇬🇧"]];
function FlagSelect({ value, onChange, options, err }) {
  return <div className={cx("relative w-full bg-surface border rounded-[10px]", err ? "border-tap-red" : "border-line")}>
    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[15px] pointer-events-none">{options[value] || "🌐"}</span>
    <select value={value || ""} onChange={e => onChange(e.target.value)} className="w-full bg-transparent pl-9 pr-7 py-3 min-h-[48px] text-[15px] font-medium text-ink outline-none appearance-none cursor-pointer">
      <option value="" disabled>Select…</option>{Object.keys(options).map(o => <option key={o} value={o}>{o}</option>)}
    </select>
    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none text-[11px]">▾</span>
  </div>;
}
// Input with valid (green check) / error (red border) feedback
const VInput = ({ value, onChange, placeholder, err }) => (
  <div className="relative">
    <input value={value || ""} onChange={onChange} placeholder={placeholder} className={cx("w-full bg-surface border rounded-[10px] px-3 py-3 pr-8 text-[14px] text-ink placeholder:text-ink-faint outline-none focus:border-tap-green", err ? "border-tap-red" : "border-line")} />
    {err ? <Icon name="x" size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-tap-red" /> : null}
  </div>
);
// Native date picker with the same valid/error treatment (#8)
const DateInput = ({ value, onChange, err, max, min }) => (
  <input type="date" value={value || ""} max={max} min={min} onChange={onChange} className={cx("w-full bg-surface border rounded-[10px] px-3 py-3 text-[14px] text-ink outline-none focus:border-tap-green cursor-pointer", err ? "border-tap-red" : "border-line")} />
);
// Generic dropdown with a visible ▾ affordance so selectable fields don't read as static
// inputs (#7, #8). Mirrors FlagSelect styling minus the flag glyph.
const Select = ({ value, onChange, options, placeholder = "Select…", err }) => (
  <div className={cx("relative w-full bg-surface border rounded-[10px]", err ? "border-tap-red" : "border-line")}>
    <select value={value || ""} onChange={onChange} className="w-full bg-transparent pl-3 pr-8 py-3 text-[14px] text-ink outline-none appearance-none cursor-pointer">
      <option value="" disabled>{placeholder}</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none text-[11px]">▾</span>
  </div>
);
const TITLES = ["Mr", "Ms", "Mrs", "Mx", "Dr"];
const GENDERS = ["Female", "Male", "Non-binary", "Prefer not to say"];
const DOCTYPES = ["Passport", "National ID card", "Residence permit", "Driving licence"];
const LANGS = ["Português (PT)", "Português (BR)", "English", "Español", "Français", "Deutsch", "Italiano"];

// Passenger-page section heading — bold dark title + muted descriptor + lime accent (#4),
// giving the IDENTITY / TRAVEL DOCUMENT / LOYALTY sections real typographic hierarchy.
const PaxSectionTitle = ({ title, sub, info, className }) => (
  <div className={cx("mb-3", className)}>
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[16px] font-semibold leading-none" style={{ color: "#1F1F1F" }}>{title}</span>
      {info && <Icon name="info" size={12} className="text-ink-faint" />}
    </div>
    {sub && <div className="text-[13px] leading-snug mt-1" style={{ color: "#8A8F98" }}>{sub}</div>}
  </div>
);

// Mix-method payment row. Defined at module scope (NOT inside Payment's render) so the
// slider input it wraps keeps a stable identity across re-renders — re-creating this
// component on every keystroke remounted the <input type=range> and broke drag (#11).
const MixComp = ({ on, title, sub, right, onToggle, onEdit, children }) => (
  <div className={cx("rounded-xl border", on ? "border-tap-green bg-lime-tint/40" : "border-line")} style={{ padding: "16px" }}>
    <div className="flex items-center gap-3"><button onClick={onToggle} className={cx("w-6 h-6 rounded-full inline-flex items-center justify-center text-white text-[11px] shrink-0", on ? "bg-tap-green" : "bg-surface-mute text-ink-faint")}>{on ? "✓" : ""}</button><div className="flex-1 min-w-0"><div className="text-[15px] font-bold truncate">{title}</div><div className="text-[11px] text-ink-faint">{sub}</div></div>{right && <span className="inline-flex items-center shrink-0" style={{ border: "1px solid #E0E3E8", background: "#fff", borderRadius: "8px", padding: "8px 12px" }}>{right}</span>}<button onClick={onEdit || onToggle} className="text-[12px] font-bold shrink-0 hover:underline" style={{ color: "#E00A0A", marginLeft: "16px" }}>Edit</button></div>
    {children}
  </div>
);

// #19 — Split-payment cart variant: participant-wise allocation, Paid/Pending status, a
// progress bar, outstanding balance and a contextual "Pay my share" CTA (vs the standard summary).
function SplitSummary({ payers, amtFor, total, allocated, leadAmt, paid, onPayShare, onMarkPaid, disabled, busy, onCta, onBack }) {
  const t = tripTotals();
  const paidCount = paid.size;
  const pct = payers.length ? Math.round((paidCount / payers.length) * 100) : 0;
  const settled = payers.reduce((s, _, i) => s + (paid.has(i) ? (amtFor(i) || 0) : 0), 0);
  const outstanding = +(total - settled).toFixed(2);
  const mismatch = Math.abs(allocated - total) > 0.01;
  const leadPaid = paid.has(0);
  const allPaid = paidCount >= payers.length;
  const pending = payers.length - paidCount;
  // #63/#64 — product breakdown by category (Flights + booked extras + fees)
  const catTotals = {};
  trip.extras.forEach(e => { catTotals[e.cat] = (catTotals[e.cat] || 0) + (e.price || 0) * (e.qty || 1); });
  const breakdown = [["Flights", t.flights], ...CAT_ORDER.filter(c => catTotals[c]).map(c => [c, catTotals[c]]), ...(t.bundle > 0 ? [["Bundle savings", -t.bundle]] : []), ["Taxes & fees", t.taxes]];
  return (
    <aside>
      <Card className="p-5 lg:sticky lg:top-20">
        <div className="flex items-start justify-between">
          <div><div className="font-bold text-[16px]">Split payment</div><div className="text-[11px] text-ink-muted">{payers.length} traveller{payers.length !== 1 ? "s" : ""} · in {getCurrency().label}</div></div>
          <span className="text-[10px] font-bold uppercase tracking-wide bg-[#3b6fd6] text-white rounded px-2 py-1">Step 4/5</span>
        </div>
        {/* #63/#64/#65 — product breakdown */}
        <div className="space-y-2" style={{ marginTop: "18px" }}>
          {breakdown.map(([label, amt]) => (
            <div key={label} className="flex items-center justify-between text-[13px]"><span className={amt < 0 ? "text-tap-greenDeep font-medium" : "text-ink-muted"}>{label}</span><span className={cx("v2-num font-semibold", amt < 0 ? "text-tap-greenDeep" : "text-ink")}>{amt < 0 ? "−" : ""}{eurC(Math.abs(amt))}</span></div>
          ))}
        </div>
        <div style={{ height: "1px", background: "#E8E8E5", margin: "14px 0" }} />
        {/* #66/#67 — total charged */}
        <div className="flex items-end justify-between gap-2"><div><div className="text-[13px] font-bold">Total charged</div><div className="text-[11px]" style={{ color: "#9A9A9A" }}>One-time charge · taxes included</div></div><span className="v2-num font-bold shrink-0" style={{ fontSize: "34px", letterSpacing: "-0.03em", lineHeight: 1 }}>{eurC(total)}</span></div>
        {/* #68 — reward miles banner */}
        <div className="flex items-center justify-between" style={{ marginTop: "18px", background: "#F2FFDB", borderRadius: "10px", padding: "10px 12px" }}><span className="flex items-center gap-1.5 text-[12px] font-medium text-tap-greenDark"><Icon name="plane" size={12} /> You'll earn</span><span className="v2-num text-[14px] font-bold text-tap-greenDark">{miles(EARN(total))} miles</span></div>
        {/* #69/#70/#71 — payment progress card */}
        <div style={{ marginTop: "18px", background: "#F2FCD9", border: "1px solid #2E7D33", borderRadius: "12px", padding: "14px" }}>
          <div className="flex items-center justify-between text-[12px] font-semibold" style={{ color: "#1A1F29" }}><span>{paidCount} of {payers.length} paid</span><span className="v2-num">{eurC(outstanding)} outstanding</span></div>
          <div className="rounded-full mt-2 overflow-hidden" style={{ height: "12px", background: "#FFFFFF" }}><div className="h-full rounded-full transition-all" style={{ width: pct + "%", background: "#2E7D33" }} /></div>
          <div className="mt-3 space-y-2">
            {payers.map((p, i) => {
              const isPaid = paid.has(i);
              return (
                <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ border: "1px solid #E0E3E8", background: "#FFFFFF" }}>
                  <div className="min-w-0"><div className="text-[13px] font-semibold truncate" style={{ color: "#1A1F29" }}>{p.name}</div><div className="text-[11px] truncate" style={{ color: "#667080" }}>{p.lead ? `Card •••• ${p.card}` : p.email}</div></div>
                  <div className="text-right shrink-0">
                    <div className="text-[14px] font-bold v2-num">{eurC(amtFor(i))}</div>
                    {isPaid
                      ? <span className="text-[10px] font-bold uppercase tracking-wide text-tap-greenDeep inline-flex items-center gap-1"><Icon name="check" size={10} /> Paid</span>
                      : p.lead
                        ? <span className="text-[10px] font-bold uppercase tracking-wide text-[#9a6b00]">Your share</span>
                        : <button onClick={() => onMarkPaid(i)} className="text-[10px] font-bold uppercase tracking-wide text-[#9a6b00] hover:text-tap-greenDeep hover:underline">Mark paid</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {mismatch && <div className="mt-2 rounded-lg bg-[#fff4d6] text-[#9a6b00] text-[11px] font-semibold px-3 py-2">Allocated {eurC(allocated)} of {eurC(total)} — adjust the shares to match before paying.</div>}
        {/* #72/#73 — primary CTA */}
        {!leadPaid
          ? <button disabled={disabled || mismatch} onClick={onPayShare} className="w-full inline-flex items-center justify-center text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed" style={{ marginTop: "18px", height: "60px", borderRadius: "9999px", background: "#46A41A", fontSize: "15px" }}>{`Pay my share · ${eurC(leadAmt)} →`}</button>
          : <button disabled={disabled} onClick={onCta} className="w-full inline-flex items-center justify-center text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed" style={{ marginTop: "18px", height: "60px", borderRadius: "9999px", background: "#46A41A", fontSize: "15px" }}>{busy ? "Processing…" : "Complete booking →"}</button>}
        {/* #74 — supporting CTA note */}
        <div className="mt-2 text-center text-[11px] text-ink-muted">{allPaid ? "All travellers have paid · ready to confirm" : leadPaid ? `Your share is paid. ${pending} traveller${pending !== 1 ? "s" : ""} settle via their link.` : "You're only charged your share now; others pay via their own link."}</div>
        <button onClick={onBack} className="w-full text-center text-[12px] font-semibold text-ink-muted mt-3 hover:text-ink">← Back to passenger details</button>
        {/* #75/#76 — trust & security benefits */}
        <div className="mt-3" style={{ background: "#FFFFFF", border: "1px solid #E8E8E5", borderRadius: "14px", padding: "14px" }}>
          <div className="grid grid-cols-2 gap-2.5">
            {[["lock", "PCI-DSS Level 1"], ["clock", "Free 24h cancellation"], ["star", "24/7 customer care"], ["check", "Instant confirmation"]].map(([ic, tx]) => (
              <div key={tx} className="flex items-center gap-2 text-[12px] font-medium" style={{ color: "#1A1F29" }}><span className="inline-flex items-center justify-center shrink-0" style={{ width: "28px", height: "28px", borderRadius: "8px", background: "#F5FFEB" }}><Icon name={ic} size={14} className="text-tap-greenDeep" /></span>{tx}</div>
            ))}
          </div>
        </div>
        {/* #77 — verified by Stripe banner */}
        <div className="mt-3 flex items-center gap-2.5" style={{ background: "#0A0A0A", borderRadius: "14px", padding: "14px 16px" }}>
          <span className="inline-flex items-center justify-center shrink-0 text-white text-[12px] font-bold" style={{ width: "32px", height: "32px", borderRadius: "8px", background: "#635bff" }}>S</span>
          <div className="flex-1"><div className="text-[12px] font-semibold text-white">Verified by Stripe</div><div className="text-[10px] text-white/60">Every card is encrypted and tokenised.</div></div>
          <Icon name="lock" size={14} className="text-white/70 shrink-0" />
        </div>
      </Card>
    </aside>
  );
}

function PaxCard({ idx, lead, prefill, profile, onRemove, showErr, onChange, paxType }) {
  const [p, setP] = useState(lead && prefill ? prefill : {});
  const [saveDoc, setSaveDoc] = useState(true);
  const [reqs, setReqs] = useState([]);
  const [reqOpen, setReqOpen] = useState(false);
  const REQ_OPTS = ["Wheelchair assistance", "Special meal — vegetarian", "Special meal — kosher", "Extra legroom", "Travelling with an infant", "Travelling with a pet", "Visual / hearing assistance"];
  const f = (k) => ({ value: p[k] || "", onChange: e => { const v = { ...p, [k]: e.target.value }; setP(v); trip.passengers[idx] = v; onChange && onChange(); } });
  const set = (k, val) => { const v = { ...p, [k]: val }; setP(v); trip.passengers[idx] = v; onChange && onChange(); };
  const err = (k) => showErr && !(p[k] && String(p[k]).trim());
  const src = prefill || profile || {};
  const doPrefill = () => { const v = { ...p, title: src.title || (src.gender === "Female" ? "Ms" : "Mr"), first: src.first, last: src.last, dob: src.dob, gender: src.gender, nat: src.nat, doctype: "Passport", doc: src.doc, docctry: src.docctry, docexp: src.docexp || "2028-11-22" }; setP(v); trip.passengers[idx] = v; onChange && onChange(); };
  useEffect(() => { trip.passengers[idx] = p; onChange && onChange(); }, []);
  return (
    <Card className="p-5 border-2" style={{ borderRadius: "18px", borderColor: "#e8e8e5", boxShadow: "0px 4px 16px rgba(0,0,0,0.06)" }}>
      <div className="flex items-start justify-between gap-3 -mx-5 -mt-5 mb-4 px-5 py-4 bg-surface-soft rounded-t-2xl border-b border-line">
        <div className="flex items-center gap-3"><span className="w-9 h-9 rounded-full bg-surface-dark text-white inline-flex items-center justify-center text-[12px] font-bold">{(p.first || "P")[0]}{(p.last || String(idx + 1))[0]}</span>
          <div><div className="font-bold text-[15px] flex items-center gap-2">Passenger {idx + 1}{p.first ? " · " + p.first + " " + (p.last || "") : " · Add details"}{(() => { const ty = paxType || "Adult"; const col = ty === "Child" ? { bg: "#E8F0FE", fg: "#2C5AA0" } : ty === "Infant" ? { bg: "#FDEAF2", fg: "#A03B6F" } : { bg: "#F2F2EE", fg: "#667080" }; return <span className="inline-flex items-center" style={{ height: "22px", padding: "0 8px", fontSize: "10px", fontWeight: 700, borderRadius: "6px", background: col.bg, color: col.fg }}>{ty}</span>; })()}{lead && <span className="inline-flex items-center" style={{ height: "22px", padding: "0 8px", fontSize: "10px", fontWeight: 700, borderRadius: "6px", background: "#FBEFD0", color: "#8A6D1F" }}>{src.tier}</span>}{(() => { const req = ["first", "last", "dob", "doc"]; const done = req.filter(k => p[k] && String(p[k]).trim()).length; const ok = done === req.length; return <span className="inline-flex items-center gap-1" style={{ height: "22px", padding: "0 8px", fontSize: "10px", fontWeight: 700, borderRadius: "6px", background: ok ? "#EAF7EC" : "#FBF3E0", color: ok ? "#2E7D33" : "#8A6D1F" }}>{ok ? "✓ Complete" : `${done}/${req.length} done`}</span>; })()}</div><div className="text-[11px] text-ink-faint">{lead ? "Lead traveler · contact for this booking" : paxType === "Child" ? "Child fare (2–11 yrs) · required to issue ticket" : paxType === "Infant" ? "Infant on lap (under 2) · required to issue ticket" : "Required to issue ticket"}</div></div></div>
        <div className="flex items-center gap-2">
          <button onClick={doPrefill} className="inline-flex items-center gap-1.5 rounded-[8px] border h-8 px-2.5 text-[12px] font-medium text-ink hover:border-tap-green" style={{ borderColor: "#e8e8e5" }}><Icon name="refresh" size={12} /> Prefill from profile</button>
          {!lead && onRemove && <button onClick={() => onRemove(idx)} className="inline-flex items-center gap-1.5 rounded-[8px] border h-8 px-2.5 text-[12px] font-medium text-ink-muted hover:border-tap-red hover:text-tap-red" style={{ borderColor: "#e8e8e5" }}><Icon name="x" size={12} /> Remove</button>}
        </div>
      </div>
      <PaxSectionTitle title="Identity" sub="as shown on passport" />
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={<>Title <Req /></>}><Select {...f("title")} options={TITLES} placeholder="Title" err={err("title")} /></Field>
        <Field label={<>First / middle names <Req /></>}><VInput {...f("first")} err={err("first")} /></Field>
        <Field label={<>Last name <Req /></>}><VInput {...f("last")} err={err("last")} /></Field>
        <Field label={<>Date of birth <Req /></>}><DateInput value={p.dob} onChange={e => set("dob", e.target.value)} err={err("dob")} max="2024-12-31" /></Field>
        <Field label={<>Gender <Req /></>}><Select {...f("gender")} options={GENDERS} placeholder="Gender" err={err("gender")} /></Field>
        <Field label={<>Nationality <Req /></>}><FlagSelect value={p.nat} onChange={v => set("nat", v)} options={FLAG_NAT} err={err("nat")} /></Field>
      </div>
      <PaxSectionTitle title="Travel document" sub="Required to issue your boarding pass" info className="mt-4" />
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label={<>Document type <Req /></>}><Select {...f("doctype")} options={DOCTYPES} placeholder="Document type" err={err("doctype")} /></Field>
        <Field label={<>Document number <Req /></>}><VInput {...f("doc")} err={err("doc")} /></Field>
        <Field label={<>Country of issue <Req /></>}><FlagSelect value={p.docctry} onChange={v => set("docctry", v)} options={FLAG_CTRY} err={err("docctry")} /></Field>
      </div>
      <div className="flex flex-wrap items-end gap-4 mt-3">
        <Field label={<>Expiry date <Req /></>} className="w-44"><DateInput value={p.docexp} onChange={e => set("docexp", e.target.value)} err={err("docexp")} min="2025-01-01" /></Field>
        <label className="flex items-center gap-2 text-[12px] text-ink-muted pb-2.5"><input type="checkbox" checked={saveDoc} onChange={e => setSaveDoc(e.target.checked)} className="accent-[#46a41a]" /> Save this document to my Xperion profile <span className="text-ink-faint">· Reuse for future trips — we'll encrypt it</span></label>
      </div>
      <PaxSectionTitle title="Loyalty" sub="Optional — earn miles on this trip" className="mt-4" />
      {lead
        ? <div className="rounded-[10px] border text-tap-greenDark flex items-center gap-3" style={{ background: "#F2FFDB", borderColor: "#9EFD38", padding: "14px" }}><span className="w-9 h-9 rounded-lg bg-white inline-flex items-center justify-center shrink-0 text-tap-greenDeep"><Icon name="plane" size={16} /></span><div className="flex-1"><div className="text-[13px] font-bold">Xperion.miles applied</div><div className="text-[11px]">{src.member} · {src.tier} tier — you'll earn {miles(src.earn || 2416)} miles on this trip.</div></div><button className="text-[12px] font-semibold shrink-0">Edit</button></div>
        : <div className="grid sm:grid-cols-[160px_1fr_auto] gap-3 items-end"><Field label="Program"><Input defaultValue="Xperion.miles" /></Field><Field label="Membership number"><Input placeholder="Add Xperion Miles number (optional)" /></Field><Btn variant="outline" size="sm">Apply membership</Btn></div>}
      <div className="mt-4 rounded-[10px]" style={{ background: "#FAFAF7", padding: "14px" }}>
        <div className="flex items-center justify-between gap-2"><div><div className="text-[13px] font-semibold">Special requests <span className="text-ink-faint font-normal">· optional</span></div><div className="text-[11px] text-ink-faint">Wheelchair, special meals, dietary preferences, traveling with a pet…</div></div><button onClick={() => setReqOpen(o => !o)} className="text-[12px] font-semibold text-tap-greenDeep shrink-0">{reqOpen ? "Close ▴" : "Add request ▾"}</button></div>
        {(reqs.length > 0 || reqOpen) && <div className="mt-3 rounded-xl border border-line bg-surface p-3">
          {reqs.length > 0 && <div className="flex flex-wrap gap-1.5 mb-2">{reqs.map(rq => <span key={rq} className="inline-flex items-center gap-1 text-[11px] font-semibold bg-lime-tint text-tap-greenDeep rounded-full px-2.5 py-1">{rq}<button onClick={() => setReqs(reqs.filter(x => x !== rq))} className="text-tap-greenDeep/70 hover:text-tap-red"><Icon name="x" size={11} /></button></span>)}</div>}
          {reqOpen && <div className="flex flex-wrap gap-1.5">{REQ_OPTS.filter(o => !reqs.includes(o)).map(o => <button key={o} onClick={() => { setReqs([...reqs, o]); setReqOpen(false); }} className="text-[11px] font-medium border border-line-strong rounded-full px-2.5 py-1 hover:border-tap-green hover:text-tap-greenDeep"><span className="text-[13px] leading-none mr-0.5">+</span> {o}</button>)}</div>}
        </div>}
      </div>
    </Card>
  );
}
const Toggle = ({ on, set }) => <button onClick={() => set(!on)} className="w-12 h-7 rounded-[14px] relative transition-colors shrink-0" style={{ background: on ? "#C7F21F" : "#D9DBE0" }}><span className={cx("absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all", on ? "right-0.5" : "left-0.5")} /></button>;

export function Passenger({ shared, go }) {
  syncTripRoute();   // drop a stale flight whose route ≠ the searched route, so the page is consistent
  if (!trip.outbound) return noTrip(go);
  useEffect(() => { api.post("/journey", { origin: trip.origin, dest: trip.dest, date: trip.date, stage: "passenger", device: "Web app" }).catch(() => {}); }, []); // eslint-disable-line
  seedExtras();
  const u = shared.profile?.user || {};
  const last = (u.full_name || "").replace(u.first_name || "", "").trim() || "Silva";
  const natName = u.nationality === "Brazilian" ? "Brazilian" : "Portuguese";
  const ctryName = natName === "Brazilian" ? "Brazil" : "Portugal";
  const p1 = { title: u.gender === "Female" ? "Ms" : "Mr", first: u.first_name || "Daniel", last, dob: /^\d{4}-\d{2}-\d{2}/.test(u.dob || "") ? u.dob : "1985-03-14", gender: u.gender || "Male", nat: natName, doctype: "Passport", doc: u.doc_id || "PT 4821190", docctry: ctryName, docexp: "2028-11-22", member: u.member_no, tier: u.tier, earn: 2416 };
  const [paxCount, setPaxCount] = useState(trip.pax || 1);
  const [contact, setContact] = useState({ email: u.email || "daniel.silva@email.com", phoneCode: "+1", phone: u.phone ? String(u.phone).replace(/^\s*\+?\d{1,3}\s*/, "") : "91 442 7781", country: ctryName, city: "Miami", lang: "English", fare: false });
  const [tab, setTab] = useState("all");
  const [cons, setCons] = useState({ fare: true, hotel: true, stopover: false, analytics: true, ads: false });
  const [, force] = useState(0); const bump = () => force(x => x + 1);
  useEffect(() => { trip.contact = contact; trip.pax = paxCount; }, [contact, paxCount]);
  // H2 — surface a mid-journey fare change here (once per selected outbound); Payment re-arms as a fallback.
  const [reval, setReval] = usePriceReval();

  const REQ = ["title", "first", "last", "dob", "gender", "nat", "doctype", "doc", "docctry", "docexp"];
  const paxComplete = (i) => { const d = trip.passengers[i] || {}; return REQ.every(k => d[k] && String(d[k]).trim()); };
  const contactComplete = !!(contact.email && contact.phone && contact.country && contact.city);
  const completeN = Array.from({ length: paxCount }).filter((_, i) => paxComplete(i)).length;
  const allComplete = completeN === paxCount && contactComplete;
  const firstIncomplete = Array.from({ length: paxCount }).findIndex((_, i) => !paxComplete(i));
  const missingCount = (() => { let n = 0; for (let i = 0; i < paxCount; i++) { const d = trip.passengers[i] || {}; n += REQ.filter(k => !(d[k] && String(d[k]).trim())).length; } if (!contactComplete) n += 1; return n; })();
  const infN = trip.infants || 0;
  const paxType = (i) => { const a = trip.adults || trip.pax || 1, c = trip.children || 0; return i >= paxCount ? "Infant" : i < a ? "Adult" : i < a + c ? "Child" : "Adult"; };   // #13 — per-passenger type from search breakdown
  const showErr = !allComplete;
  const addPax = () => { setPaxCount(c => c + 1); setTab("all"); };
  const removePax = (i) => { trip.passengers.splice(i, 1); setPaxCount(c => Math.max(1, c - 1)); setTab("all"); };

  return (
    <div className="bg-[rgba(255,255,255,1)] min-h-screen">
      <RevalGate reval={reval} setReval={setReval} go={go} />
      <Stepper active={3} />
      <div className="mx-auto max-w-page px-4 sm:px-6 py-6">
        <div className="flex items-center gap-3"><h1 className="text-[26px] font-bold">Passenger details</h1><Pill tone="slate">{paxCount} traveler{paxCount > 1 ? "s" : ""}</Pill></div>
        <p className="text-[13px] text-ink-muted mt-1 max-w-xl">Enter passenger information exactly as it appears on travel documents. We'll use this to issue tickets and send trip updates.</p>
        <div className="flex flex-wrap gap-2 mt-3"><Chip>{trip.origin}–{trip.dest}</Chip><Chip>{paxCount} adult{paxCount > 1 ? "s" : ""}</Chip><Chip>{fmtDate(trip.date).replace(/ \d{4}/, "")} – {fmtDate(trip.ret).replace(/ \d{4}/, "")}</Chip><Chip dot>{u.first_name} {last}{paxCount > 1 ? " + " + (paxCount - 1) : ""}</Chip></div>

        <div className="grid lg:grid-cols-[minmax(0,880px)_328px] lg:justify-center gap-6 mt-5 items-start">
          <div className="space-y-6">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex items-center gap-1 rounded-full border flex-wrap" style={{ borderColor: "#E8E8E5", padding: "6px" }}>
                {[["all", "All"], ...Array.from({ length: paxCount }).map((_, i) => ["p" + (i + 1), `Passenger ${i + 1}` + (i === 0 ? ` · ${u.first_name}` : "")])].map(([k, l]) => (
                  <button key={k} onClick={() => setTab(k)} className="rounded-full text-[13px] font-semibold transition-colors inline-flex items-center gap-1.5" style={tab === k ? { background: "#0A0A0A", color: "#FFFFFF", padding: "8px 14px" } : { background: "#FFFFFF", color: "#0A0A0A", padding: "8px 14px" }}>{k !== "all" && (() => { const pi = parseInt(k.slice(1), 10) - 1; return paxComplete(pi) ? <Icon name="check" size={12} className={tab === k ? "text-tap-green" : "text-tap-greenDeep"} /> : <span className={cx("w-1.5 h-1.5 rounded-full inline-block shrink-0", tab === k ? "bg-white/50" : "bg-ink-faint")} />; })()}{l}</button>
                ))}
                <span className="text-[11px] text-ink-faint pl-2 pr-1.5 whitespace-nowrap">{completeN} of {paxCount} complete · <span className="text-tap-greenDeep font-semibold">Autosaved</span></span>
              </div>
            </div>

            {showErr && <div className="rounded-xl border border-tap-red/40 bg-tap-red/5 px-4 py-3 flex items-start gap-3"><span className="w-5 h-5 rounded-full bg-tap-red text-white inline-flex items-center justify-center text-[12px] font-bold shrink-0">!</span><div><div className="text-[13px] font-bold text-tap-red">Please complete required passenger and contact details</div><div className="text-[12px] text-ink-muted">{missingCount} field{missingCount !== 1 ? "s" : ""} need attention — required fields are highlighted below.</div></div></div>}

            {Array.from({ length: paxCount + infN }).map((_, i) => ((tab === "all" || tab === "p" + (i + 1)) &&
              <PaxCard key={i} idx={i} lead={i === 0} prefill={i === 0 ? p1 : undefined} profile={p1} onRemove={i >= paxCount ? null : removePax} showErr={showErr && i < paxCount} onChange={bump} paxType={paxType(i)} />))}

            {tab === "all" && <button onClick={addPax} className="w-full rounded-xl border border-dashed border-line-strong py-3 text-[13px] font-semibold text-tap-greenDeep hover:border-tap-green hover:bg-lime-tint/30 inline-flex items-center justify-center gap-1.5"><span className="text-[15px] leading-none">+</span> Add another passenger</button>}

            <Card className="p-5">
              <div className="flex items-center justify-between mb-1"><div className="flex items-center gap-2"><Icon name="mail" size={15} className="text-ink-faint" /><div className="font-bold text-[15px]">Contact details for this booking</div></div><button className="inline-flex items-center gap-1.5 rounded-[8px] border h-8 px-2.5 text-[12px] font-medium text-ink hover:border-tap-green" style={{ borderColor: "#e8e8e5" }}><Icon name="refresh" size={12} /> Using your account · Change</button></div>
              <p className="text-[11px] text-ink-muted mb-3">We'll send confirmation and important trip updates to this contact.</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label={<>Email address <Req /></>}><VInput value={contact.email} onChange={e => setContact({ ...contact, email: e.target.value })} err={showErr && !contact.email} /></Field>
                <Field label={<>Mobile phone <Req /></>}>
                  <div className="flex gap-2">
                    <div className="relative w-[96px] shrink-0"><span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] pointer-events-none">{(PHONE_CODES.find(c => c[0] === contact.phoneCode) || PHONE_CODES[0])[1]}</span><select value={contact.phoneCode} onChange={e => setContact({ ...contact, phoneCode: e.target.value })} className="w-full bg-surface border border-line rounded-[10px] pl-8 pr-6 py-3 text-[13px] outline-none appearance-none cursor-pointer">{PHONE_CODES.map(([c]) => <option key={c} value={c}>{c}</option>)}</select><span className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none text-[10px]">▾</span></div>
                    <input value={contact.phone} onChange={e => setContact({ ...contact, phone: e.target.value })} className={cx("flex-1 bg-surface border rounded-[10px] px-3 py-3 text-[14px] outline-none focus:border-tap-green", showErr && !contact.phone ? "border-tap-red" : "border-line")} />
                  </div>
                </Field>
                <Field label={<>Country <Req /></>}><FlagSelect value={contact.country} onChange={v => setContact({ ...contact, country: v })} options={FLAG_CTRY} err={showErr && !contact.country} /></Field>
                <Field label={<>City <Req /></>}><VInput value={contact.city} onChange={e => setContact({ ...contact, city: e.target.value })} err={showErr && !contact.city} /></Field>
                <Field label="Preferred language"><Select value={contact.lang} onChange={e => setContact({ ...contact, lang: e.target.value })} options={LANGS} placeholder="Select language" /></Field>
              </div>
              <div className="h-px bg-line my-4" />
              <label className="flex items-start gap-2.5 text-[13px] text-ink-700"><input type="checkbox" checked={contact.fare} onChange={e => setContact({ ...contact, fare: e.target.checked })} className="accent-[#46a41a] mt-0.5" /><span>Email me fare alerts and travel inspiration <span className="text-ink-faint">(optional)</span><span className="block text-[11px] text-ink-faint">You can unsubscribe any time. We'll always send essential trip emails.</span></span></label>
            </Card>

            <div className="rounded-[12px] border flex items-start gap-3" style={{ background: "#F5FAFF", borderColor: "#C7D6F5", padding: "16px 22px" }}><span className="w-9 h-9 rounded-[18px] bg-white inline-flex items-center justify-center shrink-0" style={{ color: "#1A1F29" }}><Icon name="lock" size={16} /></span><div><div className="font-bold text-[14px]" style={{ color: "#1A1F29" }}>Your data, your choice</div><div className="text-[11px]" style={{ color: "#667080" }}>GDPR-compliant · Xperion only shares what you explicitly allow below. Encrypted end-to-end.</div></div></div>
            <Card className="p-5">
              <div className="mb-3 font-bold" style={{ fontSize: "18px", fontWeight: 700, color: "#1A1F29" }}>Marketing &amp; partner consents</div>
              <div className="divide-y divide-[#e0e3e8]">
                {[["fare", "Xperion fare alerts", "Personalised deals based on your routes"], ["hotel", "Hotel & car partners", "Booking.com & Hertz can email you matched offers"], ["stopover", "Stopover Portugal", "Destination guides & limited-time experiences"], ["analytics", "Anonymised analytics", "Helps Xperion improve product (no personal data shared)"], ["ads", "Third-party advertising", "Personalised ads on social platforms"]].map(([k, t, s]) => (
                  <div key={k} className="flex items-center justify-between gap-3 min-h-[72px]" style={{ padding: "14px 0" }}><div><div className="text-[13px] font-semibold">{t}</div><div className="text-[11px] text-ink-faint">{s}</div></div><Toggle on={cons[k]} set={v => setCons({ ...cons, [k]: v })} /></div>
                ))}
              </div>
            </Card>
          </div>
          <BasketSummary step={4} grouped bigTotal carded cta="Continue to payment →" onCta={() => go("payment")} disabled={!allComplete} note={allComplete ? "Final review again on Step 4." : (firstIncomplete >= 0 ? `Complete Passenger ${firstIncomplete + 1} details to continue.` : "Complete contact details to continue.")} secondary="← Back to My Trip Cart" onSecondary={() => go("cart")} />
        </div>
      </div>
    </div>
  );
}

/* ═══════════ PAYMENT ═══════════ */
const METHODS = ["Card", "Instalments", "Pay by Segment", "Digital Wallet", "Xperion Miles", "Bank transfer", "Split Payment", "Mix Method"];

/* H2 · Real-time availability / price change during booking. Revalidation runs when the
   passenger reaches payment (before confirmation). It fires once per selected outbound so
   a fresh selection re-arms it; the passenger can accept the new price or return to the
   basket — their seat, extras and details are preserved either way. Presenter can silence
   it from the Demo Console (window.__tapNoRevalidate). */
let _h2ArmedFor = null;
function computeRevalidation(t) {
  const o = trip.outbound;
  const delta = Math.max(12, Math.round((o?.price || 130) * 0.08));   // ~8% of the outbound fare, min $12
  const fno = String(o?.flight?.flight_no || "your flight").replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2");
  const oldTotal = t.total, newTotal = t.total + delta;
  const pct = oldTotal > 0 ? Math.round((delta / oldTotal) * 1000) / 10 : 0;   // one decimal
  const capturedAt = new Date(Date.now() - 4 * 60000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return { oldTotal, newTotal, delta, pct, capturedAt, flight: fno };
}
// Shared once-per-journey revalidation: any checkout step can arm this on mount; it fires a
// single time per selected outbound (guarded by _h2ArmedFor), so the price-change popup shows
// mid-journey and never repeats. Presenters can silence it via window.__tapNoRevalidate.
function usePriceReval(enabled = true) {
  const [reval, setReval] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    if (trip.pnr) return;                                                      // already booked → never
    // #3 — a held fare is locked for its window: suppress the price-change prompt while the hold is valid
    if (trip.fareHold && trip.fareHold.until > Date.now() && trip.fareHold.flightNo === (trip.outbound?.flight?.flight_no || null)) return;
    if (typeof window !== "undefined" && window.__tapNoRevalidate) return;     // presenter silenced it
    const fno = trip.outbound?.flight?.flight_no || null;
    // A resume sets window.__tapForceReval so the popup re-fires on return even if it was already
    // shown for this flight (the fare is re-validated fresh on resume). Otherwise: once per flight.
    const forced = typeof window !== "undefined" && !!window.__tapForceReval;
    if (!forced && _h2ArmedFor === fno) return;
    if (forced && typeof window !== "undefined") window.__tapForceReval = false;   // consume the flag
    setReval(computeRevalidation(tripTotals()));
  }, []);
  return [reval, setReval];
}
// Renders the price-change modal + wires accept/exit consistently for whichever step armed it.
function RevalGate({ reval, setReval, go }) {
  if (!reval) return null;
  const arm = () => { _h2ArmedFor = trip.outbound?.flight?.flight_no || null; };
  return <PriceChangeModal info={reval}
    onAccept={() => { trip.repriceDelta = (trip.repriceDelta || 0) + reval.delta; arm(); pingBasket(); setReval(null); }}
    onExit={() => { arm(); setReval(null); go("results", { origin: trip.origin, dest: trip.dest, date: trip.date, ret: trip.ret, type: trip.type }); }} />;
}
function PriceChangeModal({ info, onAccept, onExit }) {
  const pctStr = String(info.pct).replace(".", ",");
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onExit}>
      <div className="bg-white rounded-2xl max-w-lg w-full shadow-pop overflow-hidden border-t-4 border-[#f59e0b]" onClick={e => e.stopPropagation()}>
        <div className="p-6">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-[#fef3c7] text-[#d97706] inline-flex items-center justify-center shrink-0 text-[18px] font-black leading-none">!</span>
            <div className="text-[22px] font-black text-ink leading-tight">Price has changed</div>
          </div>
          <p className="text-[14px] text-ink-muted mt-3 leading-relaxed">While you were choosing, the fare on <b>{info.flight}</b> changed. Please confirm to continue with the new price.</p>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="rounded-xl border border-line bg-surface-soft p-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Old price</div>
              <div className="text-[22px] font-black v2-num text-ink-faint line-through mt-1">{money(info.oldTotal, { dp: 2 })}</div>
              <div className="text-[11px] text-ink-faint mt-1">Captured at {info.capturedAt}</div>
            </div>
            <div className="rounded-xl border-2 p-4" style={{ borderColor: "#f5c518", background: "#fffaeb" }}>
              <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: "#9a6b00" }}>New price</div>
              <div className="text-[26px] font-black v2-num text-ink mt-1">{money(info.newTotal, { dp: 2 })}</div>
              <div className="text-[12px] text-tap-red font-bold mt-1">+{money(info.delta, { dp: 0 })} (+{pctStr}%)</div>
            </div>
          </div>
          <div className="text-[12px] text-ink-faint mt-4">💡 Why did this happen? Fares update in real time.</div>
          <div className="flex items-center gap-3 mt-5">
            <Btn variant="outline" className="flex-1" onClick={onExit}>Find another flight</Btn>
            <Btn variant="primary" className="flex-1" onClick={onAccept}>Accept changes &amp; continue</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Payment({ shared, go }) {
  if (!trip.outbound) return noTrip(go);
  useEffect(() => { api.post("/journey", { origin: trip.origin, dest: trip.dest, date: trip.date, stage: "payment", device: "Web app" }).catch(() => {}); }, []); // eslint-disable-line
  seedExtras();
  const u = shared.profile?.user || {};
  const voucher = (shared.profile?.vouchers || []).find(v => v.status === "active")?.amount || 0;
  // Mix #8 — Figma shows the voucher pre-selected in the composer; apply an eligible voucher on mount
  // (only read by the Mix Method branch, so other methods are unaffected). User can still toggle it off.
  useEffect(() => { if (voucher > 0) setMix(m => (m.voucher > 0 ? m : { ...m, voucher })); }, [voucher]);
  const t = tripTotals();
  const [method, setMethod] = useState(trip.payMiles ? "Xperion Miles" : "Card");   // honour the Pay-with-Miles toggle from search
  const [agree, setAgree] = useState(true);
  const [saveCard, setSaveCard] = useState(true);   // A#14 — custom save-card checkbox
  const [useContactBilling, setUseContactBilling] = useState(true);   // B#12 — use-contact-details banner toggle
  const [useV, setUseV] = useState(false);
  const [milesUsed, setMilesUsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [instN, setInstN] = useState(3);                 // F1 — chosen instalment plan (months)
  const [segPaid, setSegPaid] = useState(() => new Set()); // F2 — segments settled ("ob" / "ib")
  const [optIn, setOptIn] = useState(false);               // Split #59 — custom optional-consent checkbox
  const [seat, setSeat] = useState(null);                 // recommended seat from history (DB)
  const [splitTab, setSplitTab] = useState("Split Equally");
  const [splitAmts, setSplitAmts] = useState({});   // #16 — per-payer custom amounts (index → $)
  const [splitPaid, setSplitPaid] = useState(() => new Set());   // #19 — indices of payers who've settled
  const payMyShare = () => setSplitPaid(s => new Set(s).add(0));                 // lead pays their own share
  const markPaid = (i) => setSplitPaid(s => { const n = new Set(s); n.add(i); return n; });   // demo: invitee settles via their link
  const [mix, setMix] = useState({ card: null, miles: 0, voucher: 0, cashback: 0 }); // Payment Composer amounts ($ per source)
  const [editMiles, setEditMiles] = useState(false); // #7: Edit reveals an exact-amount field
  const [editVoucher, setEditVoucher] = useState(false), [editCash, setEditCash] = useState(false); // #21: Edit reveals partial-amount fields
  useEffect(() => { api.get("/seat-recommendation").then(setSeat).catch(() => {}); }, []);
  // H2 — revalidate availability/price; fires once per selected outbound (also armed mid-journey on Passenger).
  const [reval, setReval] = usePriceReval();
  const cashbackBal = 38;
  let voucher_amt = 0, miles_used = 0, miles_amt = 0, cashback_amt = 0;
  if (method === "Xperion Miles") { miles_used = Math.min(u.miles || 0, Math.round(t.total / MILES_RATE)); miles_amt = Math.round(miles_used * MILES_RATE); voucher_amt = Math.min(voucher, Math.max(0, t.total - miles_amt)); }
  else if (method === "Mix Method") {
    voucher_amt = Math.min(voucher, mix.voucher || 0);
    miles_used = mix.miles; miles_amt = Math.round(miles_used * MILES_RATE);
    cashback_amt = Math.min(cashbackBal, mix.cashback || 0);
  }
  // Multi-trip basket: the other selected itineraries settle on this same payment (each is
  // still issued as its own PNR). They ride on the card leg — miles/vouchers apply to the
  // active trip only, which is how airlines apply redemption to a single order.
  const queued = getQueue();
  const queuedTotal = queued.reduce((a, sn) => a + basketTripTotal(sn), 0);
  const card_amt = Math.max(0, t.total - voucher_amt - miles_amt - cashback_amt) + queuedTotal;
  const seatNo = chosenSeat() || (/exec|plus|premium/i.test(trip.outbound?.fare || "") ? seatForFare(trip.outbound?.fare) : (seat?.seat || seatForFare(trip.outbound?.fare)));
  const mixBreakdown = method === "Mix Method" ? [
    { label: "Card payment", text: EUR(card_amt) },
    { label: `Miles (${miles(miles_used)})`, text: miles_amt > 0 ? "−" + EUR(miles_amt) : EUR(0), green: miles_amt > 0 },
    { label: voucher ? `Voucher Xperion-${shared.profile?.vouchers?.[0]?.code || "XYZ"}` : "Voucher", text: voucher_amt > 0 ? "−" + EUR(voucher_amt) : EUR(0), red: voucher_amt > 0 },
    { label: "Cashback wallet", text: cashback_amt > 0 ? "−" + EUR(cashback_amt) : EUR(0) + " (unused)", muted: cashback_amt === 0 },
  ] : null;
  // #19 — split-payment participant model (shared by the left allocation editor and the right summary panel).
  const splitPayers = method === "Split Payment"
    ? [{ name: (trip.passengers?.[0]?.first ? trip.passengers[0].first + " (you)" : (u.first_name || "You") + " (you)"), email: trip.contact?.email || u.email || "you@email.com", card: u.card_last4 || "4242", lead: true },
       ...Array.from({ length: Math.max(0, (trip.pax || 1) - 1) }).map((_, i) => { const p = trip.passengers?.[i + 1]; return { name: p?.first ? `${p.first} ${p.last || ""}`.trim() : `Guest ${i + 1}`, email: "guest" + (i + 1) + "@email.com", card: ["1881", "1234", "5079"][i] || "0000", status: i === 0 ? "Link sent" : "Link pending" }; })]
    : [];
  const splitEqual = splitPayers.length ? +(t.total / splitPayers.length).toFixed(2) : 0;
  const splitAmtFor = (i) => splitTab === "Single Payer" ? (i === 0 ? t.total : 0) : splitTab === "Custom Split" ? (splitAmts[i] != null ? splitAmts[i] : splitEqual) : splitEqual;
  const splitAllocated = +splitPayers.reduce((s, _, i) => s + (splitAmtFor(i) || 0), 0).toFixed(2);
  const splitLeadAmt = splitPayers.length ? (splitAmtFor(0) || 0) : 0;

  // F1 — instalment plans: 3× and 4× interest-free, 6× carries a small service fee.
  const INST_PLANS = [{ n: 3, feeRate: 0 }, { n: 4, feeRate: 0 }, { n: 6, feeRate: 0.04 }];
  const instPlan = INST_PLANS.find(p => p.n === instN) || INST_PLANS[0];
  const instTotal = +(t.total * (1 + instPlan.feeRate)).toFixed(2);
  const instPer = +(instTotal / instPlan.n).toFixed(2);
  const instFirst = +(instTotal - instPer * (instPlan.n - 1)).toFixed(2);   // first payment absorbs rounding
  const INST_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const instDateLabel = (m) => { const d = new Date(); d.setMonth(d.getMonth() + m); return `${d.getDate()} ${INST_MON[d.getMonth()]} ${d.getFullYear()}`; };
  const instSchedule = Array.from({ length: instPlan.n }, (_, i) => ({ i, amt: i === 0 ? instFirst : instPer }));

  // F2 — per-segment pricing: each flight's fare share of the total (outbound also carries extras/taxes/bundle).
  const obFlights = (trip.outbound?.price || 0) * (trip.pax || 1);
  const ibFlights = (trip.inbound?.price || 0) * (trip.pax || 1);
  const segTaxOb = ibFlights ? Math.round(t.taxes * obFlights / (obFlights + ibFlights)) : t.taxes;
  const segTaxIb = t.taxes - segTaxOb;
  const obShare = +(obFlights + segTaxOb + t.extras - t.bundle + (t.reprice || 0)).toFixed(2);
  const ibShare = +(ibFlights + segTaxIb).toFixed(2);
  const hasInbound = !!trip.inbound;
  const segList = [{ key: "ob", label: "Outbound", f: trip.outbound?.flight, date: trip.date, amt: obShare, sub: "Fare + taxes + extras" }, ...(hasInbound ? [{ key: "ib", label: "Return", f: trip.inbound?.flight, date: trip.ret, amt: ibShare, sub: "Fare + taxes" }] : [])];
  const bothSegPaid = segList.every(s => segPaid.has(s.key));

  async function pay() {
    setBusy(true);
    try {
      const r = await api.post("/pay", { flight_no: trip.outbound.flight.flight_no, items: trip.extras.map(e => e.code || e.name), total: t.total, voucher_amt, miles_used, miles_amt, card_amt, seat: seatNo, date: trip.date, fare: trip.outbound?.fare, cabin: fareCabin(trip.outbound?.fare), pax: trip.pax, passengers: (trip.passengers || []).filter(p => p && p.first).map(p => ({ title: p.title, first: p.first, last: p.last })), inbound: trip.inbound?.flight?.flight_no ? { flight_no: trip.inbound.flight.flight_no, date: trip.ret } : null, contact: trip.contact || null });
      if (r.ok) {
        // One payment → many orders: issue each queued itinerary as its own PNR.
        const alsoBooked = [];
        for (const sn of queued) {
          const qo = sn.outbound?.flight; if (!qo?.flight_no) continue;
          const qr = await api.post("/pay", { flight_no: qo.flight_no, items: (sn.extras || []).map(e => e.code || e.name), total: basketTripTotal(sn), date: sn.date, fare: sn.outbound?.fare, pax: sn.pax || 1, inbound: sn.inbound?.flight?.flight_no ? { flight_no: sn.inbound.flight.flight_no, date: sn.ret } : null, contact: sn.contact || trip.contact || null }).catch(() => null);
          if (qr && qr.ok) alsoBooked.push({ pnr: qr.pnr, origin: sn.origin, dest: sn.dest, total: basketTripTotal(sn) });
        }
        if (alsoBooked.length) { trip.alsoBooked = alsoBooked; clearBasketQueue(); } else if (queued.length) { clearBasketQueue(); }
        trip.pnr = r.pnr; trip.seat = seatNo; trip.payment = { total: t.total, queued_total: queuedTotal, queued_n: queued.length, voucher_amt, miles_used, miles_amt, cashback_amt, card_amt, method, email: r.email?.to, payNote: method === "Instalments" ? `${instPlan.n}× instalments — ${EUR(instFirst)} today, then ${instPlan.n - 1} × ${EUR(instPer)}` : method === "Pay by Segment" ? `Paid by segment — outbound ${EUR(obShare)}${hasInbound ? ` + return ${EUR(ibShare)}` : ""}` : null };
        // Cart persistence #1 — a completed booking is not a resumable cart. saveTrip() sees the pnr
        // and purges the localStorage trip immediately (the pnr was set by direct assignment, which
        // doesn't fire notify()/saveTrip on its own, so the pre-payment snapshot would otherwise linger
        // and be restored on the next boot). Also drop the client-side basket queue and clear the
        // server "resume your search" context so no stale search/basket can reload into a new booking.
        saveTrip(); clearBasketQueue();
        api.post("/journey/clear", { origin: trip.origin, dest: trip.dest }).catch(() => {});
        go("confirmation"); }
      else alert("Payment could not be completed: " + (r.error || "unknown"));
    } catch (e) { alert("Payment error: " + e.message); } finally { setBusy(false); }
  }
  const [billCtry, setBillCtry] = useState(trip.contact?.country || "Portugal");
  const VOK = (p) => <ValidatedInput {...p} />;
  const billing = (
    <Card className="p-6" style={{ borderRadius: "12px", boxShadow: "none" }}>
      <div className="flex items-start justify-between gap-3 flex-wrap" style={{ marginBottom: "18px" }}>
        <div className="flex items-center" style={{ gap: "12px" }}>
          <span className="inline-flex items-center justify-center shrink-0" style={{ width: "36px", height: "36px", borderRadius: "8px", background: "#F2F2EE" }}><img src={AIC + "billing.png"} alt="" className="w-[18px] h-[18px] object-contain opacity-70" onError={e => { e.currentTarget.style.display = "none"; }} /></span>
          <div><div style={{ fontSize: "16px", fontWeight: 600, color: "#0A0A0A" }}>Billing details</div><div className="leading-4" style={{ fontSize: "12px", color: "#6B6B6B" }}>We use these only for payment authorisation and invoicing.</div></div>
        </div>
        <label onClick={() => setUseContactBilling(v => !v)} className="flex items-center gap-2.5 rounded-[10px] cursor-pointer shrink-0" style={{ background: "#F2FFDB", border: "1px solid #9EFD38", padding: "8px 12px" }}><span className="inline-flex items-center justify-center shrink-0" style={{ width: "18px", height: "18px", borderRadius: "5px", background: useContactBilling ? "#336614" : "#FFFFFF", border: useContactBilling ? "none" : "1px solid #DCEFC6" }}>{useContactBilling && <Icon name="check" size={11} className="stroke-[3]" style={{ color: "#9EFD38" }} />}</span><span style={{ fontSize: "12px", fontWeight: 500, color: "#336614" }}>Use contact details from this booking</span></label>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4" style={{ gap: "18px" }}>
        <Field className="lg:col-span-2" label={<>Country <Req /></>}><FlagSelect value={billCtry} onChange={setBillCtry} options={FLAG_CTRY} /></Field>
        <Field className="lg:col-span-2" label={<>Street address <Req /></>}><VOK defaultValue="Av. Paulista, 1842 · Apt 71" /></Field>
        <Field label={<>City <Req /></>}><VOK defaultValue={trip.contact?.city || "Miami"} /></Field>
        <Field label="State / province"><Input defaultValue="SP" /></Field>
        <Field label={<>Postal code <Req /></>}><VOK defaultValue="01310-100" /></Field>
        <Field label="CPF / Tax ID (optional)"><Input placeholder="000.000.000-00" /></Field>
      </div>
      <div className="flex items-center gap-2 leading-[18px]" style={{ borderTop: "1px solid #E8E8E5", paddingTop: "6px", marginTop: "6px", fontSize: "11px", color: "#6B6B6B" }}><Icon name="doc" size={14} className="text-ink-faint shrink-0" /> Invoice will be issued to this address. You can edit it before requesting a refund.</div>
    </Card>
  );
  const terms = (
    <Card className="p-5 space-y-3">
      <div className="flex items-center" style={{ gap: "10px", fontSize: "16px", fontWeight: 600, color: "#0A0A0A" }}><Icon name="doc" size={14} className="text-ink-faint shrink-0" /> Terms and consent</div>
      <label className="flex items-start gap-2.5 text-[13px]" style={{ borderRadius: "10px", border: "1px solid #E8E8E5", background: "#FAFAF7", padding: "14px" }}>
        <span className="mt-0.5 inline-flex items-center justify-center shrink-0 cursor-pointer" style={{ width: "20px", height: "20px", borderRadius: "5px", background: agree ? "#0A0A0A" : "#FFFFFF", border: "1px solid #0A0A0A" }} onClick={() => setAgree(!agree)}>{agree && <Icon name="check" size={12} className="stroke-[3]" style={{ color: "#9EFD38" }} />}</span>
        <span className="flex-1" style={{ fontWeight: 500 }}>I've read and accept the <span style={{ fontWeight: 600, color: "#0A0A0A" }}>fare conditions</span> · <span style={{ fontWeight: 600, color: "#0A0A0A" }}>baggage rules</span> · <span style={{ fontWeight: 600, color: "#0A0A0A" }}>privacy policy</span>.<div className="font-normal" style={{ fontSize: "11px", color: "#6B6B6B" }}>You'll receive your booking confirmation and e-ticket after successful payment.</div></span>
        <span className="shrink-0"><span className="uppercase rounded-full bg-tap-red text-white" style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.04em", padding: "3px 8px" }}>Required</span></span>
      </label>
      <label className="flex items-start cursor-pointer" style={{ padding: "6px", gap: "14px" }} onClick={() => setOptIn(v => !v)}>
        <span className="mt-0.5 inline-flex items-center justify-center shrink-0" style={{ width: "20px", height: "20px", borderRadius: "5px", background: optIn ? "#0A0A0A" : "#FFFFFF", border: optIn ? "1px solid #0A0A0A" : "1px solid #E8E8E5" }}>{optIn && <Icon name="check" size={12} className="stroke-[3]" style={{ color: "#9EFD38" }} />}</span>
        <span style={{ fontSize: "13px", fontWeight: 500, color: "#0A0A0A" }}>Send me deals and offers from Xperion and partners <span style={{ color: "#6B6B6B" }}>(optional)</span><div style={{ fontSize: "11px", color: "#6B6B6B" }}>You can unsubscribe any time. We'll always send essential trip emails.</div></span>
      </label>
    </Card>
  );

  return (
    <div className="bg-[rgba(255,255,255,1)] min-h-screen">
      <RevalGate reval={reval} setReval={setReval} go={go} />
      <Stepper active={4} />
      <div className="mx-auto max-w-page px-4 sm:px-6 py-6">
        <div className="flex items-center gap-3"><h1 className="text-[26px] font-bold">Payment</h1><Pill tone="slate"><Icon name="lock" size={11} /> Secure checkout · powered by Stripe</Pill></div>
        <p className="text-[13px] text-ink-muted mt-1">Review your total and pay securely to confirm your trip. No charge has been made until you click Pay.</p>
        <div className="flex flex-wrap items-center gap-2 mt-3"><Chip>{trip.origin}–{trip.dest}</Chip><Chip>{trip.pax} adults</Chip><Chip>{fmtDate(trip.date).replace(/ \d{4}/, "")} – {fmtDate(trip.ret).replace(/ \d{4}/, "")}</Chip><Chip dot>{u.first_name} {trip.pax > 1 ? "+ " + (trip.pax - 1) : ""}</Chip><span className="ml-auto inline-flex items-center gap-2 rounded-lg bg-surface-mute px-3 py-1.5"><span className="w-2 h-2 rounded-full bg-tap-red inline-block" /><span className="leading-tight"><span className="block text-[9px] font-bold uppercase tracking-wide text-ink-faint">Price locked</span><SessionTimer prefix="" suffix=" remaining" className="block text-[12px] font-bold text-ink v2-num" /></span></span></div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_328px] gap-6 mt-5 items-start">
          <div className="space-y-[18px]">
            {queued.length > 0 && (
              <div className="rounded-2xl flex items-center gap-3 flex-wrap" style={{ background: "#F2FCD9", border: "1px solid #2E7D33", padding: "14px 16px" }}>
                <Icon name="cart" size={16} className="text-tap-greenDeep shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold" style={{ color: "#1A7333" }}>Paying for {queued.length + 1} trips in one payment</div>
                  <div className="text-[11px] text-ink-muted">This trip + {queued.length} more from your basket · each is issued as its own PNR. Extra trips add <span className="v2-num font-semibold">{eur2(queuedTotal)}</span>.</div>
                </div>
              </div>
            )}
            <div className="rounded-2xl flex items-center justify-between flex-wrap gap-3" style={{ background: "#FFFFFF", border: "1px solid #E8E8E5", padding: "16px" }}>
              <div className="flex items-center gap-3"><span className="inline-flex items-center justify-center shrink-0" style={{ width: "44px", height: "44px", borderRadius: "10px", background: "#F2F2EE" }}><Icon name="lock" size={18} className="text-ink-faint" /></span><div><div style={{ fontSize: "13px", fontWeight: 600, color: "#0A0A0A" }}>Secure payment</div><div className="text-[11px]" style={{ color: "#667080" }}>Encrypted &amp; tokenised · Stripe · 3-D Secure 2.0 · we never see your full card number.</div></div></div>
              <div className="flex flex-wrap gap-1.5">{["VISA", "MC", "AMEX", "MAESTRO", "APPLE PAY", "G PAY", "PIX"].map(b => <span key={b} className="text-[9px] font-bold rounded px-1.5 py-1" style={{ background: "#F2F2EE", color: "#1A1F29" }}>{b}</span>)}<span className="text-[9px] font-bold text-white rounded px-1.5 py-1" style={{ background: "#635bff" }}>stripe</span></div>
            </div>
            <Card className="overflow-hidden">
            <div className="p-1.5 flex gap-1 overflow-x-auto v2-track border-b border-line">{METHODS.filter(m => trip.inbound || m !== "Pay by Segment").map(m => { const on = method === m; return <button key={m} onClick={() => setMethod(m)} className={cx("shrink-0 px-3.5 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5", on ? "bg-tap-green text-white" : "text-ink-muted hover:bg-surface-mute")}>{m}{m === "Card" && on && <span className="flex gap-1 ml-0.5">{["VISA", "MC", "AMEX"].map(b => <span key={b} className="text-[8px] font-bold bg-white/25 rounded px-1 py-0.5 leading-none">{b}</span>)}</span>}</button>; })}</div>
            <div className="p-5">
              {method === "Card" && <>
                {/* header group: title and the supported-card brands belong together, 2px apart.
                    The title carries an explicit line-height so that 2px is the actual visual gap
                    rather than 2px plus the default leading under an 18px glyph. */}
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2" style={{ fontSize: "18px", fontWeight: 600, lineHeight: "22px" }}><Icon name="lock" size={14} className="text-ink-faint" /> Pay by card</div>
                    <div className="text-[11px] text-ink-faint" style={{ marginTop: "2px", lineHeight: "15px" }}>Visa · Mastercard · American Express · Maestro · Elo</div>
                  </div>
                  <span className="text-[11px] text-ink-faint flex items-center gap-1 shrink-0">Powered by <span className="text-[11px] font-bold text-white rounded-[6px] px-2 py-1" style={{ background: "#6B4DD9" }}>stripe</span></span>
                </div>
                <div className="grid gap-3">
                  <Field label={<>Cardholder name <Req /></>}><ValidatedInput defaultValue={(u.full_name || "Daniel Silva").toUpperCase()} validate={(v) => v.trim().split(/\s+/).filter(Boolean).length >= 2} /></Field>
                  <Field label={<>Card number <Req /></>}>
                    <ValidatedInput defaultValue={`XXXX XXXX XXXX ${u.card_last4 || "4242"}`} className="v2-num tracking-wide"
                      left={<><svg width="22" height="14" viewBox="0 0 22 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="21" height="13" rx="2.5" fill="#fff" stroke="#dcdcd8"/><rect x="0" y="3" width="22" height="3" fill="#ed1c24"/><rect x="3" y="9.5" width="7" height="1.8" rx="0.9" fill="#9a9a9a"/></svg></>}
                      right={<span className="text-[10px] font-bold text-ink-slate">VISA</span>}
                      validate={(v) => v.replace(/[^0-9A-Za-z]/g, "").length >= 15} />
                  </Field>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field label={<>Expiry (MM / YY) <Req /></>}><ValidatedInput defaultValue={u.card_exp || "09 / 28"} placeholder="MM / YY" className="v2-num" validate={(v) => /^\s*\d{2}\s*\/\s*\d{2}\s*$/.test(v)} /></Field>
                    <Field label={<span className="inline-flex items-center gap-1.5">CVC <Req /> <span className="w-3.5 h-3.5 rounded-full inline-flex items-center justify-center" style={{ background: "#F2F2EE" }}><Icon name="info" size={9} className="text-ink-faint" /></span></span>}>
                      <ValidatedInput defaultValue="•••" validate={(v) => v.trim().length >= 3} />
                    </Field>
                    <Field label={<>Postal / ZIP <Req /></>}><ValidatedInput defaultValue="01310-100" className="v2-num" validate={(v) => v.replace(/[^0-9A-Za-z]/g, "").length >= 4} /></Field>
                  </div>
                </div>
                <div className="mt-3">
                  <div onClick={() => setSaveCard(v => !v)} className="flex items-center gap-2.5 text-[13px] cursor-pointer">
                    <span className="w-[18px] h-[18px] rounded-[5px] inline-flex items-center justify-center shrink-0" style={saveCard ? { background: "#336614" } : { background: "#FFFFFF", border: "1px solid #DCDCD8" }}>{saveCard && <Icon name="check" size={12} className="stroke-[3]" style={{ color: "#9EFD38" }} />}</span>
                    <span className="font-semibold">Save card securely for faster checkout next time</span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide rounded-full px-2.5 py-1" style={{ background: "#F2FFDB", color: "#336614" }}><Icon name="lock" size={10} /> Encrypted</span>
                  </div>
                  <div className="text-[11px] mt-1 pl-[28px]" style={{ color: "#6B6B6B" }}>We store a Stripe token — never your full card number.</div>
                </div>
              </>}
              {method === "Xperion Miles" && <div className="text-[13px]"><div className="font-bold text-[15px] mb-2 flex items-center gap-2"><Icon name="spark" size={14} className="text-tap-green" /> Pay with Miles &amp; Go</div><div className="rounded-xl border border-tap-green bg-lime-tint/40 p-4"><div className="flex items-center justify-between"><span>Balance</span><span className="font-bold v2-num">{miles(u.miles)} miles</span></div><div className="flex items-center justify-between mt-1.5"><span>Using for this trip</span><span className="font-bold v2-num">{miles(miles_used)} mi ({EUR(miles_amt)})</span></div>{voucher_amt > 0 && <div className="flex items-center justify-between mt-1.5"><span>Voucher applied</span><span className="font-bold v2-num text-tap-greenDeep">−{EUR(voucher_amt)}</span></div>}<Divider className="my-2" /><div className="flex items-center justify-between font-bold"><span>Remaining on saved card</span><span className="v2-num">{EUR(card_amt)}</span></div></div></div>}
              {method === "Mix Method" && (() => {
                const milesMax = Math.min(u.miles || 0, Math.round(t.total / MILES_RATE));
                const clampMiles = v => Math.max(0, Math.min(milesMax, Math.round((+v || 0) / 100) * 100));
                return <div className="space-y-3"><div className="font-semibold text-[18px] flex items-center gap-2" style={{ color: "#0A0A0A" }}><Icon name="lock" size={14} className="text-ink-faint" /> Payment Composer</div><p className="text-[12px] text-ink-muted">Mix card · miles · voucher · cashback. Live total updates as you adjust.</p>
                  <MixComp on={card_amt > 0} title={`Card · Visa •••• ${u.card_last4 || "4242"}`} sub="Available: unlimited" right={<span className="text-[13px] font-bold v2-num">{EUR(card_amt)}</span>} onToggle={() => { }} onEdit={() => setMethod("Card")} />
                  <MixComp on={mix.miles > 0} title="Xperion miles" sub={`Balance ${miles(u.miles)} · 1mi=${EUR(MILES_RATE)}`} onToggle={() => setMix(m => ({ ...m, miles: m.miles > 0 ? 0 : milesMax }))} onEdit={() => setEditMiles(v => !v)} right={<span className="text-[13px] font-bold v2-num">{miles(miles_used)} mi ({EUR(miles_amt)})</span>}>
                    <div className="px-1 mt-3"><input type="range" min="0" max={milesMax} step="100" value={mix.miles} onChange={e => setMix(m => ({ ...m, miles: +e.target.value }))} className="w-full accent-[#46a41a]" /></div>
                    {editMiles && <div className="px-1 mt-2.5 flex items-center gap-2 text-[12px]"><span className="text-ink-muted">Use exactly</span><input type="number" min="0" max={milesMax} step="100" value={mix.miles} onChange={e => setMix(m => ({ ...m, miles: clampMiles(e.target.value) }))} className="w-28 rounded-lg border border-line-strong px-2 py-1 text-[13px] font-bold v2-num" /><span className="text-ink-faint">miles = {EUR(miles_amt)}</span><button onClick={() => setMix(m => ({ ...m, miles: milesMax }))} className="ml-auto text-[11px] font-bold text-tap-greenDeep hover:underline">Max</button></div>}
                  </MixComp>
                  <MixComp on={(mix.voucher || 0) > 0 && voucher > 0} title={`Voucher${voucher ? " Xperion-" + (shared.profile?.vouchers?.[0]?.code || "XYZ") : ""}`} sub={voucher ? `Eligible: ${EUR(voucher)}` : "No active voucher"} onToggle={() => voucher && setMix(m => ({ ...m, voucher: (m.voucher || 0) > 0 ? 0 : voucher }))} onEdit={() => voucher && setEditVoucher(v => !v)} right={<span className="text-[13px] font-bold v2-num">{EUR(voucher_amt)}</span>}>
                    {editVoucher && voucher > 0 && <div className="px-1 mt-2.5 flex items-center gap-2 text-[12px]"><span className="text-ink-muted">Apply $</span><input type="number" min="0" max={voucher} step="1" value={mix.voucher || 0} onChange={e => setMix(m => ({ ...m, voucher: Math.max(0, Math.min(voucher, +(+e.target.value).toFixed(2))) }))} className="w-24 rounded-lg border border-line-strong px-2 py-1 text-[13px] font-bold v2-num" /><span className="text-ink-faint">of {EUR(voucher)}</span><button onClick={() => setMix(m => ({ ...m, voucher }))} className="ml-auto text-[11px] font-bold text-tap-greenDeep hover:underline">Max</button></div>}
                  </MixComp>
                  <MixComp on={cashback_amt > 0} title="Cashback wallet" sub={`Balance: ${EUR(cashbackBal)}`} onToggle={() => setMix(m => ({ ...m, cashback: m.cashback > 0 ? 0 : cashbackBal }))} onEdit={() => setEditCash(v => !v)} right={<span className="text-[13px] font-bold v2-num">{EUR(cashback_amt)}</span>}>
                    {editCash && <div className="px-1 mt-2.5 flex items-center gap-2 text-[12px]"><span className="text-ink-muted">Apply $</span><input type="number" min="0" max={cashbackBal} step="1" value={mix.cashback || 0} onChange={e => setMix(m => ({ ...m, cashback: Math.max(0, Math.min(cashbackBal, +(+e.target.value).toFixed(2))) }))} className="w-24 rounded-lg border border-line-strong px-2 py-1 text-[13px] font-bold v2-num" /><span className="text-ink-faint">of {EUR(cashbackBal)}</span><button onClick={() => setMix(m => ({ ...m, cashback: cashbackBal }))} className="ml-auto text-[11px] font-bold text-tap-greenDeep hover:underline">Max</button></div>}
                  </MixComp>
                  <p className="text-[11px] text-ink-faint">Your live payment breakdown is shown in My trip basket on the right.</p>
                </div>;
              })()}
              {(method === "Digital Wallet" || method === "Bank transfer") && <div className="text-[13px] text-ink-muted">{method} selected — you'll be redirected to complete payment. (Demo charges your saved card for {EUR(t.total)}.)</div>}
              {method === "Split Payment" && (() => {
                const payers = [{ name: (trip.passengers?.[0]?.first ? trip.passengers[0].first + " (you)" : (u.first_name || "You") + " (you)"), email: trip.contact?.email || u.email || "you@email.com", card: u.card_last4 || "4242", status: "Pay now", lead: true }, ...Array.from({ length: Math.max(0, trip.pax - 1) }).map((_, i) => { const p = trip.passengers?.[i + 1]; return { name: p?.first ? `${p.first} ${p.last || ""}` : `Guest ${i + 1}`, email: "guest" + (i + 1) + "@email.com", card: ["1881", "1234", "5079"][i] || "0000", status: i === 0 ? "Link sent" : "Link pending" }; })];
                const equal = +(t.total / payers.length).toFixed(2);
                // Amount each payer owes, by mode. Custom Split reads the editable splitAmts map.
                const amtFor = (i) => splitTab === "Single Payer" ? (i === 0 ? t.total : 0) : splitTab === "Custom Split" ? (splitAmts[i] != null ? splitAmts[i] : equal) : equal;
                const custom = splitTab === "Custom Split";
                const allocated = +payers.reduce((s, _, i) => s + (amtFor(i) || 0), 0).toFixed(2);
                const balanced = Math.abs(allocated - t.total) < 0.01;
                const cur = getCurrency();   // Split #2 — split amounts follow the active display currency (same as Trip Basket)
                return <div className="text-[13px]">
                  <div className="flex gap-1 text-[13px] mb-3">{["Single Payer", "Split Equally", "Custom Split"].map(s => <button key={s} onClick={() => setSplitTab(s)} className={cx("border-b", splitTab === s ? "border-tap-green text-tap-greenDeep font-semibold" : "border-transparent text-ink-faint font-medium")} style={{ padding: "10px 16px" }}>{s}</button>)}</div>
                  {payers.map((p, i) => (
                    <div key={i} className="rounded-xl mb-2.5 flex items-center gap-3 flex-wrap" style={{ padding: "13px 16px", border: "1px solid #E0E3E8", background: "#FFFFFF" }}>
                      <span className="inline-flex items-center justify-center text-[13px] font-bold shrink-0" style={{ width: "36px", height: "36px", borderRadius: "18px", background: "#F7FAFA", color: "#1A1F29" }}>{p.name[0]}</span>
                      <div className="min-w-0"><div className="font-bold leading-tight text-[14px]" style={{ color: "#1A1F29" }}>{p.name}</div><div className="text-[12px] truncate" style={{ color: "#667080" }}>{p.email}</div></div>
                      <button className="inline-flex items-center gap-1 border border-line hover:border-tap-red shrink-0" style={{ borderRadius: "8px", padding: "6px 10px", fontSize: "12px", fontWeight: 500, color: "#0A0A0A" }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg> Remove</button>
                      <div className={cx("inline-flex items-center gap-1.5 rounded-lg border ml-auto", custom ? "border-tap-green bg-surface" : "border-line-strong")} style={{ padding: "8px 16px" }}>
                        <span className="text-[13px] text-ink-faint">{cur.symbol}</span>
                        {custom
                          ? <input type="number" min="0" step="0.01" value={amtFor(i) ? +(amtFor(i) * cur.rate).toFixed(2) : ""} onChange={e => { const raw = e.target.value.replace(/^0+(?=\d)/, ""); const nextAmt = +(+raw / cur.rate).toFixed(2); setSplitAmts(a => ({ ...a, [i]: Number.isFinite(nextAmt) ? Math.max(0, nextAmt) : 0 })); }} className="w-20 bg-transparent font-bold v2-num text-[18px] outline-none" style={{ color: "#1A1F29" }} aria-label={`Amount for ${p.name}`} />
                          : <span className="font-bold v2-num text-[18px]" style={{ color: "#1A1F29" }}>{(amtFor(i) * cur.rate).toFixed(2)}</span>}
                        <button type="button" onClick={() => { setSplitTab("Custom Split"); setSplitAmts(a => (a[i] != null ? a : { ...a, [i]: equal })); }} title={custom ? "Edit amount" : "Edit amounts — switch to a custom split"} aria-label="Edit amount" className="inline-flex items-center justify-center rounded hover:bg-surface-mute -mr-1 p-0.5">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={custom ? "var(--tap-green)" : "#171717"} style={{ opacity: custom ? 1 : 0.7 }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                        </button>
                      </div>
                      <div className="text-[13px] shrink-0 text-right" style={{ minWidth: "120px", fontWeight: 500, color: "#1A1F29" }}>{p.lead ? `Card •••• ${p.card}` : p.status}</div>
                      <button className="text-[13px] font-bold shrink-0 hover:underline text-right" style={{ minWidth: "72px", color: "#E00A0A" }}>{p.lead ? "Pay now" : p.status === "Link pending" ? "Send link" : "Resend"}</button>
                    </div>
                  ))}
                  <div className={cx("flex items-center justify-between text-[12px] font-semibold", balanced ? "bg-lime-tint/60 text-tap-greenDeep" : "bg-[#fdecec] text-tap-red")} style={{ borderRadius: "12px", padding: "13px 16px" }}>
                    <span>{custom ? "Allocated" : "Total split"}: {eurC(allocated)} of {eurC(t.total)}</span>
                    <span>{balanced ? "✓ Balanced" : allocated > t.total ? `Over by ${eurC(allocated - t.total)}` : `${eurC(t.total - allocated)} unallocated`}</span>
                  </div>
                  {custom && <button onClick={() => setSplitAmts({})} className="mt-2 text-[11px] font-semibold text-ink-muted hover:text-tap-greenDeep">Reset to equal split</button>}
                </div>;
              })()}
              {method === "Instalments" && (
                <div className="text-[13px]">
                  <div className="font-semibold text-[18px] flex items-center gap-2 mb-1" style={{ color: "#0A0A0A" }}><Icon name="clock" size={14} className="text-ink-faint" /> Pay in instalments</div>
                  <p className="text-[12px] text-ink-muted mb-3">Split {EUR(t.total)} into equal monthly payments — first today, the rest auto-charged to your saved card.</p>
                  <div className="grid sm:grid-cols-3 gap-2.5 mb-4">
                    {INST_PLANS.map(p => { const on = instN === p.n; const per = +((t.total * (1 + p.feeRate)) / p.n).toFixed(2); return (
                      <button key={p.n} onClick={() => setInstN(p.n)} className="text-left rounded-xl transition-colors" style={{ border: on ? "2px solid #46A41A" : "1px solid #E0E3E8", background: on ? "#F2FFDB" : "#FFFFFF", padding: "14px 16px" }}>
                        <div className="flex items-center justify-between"><div className="text-[15px] font-bold">{p.n}×</div>{p.feeRate === 0 ? <span className="text-[9px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5" style={{ background: "#E9F9D6", color: "#2E7D33" }}>0% interest</span> : <span className="text-[9px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 bg-surface-mute text-ink-muted">+{Math.round(p.feeRate * 100)}% fee</span>}</div>
                        <div className="text-[18px] font-bold v2-num mt-1.5">{EUR(per)}<span className="text-[11px] font-medium text-ink-faint"> /mo</span></div>
                        <div className="text-[11px] text-ink-faint mt-0.5">over {p.n} months</div>
                      </button>
                    ); })}
                  </div>
                  <div className="rounded-xl border border-line overflow-hidden">
                    <div className="bg-surface-soft px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-ink">Repayment schedule</div>
                    <div className="divide-y divide-line">
                      {instSchedule.map((s, idx) => (
                        <div key={idx} className="flex items-center justify-between px-4 py-2.5">
                          <div className="flex items-center gap-2.5"><span className="inline-flex items-center justify-center text-[11px] font-bold shrink-0" style={{ width: "26px", height: "26px", borderRadius: "13px", background: idx === 0 ? "#46A41A" : "#F2F2EE", color: idx === 0 ? "#fff" : "#667080" }}>{idx + 1}</span><div><div className="text-[13px] font-semibold">{idx === 0 ? "Today" : instDateLabel(idx)}</div>{idx === 0 && <div className="text-[10px] text-tap-greenDeep font-semibold">Charged now</div>}</div></div>
                          <span className="text-[14px] font-bold v2-num">{EUR(s.amt)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 rounded-lg bg-lime-tint text-tap-greenDark px-3 py-2.5 text-[12px] flex items-center gap-1.5"><Icon name="info" size={13} className="shrink-0" /> {instPlan.feeRate > 0 ? `Includes a ${Math.round(instPlan.feeRate * 100)}% service fee — ${EUR(instTotal)} total across ${instPlan.n} payments.` : `0% interest — you pay exactly ${EUR(t.total)}, spread over ${instPlan.n} months.`}</div>
                </div>
              )}
              {method === "Pay by Segment" && (
                <div className="text-[13px]">
                  <div className="font-semibold text-[18px] flex items-center gap-2 mb-1" style={{ color: "#0A0A0A" }}><Icon name="plane" size={14} className="text-ink-faint" /> Pay by segment</div>
                  <p className="text-[12px] text-ink-muted mb-3">{hasInbound ? "Pay for each flight independently — your booking confirms once both segments are settled." : "This is a one-way trip, so there's a single segment to pay."}</p>
                  {segList.map(s => { const paid = segPaid.has(s.key); return (
                    <div key={s.key} className="rounded-xl mb-2.5 flex items-center gap-3 flex-wrap" style={{ padding: "14px 16px", border: paid ? "1px solid #A6D926" : "1px solid #E0E3E8", background: paid ? "#F5FCD9" : "#FFFFFF" }}>
                      <span className="inline-flex items-center justify-center shrink-0" style={{ width: "36px", height: "36px", borderRadius: "10px", background: "#F7FAFA" }}><Icon name="plane" size={16} className="text-tap-greenDeep" /></span>
                      <div className="min-w-0"><div className="font-bold text-[14px] leading-tight">{s.label} · {s.f?.origin} → {s.f?.dest}</div><div className="text-[12px] text-ink-faint">{fmtDate(s.date).replace(/ \d{4}/, "")} · {s.f?.flight_no} · {s.sub}</div></div>
                      <div className="ml-auto text-right"><div className="text-[18px] font-bold v2-num">{EUR(s.amt)}</div></div>
                      <button disabled={paid} onClick={() => setSegPaid(p => new Set(p).add(s.key))} className={cx("shrink-0 inline-flex items-center gap-1.5 rounded-full text-[13px] font-semibold", paid ? "bg-lime-tint text-tap-greenDeep" : "text-white")} style={paid ? { padding: "9px 16px" } : { padding: "9px 18px", background: "#46A41A" }}>{paid ? <><Icon name="check" size={13} /> Paid</> : `Pay ${EUR(s.amt)}`}</button>
                    </div>
                  ); })}
                  <div className={cx("flex items-center justify-between text-[12px] font-semibold", bothSegPaid ? "bg-lime-tint/60 text-tap-greenDeep" : "bg-surface-soft text-ink-muted")} style={{ borderRadius: "12px", padding: "13px 16px" }}>
                    <span>{[...segPaid].filter(k => segList.some(s => s.key === k)).length} of {segList.length} segment{segList.length > 1 ? "s" : ""} paid</span>
                    <span>{bothSegPaid ? "✓ Ready to confirm" : `${EUR(segList.filter(s => !segPaid.has(s.key)).reduce((a, s) => a + s.amt, 0))} remaining`}</span>
                  </div>
                </div>
              )}
              <div className="mt-4 rounded-xl border border-line flex items-center text-[12px]" style={{ background: "#FAFAF7", padding: "18px", gap: "14px" }}><span className="inline-flex items-center justify-center shrink-0" style={{ width: "44px", height: "44px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E8E8E5" }}><Icon name="lock" size={16} className="text-ink-faint" /></span><div className="flex-1"><div className="font-semibold text-[13px]" style={{ color: "#0A0A0A" }}>Bank verification (3-D Secure) appears here when required</div><div className="text-[11px]" style={{ color: "#6B6B6B" }}>Your bank may ask you to confirm with a code, push notification, or biometric.</div></div><span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide rounded-full shrink-0" style={{ border: "1px solid #E8E8E5", background: "#FFFFFF", padding: "5px 10px" }}><Icon name="lock" size={10} /> 3-D Secure 2.0</span></div>
            </div>
            </Card>
            {billing}{terms}
            <Card className="p-3.5 flex flex-wrap items-center justify-between gap-3 text-[12px] text-ink font-medium">
              {[["lock", "PCI-DSS Level 1"], ["clock", "Free 24h cancellation"], ["star", "24/7 customer care"], ["check", "Instant confirmation"]].map(([ic, t2]) => <span key={t2} className="flex items-center gap-2"><span className="inline-flex items-center justify-center shrink-0" style={{ width: "28px", height: "28px", borderRadius: "8px", background: "#F5FFEB" }}><Icon name={ic} size={14} className="text-tap-greenDeep" /></span> {t2}</span>)}
            </Card>
          </div>
          {method === "Split Payment"
            ? <SplitSummary payers={splitPayers} amtFor={splitAmtFor} total={t.total} allocated={splitAllocated} leadAmt={splitLeadAmt} paid={splitPaid} onPayShare={payMyShare} onMarkPaid={markPaid} disabled={!agree || busy} busy={busy} onCta={pay} onBack={() => go("passenger")} />
            : <BasketSummary step={4} grouped cta={busy ? "Processing…" : method === "Mix Method" ? `Pay ${EUR(card_amt)} by card →` : method === "Instalments" ? `Pay ${EUR(instFirst)} today →` : method === "Pay by Segment" ? (bothSegPaid ? "Complete booking →" : "Pay each segment above") : `Pay ${EUR(t.total)} & complete booking`} disabled={!agree || busy || (method === "Pay by Segment" && !bothSegPaid)} onCta={pay} note={method === "Mix Method" ? `Card covers the ${EUR(card_amt)} balance after miles, voucher & wallet. By paying, you confirm fare conditions & privacy policy.` : method === "Instalments" ? `Then ${instPlan.n - 1} monthly payment${instPlan.n - 1 !== 1 ? "s" : ""} of ${EUR(instPer)}${instPlan.feeRate > 0 ? " · incl. fee" : " · 0% interest"}.` : method === "Pay by Segment" ? (bothSegPaid ? "Both segments settled — confirm to issue your tickets." : "Settle both flight segments above to continue.") : "By paying you confirm fare conditions & privacy policy."} secondary="← Back to passenger details" onSecondary={() => go("passenger")} user={u} breakdown={mixBreakdown} hideMiles={method === "Mix Method"} milesSwitch={method === "Mix Method" ? undefined : { tier: u.tier }} onMilesSwitch={() => setMethod("Xperion Miles")}
            footer={<>
              <div className="mt-2 rounded-xl bg-surface-soft border border-line px-3 py-2.5 flex items-start gap-2 text-[12px]"><Icon name="lock" size={13} className="text-tap-greenDeep mt-0.5 shrink-0" /><div><div className="font-bold">PCI-DSS Level 1</div><div className="text-ink-faint">Stripe encrypts and tokenises every card.</div></div></div>
              <div className="text-[11px] text-ink-faint text-center mt-2"><SessionTimer prefix="No charge yet · price locked" /></div>
            </>} />}
        </div>
      </div>
    </div>
  );
}

/* ═══════════ CONFIRMATION ═══════════ */
// D1 · Portugal Stopover builder — a personalized New York stopover (boutique vs budget
// hotels + curated experiences) with fully transparent per-component pricing, added to
// the itinerary as individual line items. Hotel tier is personalized to the member.
// B3 · Xperion Miles redemption shopping — a dedicated space to spend miles: cash+miles
// combinations on a fare, a miles-price calendar (off-peak vs peak), and miles-for-
// ancillaries. Uses the same MILES_RATE as the server so values reconcile at checkout.
export function MilesShop({ shared, go }) {
  const u = shared.profile?.user || {};
  const balance = u.miles || 42000;
  const route = { o: u.home_airport || "JFK", d: "GRU", cash: 489, label: `${u.home_airport || "JFK"} → São Paulo` };
  const [pct, setPct] = useState(40);
  const [dayIdx, setDayIdx] = useState(2);
  const [ancRedeemed, setAncRedeemed] = useState(() => new Set());
  const [done, setDone] = useState(false);
  const milesToEur = (m) => m * MILES_RATE;
  const eurToMiles = (e) => Math.round(e / MILES_RATE);
  // Cash + miles split on the fare, capped by the member's balance.
  const wantMilesEur = route.cash * (pct / 100);
  const milesUsed = Math.min(balance, eurToMiles(wantMilesEur));
  const cashPart = Math.max(0, route.cash - milesToEur(milesUsed));
  // Miles-price calendar — a week of dates, off-peak cheaper in miles.
  const days = useMemo(() => {
    const base = new Date("2026-07-10T00:00:00");
    return Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(base); dt.setDate(base.getDate() + i);
      const wd = dt.getDay(); const peak = wd === 5 || wd === 0; // Fri/Sun peak
      return { iso: dt.toISOString().slice(0, 10), label: dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }), miles: peak ? 58000 : 41500, peak };
    });
  }, []);
  const ANC = [
    { k: "bag", name: "Extra checked bag", miles: 6000 },
    { k: "seat", name: "Extra-legroom seat", miles: 4500 },
    { k: "lounge", name: "New York lounge access", miles: 7500 },
    { k: "wifi", name: "Full-flight Wi-Fi", miles: 3000 },
  ];
  const toggleAnc = (k) => setAncRedeemed(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const ancMiles = ANC.filter(a => ancRedeemed.has(a.k)).reduce((s, a) => s + a.miles, 0);
  if (done) return (
    <div className="mx-auto max-w-content px-6 py-10">
      <div className="flex items-center gap-3"><span className="w-11 h-11 rounded-full bg-tap-green text-white inline-flex items-center justify-center"><Icon name="spark" size={22} /></span><div><h1 className="text-[26px] font-black">Redemption confirmed</h1><div className="text-[13px] text-ink-muted">{route.label} · paid with Xperion Miles</div></div></div>
      <Card className="p-5 mt-6">
        <div className="space-y-1.5 text-[13px]">
          <Row label={`Fare · ${miles(milesUsed)} miles + cash`} v={eurC(cashPart)} />
          {ANC.filter(a => ancRedeemed.has(a.k)).map(a => <Row key={a.k} label={`${a.name} · ${miles(a.miles)} miles`} v={"—"} />)}
        </div>
        <Divider className="my-3" />
        <div className="flex justify-between text-[14px] font-black"><span>Miles redeemed</span><span className="v2-num">{miles(milesUsed + ancMiles)}</span></div>
        <div className="flex justify-between text-[13px] mt-1"><span className="text-ink-muted">Remaining balance</span><span className="v2-num font-semibold">{miles(Math.max(0, balance - milesUsed - ancMiles))}</span></div>
      </Card>
      <div className="flex gap-3 mt-5"><Btn onClick={() => go("home")}>Done</Btn><Btn variant="outline" onClick={() => setDone(false)}>Redeem more</Btn></div>
    </div>
  );
  return (
    <div className="mx-auto max-w-page px-4 sm:px-6 py-8">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <Eyebrow>Miles &amp; Go · redemption</Eyebrow>
          <h1 className="text-[30px] font-black mt-1">Shop with your miles</h1>
          <p className="text-[13px] text-ink-muted mt-1">Combine cash and miles, find the cheapest dates in miles, or spend miles on extras.</p>
        </div>
        <div className="rounded-2xl bg-surface-dark text-white px-5 py-3 text-right"><div className="text-[10px] uppercase tracking-widest text-white/50">Your balance</div><div className="text-[24px] font-black v2-num text-lime">{miles(balance)}</div><div className="text-[10px] text-white/60">≈ {EUR(milesToEur(balance))} value</div></div>
      </div>
      <div className="grid lg:grid-cols-2 gap-5 mt-6 items-start">
        <Card className="p-5">
          <div className="text-[13px] font-bold">Cash + Miles · {route.label}</div>
          <div className="text-[11px] text-ink-faint mb-3">Slide to choose how much of the {EUR(route.cash)} fare to cover with miles.</div>
          <input type="range" min="0" max="100" value={pct} onChange={e => setPct(+e.target.value)} className="w-full accent-tap-green" />
          <div className="flex justify-between text-[10px] text-ink-faint"><span>All cash</span><span>{pct}% miles</span><span>Max miles</span></div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="rounded-xl bg-lime-tint/50 p-3 text-center"><div className="text-[10px] font-bold uppercase text-tap-greenDeep">Miles used</div><div className="text-[20px] font-black v2-num">{miles(milesUsed)}</div></div>
            <div className="rounded-xl bg-surface-soft p-3 text-center"><div className="text-[10px] font-bold uppercase text-ink-muted">Cash to pay</div><div className="text-[20px] font-black v2-num">{EUR(cashPart)}</div></div>
          </div>
          {milesUsed >= balance && pct > 0 && <div className="text-[11px] text-[#9a6b00] mt-2">Capped at your available balance.</div>}
          <Btn className="w-full mt-4" onClick={() => setDone(true)}>Redeem {miles(milesUsed)} miles + {EUR(cashPart)}</Btn>
        </Card>
        <div className="space-y-5">
          <Card className="p-5">
            <div className="text-[13px] font-bold">Miles calendar</div>
            <div className="text-[11px] text-ink-faint mb-3">Miles price per departure date — off-peak is cheaper.</div>
            <div className="grid grid-cols-7 gap-1.5">
              {days.map((d, i) => (
                <button key={d.iso} onClick={() => setDayIdx(i)} className={cx("rounded-lg border p-1.5 text-center transition-colors", dayIdx === i ? "border-tap-green bg-lime-tint ring-1 ring-tap-green" : d.peak ? "border-line bg-surface-soft" : "border-line")}>
                  <div className="text-[10px] font-semibold">{d.label}</div>
                  <div className="text-[10px] font-black v2-num mt-0.5">{Math.round(d.miles / 1000)}k</div>
                  {!d.peak && <div className="text-[8px] font-bold text-tap-greenDeep uppercase">off-peak</div>}
                  {d.peak && <div className="text-[8px] font-bold text-ink-faint uppercase">peak</div>}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-ink-muted mt-2.5">Selected: <span className="font-semibold text-ink">{days[dayIdx].label}</span> · {miles(days[dayIdx].miles)} miles one-way</div>
          </Card>
          <Card className="p-5">
            <div className="text-[13px] font-bold">Spend miles on extras</div>
            <div className="text-[11px] text-ink-faint mb-3">Redeem miles for ancillaries instead of cash.</div>
            <div className="space-y-2">
              {ANC.map(a => {
                const on = ancRedeemed.has(a.k);
                return (
                  <button key={a.k} onClick={() => toggleAnc(a.k)} className={cx("w-full flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left transition-colors", on ? "border-tap-green bg-lime-tint/40 ring-1 ring-tap-green" : "border-line hover:border-line-strong")}>
                    <span className="text-[13px] font-semibold">{a.name}</span>
                    <span className="text-[12px] font-black v2-num inline-flex items-center gap-1">{miles(a.miles)} mi {on && <Icon name="check" size={13} className="text-tap-green" />}</span>
                  </button>
                );
              })}
            </div>
            {ancMiles > 0 && <div className="flex justify-between text-[13px] font-bold mt-3 pt-3 border-t border-line"><span>Extras total</span><span className="v2-num">{miles(ancMiles)} miles</span></div>}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function StopoverBuilder({ shared, go }) {
  const u = shared.profile?.user || {};
  const premium = /gold|platin|business|executive/i.test(`${u.tier || ""} ${trip.outbound?.fare || ""}`);
  const [nights, setNights] = useState(2);
  const [hotel, setHotel] = useState(premium ? "boutique" : "smart");
  const [exps, setExps] = useState(() => new Set(["sintra"]));
  const [transfer, setTransfer] = useState(true);
  const [added, setAdded] = useState(false);
  const HOTELS = [
    { k: "boutique", name: "Boutique · Chiado heritage", area: "Chiado", rate: 145, tag: premium ? "Recommended for you" : "Premium", note: "Design hotel in the historic centre" },
    { k: "smart", name: "Smart · Baixa central", area: "Baixa", rate: 95, tag: premium ? "Great value" : "Recommended for you", note: "Modern rooms steps from the river" },
    { k: "budget", name: "Budget · Wynwood guesthouse", area: "Wynwood", rate: 62, tag: "Lowest price", note: "Simple, characterful, central" },
  ];
  const EXPS = [
    { k: "sintra", name: "Key West & Pena Palace", dur: "Full day", price: 89 },
    { k: "tram", name: "Tram 28 & Wynwood walk", dur: "3 hours", price: 35 },
    { k: "fado", name: "Fado dinner in Bairro Alto", dur: "Evening", price: 68 },
    { k: "food", name: "Time Out Market food tour", dur: "3 hours", price: 55 },
  ];
  const hotelObj = HOTELS.find(h => h.k === hotel) || HOTELS[1];
  const hotelCost = hotelObj.rate * nights;
  const expList = EXPS.filter(e => exps.has(e.k));
  const expCost = expList.reduce((s, e) => s + e.price, 0);
  const transferCost = transfer ? 28 : 0;
  const total = hotelCost + expCost + transferCost;
  const toggleExp = (k) => setExps(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const addToTrip = () => {
    if (trip.outbound) {
      trip.extras = (trip.extras || []).filter(x => !/^stopover-/.test(x.code));
      toggleExtra({ code: "stopover-hotel", name: `New York stopover · ${hotelObj.name} × ${nights}n`, price: hotelCost, cat: "Stopover" });
      expList.forEach(e => toggleExtra({ code: "stopover-exp-" + e.k, name: `Stopover · ${e.name}`, price: e.price, cat: "Stopover" }));
      if (transfer) toggleExtra({ code: "stopover-transfer", name: "Stopover · airport transfer", price: transferCost, cat: "Stopover" });
      trip.stopover = { nights, hotel: hotelObj.name, experiences: expList.map(e => e.name), total, viaHub: true, segments: [{ from: trip.outbound?.flight?.origin, to: "JFK" }, { from: "JFK", to: trip.outbound?.flight?.dest }] };
      pingBasket();
    }
    setAdded(true); window.scrollTo({ top: 0 });
  };
  if (added) return (
    <div className="mx-auto max-w-content px-6 py-10">
      <div className="flex items-center gap-3"><span className="w-11 h-11 rounded-full bg-tap-green text-white inline-flex items-center justify-center"><Icon name="check" size={22} /></span><div><h1 className="text-[26px] font-black">Stopover added</h1><div className="text-[13px] text-ink-muted">{nights} nights in New York · {hotelObj.name}</div></div></div>
      <Card className="p-5 mt-6">
        <div className="text-[13px] font-bold mb-2">Your New York stopover</div>
        <div className="space-y-1.5 text-[13px]">
          <Row label={`${hotelObj.name} × ${nights} nights`} v={eurC(hotelCost)} />
          {expList.map(e => <Row key={e.k} label={e.name} v={eurC(e.price)} />)}
          {transfer && <Row label="Airport transfer" v={eurC(transferCost)} />}
        </div>
        <Divider className="my-3" />
        <div className="flex justify-between text-[15px] font-black"><span>Stopover total</span><span className="v2-num">{eurC(total)}</span></div>
      </Card>
      <div className="flex gap-3 mt-5">{trip.outbound ? <Btn onClick={() => go("cart")}>Review in cart →</Btn> : <Btn onClick={() => go("home")}>Book a flight via New York →</Btn>}<Btn variant="outline" onClick={() => setAdded(false)}>Edit stopover</Btn></div>
    </div>
  );
  return (
    <div className="mx-auto max-w-page px-4 sm:px-6 py-8">
      <Eyebrow>Portugal Stopover · free on Xperion long-haul via New York</Eyebrow>
      <h1 className="text-[30px] font-black mt-1">Break your trip in New York</h1>
      <p className="text-[13px] text-ink-muted mt-1 max-w-2xl">Stop over for up to a few nights at no extra airfare. We've tailored the picks to your profile{premium ? " — boutique stays first, as a " + (u.tier || "premium") + " member." : "."} Every component is priced separately — add only what you want.</p>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_330px] gap-6 mt-6 items-start">
        <div className="space-y-5">
          {trip.outbound && trip.outbound.flight.origin !== "JFK" && trip.outbound.flight.dest !== "JFK" && (() => {
            const of = trip.outbound.flight;
            const cityOf = (c) => (shared?.airports || []).find(a => a.code === c)?.city || c;
            const shiftHM = (hm, mins) => { const [h, m] = String(hm || "00:00").split(":").map(Number); const t = ((h * 60 + m + mins) % 1440 + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
            const lisArr = shiftHM(of.arr, -125), lisDep = shiftHM(of.arr, -70);
            const Seg = ({ dep, from, fromCity, arr, to, toCity, label }) => (
              <div className="flex items-center gap-3">
                <div className="w-16 shrink-0"><div className="text-[18px] font-bold v2-num leading-none">{dep}</div><div className="text-[11px] text-ink-faint mt-0.5">{from} · {fromCity}</div></div>
                <div className="flex-1 text-center text-[11px] text-ink-muted">{label}<div className="mx-auto my-1" style={{ width: "100%", maxWidth: "120px", height: "2px", background: "#E0E2E8" }} /><div className="text-[10px]">Direct</div></div>
                <div className="w-16 shrink-0 text-right"><div className="text-[18px] font-bold v2-num leading-none">{arr}</div><div className="text-[11px] text-ink-faint mt-0.5">{to} · {toCity}</div></div>
              </div>
            );
            return (
              <Card className="p-5" style={{ border: "1px solid #E0E2E8", borderRadius: "12px", boxShadow: "none" }}>
                <div className="flex items-center justify-between mb-3"><div className="text-[13px] font-bold">Your journey via New York</div><span className="text-[10px] font-bold uppercase tracking-wide rounded-full" style={{ background: "#F2FFDB", color: "#2E7D33", padding: "4px 10px" }}>Stopover</span></div>
                <Seg dep={of.dep} from={of.origin} fromCity={cityOf(of.origin)} arr={lisArr} to="JFK" toCity="New York" label={`Segment 1 · ${String(of.flight_no).replace(/([A-Za-z]+)\s*(\d+)/, "$1 $2")}`} />
                <div className="my-2.5 flex items-center gap-2 text-[12px] font-semibold" style={{ color: "#2E7D33" }}><Icon name="clock" size={13} /> Stopover · {nights} night{nights > 1 ? "s" : ""} in New York</div>
                <Seg dep={lisDep} from="JFK" fromCity="New York" arr={of.arr} to={of.dest} toCity={cityOf(of.dest)} label="Segment 2 · TP short-haul" />
                <div className="mt-3 text-[11px] text-ink-faint">Your long-haul routes through Xperion's New York hub — the stopover simply extends your connection at no extra airfare.</div>
              </Card>
            );
          })()}
          <Card className="p-5">
            <div className="text-[13px] font-bold mb-2.5">How many nights?</div>
            <div className="flex gap-2">{[1, 2, 3].map(n => <button key={n} onClick={() => setNights(n)} className={cx("flex-1 rounded-xl border py-2.5 text-[14px] font-bold transition-colors", nights === n ? "border-tap-green bg-lime-tint text-tap-greenDeep ring-1 ring-tap-green" : "border-line hover:border-line-strong")}>{n} night{n > 1 ? "s" : ""}</button>)}</div>
          </Card>
          <Card className="p-5">
            <div className="text-[13px] font-bold mb-2.5">Where to stay</div>
            <div className="space-y-2.5">
              {HOTELS.map(h => {
                const on = hotel === h.k;
                return (
                  <button key={h.k} onClick={() => setHotel(h.k)} className={cx("w-full text-left rounded-xl border p-3.5 transition-colors flex items-center justify-between gap-3", on ? "border-tap-green bg-lime-tint/40 ring-1 ring-tap-green" : "border-line hover:border-line-strong")}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><span className="text-[14px] font-bold">{h.name}</span><span className={cx("text-[9px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5", h.tag.includes("you") ? "bg-tap-green text-white" : "bg-surface-mute text-ink-muted")}>{h.tag}</span></div>
                      <div className="text-[11px] text-ink-faint mt-0.5">{h.note}</div>
                    </div>
                    <div className="text-right shrink-0"><div className="text-[15px] font-black v2-num">{eurC(h.rate)}</div><div className="text-[10px] text-ink-faint">/ night</div></div>
                  </button>
                );
              })}
            </div>
          </Card>
          <Card className="p-5">
            <div className="text-[13px] font-bold mb-2.5">Add experiences</div>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {EXPS.map(e => {
                const on = exps.has(e.k);
                return (
                  <button key={e.k} onClick={() => toggleExp(e.k)} className={cx("text-left rounded-xl border p-3 transition-colors", on ? "border-tap-green bg-lime-tint/40 ring-1 ring-tap-green" : "border-line hover:border-line-strong")}>
                    <div className="flex items-center justify-between"><span className="text-[13px] font-bold">{e.name}</span><span className={cx("w-4 h-4 rounded inline-flex items-center justify-center shrink-0", on ? "bg-tap-green text-white" : "border border-line-strong")}>{on && <Icon name="check" size={10} />}</span></div>
                    <div className="text-[11px] text-ink-faint mt-0.5">{e.dur}</div>
                    <div className="text-[13px] font-black v2-num mt-1">{eurC(e.price)}</div>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
        <aside className="lg:sticky lg:top-24 space-y-3">
          <Card className="p-5">
            <div className="text-[13px] font-bold mb-3">Stopover summary</div>
            <div className="space-y-1.5 text-[12.5px]">
              <div className="flex justify-between"><span className="text-ink-muted">{hotelObj.name.split(" · ")[0]} × {nights}n</span><span className="font-semibold v2-num">{eurC(hotelCost)}</span></div>
              {expList.map(e => <div key={e.k} className="flex justify-between"><span className="text-ink-muted truncate pr-2">{e.name}</span><span className="font-semibold v2-num">{eurC(e.price)}</span></div>)}
              <label className="flex justify-between items-center cursor-pointer"><span className="text-ink-muted inline-flex items-center gap-1.5"><input type="checkbox" checked={transfer} onChange={() => setTransfer(v => !v)} className="accent-tap-green" /> Airport transfer</span><span className="font-semibold v2-num">{eurC(28)}</span></label>
            </div>
            <Divider className="my-3" />
            <div className="flex justify-between text-[16px] font-black"><span>Total</span><span className="v2-num">{eurC(total)}</span></div>
            <div className="text-[10px] text-ink-faint mt-1">Airfare unchanged · stopover billed as add-ons</div>
            <Btn className="w-full mt-3" onClick={addToTrip}>{trip.outbound ? "Add to my trip" : "Build stopover"}</Btn>
            {!trip.outbound && <div className="text-[11px] text-ink-faint mt-2 text-center">Tip: search a long-haul via New York to attach this to a booking.</div>}
          </Card>
        </aside>
      </div>
    </div>
  );
}

export function Confirmation({ shared, go }) {
  const [recs, setRecs] = useState([]);
  // v33 Booking Confirmed #4 — everything on this page keys off the CURRENT booking; a new
  // PNR resets local state and re-fetches, so no data from a previous booking can linger.
  useEffect(() => { api.get("/destinations").then(d => setRecs((d || []).slice(0, 4))).catch(() => {}); }, [trip.pnr]);
  const [walletAdded, setWalletAdded] = useState(false);
  useEffect(() => { setAddedRecs(new Set()); setWalletAdded(false); }, [trip.pnr]);
  // A14 · contextual ancillary recommendations for THIS booking — derived from route,
  // trip length, party size and what was NOT already purchased. Limited to 3, added to the PNR.
  // v35 Booking Confirmed #1: the added set must survive leaving and returning to this page, so
  // it is mirrored on the module-level trip object (server state is the ultimate truth; this is
  // the session mirror of it).
  const [addedRecs, setAddedRecs] = useState(() => new Set(trip.recsAdded || []));
  const ancRecs = (() => {
    const ob = trip.outbound; const dst = ob?.flight?.dest;
    const hasBag = (trip.extras || []).some(e => /bag/i.test(e.code || "") || /bag|luggage/i.test(e.name || ""));
    const days = (trip.date && trip.ret) ? Math.max(1, Math.round((new Date(trip.ret) - new Date(trip.date)) / 864e5)) : null;
    const px = trip.pax || 1;
    const CITY = { JFK: "New York", EWR: "New York", BOS: "Boston", GRU: "São Paulo", GIG: "Rio de Janeiro", FCO: "Rome", CDG: "Paris", MCO: "Orlando", CUN: "Cancún", JFK: "New York", MIA: "Miami", MAD: "Madrid", LHR: "London" };
    const city = CITY[dst] || dst || "your destination";
    const out = [];
    if (!hasBag) out.push({ code: "bag", name: "Add a checked bag", sub: `You booked with cabin bag only${days && days >= 7 ? ` — handy for a ${days}-day trip` : ""}.`, price: 30, tag: "Most added after booking" });
    if (days && days <= 2) out.push({ code: "transfer", name: `Airport parking at ${ob?.flight?.origin || "departure"}`, sub: `A quick ${days}-day trip — park & fly, skip transfers.`, price: 24, tag: "For short trips" });
    else out.push({ code: "transfer", name: `Airport transfer in ${city}`, sub: "Private car, airport → your hotel.", price: 28, tag: "Skip the taxi queue" });
    if (px >= 3) out.push({ code: "lounge", name: "Family lounge access", sub: `${px} travellers · relax together before boarding.`, price: 22, tag: "For your group" });
    else out.push({ code: "xsell-sintra", name: `A day out near ${city}`, sub: "Hand-picked local experience · small group.", price: 89, tag: "Make the most of it" });
    return out.slice(0, 3);
  })();
  // v33 Booking Confirmed #3 — recommendations TOGGLE: clicking "Added ✓" removes the item again.
  const toggleRec = async (code) => {
    const on = addedRecs.has(code);
    setAddedRecs(prev => { const n = new Set(prev); on ? n.delete(code) : n.add(code); return n; });
    let ok = false;
    try { const r = await api.post("/bookings/ancillary", { pnr: trip.pnr, code, ...(on ? { remove: true } : {}) }); ok = !!(r && r.ok !== false); } catch { ok = false; }
    // Server rejected (e.g. code absent from the ancillaries catalogue) — undo the optimistic flip rather than show a state the booking does not have.
    if (!ok) { setAddedRecs(prev => { const n = new Set(prev); on ? n.add(code) : n.delete(code); return n; }); return; }
    // Every other booking mutation notifies; this one did not, so Add Extras and the shell kept a stale items list.
    trip.recsAdded = on ? (trip.recsAdded || []).filter(c => c !== code) : [...new Set([...(trip.recsAdded || []), code])];
    try { window.dispatchEvent(new Event("tap:booking-changed")); } catch { }
  };
  if (!trip.pnr) return noTrip(go);
  const pay = trip.payment || {}, o = trip.outbound, i = trip.inbound, u = shared.profile?.user || {}, t = tripTotals();
  const pax = trip.passengers.filter(p => p && p.first).length ? trip.passengers.filter(p => p && p.first) : [{ first: u.first_name, last: "" }];
  // Seat display driven by the booked fare so Executive/Plus never show an economy seat (e.g. Daniel's 4C).
  const leadSeat = chosenSeat() || trip.seat || seatForFare(o?.fare);
  const inSeat = i ? seatForFare(i.fare) : null;
  const seatClass = seatClassLabel(o?.fare);
  // #13 — quick actions now produce real downloads (e-ticket / boarding pass text, .ics calendar).
  const ticketText = () => {
    const seg = (c, d, seat) => c ? `${c.flight.origin} -> ${c.flight.dest}  ${c.flight.flight_no}\n  ${fmtDate(d)} · dep ${c.flight.dep} · arr ${c.flight.arr} · seat ${seat}` : "";
    return [`Xperion AIR PORTUGAL — E-TICKET`, `PNR: ${trip.pnr}`, `Passenger(s): ${pax.map(p => `${p.first} ${p.last || ""}`.trim()).join(", ")}`, ``, seg(o, trip.date, leadSeat), i ? seg(i, trip.ret, inSeat || "22B") : "", ``, `Total paid: ${EUR(t.total)}`].filter(Boolean).join("\n");
  };
  const addCalendar = () => { const events = [o, i].filter(Boolean).map((c, n) => (buildICS({ title: `Xperion ${c.flight.flight_no} ${c.flight.origin}→${c.flight.dest}`, start: `${c === o ? trip.date : trip.ret}T${c.flight.dep || "08:00"}:00`, location: `${c.flight.origin} Airport`, description: `PNR ${trip.pnr} · seat ${c === o ? leadSeat : (inSeat || "22B")}` }).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/) || [""])[0].replace(/^UID:.*$/m, `UID:${trip.pnr}-${n}@flyxperion`)).filter(Boolean); const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Xperion Airways//FlyTAP//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events, "END:VCALENDAR", ""].join("\r\n"); downloadFile(`Xperion-${trip.pnr}.ics`, ics, "text/calendar"); };
  const downloadTicket = () => downloadFile(`eticket-${trip.pnr}.txt`, ticketText(), "text/plain");
  // v33 Booking Confirmed #2 — the invoice link DOWNLOADS a real PDF (was wrongly routed to the basket).
  const buildInvoicePdf = (lines) => {
    const esc = (t) => String(t).replace(/$/g, "EUR ").replace(/—/g, "-").replace(/[^\x20-\x7E]/g, "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const content = "BT /F1 11 Tf 50 792 Td 16 TL " + lines.map((l, n) => `(${esc(l)}) Tj T*`).join(" ") + " ET";
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n"; const offs = [];
    objs.forEach((o, n) => { offs.push(out.length); out += `${n + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return out;
  };
  const downloadInvoice = () => {
    const t2 = tripTotals();
    const rows = [
      "Xperion AIR PORTUGAL — INVOICE", "",
      `Invoice no: INV-${trip.pnr}`, `PNR: ${trip.pnr}`, `Date: ${new Date().toLocaleDateString("en-GB")}`,
      `Passenger: ${pax.map(px2 => `${px2.first} ${px2.last || ""}`.trim()).join(", ")}`, "",
      `Flights subtotal: ${eur2((o?.price || 0) + (i?.price || 0))}`,
      ...trip.extras.map(e => `${e.name}: ${eur2(e.price * (e.qty || 1))}`),
      "", `Total paid: ${eur2(pay.total ?? t2.total)}`, `Payment method: ${pay.method || "Card"}`,
      "", "This document serves as your receipt. Obrigado por voar Xperion.",
    ];
    downloadFile(`invoice-${trip.pnr}.pdf`, buildInvoicePdf(rows), "application/pdf");
  };
  // v33 Booking Confirmed #1 — Wallet is an integration flow, not a file download.
  const addWallet = () => setWalletAdded(true);
  return (
    <div className="bg-[rgba(255,255,255,1)] min-h-screen">
      <div className="mx-auto max-w-page px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3"><span className="w-11 h-11 rounded-full bg-tap-green text-white inline-flex items-center justify-center shrink-0"><Icon name="check" size={22} /></span><div><h1 className="text-[36px] font-bold leading-tight">Booking Confirmed</h1><div className="text-[16px] text-ink-muted leading-6">PNR {trip.pnr} · Receipt sent to {pay.email || u.email}</div></div></div>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 mt-6 items-start">
          <div className="space-y-6">
            <Card className="p-6" style={{ borderRadius: "18px", background: "#FFFFFF", borderColor: "#E8E8E5" }}>
              <div className="flex items-center gap-2 mb-3"><div className="font-semibold text-[16px]">Your itinerary</div><span className="text-[11px] font-bold uppercase tracking-wide bg-tap-red text-white rounded-md px-2.5 py-1">PNR {trip.pnr}</span></div>

              {/* Multi-trip basket: the other itineraries paid for in the same transaction */}
              {Array.isArray(trip.alsoBooked) && trip.alsoBooked.length > 0 && (
                <div className="rounded-xl mb-3" style={{ background: "#F2FCD9", border: "1px solid #2E7D33", padding: "12px 14px" }}>
                  <div className="text-[12px] font-bold" style={{ color: "#1A7333" }}>{trip.alsoBooked.length + 1} itineraries issued in this payment</div>
                  {trip.alsoBooked.map(b => (
                    <div key={b.pnr} className="flex items-center justify-between gap-2 text-[12px] mt-1.5">
                      <span className="truncate">{b.origin} → {b.dest}</span>
                      <span className="flex items-center gap-2 shrink-0"><span className="v2-num text-ink-muted">{eur2(b.total)}</span><span className="text-[10px] font-bold uppercase tracking-wide bg-tap-red text-white rounded-md px-2 py-0.5">PNR {b.pnr}</span></span>
                    </div>
                  ))}
                </div>
              )}              {(() => {
                const sh = (hm, m) => { const [h, mm] = String(hm || "00:00").split(":").map(Number); const t = ((h * 60 + mm + m) % 1440 + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
                const rows = (trip.stopover?.viaHub && o) ? [
                  { flight: { ...o.flight, dest: "JFK", arr: sh(o.flight.arr, -125), duration: "7h 15m" }, _lbl: "Outbound · Segment 1", _d: trip.date, _seat: leadSeat },
                  { _stop: trip.stopover.nights },
                  { flight: { ...o.flight, origin: "JFK", dep: sh(o.flight.arr, -70), duration: "1h 05m" }, _lbl: "Outbound · Segment 2", _d: trip.date, _seat: leadSeat },
                  ...(i ? [{ flight: i.flight, _lbl: "Return", _d: trip.ret, _seat: inSeat || "22B" }] : []),
                ] : [o, i].filter(Boolean).map((c, idx) => ({ flight: c.flight, _lbl: trip.type === "multi" ? `Flight ${idx + 1}` : null, _d: idx === 0 ? trip.date : trip.ret, _seat: idx === 0 ? leadSeat : (inSeat || "22B") }));
                return rows.map((c, idx) => c._stop ? (
                  <div key={idx} className="flex items-center gap-2 px-5 py-2 mb-2 text-[12px] font-semibold text-tap-greenDeep" style={{ borderTop: "1px dashed #DCDCD8", borderBottom: "1px dashed #DCDCD8" }}><Icon name="clock" size={13} /> Stopover · {c._stop} night{c._stop > 1 ? "s" : ""} in New York</div>
                ) : (
                <div key={idx} className="rounded-[12px] px-5 mb-2 flex flex-wrap items-center gap-4" style={{ background: "#f2ffdb", minHeight: "108px" }}>
                  <div><div className="text-[14px] font-bold" style={{ color: "#1A1F29" }}>{c.flight.origin}</div><div className="text-[26px] font-bold v2-num leading-none mt-0.5">{c.flight.dep}</div><div className="text-[11px] mt-1" style={{ color: "#667080" }}>Terminal 1</div></div>
                  <div className="flex-1 min-w-[170px] text-center"><div className="text-[12px] font-medium text-ink-muted">{c.flight.duration} · nonstop</div><div className="h-0.5 bg-ink/80 my-2 mx-auto max-w-[340px]" /><div className="text-[12px] font-semibold text-ink">{c._lbl ? c._lbl + " · " : ""}{fmtDate(c._d).replace(/(\w+) (\d+) \d+/, "$1 $2")} · {c.flight.flight_no} · {c.flight.aircraft}</div><div className="text-[11px] mt-0.5" style={{ color: "#667080" }}>{pax.length > 1 ? "Seats " : "Seat "}{pax.map((_, n) => adjSeat(c._seat, n)).join(" · ")} · Gate info 90 min before</div></div>
                  <div className="text-right"><div className="text-[14px] font-bold" style={{ color: "#1A1F29" }}>{c.flight.dest}</div><div className="text-[26px] font-bold v2-num leading-none mt-0.5">{c.flight.arr}</div><div className="text-[11px] mt-1" style={{ color: "#667080" }}>Terminal 1</div></div>
                </div>
                ));
              })()}
              <div className="flex flex-wrap gap-2 mt-3">{pax.map((p, n) => <span key={n} className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-surface text-ink rounded-[14px] shadow-sm" style={{ border: "1px solid #E8E8E5", padding: "7px 12px" }}><Icon name="user" size={11} className="text-ink-muted" /> {p.first} {p.last} · {inSeat && adjSeat(inSeat, n) !== adjSeat(leadSeat, n) ? `${adjSeat(leadSeat, n)} out · ${adjSeat(inSeat, n)} ret` : adjSeat(leadSeat, n)}</span>)}<span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-surface text-ink rounded-[14px] shadow-sm" style={{ border: "1px solid #E8E8E5", padding: "7px 12px" }}><Icon name="bag" size={11} className="text-ink-muted" /> Carry-on × {pax.length}</span><span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-surface text-ink rounded-[14px] shadow-sm" style={{ border: "1px solid #E8E8E5", padding: "7px 12px" }}><Icon name="seat" size={11} className="text-ink-muted" /> {seatClass}</span><span className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-surface text-ink rounded-[14px] shadow-sm" style={{ border: "1px solid #E8E8E5", padding: "7px 12px" }}><Icon name="star" size={11} className="text-ink-muted" /> {/exec/i.test(o?.fare || "") ? "Lounge access" : "Miles earned"}</span></div>
              <div className="flex flex-wrap gap-5 mt-4 text-[13px] font-semibold text-tap-greenDeep"><button onClick={addWallet} disabled={walletAdded} className={walletAdded ? "text-tap-greenDeep cursor-default" : "hover:underline"}>{walletAdded ? "Added to Wallet ✓" : "Add to Wallet"}</button><button onClick={addCalendar} className="hover:underline">Add to Calendar</button><button onClick={downloadTicket} className="hover:underline">Download e-ticket</button></div>
              <div className="text-[12px] text-ink-faint mt-3">Manage booking · check-in opens 24h before</div>
            </Card>
            <section>
              <h2 className="text-[24px] font-bold flex items-center gap-2"><Icon name="spark" size={20} className="text-tap-green" />Recommended for this trip</h2>
              <p className="text-[13px] mb-3" style={{ color: "#667080" }}>Tailored to your route, trip length and party · added straight to PNR {trip.pnr} · max 3.</p>
              <div className="grid sm:grid-cols-3 gap-4">
                {ancRecs.map(r => {
                  const on = addedRecs.has(r.code);
                  const rImg = (() => { const t = ((r.code || "") + " " + (r.name || "") + " " + (r.tag || "")).toLowerCase(); return /tour|day|sintra|highlight|sight|excursion/.test(t) ? "sintra.jpg" : /food|wine|tast|flavou|dining/.test(t) ? "wine-tour.jpg" : /transfer|car|ride|pickup|shuttle/.test(t) ? "return-transfer.jpg" : /checkout|late|hotel|room|stay|lounge/.test(t) ? "late-checkout.jpg" : "bairro-alto.jpg"; })();
                  return (
                    <Card key={r.code} className={cx("flex flex-col overflow-hidden", on && "ring-1 ring-tap-green bg-lime-tint/30")} style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.06)" }}>
                      {rImg && <div className="h-[148px] w-full overflow-hidden bg-surface-mute"><Img seed={"crec-" + r.code} src={PIMG + rImg} alt={r.name} className="w-full h-full object-cover" /></div>}
                      <div className="p-4 flex flex-col flex-1">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-tap-greenDeep bg-lime-tint rounded-full px-2 py-0.5 w-fit">{r.tag}</span>
                      <div className="font-bold text-[14px] mt-2">{r.name}</div>
                      <div className="text-[11px] text-ink-muted mt-1 flex-1 max-w-[280px]">{r.sub}</div>
                      <div className="flex items-center justify-between mt-3">
                        <div className="text-[20px] font-bold v2-num">{eur2(r.price)}</div>
                        <span className="inline-flex items-center gap-2">{on && <button onClick={() => go("addextras")} className="text-[11px] font-semibold text-tap-greenDeep hover:underline whitespace-nowrap">Review extras →</button>}<Btn size="sm" variant={on ? "primary" : "outline"} style={{ borderRadius: "20px", padding: "10px 14px" }} title={on ? "Remove from trip" : "Add to trip"} onClick={() => toggleRec(r.code)}>{on ? "Added ✓ · Remove" : "+ Add to trip"}</Btn></span>
                      </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
              {recs.length > 0 && <>
                <h2 className="text-[24px] font-bold mt-6 flex items-center gap-2"><Icon name="spark" size={20} className="text-tap-green" />Useful for your trip</h2>
                <p className="text-[13px] mb-3" style={{ color: "#667080" }}>Ideas for your next trip based on where you go.</p>
                <div className="grid sm:grid-cols-2 gap-6">
                  {recs.slice(0, 2).map(d => (
                    <Card key={d.code} className="overflow-hidden flex flex-col max-w-[388px]" style={{ borderRadius: "18px", borderColor: "#E8E8E5", boxShadow: "0px 4px 16px rgba(0,0,0,0.06)" }}>
                      <div className="relative">
                        <Img seed={"dest-" + d.code} src={d.image_url || imageFor(d.code, d.city)} alt={d.city} className="h-[148px] w-full object-cover rounded-t-[18px]" />
                        <span className="absolute top-3 left-3 text-[10px] font-bold uppercase tracking-wide bg-white/90 text-ink rounded-md px-2 py-1 shadow-sm">{d.tag || "Experience"}</span>
                      </div>
                      <div className="p-4 flex flex-col flex-1">
                        <div className="font-semibold text-[16px]">{d.city}</div>
                        <div className="text-[12px] text-ink-muted mt-1 flex-1 max-w-[280px]">{d.reason || d.tag}</div>
                        <div className="flex items-center justify-between mt-3">
                          <div><div className="text-[20px] font-bold v2-num">{eur2(d.price)}</div><div className="text-[11px]" style={{ color: "#9A9A9A" }}>per person</div></div>
                          <Btn size="sm" variant="outline" onClick={() => go("results", { origin: d.origin, dest: d.code })} style={{ borderRadius: "20px", padding: "10px 14px", borderColor: "#46A41A" }}>+ Add</Btn>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </>}
            </section>
          </div>
          <aside className="space-y-4">
            <Card className="p-5" style={{ borderRadius: "18px", borderColor: "#E8E8E5", boxShadow: "0px 8px 24px rgba(0,0,0,0.08)" }}>
              <div className="font-bold text-[16px]">Payment receipt</div>
              <div className="h-px my-3" style={{ background: "#E8E8E5" }} />
              <div className="space-y-1.5 text-[13px]"><Row label={`Fare x${trip.pax}`} v={eur2(t.flights)} /><Row label="Taxes & fees" v={eur2(t.taxes)} />{t.extras ? <Row label="Extras" v={eur2(t.extras)} /> : null}{pay.queued_total ? <Row label={`Other trips (${pay.queued_n || 1})`} v={eur2(pay.queued_total)} /> : null}{t.bundle ? <Row label="Bundle savings" v={"−" + eur2(t.bundle)} green /> : null}{pay.voucher_amt ? <Row label="Voucher" v={"−" + eur2(pay.voucher_amt)} green /> : null}{pay.miles_amt ? <Row label={`Miles (${miles(pay.miles_used)})`} v={"−" + eur2(pay.miles_amt)} green /> : null}{pay.cashback_amt ? <Row label="Cashback wallet" v={"−" + eur2(pay.cashback_amt)} green /> : null}</div>
              <div className="h-px my-3" style={{ background: "#E8E8E5" }} />
              <div className="rounded-xl overflow-hidden mt-1" style={{ background: "#FAFAF7", border: "1px solid #E8E8E5" }}>
                <div className="flex items-center justify-between gap-2" style={{ padding: "18px 20px" }}><div className="text-[12px] font-semibold text-ink">Paid · {(() => { const parts = []; if (pay.miles_used > 0) parts.push(`${miles(pay.miles_used)} miles`); if (pay.voucher_amt > 0) parts.push(`voucher ${eur2(pay.voucher_amt)}`); if ((pay.card_amt ?? t.total) > 0) parts.push(`${eur2(pay.card_amt ?? t.total)} card${u.card_last4 ? " ••" + u.card_last4 : ""}`); return parts.length ? parts.join(" + ") : (pay.method || "Card"); })()}</div><div className="text-[34px] font-bold text-tap-green v2-num">{eur2(pay.card_amt ?? t.total)}</div></div>
                {pay.payNote && <div className="text-[11px] text-tap-greenDeep font-semibold flex items-center gap-1.5" style={{ padding: "0 20px 14px" }}><Icon name="clock" size={12} className="shrink-0" /> {pay.payNote}</div>}
                <div style={{ padding: "14px 20px", borderTop: "1px solid #E8E8E5", background: "#F2FFDB" }}><div className="text-[13px] font-bold text-ink flex items-center gap-1.5"><Icon name="spark" size={13} className="text-tap-green" /> You earned {miles(EARN(t.total))} miles</div><div className="text-[11px] text-ink-muted mt-0.5">+ {Math.round(EARN(t.total) * 0.2)} status miles · 2 trips to next tier</div></div>
              </div>
              <button onClick={downloadInvoice} className="w-full mt-3 inline-flex items-center justify-center gap-2 text-[13px] font-semibold hover:brightness-95" style={{ height: "42px", borderRadius: "9999px", background: "#FFFFFF", border: "1px solid #E8E8E5", color: "#0A0A0A" }}>Download invoice (PDF)<span style={{ fontWeight: 400 }}>→</span></button>
            </Card>
            <Card className="p-4 text-[12px] space-y-2.5" style={{ borderRadius: "14px" }}><div className="flex items-start gap-2.5"><span className="text-tap-green mt-0.5"><Icon name="shield" size={15} /></span><div><div style={{ fontSize: "12px", fontWeight: 500, color: "#0A0A0A" }}>Free 24h cancellation</div><div style={{ color: "#667080" }}>Full refund on flights &amp; most extras.</div></div></div><div className="flex items-start gap-2.5"><span className="text-tap-green mt-0.5"><Icon name="heart" size={15} /></span><div><div style={{ fontSize: "12px", fontWeight: 500, color: "#0A0A0A" }}>24/7 Xperion Care</div><div style={{ color: "#667080" }}>Need help? Chat with us 24/7.</div></div></div></Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
const Row = ({ label, v, green }) => <div className="flex items-center justify-between"><span className="text-ink-muted">{label}</span><span className={cx("font-semibold v2-num", green && "text-tap-greenDeep")}>{v}</span></div>;

/* ═══════════ EXPRESS CHECKOUT (CH1·B4) — book your usual in two taps ═══════════ */
export function ExpressCheckout({ shared, go, params }) {
  const u = shared?.profile?.user || {};
  const pat = shared?.profile?.pattern || {};
  const airports = shared?.airports || [];
  const cityOf = (c) => airports.find(a => a.code === c)?.city || c;
  // Use the route the user actually searched (passed from the results page) when present;
  // otherwise fall back to the member's usual trip pattern.
  const origin = params?.origin || pat.origin || u.home_airport || "MIA", dest = params?.dest || pat.dest || "JFK";
  const date = params?.date || pat.recommendedDate || trip.date || "";
  const retDate = params?.ret || (() => { if (!date) return ""; const d = new Date(date); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); })();
  const [, force] = useState(0);
  const [seat, setSeat] = useState(null);
  const [bag, setBag] = useState(true), [carbon, setCarbon] = useState(true), [seatUp, setSeatUp] = useState(true), [agree, setAgree] = useState(false), [busy, setBusy] = useState(false);
  const [showFare, setShowFare] = useState(false); // #22: See fare rules toggle

  useEffect(() => {
    api.get("/seat-recommendation").then(setSeat).catch(() => {});
    if (trip.pnr) resetTrip();   // #18 — a completed booking must not seed a new Express Checkout session
    // #29 — a stale in-progress trip on a DIFFERENT route must not be reused, or the header (the usual
    // route) and the flight segments (the stale route, e.g. DEL/DXB) disagree. Rebuild to the usual route.
    if (trip.outbound && (trip.outbound.flight?.origin !== origin || trip.outbound.flight?.dest !== dest)) resetTrip();
    if (!trip.outbound) {
      Object.assign(trip, { origin, dest, date, ret: retDate, pax: Math.max(1, Number(params?.pax) || 1), cabin: params?.cabin || "Economy" });
      api.get(`/search?origin=${origin}&dest=${dest}&date=${date}`).then(r => {
        const f = (r.flights || []).find(x => x.flight_no === pat.usualOutNo) || (r.flights || []).find(x => x.recommended) || (r.flights || [])[0];
        if (f) setLeg("outbound", { flight: f, fare: "Classic", price: f.price, origin, dest, date });
        force(x => x + 1);
      }).catch(() => {});
      api.get(`/search?origin=${dest}&dest=${origin}&date=${retDate}`).then(r => {
        const f = (r.flights || []).find(x => x.flight_no === pat.usualBackNo) || (r.flights || []).find(x => x.recommended) || (r.flights || [])[0];
        if (f) setLeg("inbound", { flight: f, fare: "Classic", price: f.price });
        force(x => x + 1);
      }).catch(() => {});
    }
  }, []);

  // J1 — never render a stale in-progress trip whose route differs from the searched route, or the
  // header (searched route, e.g. New York ⇄ Miami) and the flight segments (a stale route, e.g. DEL/DXB)
  // disagree. Treat a route-mismatched leg as "not ready" so the loader holds until the effect above
  // resets and rebuilds the real route.
  const legOnRoute = (leg, from, to) => !!(leg && leg.flight && leg.flight.origin === from && leg.flight.dest === to);
  const o = legOnRoute(trip.outbound, origin, dest) ? trip.outbound : null;
  const i = legOnRoute(trip.inbound, dest, origin) ? trip.inbound : null;
  // v33 Express #5 — every traveller from the search is priced and shown; nothing is hardcoded to 1.
  const paxN = Math.max(1, Number(params?.pax) || Number(trip.pax) || 1);
  const paxRows = Array.from({ length: paxN }, (_, n) => n === 0
    ? (trip.passengers?.[0]?.first ? { ...trip.passengers[0], lead: true } : { first: u.first_name || "Traveller", last: (u.full_name || "").split(" ").slice(-1)[0] || "", lead: true })
    : (trip.passengers?.[n]?.first ? { ...trip.passengers[n], lead: false } : { first: `Traveller ${n + 1}`, last: "", lead: false }));
  const base = (o?.price || 0) * paxN;
  const seatNo = chosenSeat() || (/exec|plus|premium/i.test(o?.fare || "") ? seatForFare(o?.fare) : (seat?.seat || seatForFare(o?.fare)));
  const seatCost = seatUp ? 18 * paxN : 0, bagCost = bag ? 25 * paxN : 0, carbonCost = carbon ? 2 * paxN : 0;   // per traveller
  const taxes = Math.round((base + seatCost + bagCost + carbonCost) * 0.12);
  const total = base + seatCost + bagCost + carbonCost + taxes;
  const earn = Math.round(total * 2.88);

  async function pay() {
    if (!o) return; setBusy(true);
    try {
      const items = ["seat-" + seatNo, bag && "checked-bag", carbon && "carbon"].filter(Boolean);
      const r = await api.post("/pay", { flight_no: o.flight.flight_no, items, total, voucher_amt: 0, miles_used: 0, miles_amt: 0, card_amt: total, seat: seatNo, date, fare: o?.fare, cabin: fareCabin(o?.fare), inbound: i?.flight?.flight_no ? { flight_no: i.flight.flight_no, date: trip.ret } : null, pax: paxN, passengers: ((trip.passengers || []).filter(p => p && p.first).length ? (trip.passengers || []).filter(p => p && p.first) : paxRows).map(p => ({ title: p.title, first: p.first, last: p.last })) });
      if (r.ok) { trip.pnr = r.pnr; trip.seat = seatNo; trip.payment = { total, card_amt: total, method: "Card", email: r.email?.to }; go("confirmation"); }
      else alert("Payment could not be completed: " + (r.error || "unknown"));
    } catch (e) { alert("Payment error: " + e.message); } finally { setBusy(false); }
  }

  const Sec = ({ title, action, onAction, children }) => <Card className="p-5" style={{ borderRadius: "12px", border: "1px solid #E0E2E8", boxShadow: "none" }}><div className="flex items-center justify-between mb-2"><div className="font-bold text-[18px]">{title}</div>{action && <button onClick={onAction} className="text-[13px] font-semibold underline underline-offset-2 hover:brightness-90" style={{ color: "#46A41A" }}>{action}</button>}</div>{children}</Card>;

  return (
    <div className="bg-[rgba(255,255,255,1)] min-h-screen">
      <div className="bg-surface border-b border-line"><div className="mx-auto max-w-page px-4 sm:px-6 py-4 flex items-center gap-3 text-[13px] font-semibold"><span className="flex items-center gap-1.5 text-ink"><span className="w-5 h-5 rounded-full bg-lime text-ink inline-flex items-center justify-center text-[11px]">1</span> Review &amp; Pay</span><span className="flex-1 h-px bg-line-strong" /><span className="flex items-center gap-1.5 text-ink-faint"><span className="w-5 h-5 rounded-full bg-surface-mute text-ink-faint inline-flex items-center justify-center text-[11px]">2</span> Confirmation</span></div></div>
      <div className="mx-auto max-w-page px-4 sm:px-6 py-6">
        <h1 className="text-[26px] font-bold">Express checkout</h1>
        <p className="text-[13px] text-ink-muted mt-1">Review your total and pay securely to confirm your trip. No charge has been made until you click Pay.</p>
        {!o ? <Card className="p-10 text-center mt-6"><div className="text-[14px] text-ink-muted">Loading your usual {cityOf(origin)} ⇄ {cityOf(dest)} trip…</div></Card> : (
          <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 mt-6 items-start">
            <div className="space-y-[14px]">
              <Sec title={`Your trip · ${cityOf(o?.flight?.origin || origin)} ⇄ ${cityOf(o?.flight?.dest || dest)}`} action="Change flight" onAction={() => go("results", { origin, dest, date, ret: retDate, type: "round" })}>
                {[o, i].filter(Boolean).map((c, idx) => (
                  <div key={idx} className="py-2.5 border-t border-[#E0E2E8] first:border-0">
                    <span className="inline-block text-[11px] font-semibold uppercase tracking-wide text-ink rounded-full mb-1.5" style={{ background: "#F7F8FA", padding: "4px 10px" }}>{idx === 0 ? "Outbound" : "Return"} · {fmtDate(idx === 0 ? date : retDate).replace(/(\w+) (\d+) \d+/, "$1 $2")}</span>
                    <div className="flex items-center gap-3"><div><div className="text-[22px] font-bold v2-num">{c.flight.dep}</div><div className="text-[11px] text-ink-faint">{c.flight.origin} · {cityOf(c.flight.origin)}</div></div><div className="flex-1 text-center text-[11px] text-ink-muted">{c.flight.duration} · Direct<div className="my-1 mx-auto" style={{ width: "120px", maxWidth: "100%", height: "1px", background: "#E0E2E8" }} /><div className="font-semibold text-ink-muted">{c.flight.flight_no} · {c.flight.aircraft}</div></div><div className="text-right"><div className="text-[22px] font-bold v2-num">{c.flight.arr}</div><div className="text-[11px] text-ink-faint">{c.flight.dest} · {cityOf(c.flight.dest)}</div></div></div>
                  </div>
                ))}
                <div className="mt-2 pt-3 border-t border-[#E0E2E8] flex items-start justify-between gap-3"><div><div className="text-[13px] font-bold">Fare: Classic</div><div className="text-[11px] text-ink-muted mt-0.5">23kg bag · seat select · 50% refund · changes for fee</div></div><button onClick={() => setShowFare(v => !v)} className="text-[13px] font-semibold hover:brightness-90 shrink-0" style={{ color: "#46A41A" }}>{showFare ? "Hide fare rules" : "See fare rules"}</button></div>
                {showFare && <div className="mt-2 rounded-xl border border-line bg-surface-soft p-3 text-[12px] text-ink-muted space-y-1.5 v2-in">
                  <div className="flex justify-between"><span>Cabin bag (8kg) + checked bag (23kg)</span><span className="font-semibold text-ink">Included</span></div>
                  <div className="flex justify-between"><span>Seat selection</span><span className="font-semibold text-ink">Included</span></div>
                  <div className="flex justify-between"><span>Date / time change</span><span className="font-semibold text-ink">Fee + fare difference</span></div>
                  <div className="flex justify-between"><span>Cancellation refund</span><span className="font-semibold text-ink">50% of fare</span></div>
                  <div className="flex justify-between"><span>Miles earned</span><span className="font-semibold text-ink">100% (Classic)</span></div>
                </div>}
              </Sec>
              <Sec title={paxN > 1 ? `Passengers · ${paxN}` : "Passenger"} action="Edit" onAction={() => go("passenger")}>
                <div className="space-y-2.5">
                  {paxRows.map((p2, n) => (
                    <div key={n} className="flex items-center gap-3">
                      <span className="w-9 h-9 rounded-full inline-flex items-center justify-center text-[14px] font-bold" style={{ background: "#F7FAFA", color: "#1A1F29" }}>{(p2.first || "T")[0]}</span>
                      <div>
                        <div className="font-bold text-[14px] flex items-center gap-2">{[p2.first, p2.last].filter(Boolean).join(" ")}
                          {p2.lead
                            ? <span className="text-[11px] font-semibold rounded-full" style={{ background: "#FFF7E5", color: "#C8A24B", padding: "4px 10px" }}>{u.tier || "Gold"} · Lead</span>
                            : <span className="text-[11px] font-semibold rounded-full" style={{ background: "#F2F2EE", color: "#667080", padding: "4px 10px" }}>Adult</span>}
                        </div>
                        <div className="text-[11px] text-ink-faint mt-0.5">{p2.lead ? (u.email || "Contact on file") : "Details at check-in"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Sec>
              <Sec title="Baggage" action="+ Add bag" onAction={() => go("cart")}>
                <div className="flex items-center justify-between text-[13px] py-1"><div><div className="font-semibold">Cabin bag · 8kg</div><div className="text-[11px] text-ink-faint">Included in fare</div></div><span className="text-[11px] font-semibold uppercase tracking-wide text-ink rounded-full" style={{ background: "#F7F8FA", padding: "4px 10px" }}>Included</span></div>
                <div className="flex items-center justify-between text-[13px] py-1 mt-1"><div><div className="font-semibold">Checked bag · 23kg ×1</div><div className="text-[11px] text-ink-faint">Outbound + return</div></div><span className="v2-num font-bold">{eur2(25)}</span></div>
              </Sec>
              <Sec title="Payment method" action="+ Change" onAction={() => go("payment")}>
                <div className="flex items-center justify-between"><div className="text-[14px] font-semibold flex items-center gap-2">{u.first_name}'s Card <span className="font-bold tracking-wide" style={{ fontSize: "8px", color: "#336614", padding: "1px 4px" }}>VISA</span></div><span className="inline-flex items-center gap-1 font-bold uppercase tracking-wide rounded-full" style={{ background: "#F2FFDB", color: "#336614", padding: "5px 10px", fontSize: "11px" }}><Icon name="lock" size={10} /> Encrypted</span></div>
                <div className="text-[13px] v2-num mt-1 tracking-wide">XXXX XXXX XXXX {u.card_last4 || "4242"}</div>
                <div className="mt-3 flex items-center gap-3 text-[12px]" style={{ padding: "18px", borderRadius: "12px", border: "1px dashed #DCDCD8", background: "#FAFAF7" }}><span className="inline-flex items-center justify-center shrink-0" style={{ width: "44px", height: "44px", borderRadius: "10px", border: "1px solid #E8E8E5", background: "#FFFFFF" }}><Icon name="lock" size={16} className="text-ink-faint" /></span><div className="flex-1"><div className="font-semibold">Bank verification (3-D Secure) appears here when required</div><div className="text-ink-faint">Your bank may ask for a code, push, or biometric.</div></div><span className="text-[10px] font-bold uppercase tracking-wide rounded-full shrink-0" style={{ border: "1px solid #E8E8E5", background: "#FFFFFF", padding: "3px 10px" }}>3-D Secure 2.0</span></div>
              </Sec>
              <Sec title="Seat selection" action="Change seat" onAction={() => go("seatchange")}>
                <div className="flex items-center justify-between text-[13px] py-1"><div><div className="font-semibold">Outbound · {seatNo} ({seatZone(o?.fare)})</div><div className="text-[11px] text-ink-faint">{o.flight.flight_no} · {o.flight.aircraft} · Seat {seatNo}</div></div><span className="v2-num font-bold">{eur2(18)}</span></div>
                <div className="flex items-center justify-between text-[13px] py-1 mt-1"><div><div className="font-semibold">Return · {seatForFare(i?.fare)} ({seatZone(i?.fare)})</div><div className="text-[11px] text-ink-faint">{i?.flight?.flight_no || ""}{i ? ` · ${i.flight.aircraft} · Seat ${seatForFare(i?.fare)}` : ""}</div></div><span className="text-[10px] font-bold uppercase tracking-wide bg-surface-mute text-ink rounded px-2 py-0.5">Free · {u.tier}</span></div>
              </Sec>
              <Sec title="Contact details" action="Edit" onAction={() => go("passenger")}>
                <div className="text-[14px] font-semibold">{(u.email || "d•••@gmail.com").replace(/(.).+(@.+)/, "$1•••••$2")} · {u.phone || "+1 ••• 482"}</div>
                <div className="text-[11px] text-ink-faint mt-0.5">Boarding pass, receipt and IROPS alerts go here.</div>
              </Sec>
              <Card className="p-4" style={{ background: "#FAFAF7", border: "1px solid #E8E8E5", borderRadius: "10px", boxShadow: "none", padding: "14px" }}><label className="flex items-start gap-2.5 text-[13px]"><span className="mt-0.5 inline-flex items-center justify-center shrink-0 cursor-pointer" style={{ width: "20px", height: "20px", borderRadius: "5px", background: agree ? "#0A0A0A" : "#FFFFFF", border: "1px solid #0A0A0A" }} onClick={() => setAgree(!agree)}>{agree && <Icon name="check" size={12} className="stroke-[3]" style={{ color: "#9EFD38" }} />}</span><span className="flex-1"><span className="flex items-center gap-2 font-semibold">I accept the fare conditions</span><span className="block text-[11px] text-ink-muted mt-0.5">By continuing you agree to the <button className="font-semibold" style={{ color: "#0A0A0A" }}>fare conditions</button> · <button className="font-semibold" style={{ color: "#0A0A0A" }}>baggage rules</button> · <button className="font-semibold" style={{ color: "#0A0A0A" }}>privacy policy</button>.</span><span className="block text-[11px] text-ink-faint mt-1">You'll receive your booking confirmation and e-ticket after successful payment.</span></span><span className="shrink-0"><span className="font-bold uppercase tracking-wide text-white" style={{ background: "#ED1C24", fontSize: "9px", borderRadius: "999px", padding: "3px 8px" }}>Required</span></span></label></Card>
            </div>
            <aside className="space-y-4">
              <Card className="p-5" style={{ borderRadius: "12px", border: "1px solid #E0E2E8", background: "#FFFFFF", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                <div className="mb-3" style={{ fontSize: "20px", fontWeight: 600, color: "#0A0A0A", letterSpacing: "-0.01em" }}>My trip basket</div>
                <div className="space-y-2 text-[13px]"><Row label="Base fare · 1 adult" v={eur2(base)} /><Row label="Taxes & fees" v={eur2(taxes)} />{seatUp && <Row label={`Seat ${seatNo} · extra legroom`} v={eur2(seatCost)} />}{bag && <Row label="Checked bag 23kg" v={eur2(bagCost)} />}{carbon && <Row label="Carbon offset" v={eur2(carbonCost)} />}</div>
                <div className="my-3" style={{ height: "1px", background: "#E0E2E8" }} />
                <div className="flex items-center justify-between"><div style={{ fontSize: "15px", fontWeight: 600, color: "#0A0A0A" }}>Total to pay</div><div className="v2-num" style={{ fontSize: "28px", fontWeight: 700, color: "#0A0A0A" }}>{eur2(total)}</div></div>
                <div className="mt-3" style={{ background: "#EBF7ED", borderRadius: "8px", padding: "8px 12px", color: "#00874E", fontSize: "12px", fontWeight: 600 }}>Earn {miles(earn)} miles · or pay {miles(Math.round(total * 0.9 / MILES_RATE))} mi + {eur2(Math.round(total * 0.1))}</div>
                <div className="mt-3 flex items-stretch overflow-hidden" style={{ background: "#F7F8FA", border: "1px solid #E0E2E8", borderRadius: "8px" }}><input placeholder="Promo code" className="flex-1 bg-transparent outline-none" style={{ padding: "10px 12px", fontSize: "13px", color: "#666B80" }} /><button className="font-bold hover:brightness-95" style={{ padding: "0 16px", fontSize: "13px", color: "#46A41A" }}>Apply</button></div>
                <div className="mt-3 flex items-center flex-wrap" style={{ background: "#FFF5E0", borderRadius: "8px", padding: "8px 12px", gap: "8px", color: "#8C590D", fontSize: "12px", fontWeight: 600 }}><span style={{ color: "#e8920a", fontSize: "8px" }}>●</span> <SessionTimer minutes={15} prefix="Price held for" className="whitespace-nowrap" /><span className="whitespace-nowrap">· won't change if you pay now</span></div>
                <Btn size="lg" className="w-full mt-3" style={{ height: "60px", borderRadius: "9999px", background: "#46A41A", color: "#fff", fontSize: "15px", fontWeight: 700 }} disabled={!agree || busy} onClick={pay}>{busy ? "Processing…" : `Pay ${eur2(total)} securely`}</Btn>
                <div className="flex items-center justify-center gap-2 mt-2" style={{ fontSize: "13px", fontWeight: 600 }}><button className="hover:underline text-ink">Save &amp; pay later</button><span className="text-ink-faint">·</span><button onClick={() => go("payment")} className="hover:underline text-ink">Use miles instead</button></div>
                <div className="text-center mt-2 leading-relaxed" style={{ fontSize: "11px", color: "#666B80" }}>PCI · Visa · Mastercard · Amex · MB WAY · Apple Pay · PayPal<br />Free 24h cancellation · Refundable taxes · 24/7 support</div>
              </Card>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
