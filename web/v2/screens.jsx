// FlyTAP v2 — screens. Homepage (logged-out) + the personalized Home (returning
// user), built to the approved Figma and wired to the live backend. Remaining
// screens are scaffolded as a navigable map of the full program.
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { api, EUR, miles, fmtDate, tierProgress, MILES_RATE } from "./lib.js";
import { Btn, Card, Pill, Eyebrow, PersonalizedTag, TierBadge, Field, Input, Icon, Divider, Img, imageFor, WhyChip, Avatar, cx } from "./ui.jsx";
import { Page } from "./shell.jsx";
import { trip, setLeg, setFareHold } from "./trip.js";
import { Results } from "./results.jsx";
import { Cart, Basket, Passenger, Payment, Confirmation, ExpressCheckout, StopoverBuilder, MilesShop } from "./checkout.jsx";
import { AIConcierge } from "./ai.jsx";
import { ManageBooking, CabinUpgrade, SeatChange, Rebook, CheckInIndirect, AddExtras, Refund, Retrieve, SplitBooking, DisruptionCenter } from "./mmb.jsx";
import { DemoConsole } from "./demo.jsx";

const TRIP_TABS = ["Flights", "Flights + Hotel", "Hotels", "Experiences", "Cabs & Transfers", "Flight Status"];
const AICON = "/v2/assets/extras/";     // ancillary artwork (SVG — sharp at any size, unlike the 20px icon PNGs)
const ASSET = "/v2/assets/homepage/";   // #14/#5 — approved design assets

/* deterministic gradient "photo" header per city/route (real imagery can be added via AEM) */
const GRADS = [["#2e7d33", "#9efd38"], ["#1a1f29", "#46a41a"], ["#0a3d2e", "#c7f21f"], ["#163a4a", "#5ec6c0"], ["#3a2a1f", "#e8a23a"]];
function gradFor(seed) { let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0; const g = GRADS[h % GRADS.length]; return { background: `linear-gradient(135deg, ${g[0]}, ${g[1]})` }; }

/* ─────────────────────────── shared: search widget ─────────────────────────── */
// #13 — passenger configuration panel: separate Adults / Children / Infants counters (replaces adult-only dropdown).
function PaxPanel({ adults, children, infants, onChange, buttonClassName }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const summary = [
    `${adults} adult${adults !== 1 ? "s" : ""}`,
    children ? `${children} child${children !== 1 ? "ren" : ""}` : "",
    infants ? `${infants} infant${infants !== 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");
  const step = (k, delta, min, max) => {
    const cur = { adults, children, infants };
    cur[k] = Math.max(min, Math.min(max, cur[k] + delta));
    if (cur.infants > cur.adults) cur.infants = cur.adults;   // one lap infant per adult
    onChange(cur);
  };
  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (r) setPos({ left: r.left, top: r.bottom + 6, width: r.width }); };
  const toggle = () => { if (!open) place(); setOpen(o => !o); };
  useEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener("scroll", on, true); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); };
  }, [open]); // eslint-disable-line
  const Row = ({ label, sub, val, k, min = 0, max = 9 }) => (
    <div className="flex items-center justify-between py-2">
      <div><div className="text-[13px] font-semibold text-ink">{label}</div><div className="text-[11px] text-ink-faint">{sub}</div></div>
      <div className="flex items-center gap-2.5">
        <button type="button" disabled={val <= min} onClick={() => step(k, -1, min, max)} className="w-7 h-7 rounded-full border border-line-strong inline-flex items-center justify-center text-[16px] leading-none text-ink disabled:opacity-30 hover:border-tap-green">−</button>
        <span className="w-5 text-center text-[14px] font-bold v2-num">{val}</span>
        <button type="button" disabled={val >= max} onClick={() => step(k, 1, min, max)} className="w-7 h-7 rounded-full border border-line-strong inline-flex items-center justify-center text-[16px] leading-none text-ink disabled:opacity-30 hover:border-tap-green">+</button>
      </div>
    </div>
  );
  return (
    <div className="relative">
      <button ref={btnRef} type="button" onClick={toggle} className={buttonClassName || "w-full text-left bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] inline-flex items-center justify-between"}>{summary}<span className="text-ink-faint text-[10px] ml-2">▾</span></button>
      {open && pos && createPortal(<>
        <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
        <div className="fixed z-[61] bg-white rounded-xl border border-line shadow-pop p-3" style={{ left: pos.left, top: pos.top, width: "min(256px, calc(100vw - 24px))" }}>
          <Row label="Adults" sub="12+ years" val={adults} k="adults" min={1} />
          <div className="h-px bg-line" />
          <Row label="Children" sub="2–11 years" val={children} k="children" />
          <div className="h-px bg-line" />
          <Row label="Infants" sub="Under 2 · on lap" val={infants} k="infants" max={adults} />
          <button type="button" onClick={() => setOpen(false)} className="w-full mt-2 rounded-full bg-tap-green text-white py-2 text-[13px] font-semibold">Done</button>
        </div>
      </>, document.body)}
    </div>
  );
}
// #10 — airport picker: opens BELOW the field, with a search box that filters by code, city or country.
function AirportPicker({ value, onChange, airports = [], placeholder = "Select airport", buttonClassName }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const inputRef = useRef(null);
  const sel = airports.find(a => a.code === value);
  const ql = q.trim().toLowerCase();
  const list = (ql
    ? airports.filter(a => a.code.toLowerCase().includes(ql) || (a.city || "").toLowerCase().includes(ql) || (a.country || "").toLowerCase().includes(ql))
    : airports).slice(0, 80);
  const pick = (code) => { onChange(code); setOpen(false); setQ(""); };
  // Anchor the panel with position:fixed (viewport coords) so it escapes the
  // overflow-hidden search card / fields grid that would otherwise clip the results.
  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (r) setPos({ left: r.left, top: r.bottom + 6, width: r.width }); };
  const toggle = () => { if (!open) place(); setQ(""); setOpen(o => !o); };
  useEffect(() => {
    if (!open) return;
    place();
    // Focus the search box WITHOUT letting the browser scroll it into view. The panel is a
    // position:fixed portal appended to <body>; the default focus-on-mount scroll (what the
    // `autoFocus` attribute does) fired before the fixed coords were painted on the first open,
    // which scrolled the page to the footer. preventScroll keeps the viewport exactly where it is.
    const _ft = setTimeout(() => { try { inputRef.current?.focus({ preventScroll: true }); } catch { inputRef.current?.focus(); } }, 0);
    const on = () => place();
    window.addEventListener("scroll", on, true); window.addEventListener("resize", on);
    return () => { clearTimeout(_ft); window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); };
  }, [open]); // eslint-disable-line
  return (
    <div className="relative">
      <button ref={btnRef} type="button" onClick={toggle} className={buttonClassName || "w-full text-left bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] inline-flex items-center justify-between"}>
        {sel ? <span className="truncate min-w-0 flex-1"><span className="font-bold">{sel.code}</span><span className="text-ink-muted"> · {sel.city}</span></span> : <span className="text-ink-faint truncate min-w-0 flex-1">{placeholder}</span>}
        <span className="text-ink-faint text-[10px] ml-2 shrink-0">▾</span>
      </button>
      {open && pos && createPortal(<>
        <div className="fixed inset-0 z-[60]" onClick={() => { setOpen(false); setQ(""); }} />
        <div className="fixed z-[61] bg-white rounded-xl border border-line shadow-pop overflow-hidden" style={{ left: pos.left, top: pos.top, width: "min(288px, calc(100vw - 24px))" }}>
          <div className="p-2 border-b border-line">
            <div className="relative"><Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" /><input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search city, airport or country" className="w-full bg-surface border border-line rounded-lg pl-8 pr-3 py-2 text-[13px] outline-none focus:border-tap-green" /></div>
          </div>
          <div className="max-h-64 overflow-y-auto v2-track">
            {list.length === 0 && <div className="px-3 py-4 text-[12px] text-ink-faint text-center">No airports match "{q}"</div>}
            {list.map(a => (
              <button key={a.code} type="button" onClick={() => pick(a.code)} className={cx("w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-surface-mute transition-colors", a.code === value && "bg-lime-tint/40")}>
                <span className="w-9 shrink-0 text-[12px] font-bold text-ink v2-num">{a.code}</span>
                <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold truncate">{a.city}</span>{a.country && <span className="block text-[11px] text-ink-faint truncate">{a.country}</span>}</span>
                {a.code === value && <Icon name="check" size={14} className="text-tap-green shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      </>, document.body)}
    </div>
  );
}
// DatePicker — a calendar dropdown that matches AirportPicker exactly: a position:fixed portal
// anchored BELOW the field (never the native OS popup that opens upward), with the same design
// tokens (rounded-xl, border-line, shadow-pop) so the date field feels like part of the Xperion
// search module rather than a system component. value/onChange use ISO "YYYY-MM-DD" strings.
function DatePicker({ value, onChange, min, placeholder = "Select date", buttonClassName }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const parse = (s) => (s ? new Date(s + "T00:00:00") : null);
  const [view, setView] = useState(() => { const d = parse(value) || new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const btnRef = useRef(null);
  const sel = parse(value);
  const minD = parse(min);
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmtField = (d) => d ? `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}` : "";
  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (r) setPos({ left: r.left, top: r.bottom + 6, width: r.width }); };
  const toggle = () => { if (!open) { const d = sel || new Date(); setView({ y: d.getFullYear(), m: d.getMonth() }); place(); } setOpen(o => !o); };
  useEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener("scroll", on, true); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); };
  }, [open]); // eslint-disable-line
  // Build the 6×7 grid of days for the current view month, including trailing/leading days.
  const grid = (() => {
    const first = new Date(view.y, view.m, 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  })();
  const step = (delta) => setView(v => { const d = new Date(v.y, v.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const disabled = (d) => minD && d < minD && !sameDay(d, minD);
  const choose = (d) => { onChange(iso(d)); setOpen(false); };
  return (
    <div className="relative">
      <button ref={btnRef} type="button" onClick={toggle} className={buttonClassName || "w-full text-left bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[15px] inline-flex items-center justify-between"}>
        {sel ? <span className="truncate min-w-0 flex-1 font-bold">{fmtField(sel)}</span> : <span className="text-ink-faint truncate min-w-0 flex-1">{placeholder}</span>}
        <Icon name="calendar" size={14} className="text-ink-muted ml-2 shrink-0" />
      </button>
      {open && pos && createPortal(<>
        <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
        <div className="fixed z-[61] bg-white rounded-xl border border-line shadow-pop overflow-hidden" style={{ left: pos.left, top: pos.top, width: "min(300px, calc(100vw - 24px))" }}>
          <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2">
            <div className="text-[14px] font-bold text-ink">{MONTHS[view.m]} {view.y}</div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => step(-1)} className="w-7 h-7 rounded-lg hover:bg-surface-mute inline-flex items-center justify-center text-ink-muted" aria-label="Previous month"><Icon name="chevron-left" size={16} /></button>
              <button type="button" onClick={() => step(1)} className="w-7 h-7 rounded-lg hover:bg-surface-mute inline-flex items-center justify-center text-ink-muted" aria-label="Next month"><Icon name="chevron-right" size={16} /></button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-0.5 px-3 pb-1">
            {DOW.map(d => <div key={d} className="text-[11px] font-semibold text-ink-faint text-center py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5 px-3 pb-3">
            {grid.map((d, i) => {
              const inMonth = d.getMonth() === view.m;
              const isSel = sameDay(d, sel);
              const off = disabled(d);
              return (
                <button key={i} type="button" disabled={off} onClick={() => choose(d)}
                  className={cx("h-9 rounded-lg text-[13px] font-semibold inline-flex items-center justify-center transition-colors",
                    isSel ? "bg-tap-green text-white" : off ? "text-ink-faint/40 cursor-not-allowed" : inMonth ? "text-ink hover:bg-surface-mute" : "text-ink-faint hover:bg-surface-mute")}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5 border-t border-line">
            <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-[13px] font-semibold text-tap-greenDeep hover:underline">Clear</button>
            <button type="button" onClick={() => { const t = new Date(); if (!disabled(t)) choose(t); }} className="text-[13px] font-semibold text-tap-greenDeep hover:underline">Today</button>
          </div>
        </div>
      </>, document.body)}
    </div>
  );
}
function SearchWidget({ airports = [], onSearch, defaults = {} }) {
  const [tab, setTab] = useState("Flights");
  const [type, setType] = useState("round");
  const [from, setFrom] = useState(defaults.origin || "MIA");
  const [to, setTo] = useState(defaults.dest || "");
  const [date, setDate] = useState(defaults.date || "");
  const [ret, setRet] = useState(defaults.ret || "");
  const [pax, setPax] = useState(1);
  const [kids, setKids] = useState(0);
  const [infants, setInfants] = useState(0);
  const [cabin, setCabin] = useState("Economy");
  // Multi-city: legs 2…5 (leg 1 is the From/To/Depart row above). No return date — a return
  // is simply another leg. Previously this tab passed no legs at all, so Results silently
  // fell back to a plain one-way search.
  const [xLegs, setXLegs] = useState([{ from: "", to: "", date: "" }]);
  const setXLeg = (i, patch) => setXLegs(a => a.map((l, n) => n === i ? { ...l, ...patch } : l));
  const addLeg = () => setXLegs(a => a.length >= 4 ? a : [...a, { from: (a[a.length - 1]?.to || ""), to: "", date: "" }]);
  const dropLeg = (i) => setXLegs(a => a.length <= 1 ? a : a.filter((_, n) => n !== i));
  const [stopover, setStopover] = useState(false);
  return (
    // #32 — two-container layout: OUTER translucent/glass frame (blur lives here only),
    // INNER solid white box holds the tabs + form. Tabs restyled to pills with a clear
    // active state. Replaces the previous single flat Card.
    <div className="rounded-[26px] bg-white/55 backdrop-blur-2xl border border-white/60 shadow-pop p-2.5 sm:p-3">
      {/* HomePage #1 — service tabs are flat and integrated into the bar (not rounded pills).
          Figma: selected tab 14/20 padding, 1px bottom border rgba(70,164,26,1), bg rgba(242,255,219,1),
          13.5px bold text rgba(70,164,26,1); inactive tabs are borderless and muted. */}
      <div className="flex overflow-x-auto v2-track border-b border-line px-1">
        {TRIP_TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} className={cx("shrink-0 border-b-2 -mb-px whitespace-nowrap text-[13.5px] transition-colors", tab === t ? "font-bold" : "border-transparent text-ink-muted hover:text-ink font-semibold")} style={tab === t ? { padding: "14px 20px", color: "rgba(70,164,26,1)", borderBottomColor: "rgba(70,164,26,1)", background: "rgba(242,255,219,1)" } : { padding: "14px 20px" }}>{t}</button>
        ))}
      </div>
      {/* inner solid white box — the form content */}
      <div className="rounded-[20px] bg-surface shadow-sm p-4 sm:p-5">
      <div className="flex gap-4 text-[12px] font-semibold text-ink-muted mb-3">
        {[["round", "Round trip"], ["oneway", "One way"], ["multi", "Multi-city"]].map(([k, l]) => (
          <button key={k} onClick={() => setType(k)} className={cx("pb-1 border-b-2", type === k ? "border-tap-green text-ink" : "border-transparent")}>{l}</button>
        ))}
      </div>
      <div className="grid lg:grid-cols-12 gap-3">
        <Field label="From" className="lg:col-span-3"><AirportPicker value={from} onChange={setFrom} airports={airports} placeholder="Origin" /></Field>
        <Field label="To" className="lg:col-span-3"><AirportPicker value={to} onChange={setTo} airports={airports} placeholder="Where to?" /></Field>
        <Field label="Depart" className="lg:col-span-2"><DatePicker value={date} onChange={setDate} placeholder="Select date" /></Field>
        {type === "round" && <Field label="Return" className="lg:col-span-2"><DatePicker value={ret} onChange={setRet} min={date} placeholder="Select date" /></Field>}
        <Field label="Travellers" className="lg:col-span-2">
          <PaxPanel adults={pax} children={kids} infants={infants} onChange={c => { setPax(c.adults); setKids(c.children); setInfants(c.infants); }} />
        </Field>
        <Field label="Cabin" className="lg:col-span-2">
          <div className="relative">
            <select value={cabin} onChange={e => setCabin(e.target.value)} className="w-full bg-surface border border-line rounded-[10px] px-3 py-3 text-[14px] outline-none appearance-none cursor-pointer focus:border-tap-green">
              {["Economy", "Premium Economy", "Business"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none text-[10px]">▾</span>
          </div>
        </Field>
      </div>
      <datalist id="ap">{airports.map(a => <option key={a.code} value={a.code}>{a.city} ({a.code})</option>)}</datalist>
      <div className="mt-4">
        <label className="flex items-center gap-2 text-[12px] font-medium text-ink-muted"><input type="checkbox" checked={stopover} onChange={e => setStopover(e.target.checked)} className="accent-[#46a41a]" /> Add Portugal Stopover <span className="text-ink-faint">· free, up to 10 days</span></label>
      </div>
      </div>
      {type === "multi" && (
        <div className="mt-3 space-y-2">
          {xLegs.map((l, i) => (
            <div key={i} className="grid lg:grid-cols-12 gap-3">
              <Field label={`Flight ${i + 2} · from`} className="lg:col-span-3"><AirportPicker value={l.from || to} onChange={v => setXLeg(i, { from: v })} airports={airports} placeholder="Origin" /></Field>
              <Field label={`Flight ${i + 2} · to`} className="lg:col-span-3"><AirportPicker value={l.to} onChange={v => setXLeg(i, { to: v })} airports={airports} placeholder="Where to?" /></Field>
              <Field label={`Flight ${i + 2} · date`} className="lg:col-span-2"><DatePicker min={i === 0 ? date : (xLegs[i - 1]?.date || date)} value={l.date} onChange={v => setXLeg(i, { date: v })} placeholder="Select date" /></Field>
              <div className="lg:col-span-4 flex items-end gap-3 pb-1">
                {xLegs.length > 1 && <button onClick={() => dropLeg(i)} className="text-[12px] font-semibold text-ink-muted hover:text-tap-red transition-colors">Remove</button>}
                {i === xLegs.length - 1 && xLegs.length < 4 && <button onClick={addLeg} className="text-[12px] font-semibold text-tap-greenDeep hover:underline">+ Add another flight</button>}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-ink-faint">Up to 5 flights · each leg has its own date; we price the whole itinerary as one trip.</p>
        </div>
      )}
      {/* F6 — the Search flight CTA is a separate component, outside the grouped Route/Date/Passenger/Cabin container */}
      <div className="flex justify-end px-1 pt-3">
        <Btn size="lg" className="w-full sm:w-auto" onClick={() => {
          const legs = [{ origin: from, dest: to, date }];
          if (type === "multi") xLegs.forEach(l => { if (l.to) legs.push({ origin: l.from || to, dest: l.to, date: l.date }); });
          onSearch({ origin: from, dest: to, date, ret, pax: pax + kids, adults: pax, children: kids, infants, cabin, type, stopover, ...(type === "multi" ? { legs, legIndex: 0 } : {}) });
        }}><Icon name="search" /> Search flights</Btn>
      </div>
    </div>
  );
}

/* ─────────────────────────── shared: destination grid ─────────────────────────── */
function DestGrid({ destinations = [], go }) {
  const [filter, setFilter] = useState("Popular");
  const chips = ["Popular", "Stopover-friendly", "Beach", "City breaks", "Long weekend"];
  return (
    <section className="mt-10">
      <div className="flex items-end justify-between gap-4 mb-4">
        <div><Eyebrow>Where do you want to go next?</Eyebrow><h2 className="text-[22px] font-bold mt-1">Picked for you</h2></div>
        <div className="hidden sm:flex gap-1">{chips.map(c => <button key={c} onClick={() => setFilter(c)} className={cx("px-3 py-1.5 rounded-full text-[12px] font-semibold", filter === c ? "bg-lime text-ink" : "bg-surface-mute text-ink-muted")}>{c}</button>)}</div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {destinations.slice(0, 8).map(d => (
          <Card key={d.code} className="overflow-hidden hover:shadow-pop transition-shadow cursor-pointer" onClick={() => go("results", { origin: d.origin, dest: d.code })}>
            <div className="h-28 relative overflow-hidden"><Img seed={d.code + "-" + d.city} src={d.image_url || imageFor(d.code, d.city)} alt={d.city} className="absolute inset-0 w-full h-full" />{d.emoji && <span className="absolute bottom-2 left-3 text-2xl drop-shadow">{d.emoji}</span>}</div>
            <div className="p-3.5">
              <div className="flex items-center justify-between"><div className="font-bold text-[15px]">{d.city}</div><span className="text-[11px] text-ink-faint v2-num">{d.code}</span></div>
              <div className="text-[11px] text-ink-muted mt-1 line-clamp-2 min-h-[30px]">{d.reason || d.tag}</div>
              {(d.reason || d.signals) && <WhyChip reason={d.reason} signals={d.signals} className="mt-1" />}
              <div className="flex items-center justify-between mt-2.5"><div className="text-[13px] font-bold">from {EUR(d.price)}</div><div className="flex items-center gap-1">{d.miles_price && <Pill tone="green"><Icon name="spark" size={10} /> miles</Pill>}<Pill tone={d.contentSource === "aem" ? "lime" : "slate"}>{d.contentSource || "local"}</Pill></div></div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

/* ─────────────── Marketing sections for the logged-out Homepage (Figma match) ─────────────── */
// 1 · Quick-action shortcut row (sits under the search widget)
function QuickActions({ go }) {
  const items = [
    { icon: "doc", title: "Check-in", sub: "From 24h before", route: "checkin" },
    { icon: "refresh", title: "Manage booking", sub: "Change, add, refund", route: "manage" },
    { icon: "plane", title: "Flight status", sub: "Live tracking", route: "manage" },
    { icon: "spark", title: "Book with miles", sub: "14,900 nearby", route: "miles", badge: true },
    { icon: "seat", title: "Economy Plus", sub: "More space, more service", route: "results" },
    { icon: "bag", title: "Xperion for Business", sub: "Corporate tools", route: "home" },
    { icon: "shield", title: "Travel extras", sub: "Insurance, eSIM, more", route: "extras" },
  ];
  return (
    <section className="mt-8 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
      {items.map((it) => (
        <button key={it.title} onClick={() => go(it.route)} className="group text-left rounded-2xl border border-line bg-surface px-3.5 py-4 hover:border-tap-green hover:shadow-card transition-all">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-lime-tint text-tap-greenDeep relative">
            <Icon name={it.icon} size={17} />
            {it.badge && <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-tap-green text-white text-[10px] font-black flex items-center justify-center leading-none">+</span>}
          </span>
          <div className="mt-2.5 text-[13px] font-bold leading-tight">{it.title}</div>
          <div className="text-[11px] text-ink-muted mt-0.5">{it.sub}</div>
        </button>
      ))}
    </section>
  );
}

// 2 · Portugal Stopover
function StopoverSection({ go }) {
  const bullets = [
    "Free stopover in New York or Miami for up to 10 days",
    "25% off domestic flights when you go beyond your stopover city",
    "Special offers at 150+ hotels, restaurants, tours and museums",
  ];
  const steps = [
    ["Choose your route", "Any Xperion flight via New York or Miami"],
    ["Add a free stopover", "One click during booking — no fare difference"],
    ["Pick hotels & experiences", "Save with 150+ partner offers"],
  ];
  return (
    <section className="mt-16 grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
      <div>
        <Eyebrow>Portugal Stopover · Included</Eyebrow>
        <h2 className="text-[30px] sm:text-[34px] font-black tracking-tight leading-[1.06] mt-2">Turn your layover into a mini vacation.</h2>
        <p className="text-[14px] text-ink-muted mt-3 max-w-md">Stop in New York or Miami for up to 10 days at no extra airfare. Explore the country, then continue to your final destination.</p>
        <ul className="mt-5 space-y-2.5">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-[13px]"><span className="mt-0.5 shrink-0 text-tap-green"><Icon name="check" size={16} /></span><span>{b}</span></li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-4 mt-6">
          <Btn variant="primary" onClick={() => go("stopover")}>See Stopover deals</Btn>
          <button onClick={() => go("stopover")} className="text-[13px] font-semibold text-tap-greenDeep hover:underline inline-flex items-center gap-1">How it works <Icon name="arrow" size={14} /></button>
        </div>
      </div>
      <div className="relative">
        <div className="relative rounded-3xl overflow-hidden h-[280px] sm:h-[320px]">
          <Img seed="lisbon-stopover" src={ASSET + "book-lisbon-porto.jpg"} alt="New York" className="absolute inset-0 w-full h-full" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
          <span className="absolute top-4 right-4 flex flex-col items-center justify-center w-16 h-16 rounded-full bg-lime text-ink shadow-pop">
            <span className="text-[20px] font-black leading-none v2-num">10</span><span className="text-[9px] font-bold uppercase tracking-wide">days</span>
          </span>
        </div>
        <Card className="p-4 sm:p-5 -mt-14 relative mx-4 sm:mx-8 shadow-pop">
          {steps.map(([t, s], i) => (
            <div key={t} className={cx("flex items-start gap-3 py-2.5", i < steps.length - 1 && "border-b border-line")}>
              <span className="shrink-0 w-6 h-6 rounded-full bg-tap-green text-white text-[12px] font-bold flex items-center justify-center leading-none">{i + 1}</span>
              <div><div className="text-[13px] font-bold leading-tight">{t}</div><div className="text-[11px] text-ink-muted mt-0.5">{s}</div></div>
            </div>
          ))}
        </Card>
      </div>
    </section>
  );
}

// 3 · Trip Extras
function TripExtrasSection({ go }) {
  const cards = [
    { icon: "home", title: "Hotels with miles built-in", body: "Book partner hotels worldwide. Earn voa.miles every night and redeem them on future stays.", cta: "Find hotels" },
    { icon: "swap", title: "Cars, transfers & parking", body: "Airport pickups, daily rentals and parking, with loyalty perks on every Hertz, Sixt and Europcar booking.", cta: "Book a ride" },
    { icon: "star", title: "Experiences & insurance", body: "Skip-the-line tours, food trails and wine country, plus travel insurance from $4/day.", cta: "Browse experiences" },
  ];
  return (
    <section className="mt-16">
      <div className="flex items-end justify-between gap-4 mb-5">
        <div><Eyebrow>Trip Extras</Eyebrow><h2 className="text-[30px] sm:text-[34px] font-black tracking-tight mt-2">Complete your trip in one place.</h2></div>
        <button onClick={() => go("extras")} className="hidden sm:inline-flex items-center gap-1 text-[13px] font-semibold text-tap-greenDeep hover:underline shrink-0">All trip extras <Icon name="arrow" size={14} /></button>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        {cards.map((c) => (
          <Card key={c.title} className="p-5 flex flex-col">
            <span className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-lime-tint text-tap-greenDeep"><Icon name={c.icon} size={20} /></span>
            <div className="mt-4 font-bold text-[15px]">{c.title}</div>
            <p className="text-[12.5px] text-ink-muted mt-1.5 flex-1">{c.body}</p>
            <button onClick={() => go("extras")} className="mt-4 self-start inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-semibold hover:border-tap-green hover:text-tap-greenDeep transition-colors">{c.cta} <Icon name="arrow" size={13} /></button>
          </Card>
        ))}
      </div>
      <div className="mt-4 rounded-2xl bg-surface-dark text-white px-6 py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-tap-green/20 text-lime shrink-0"><Icon name="bolt" size={20} /></span>
          <div><div className="font-bold text-[15px]">Bundle and save up to 22%</div><div className="text-[12.5px] text-white/60 mt-0.5">Add a hotel and a car when you book your flight — checkout in under 90 seconds.</div></div>
        </div>
        <Btn variant="lime" onClick={() => go("results")} className="shrink-0">Try Flight + Hotel <Icon name="arrow" size={14} /></Btn>
      </div>
    </section>
  );
}

// 4 · Xperion Miles loyalty
function LoyaltySection({ go }) {
  const bullets = [
    "Earn and redeem across voa and 26 Star Alliance partners worldwide",
    "Silver, Gold and Navigator tiers with lounge access, priority everything and bonus miles",
    "Club Xperion Miles — monthly miles and benefits, even if you don't fly often",
  ];
  return (
    <section className="mt-16 grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
      <div>
        <Eyebrow>Xperion Miles · Loyalty Program</Eyebrow>
        <h2 className="text-[30px] sm:text-[34px] font-black tracking-tight leading-[1.06] mt-2">Fly more. Earn more. <span className="text-ink-faint">Experience more.</span></h2>
        <ul className="mt-5 space-y-2.5">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-[13px]"><span className="mt-0.5 shrink-0 text-tap-green"><Icon name="check" size={16} /></span><span>{b}</span></li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-4 mt-6">
          <Btn variant="primary" onClick={() => go("miles")}>Join Xperion Miles <Icon name="arrow" size={14} /></Btn>
          <button onClick={() => go("miles")} className="text-[13px] font-semibold text-tap-greenDeep hover:underline inline-flex items-center gap-1">See all benefits <Icon name="arrow" size={14} /></button>
        </div>
      </div>
      <div className="relative rounded-[26px] p-7 text-white overflow-hidden shadow-pop" style={{ background: "linear-gradient(135deg,#2e7d33 0%,#46a41a 55%,#336614 100%)" }}>
        <div className="absolute -right-12 -top-12 w-44 h-44 rounded-full bg-white/10" aria-hidden="true" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2.5"><Avatar initials="MS" className="bg-white/20" /><div><div className="text-[11px] text-white/70">Welcome back,</div><div className="text-[14px] font-bold">Mariana Silva</div></div></div>
          <Pill tone="gold">Gold tier</Pill>
        </div>
        <div className="relative mt-6">
          <div className="text-[10px] uppercase tracking-wide text-white/60">Miles balance</div>
          <div className="text-[34px] font-black leading-none mt-1 v2-num">52,840 <span className="text-[13px] font-medium text-white/60">voa.miles</span></div>
          <div className="text-[11px] text-white/70 mt-1">+2,140 since last trip · expires Dec 2027</div>
          <div className="h-2 rounded-full bg-white/20 mt-3 overflow-hidden"><div className="h-full rounded-full bg-lime" style={{ width: "68%" }} /></div>
          <div className="flex justify-between text-[10px] text-white/60 mt-1.5"><span>Gold</span><span>12,160 mi to Navigator</span></div>
        </div>
        <div className="relative mt-5 rounded-2xl bg-black/15 p-3.5">
          <div className="text-[10px] uppercase tracking-wide text-white/50">Ways to use your miles</div>
          <div className="flex items-center justify-between mt-1"><div className="text-[13px] font-bold">Redeem 8,000 mi → $80 off any stay</div><span className="text-[11px] text-lime font-bold">Apply</span></div>
        </div>
      </div>
    </section>
  );
}

// 5 · Localization (interactive currency toggle)
function LocalizationSection() {
  const markets = [
    { key: "BR", label: "Brasil", cur: "BRL", sym: "R$", rate: 5.6 },
    { key: "PT", label: "Portugal", cur: "USD", sym: "$", rate: 1 },
    { key: "US", label: "United States", cur: "USD", sym: "$", rate: 1.08 },
  ];
  const [m, setM] = useState(markets[0]);
  const base = [3890, 4100, 4310, 4520];
  const fmt = (eur) => m.sym + " " + Math.round(eur * m.rate).toLocaleString();
  return (
    <section className="mt-16 rounded-3xl border border-line bg-surface-soft p-7 sm:p-9 grid lg:grid-cols-2 gap-8 lg:gap-12">
      <div>
        <Eyebrow>Local · Personal · Easy to change</Eyebrow>
        <h2 className="text-[28px] sm:text-[32px] font-black tracking-tight leading-[1.08] mt-2">Your trip, in your language. <span className="text-ink-faint">Your currency. Your routes.</span></h2>
        <p className="text-[13px] text-ink-muted mt-3 max-w-md">Smart localization adjusts language, prices and offers to where you are — but a single click switches everything if you'd rather see another market.</p>
        <div className="mt-5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-faint mb-2">Viewing offers for</div>
          <div className="inline-flex flex-wrap rounded-full border border-line bg-surface p-1 gap-1">
            {markets.map((mk) => (
              <button key={mk.key} onClick={() => setM(mk)} className={cx("px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-colors", m.key === mk.key ? "bg-ink text-white" : "text-ink-muted hover:text-ink")}>{mk.label} <span className="opacity-60">{mk.cur}</span></button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wide text-ink-faint mb-2">Popular from Miami</div>
        <div className="rounded-2xl border border-line bg-surface divide-y divide-line overflow-hidden">
          {base.map((eur, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3 hover:bg-surface-mute">
              <div className="flex items-center gap-3"><span className="text-[11px] font-bold text-ink-faint v2-num">0{i + 1}</span><span className="text-[13px] font-semibold">New York → Miami</span></div>
              <span className="text-[13px] font-bold v2-num">from {fmt(eur)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// 6 · Testimonials
function TestimonialsSection() {
  const reviews = [
    { name: "Carla M.", loc: "Miami, PT", tag: "Stopover", initials: "CM", text: "Did a 6-day stopover in Miami on the way to Italy — wine tours, the Napa Valley, and zero extra airfare. Booking the bundle took 90 seconds." },
    { name: "Tomás A.", loc: "New York, PT", tag: "Gold tier", initials: "TA", text: "The crew on the New York overnight is genuinely friendly. Boarded with priority as Gold, slept the whole way, woke up to a New York sunrise." },
    { name: "Erin J.", loc: "Miami, PT", tag: "Trip Extras", initials: "EJ", text: "Brought my whole trip into one app — flight, Hertz pickup at JFK, a hotel in Wynwood, a wine class. Earned miles on every leg." },
  ];
  return (
    <section className="mt-16">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div><Eyebrow>Loved for the Portugal experience</Eyebrow><h2 className="text-[30px] sm:text-[34px] font-black tracking-tight mt-2">Trusted by travelers,<br className="hidden sm:block" /> across three continents.</h2></div>
        <div className="flex items-center gap-5 shrink-0">
          <div><div className="flex items-center gap-1.5 text-[18px] font-black v2-num">4.5 <span className="text-tap-green text-[15px]">★</span></div><div className="text-[11px] text-ink-muted">12,400 reviews</div></div>
          <div className="border-l border-line pl-5"><div className="text-[12px] font-bold">Star Alliance</div><div className="text-[11px] text-ink-muted">Member airline</div></div>
        </div>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        {reviews.map((r) => (
          <Card key={r.name} className="p-5 flex flex-col">
            <div className="text-tap-green text-[13px] tracking-tight">★★★★★</div>
            <p className="text-[13px] text-ink-strong mt-3 flex-1">“{r.text}”</p>
            <div className="flex items-center justify-between mt-4">
              <div className="flex items-center gap-2.5"><Avatar initials={r.initials} /><div><div className="text-[12px] font-bold">{r.name}</div><div className="text-[11px] text-ink-faint">{r.loc}</div></div></div>
              <Pill tone="slate">{r.tag}</Pill>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

// 7 · App download
function AppSection() {
  const stats = [["4.8", "App Store rating"], ["2.1M+", "Active travelers"], ["90s", "Avg booking time"]];
  const timeline = [["plane", "Flight VO 084", "On time"], ["swap", "Hertz pickup at JFK", "Confirmed"], ["home", "Hotel Avenida, Wynwood", "Check-in 14:00"]];
  return (
    <section className="mt-16 mb-4 rounded-3xl bg-surface-navy text-white overflow-hidden">
      <div className="grid lg:grid-cols-2 gap-8 items-center p-8 sm:p-10">
        <div>
          <Eyebrow className="text-white/50">Xperion App</Eyebrow>
          <h2 className="text-[30px] sm:text-[36px] font-black tracking-tight leading-[1.05] mt-2">Your trip in your pocket.</h2>
          <p className="text-[14px] text-white/65 mt-3 max-w-md">Real-time gate updates, mobile boarding passes, trip extras you can book mid-flight and a clean trip timeline.</p>
          <div className="flex flex-wrap gap-3 mt-6">
            <span className="inline-flex items-center gap-2 rounded-xl bg-white text-ink px-4 py-2.5 text-[13px] font-bold cursor-pointer hover:bg-white/90"><Icon name="plane" size={16} /> App Store</span>
            <span className="inline-flex items-center gap-2 rounded-xl bg-white/10 border border-white/20 px-4 py-2.5 text-[13px] font-bold cursor-pointer hover:bg-white/15">Google Play</span>
          </div>
          <div className="flex gap-8 mt-7">
            {stats.map(([n, l]) => (<div key={l}><div className="text-[22px] font-black v2-num">{n}</div><div className="text-[11px] text-white/50">{l}</div></div>))}
          </div>
        </div>
        <div className="flex justify-center lg:justify-end">
          <div className="w-[220px] rounded-[34px] bg-black p-2.5 shadow-pop">
            <div className="rounded-[26px] bg-surface overflow-hidden">
              <div className="bg-surface-navy text-white px-4 pt-4 pb-5">
                <div className="text-[10px] text-white/50">Boarding pass</div>
                <div className="flex items-center justify-between mt-1"><div className="text-[18px] font-black">GRU</div><span className="text-white/50"><Icon name="plane" size={16} /></span><div className="text-[18px] font-black">JFK</div></div>
                <div className="flex items-center justify-between text-[10px] text-white/60 mt-1"><span>São Paulo</span><span>New York</span></div>
                <div className="flex items-center justify-between mt-3 text-[10px]"><span className="text-white/50">Gate <b className="text-white">B14</b></span><span className="text-white/50">Seat <b className="text-white">4A</b></span><span className="text-white/50">Boards <b className="text-white">22:30</b></span></div>
              </div>
              <div className="p-3 space-y-2">
                {timeline.map(([ic, t, s]) => (
                  <div key={t} className="flex items-center gap-2.5 rounded-xl bg-surface-mute px-3 py-2"><span className="text-tap-greenDeep shrink-0"><Icon name={ic} size={14} /></span><div className="min-w-0 flex-1"><div className="text-[11px] font-bold truncate">{t}</div><div className="text-[9px] text-ink-faint">{s}</div></div></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── HOMEPAGE (logged-out) ─────────────────────────── */
export function Homepage({ shared, go }) {
  const { airports = [], destinations = [] } = shared;
  return (
    <Page wide>
      <section className="relative rounded-3xl overflow-hidden bg-surface-navy text-white px-6 sm:px-10 py-14 sm:py-16 mb-6 v2-in">
        <img src={ASSET + "hero-anon.jpg"} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover object-center" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(10,14,20,0.82) 0%, rgba(10,14,20,0.55) 46%, rgba(10,14,20,0.14) 100%)" }} />
        <div className="relative max-w-2xl">
          <Pill tone="lime" className="mb-3">NEW · Summer in Portugal</Pill>
          <h1 className="text-[40px] sm:text-[52px] leading-[1.02] font-black tracking-tight">Fly more. Stay longer.<br />See Portugal on the way.</h1>
          <p className="mt-3 text-white/80 text-[15px]">Free Portugal Stopover up to 10 days · earn Miles on every booking · best-price guarantee.</p>
        </div>
      </section>
      <div className="-mt-16 relative z-10 max-w-content mx-auto"><SearchWidget airports={airports} onSearch={(q) => go("results", q)} /></div>
      <div className="max-w-content mx-auto">
        <QuickActions go={go} />
        <DestGrid destinations={destinations} go={go} />
        <StopoverSection go={go} />
        <TripExtrasSection go={go} />
        <LoyaltySection go={go} />
        <LocalizationSection />
        <TestimonialsSection />
        <AppSection />
      </div>
    </Page>
  );
}

/* ─────────────────────────── HOME (returning user · Daniel) ─────────────────────────── */
/* editable, functional hero search (route editable · trip-type + pay-with-miles work) */
function HomeAIPanel({ go, aiOn, onToggle, shared }) {
  // v35 feedback: the hero must converse IN PLACE, not navigate to /ai. AIConcierge already has a
  // purpose-built embedded branch (its own thread + composer + inline send); render that instead of
  // the old teaser whose every control called go("ai"). "Expand full chat" inside it still offers
  // the full page for anyone who wants it.
  return <AIConcierge shared={shared} go={go} embedded onToggleOff={onToggle} />;
}

function HeroSearch({ u, pat, cityOf, airports, go }) {
  const retDefault = (() => { if (!pat.recommendedDate) return ""; const d = new Date(pat.recommendedDate); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })();
  const [type, setType] = useState("round");
  const [from, setFrom] = useState(pat.origin || u.home_airport || "MIA");
  const [to, setTo] = useState(pat.dest || "JFK");
  const [date, setDate] = useState(pat.recommendedDate || "");
  const [ret, setRet] = useState(retDefault);
  const [pax, setPax] = useState(1);
  const [kids, setKids] = useState(0);
  const [infants, setInfants] = useState(0);
  const [cabin, setCabin] = useState("Economy");
  const [payMiles, setPayMiles] = useState(false);
  // Multi-city, airline-standard: an ordered list of legs (flight 1 is the main row above;
  // these are legs 2…5). Each leg chains from the previous arrival, has its own date, and
  // there is NO return date — a return is just another leg.
  const [xLegs, setXLegs] = useState([{ from: pat.dest || "JFK", to: "", date: "" }]);
  const setXLeg = (i, patch) => setXLegs(a => a.map((l, n) => n === i ? { ...l, ...patch } : l));
  const lastStop = (i) => (i === 0 ? to : (xLegs[i - 1]?.to || to));            // where the previous leg landed
  const addLeg = () => setXLegs(a => a.length >= 4 ? a : [...a, { from: (a[a.length - 1]?.to || to), to: "", date: "" }]);
  const dropLeg = (i) => setXLegs(a => a.length <= 1 ? a : a.filter((_, n) => n !== i));
  const swap = () => { setFrom(to); setTo(from); };
  const go2 = () => {
    if (type === "multi") {
      // B1 — build the leg list; step through them one at a time in Results.
      const legs = [{ origin: from, dest: to, date }];
      xLegs.forEach(l => { if (l.to) legs.push({ origin: l.from || to, dest: l.to, date: l.date }); });
      return go("results", { type: "multi", legs, legIndex: 0, pax: pax + kids, adults: pax, children: kids, infants, cabin, payMiles, origin: from, dest: legs[legs.length - 1].dest, date });
    }
    return go("results", { origin: from, dest: to, date, ret: type === "oneway" ? "" : ret, type, pax: pax + kids, adults: pax, children: kids, infants, cabin, payMiles });
  };
  const lbl = "text-[10px] font-semibold uppercase tracking-[1px] text-[rgba(139,142,134,1)]";
  const bare = "w-full min-w-0 bg-transparent text-[15px] font-bold outline-none";
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const compactRange = () => {
    const d = date ? new Date(date + "T00:00:00") : null, r = ret ? new Date(ret + "T00:00:00") : null;
    if (!d) return "Select dates";
    const dd = d.getDate(), dm = MON[d.getMonth()];
    // Only a Round Trip shows a departure–return range. Single Trip and Multi-City show just the
    // departure date (for Multi-City this is Flight 1's date; later legs render their own dates in
    // the per-leg rows below). A stale `ret` from a previous round-trip selection must not leak in.
    if (type !== "round" || !r) return `${dd} ${dm}`;
    const rd = r.getDate(), rm = MON[r.getMonth()];
    return dm === rm ? `${dd}–${rd} ${dm}` : `${dd} ${dm} – ${rd} ${rm}`;
  };

  return (
    <div className="mt-5">
      {/* #6 inner search module — 18px radius, soft shadow, status row contained inside */}
      <div className="rounded-[18px] bg-surface overflow-hidden" style={{ boxShadow: "0px 8px 24px -16px rgba(15,20,16,0.12)" }}>
        {/* #7 service tabs — flat, integrated into the bar */}
        <div className="flex overflow-x-auto v2-track font-bold border-b border-line px-1">
          {TRIP_TABS.map((t, i) => <button key={t} className={cx("shrink-0 border-b-2 -mb-px transition-colors whitespace-nowrap text-[13.5px]", i === 0 ? "font-bold" : "border-transparent text-ink-muted hover:text-ink font-semibold")} style={i === 0 ? { padding: "14px 20px", color: "rgba(70,164,26,1)", borderBottomColor: "rgba(70,164,26,1)", background: "rgba(242,255,219,1)" } : { padding: "14px 20px" }}>{t}</button>)}
        </div>
        <div className="p-4 sm:p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            {/* #8 trip-type selector — compact 251×37 pill group */}
            <div className="inline-flex gap-1 p-1 rounded-[10px]" style={{ background: "rgba(250,250,247,1)" }}>
              {[["round", "Round trip"], ["oneway", "One way"], ["multi", "Multi-city"]].map(([k, l]) => (
                <button key={k} onClick={() => setType(k)} className="px-3 py-1 rounded-[7px] text-[12px] font-semibold transition-colors" style={type === k ? { background: "rgba(255,255,255,1)", color: "rgba(20,22,28,1)", boxShadow: "0px 1px 2px 0px rgba(20,22,28,0.06)" } : { color: "rgba(107,107,107,1)" }}>{l}</button>
              ))}
            </div>
            {/* #9 pay-with-miles — toggle first, then label + filled star */}
            <button onClick={() => setPayMiles(v => !v)} className="inline-flex items-center gap-2.5 text-[12px] font-semibold text-ink-muted">
              <span className={cx("w-9 h-5 rounded-full relative transition-colors shrink-0", payMiles ? "bg-tap-green" : "bg-surface-mute")}><span className={cx("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", payMiles ? "right-0.5" : "left-0.5")} /></span>
              Pay with Miles <span className={cx("text-[14px] leading-none", payMiles ? "text-tap-green" : "text-ink-faint")}>✦</span>
            </button>
          </div>

          <div className="mt-3 rounded-2xl border border-line overflow-hidden grid v2-searchgrid divide-y lg:divide-y-0 lg:divide-x divide-line">
            {/* #10 #13 route — single container, location icons + circular swap between */}
            <div className="p-3">
              <div className="flex items-center gap-2 mt-1.5">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className={lbl}>From</div>
                  <div className="flex items-center gap-1.5 mt-1"><Icon name="plane" size={14} className="text-tap-green shrink-0" /><AirportPicker value={from} onChange={setFrom} airports={airports} buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></div>
                </div>
                <button onClick={swap} title="Swap origin & destination" aria-label="Swap origin and destination" className="shrink-0 w-[34px] h-[34px] rounded-full inline-flex items-center justify-center self-end mb-0.5 hover:brightness-95 transition-[filter]" style={{ border: "1px solid rgba(217,230,203,1)", background: "rgba(241,245,236,1)" }}><Icon name="swap" size={14} className="text-tap-greenDeep" /></button>
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className={lbl}>To</div>
                  <div className="flex items-center gap-1.5 mt-1"><Icon name="globe" size={14} className="text-tap-greenDeep shrink-0" /><AirportPicker value={to} onChange={setTo} airports={airports} buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></div>
                </div>
              </div>
            </div>
            {/* #14 dates — compact range + calendar icon (dynamic, still selectable) */}
            <div className="p-3">
              <div className={lbl}>{type === "round" ? "Depart · Return" : type === "multi" ? "Flight 1 · date" : "Depart"}</div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <DatePicker value={date} onChange={setDate} placeholder="Add date" buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} />
                {type === "round" && <><span className="text-ink-faint text-[13px] shrink-0">→</span><DatePicker value={ret} onChange={setRet} min={date} placeholder="Add date" buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></>}
              </div>
            </div>
            {/* #15 passenger — traveler icon before count */}
            <div className="p-3"><div className={lbl}>Passenger</div><div className="flex items-center gap-2 mt-1.5"><Icon name="user" size={14} className="text-ink-muted shrink-0" /><PaxPanel adults={pax} children={kids} infants={infants} onChange={c => { setPax(c.adults); setKids(c.children); setInfants(c.infants); }} buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></div><div className="text-[10px] text-ink-faint mt-1">{u.first_name} · saved</div></div>
            <div className="p-3"><div className={lbl}>Cabin</div><div className="relative mt-1.5"><select value={cabin} onChange={e => setCabin(e.target.value)} className={cx(bare, "appearance-none pr-6 truncate cursor-pointer")}>{["Economy", "Premium", "Business"].map(c => <option key={c}>{c}</option>)}</select><Icon name="chevron" size={14} className="absolute right-0 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" /></div></div>
          </div>
          {/* v35 HomePage #1: the CTA is its own component below the form — the bordered
              container ends after Cabin. */}
          <div className="mt-3 flex justify-end">
            <button onClick={go2} className="text-white font-bold text-[14px] flex items-center justify-center gap-2.5 rounded-[16px] hover:opacity-95 transition-opacity" style={{ background: "rgba(70,164,26,1)", padding: "16px 22px" }}>Search flight <Icon name="arrow" size={15} /></button>
          </div>
          {type === "multi" && (
            <div className="mt-3 space-y-2">
              {xLegs.map((l, i) => (
                <div key={i} className="grid lg:grid-cols-12 gap-3">
                  <div className={cx("rounded-xl border border-line bg-surface-soft p-3", "lg:col-span-3")}>
                    <div className={lbl}>Flight {i + 2} · from</div>
                    <div className="mt-1.5"><AirportPicker value={l.from || lastStop(i)} onChange={v => setXLeg(i, { from: v })} airports={airports} placeholder="Search city, airport or country" buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></div>
                  </div>
                  <div className={cx("rounded-xl border border-line bg-surface-soft p-3", "lg:col-span-3")}>
                    <div className={lbl}>Flight {i + 2} · to</div>
                    <div className="mt-1.5"><AirportPicker value={l.to} onChange={v => setXLeg(i, { to: v })} airports={airports} placeholder="Search city, airport or country" buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></div>
                  </div>
                  <div className={cx("rounded-xl border border-line bg-surface-soft p-3", "lg:col-span-3")}>
                    <div className={lbl}>Flight {i + 2} · date</div>
                    {/* a leg can't depart before the leg before it */}
                    <div className="mt-1.5"><DatePicker min={i === 0 ? date : (xLegs[i - 1]?.date || date)} value={l.date} onChange={v => setXLeg(i, { date: v })} placeholder="Add date" buttonClassName={cx(bare, "text-left inline-flex items-center justify-between")} /></div>
                  </div>
                  <div className="lg:col-span-3 flex items-center gap-3">
                    {xLegs.length > 1 && <button onClick={() => dropLeg(i)} className="text-[12px] font-semibold text-ink-muted hover:text-tap-red transition-colors">Remove</button>}
                    {i === xLegs.length - 1 && xLegs.length < 4 && (
                      <button onClick={addLeg} className="text-[12px] font-semibold text-tap-greenDeep hover:underline inline-flex items-center gap-1">+ Add another flight</button>
                    )}
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-ink-faint">Up to 5 flights · each leg has its own date, and we price the whole itinerary as one trip.</p>
            </div>
          )}
          {/* #6 status indicators — contained inside the search module */}
          <div className="flex flex-wrap gap-4 mt-4 text-[12px] text-ink-muted">
            {[["Traveler details saved", true], [`Default ${u.card_brand || "Mastercard"} ready`, true], [`${u.tier} benefits active`, true], ["Use miles available", (u.miles || 0) > 0]].map(([t, ok], i) => (
              <span key={i} className="flex items-center gap-1.5"><Icon name="check" size={13} className={ok ? "text-tap-green" : "text-ink-faint"} /> {t}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Home({ shared, go }) {
  const { profile, airports = [] } = shared;
  // The resume card must reflect the LIVE journey, re-read on every mount — not the
  // boot-time shared snapshot. Otherwise a search made after boot (or on another channel)
  // updates the server but never appears here. Seed from the snapshot for instant paint.
  const [journey, setJourney] = useState(shared.journey);
  const [rec, setRec] = useState(null);
  const [anc, setAnc] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [offerTiles, setOfferTiles] = useState(null);
  const [aiOn, setAiOn] = useState(false);          // Xperion AI is OFF by default
  const tplRef = useRef(null);
  const scrollTpl = (dir) => tplRef.current?.scrollBy({ left: dir * 336, behavior: "smooth" });
  // High-contrast status badge for image overlays — solid/blurred white pill so it reads on any photo
  const overlayBadge = "absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-white/95 backdrop-blur px-2.5 py-1 text-[11px] font-bold shadow-sm";
  useEffect(() => {
    api.get("/recommendation").then(setRec).catch(() => {});
    api.get("/ancillaries").then(a => setAnc((a || []).sort((x, y) => (y.recommended ? 1 : 0) - (x.recommended ? 1 : 0)))).catch(() => {});
    api.get("/bookings").then(setBookings).catch(() => {});
    api.get("/offers/tiles").then(d => setOfferTiles(d?.tiles || null)).catch(() => {});
    api.get("/journey").then(j => setJourney(j && j.stage ? j : null)).catch(() => {});
  }, []);
  if (!profile) return <Page><div className="py-20 text-center text-ink-faint">Loading your journey…</div></Page>;

  const u = profile.user, pat = profile.pattern || {}, prog = tierProgress(u.tier, u.miles);
  const cityOf = (c) => airports.find(a => a.code === c)?.city || c;
  const resumable = journey && journey.stage && journey.stage !== "search" && journey.dest;
  const upcoming = bookings.filter(b => b.status === "confirmed" && b.days_to_go >= 0).sort((a, b) => a.days_to_go - b.days_to_go)[0] || bookings.find(b => b.status === "confirmed");
  const search = () => go("results", { origin: pat.origin || u.home_airport, dest: pat.dest || "JFK", date: pat.recommendedDate, type: "round", pax: 1, cabin: "Economy" });


  // Offer tiles: "Resume" on a held fare must rebuild the basket first. The hold lives in the
  // DB, but the cart is client-side — so without this the CTA opened an EMPTY cart page.
  const openTile = (o) => {
    const f = o && o.flight;
    if (o && o.action === "cart" && f && f.flight_no && !trip.outbound) {
      trip.origin = f.origin; trip.dest = f.dest; trip.date = f.flight_date || trip.date;
      trip.type = "one-way"; trip.pax = trip.pax || 1;
      const price = o.price || f.price || 0;
      setLeg("outbound", { flight: f, fare: "Classic", price, leg: "outbound", origin: f.origin, dest: f.dest, date: f.flight_date });
      // Restore the lock itself, or checkout re-validates the fare and prompts "price has
      // changed" on a fare the member is holding. Fall back to the hold window if the
      // server couldn't resolve an exact deadline.
      const hrs = o.duration === "7d" ? 168 : o.duration === "24h" ? 24 : 48;
      const until = (o.until && o.until > Date.now()) ? o.until : (Date.now() + hrs * 3600e3);
      setFareHold({ flightNo: f.flight_no, until, price, duration: o.duration || "48h" });
    }
    go((o && o.action) || "miles");
  };
  return (
    <div className="bg-surface-mute">
      {/* HERO: full-bleed video background, white content panel */}
      <div className="relative overflow-hidden bg-surface-navy">
        <video className="absolute inset-0 w-full h-full object-cover" autoPlay loop muted playsInline preload="auto" ref={v => { if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } }}>
          <source src="/v2/hero.mp4" type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-black/15" />
        <div className="relative mx-auto max-w-page px-4 sm:px-6 pt-12 pb-14">
          <div className="rounded-[37px] border-2 border-white shadow-pop p-5 sm:p-8 max-w-[1320px] mx-auto" style={{ background: "rgba(255,255,255,0.9)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}>
            <div className="flex items-start justify-between">
              <PersonalizedTag />
              <button onClick={() => setAiOn(v => !v)} className="inline-flex items-center gap-1.5 rounded-full bg-white shadow-sm text-ink-muted text-[12px] font-semibold pl-3.5 pr-2 py-2"><span className={cx("w-9 h-5 rounded-full relative transition-colors shrink-0", aiOn ? "bg-tap-green" : "bg-ink/15")}><span className={cx("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow", aiOn ? "right-0.5" : "left-0.5")} /></span> Xperion AI</button>
            </div>
            <div className="text-ink-muted text-[14px] mt-3">Bom dia, {u.first_name}.</div>
            <h1 className="text-[32px] font-semibold tracking-[-0.8px] leading-none text-[rgba(15,20,16,1)]">{aiOn ? "Ask me anything about your trip." : "Ready for your usual trip?"}</h1>
            {aiOn
              ? <HomeAIPanel go={go} aiOn={aiOn} onToggle={() => setAiOn(false)} shared={shared} />
              : <HeroSearch u={u} pat={pat} cityOf={cityOf} airports={airports} go={go} />}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-page px-4 sm:px-6 py-8 space-y-12">
        {/* COMMUTE TEMPLATES */}
        <section>
          <div className="flex items-end justify-between mb-4">
            <div><h2 className="text-[22px] font-bold">Your commute templates</h2><div className="flex gap-4 text-[12px] font-semibold mt-2"><span className="text-ink border-b-2 border-ink pb-0.5">Templates</span><span className="text-ink-faint">Recent searches</span><span className="text-ink-faint">Favourites</span></div></div>
            <div className="flex gap-2"><button onClick={() => scrollTpl(-1)} className="w-9 h-9 rounded-full border border-line flex items-center justify-center text-ink-muted hover:bg-surface-mute">←</button><button onClick={() => scrollTpl(1)} className="w-9 h-9 rounded-full bg-surface-dark text-white flex items-center justify-center hover:bg-ink-strong">→</button></div>
          </div>
          <div ref={tplRef} className="flex gap-3 overflow-x-auto v2-track snap-x pb-2 -mx-1 px-1">
            {buildTemplates(profile, cityOf).map((t, i) => (
              <Card key={i} className="overflow-hidden shrink-0 w-[85vw] max-w-[377px] snap-start border" style={{ borderRadius: "22px", boxShadow: "0px 4px 16px 0px rgba(0,0,0,0.06)" }}>
                <div className="h-[100px] relative overflow-hidden"><Img seed={"route-" + t.route} src={imageFor(t.route)} className="absolute inset-0 w-full h-full" /></div>
                <div className="p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-[rgba(70,164,26,1)]">{t.label}</span>
                    <span className="text-[10px] text-ink-faint">{t.used ? `Used ${t.used}×` : t.shuttle ? "Recurring" : ""}</span>
                  </div>
                  <div className="flex items-center justify-between mt-2"><div className="text-[15px] font-bold">{t.route}</div><div className="text-[12px] font-semibold text-ink-muted v2-num">{t.time}</div></div>
                  <div className="text-[11px] text-ink-muted mt-2 min-h-[28px]">{t.detail}</div>
                  <Btn size="sm" variant="soft" className="mt-2 w-full" onClick={() => go(t.shuttle ? "manage" : "express")}>{t.shuttle ? "Manage shuttle" : "One-tap book"}</Btn>
                </div>
              </Card>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-4 text-[12px]">
            <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Recent</span>
            {(profile.recentSearches || []).slice(0, 3).map((s, i) => (
              <button key={i} onClick={() => go("results", { origin: s.origin, dest: s.dest, date: s.travel_date, type: "round" })} className="px-3 py-1.5 rounded-full bg-surface border border-line font-semibold hover:bg-surface-mute">{s.origin} → {s.dest} · {fmtDate(s.travel_date).replace(/ \d{4}/, "")}</button>
            ))}
            <button className="px-3 py-1.5 rounded-full bg-surface-mute text-ink-muted font-semibold">+ more</button>
          </div>
        </section>
      </div>

      {/* MILES & GO JOURNEY (dark full-bleed) */}
      <section className="text-white" style={{ background: "linear-gradient(90deg, #000000 0%, #143817 100%)" }}>
        <div className="mx-auto max-w-content px-6 py-20 text-center">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase px-3 py-1 rounded-full bg-gradient-to-br from-[#E8C75A] to-[#C9A227] text-ink"><Icon name="spark" size={11} /> Your Xperion Miles journey · {u.tier} member</span>
          <h2 className="text-[44px] font-black leading-tight mt-5">{prog.next ? <>You're {miles(prog.toGo)} miles<br />from {prog.next}, {u.first_name}.</> : <>You're at the top tier, {u.first_name}.</>}</h2>
          <p className="text-white/60 text-[14px] mt-3 max-w-2xl mx-auto">One New York stopover + one European return gets you there — and unlocks free upgrades and lounge access for two.</p>
          <div className="mt-8 rounded-[24px] p-9 text-left" style={{ background: "rgba(13,13,13,0.2)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="flex flex-wrap items-center justify-center gap-8 text-center">
              <div><div className="text-[10px] uppercase tracking-wide text-white/50">Current balance</div><div className="text-[34px] font-black v2-num">{miles(u.miles)} <span className="text-[14px] font-medium text-white/50">miles</span></div><div className="text-[11px] mt-1"><TierBadge tier={u.tier} /> {prog.next && <span className="text-white/50 ml-1">You · {miles(prog.toGo)} mi to <span className="text-lime font-bold uppercase">{prog.next}</span></span>}</div></div>
              {prog.next && <div className="rounded-[18px] p-3.5 min-w-[280px] text-center" style={{ background: "rgba(15,26,17,1)", border: "1px solid rgba(46,77,52,1)" }}><div className="text-[40px] font-black text-lime leading-none v2-num">{prog.pct}%</div><div className="text-[10px] uppercase tracking-wide text-white/50 mt-1">Progress to {prog.next}</div><div className="h-2 rounded-full bg-white/15 mt-2 overflow-hidden"><div className="h-full rounded-full" style={{ width: prog.pct + "%", background: "linear-gradient(90deg,#9efd38,#8b5cf6)" }} /></div></div>}
            </div>
            <div className="grid sm:grid-cols-3 gap-3 mt-5">
              {(offerTiles && offerTiles.length ? offerTiles : [
                { icon: "home", img: ASSET + "because-you-are-gold.png", badge: "Because you're " + u.tier, title: "Use miles to discount your New York hotel", detail: "Apply 8,000 mi to any 3-night stay · save up to $80 instantly.", value: "8,000 mi", cta: "Apply", reason: `${u.tier} member · ${miles(u.miles)} miles available (users)` },
                { icon: "plane", img: ASSET + "limited-next-trip.png", badge: "Limited · next trip", title: "Upgrade " + cityOf(pat.origin || "JFK") + "–" + cityOf(pat.dest || "MIA") + " to Business with miles", detail: "20% mileage discount when upgrading on your existing booking.", value: "42,000 mi", cta: "Upgrade", reason: `${cityOf(pat.origin || "JFK")}–${cityOf(pat.dest || "MIA")} is your most-flown route (travel_history)` },
                { icon: "star", img: ASSET + "partner-offer.png", badge: "Partner offer · Nov", title: "Earn 3× miles at Memmo Príncipe Real", detail: "Triple miles when booking your favourite hotel through voa stay.", value: "3× MI", cta: "Activate", reason: "Memmo Príncipe Real is in your recent stays (bookings)" },
              ]).slice(0, 3).map((o, i) => (
                <div key={o.id || i} className="rounded-[14px] p-[18px] flex flex-col text-left" style={{ background: "rgba(15,26,17,1)", border: "1px solid rgba(46,77,52,1)" }}>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="w-11 h-11 rounded-xl inline-flex items-center justify-center text-lime shrink-0 overflow-hidden" style={{ background: "linear-gradient(135deg, rgba(158,253,56,0.18), rgba(46,125,51,0.25))", border: "1px solid rgba(158,253,56,0.25)" }}>{o.img ? <img src={o.img} alt="" className="w-6 h-6 object-contain" onError={e => { e.currentTarget.style.display = "none"; }} /> : <Icon name={o.icon} size={20} />}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-lime-tint px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-tap-greenDeep"><Icon name="spark" size={9} /> {o.badge}</span>
                  </div>
                  <div className="text-[14px] font-bold mt-3">{o.title}</div>
                  <div className="text-[11px] text-white/50 mt-1 flex-1">{o.detail}</div>
                  {(o.reason || o.signals) && <WhyChip reason={o.reason} signals={o.signals} dark className="mt-2" />}
                  <div className="h-px bg-white/10 my-3" />
                  <div className="flex items-center justify-between"><span className="text-[14px] font-black v2-num text-lime">{o.value}</span><Btn size="sm" variant="lime" onClick={() => openTile(o)}>{o.cta} →</Btn></div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-6 flex items-center justify-center gap-2 pt-2"><span className="text-[14px]" style={{ color: "rgba(158,253,56,1)" }}>✦</span><span className="text-[14px] font-medium leading-none text-white" style={{ opacity: 0.8 }}>Earn up to {miles(Math.round((rec?.package?.total || pat.usualPrice || 250) * 12))} voa.miles on your New York stopover hotel and experiences this trip.</span></div>
        </div>
      </section>

      <div className="mx-auto max-w-page px-4 sm:px-6 py-10 space-y-12">
        {/* PICK UP WHERE YOU LEFT OFF */}
        <section>
          <div className="flex items-end justify-between mb-4"><h2 className="text-[22px] font-bold">Pick up where you left off</h2><span className="text-[11px] text-ink-faint">{journey?.updated_at ? "Updated " + timeAgo(journey.updated_at) : ""}</span></div>
          <div className="grid md:grid-cols-3 gap-4">
            {/* usual trip */}
            <Card className="overflow-hidden flex flex-col">
              <div className="h-40 relative overflow-hidden"><Img seed={"dest-" + (pat.dest || "JFK")} src={ASSET + "book-lisbon-porto.jpg"} className="absolute inset-0 w-full h-full" /><span className={cx(overlayBadge, "text-tap-greenDeep")}><Icon name="home" size={11} /> Usual trip</span></div>
              <div className="p-4 flex flex-col flex-1">
                <div className="font-bold text-[15px]">Book {cityOf(pat.origin || "MIA")} → {cityOf(pat.dest || "JFK")}</div>
                <div className="text-[12px] text-ink-muted mt-1">{pat.recommendedLabel} {pat.usualDep} · fare from {EUR(pat.usualPrice)} · hand bag only.</div>
                <div className="flex flex-wrap gap-1.5 mt-2"><Pill tone="slate">2 taps</Pill><Pill tone="slate">Default card</Pill><Pill tone="slate">{miles(u.miles)} mi avail.</Pill></div>
                <div className="mt-auto"><div className="h-px bg-line my-3" />
                <div className="flex items-center justify-between"><div><div className="text-[9px] uppercase tracking-wide text-ink-faint">from ({rec?.package?.hotelNights || 3} night{(rec?.package?.hotelNights || 3) !== 1 ? "s" : ""} · 1 pax)</div><div className="text-[18px] font-black v2-num">${Number(rec?.package?.total || pat.usualPrice || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div><Btn size="sm" variant="outline" onClick={() => go("express")}>Book Now →</Btn></div></div>
              </div>
            </Card>
            {/* resume */}
            <Card className="overflow-hidden flex flex-col">
              <div className="h-40 relative overflow-hidden"><Img seed={"resume-" + (journey?.dest || "MIA")} src={ASSET + "continue-booking.jpg"} className="absolute inset-0 w-full h-full" /><span className="absolute inset-0 bg-black/15" /><span className={cx(overlayBadge, resumable ? "text-tap-greenDeep" : "text-ink-muted")}><Icon name="clock" size={11} /> {resumable ? "In-progress" : "No draft"}</span></div>
              <div className="p-4 flex flex-col flex-1">
                {resumable ? <>
                  <div className="font-bold text-[15px]">Resume booking</div>
                  <div className="text-[12px] text-ink-muted mt-1">{journey.origin} → {journey.dest} · stopped at {({ results: "flight selection", seat: "flight selection", cart: "cart", extras: "cart", basket: "basket", passenger: "passenger details", review: "passenger details", payment: "payment" }[journey.stage] || journey.stage)}.{journey.seat ? ` Seat ${journey.seat} held.` : ""}</div>
                  <div className="flex flex-wrap gap-1.5 mt-2"><Pill tone="green">{({ search: 1, results: 1, seat: 1, cart: 2, extras: 2, basket: 3, passenger: 4, review: 4, payment: 5 }[journey.stage] || 1)} of 5 done</Pill><Pill tone="slate">Fare held</Pill></div>
                  <div className="mt-auto"><div className="h-px bg-line my-3" /><div className="flex justify-end"><Btn size="sm" variant="outline" onClick={() => { if (typeof window !== "undefined") window.__tapForceReval = true; api.post("/journey/resume", {}).catch(() => {}); const _sr = { search: "results", results: "results", seat: "results", cart: "cart", extras: "cart", basket: "basket", passenger: "passenger", review: "passenger", payment: "payment" }; go(_sr[journey.stage] || "results", { origin: journey.origin || pat.origin || u.home_airport, dest: journey.dest || pat.dest || "JFK", date: journey.date || journey.travel_date || pat.recommendedDate, type: "round", pax: 1, cabin: journey.cabin || "Economy" }); }}>Continue →</Btn></div></div>
                </> : <>
                  <div className="font-bold text-[15px]">Nothing in progress</div>
                  <div className="text-[12px] text-ink-muted mt-1">Start a new search to begin a booking.</div>
                  <div className="mt-auto"><div className="h-px bg-line my-3" /><div className="flex justify-end"><Btn size="sm" variant="outline" onClick={search}>New search →</Btn></div></div>
                </>}
              </div>
            </Card>
            {/* tomorrow / boarding */}
            <Card className="overflow-hidden flex flex-col">
              <div className="h-40 relative overflow-hidden"><Img seed={"trip-" + (upcoming?.flight?.dest || "MIA")} src={imageFor("trip-" + (upcoming?.flight?.dest || "MIA"), cityOf(upcoming?.flight?.dest || "MIA"))} className="absolute inset-0 w-full h-full" /><span className="absolute inset-0 bg-black/15" /><span className={cx(overlayBadge, upcoming ? "text-tap-greenDeep" : "text-ink-muted")}><Icon name="clock" size={11} /> {upcoming ? "Upcoming" : "No trips"}</span></div>
              <div className="p-4 flex flex-col flex-1">
                {upcoming ? <>
                  <div className="font-bold text-[15px]">{upcoming.flight_no} · {upcoming.flight?.origin} → {upcoming.flight?.dest}</div>
                  <div className="text-[12px] text-ink-muted mt-1">Boarding {upcoming.flight?.dep} · seat {upcoming.seat || "—"}. {upcoming.days_to_go === 0 ? "Today." : upcoming.days_to_go === 1 ? "Tomorrow." : "On time."}</div>
                  <div className="flex flex-wrap gap-1.5 mt-2"><Pill tone="slate">Check-in soon</Pill><Pill tone="slate">Mobile pass</Pill></div>
                  <div className="mt-auto"><div className="h-px bg-line my-3" /><div className="flex justify-end"><Btn size="sm" variant="outline" onClick={() => go("manage")}>Manage trip →</Btn></div></div>
                </> : <>
                  <div className="font-bold text-[15px]">No upcoming trips</div>
                  <div className="text-[12px] text-ink-muted mt-1">Book your usual to get going.</div>
                  <div className="mt-auto"><div className="h-px bg-line my-3" /><div className="flex justify-end"><Btn size="sm" variant="outline" onClick={() => go("express")}>Book usual →</Btn></div></div>
                </>}
              </div>
            </Card>
          </div>
        </section>

      </div>

      {/* TOMORROW'S TRIP · LIVE — own white band so sections alternate (zebra) */}
      {upcoming && (
        <section className="bg-surface border-y border-line">
          <div className="mx-auto max-w-page px-4 sm:px-6 py-10">
            <div className="flex items-end justify-between mb-4"><h2 className="text-[22px] font-bold">Your next trip · live</h2><span className="text-[11px] text-ink-faint">Auto-pulled from itinerary</span></div>
            <div className="rounded-2xl border border-line bg-surface-soft p-5">
              <div className="flex flex-wrap items-center gap-6">
                <div><Pill tone="green" className="mb-2">Confirmed</Pill><div className="text-[11px] text-ink-faint">{upcoming.flight_no} · {upcoming.flight?.aircraft || "A320"}</div><div className="flex items-start gap-3 mt-1"><div><div className="text-[22px] font-bold leading-none v2-num">{upcoming.flight?.dep}</div><div className="text-[11px] text-ink-faint mt-1">{upcoming.flight?.origin}{upcoming.flight?.terminal ? ` · ${upcoming.flight.terminal}` : ""}</div></div><Icon name="arrow" size={16} className="text-ink-faint shrink-0 mt-1.5" /><div><div className="text-[22px] font-bold leading-none v2-num">{upcoming.flight?.arr}</div><div className="text-[11px] text-ink-faint mt-1">{upcoming.flight?.dest}</div></div></div><div className="text-[11px] text-ink-muted mt-1">Seat <span className="font-bold text-ink">{upcoming.seat || "—"}</span> · Hand bag · Carbon offset on</div></div>
                <div className="flex-1 min-w-[240px]">
                  {(() => {
                    const dep = upcoming.flight?.dep || "", arr = upcoming.flight?.arr || "", dtg = upcoming.days_to_go;
                    const ciSub = upcoming.checked_in ? "Checked in" : (dtg > 1 ? `in ${dtg}d` : dtg === 1 ? "Tomorrow" : dtg === 0 ? "Open today" : "Open");
                    const STEPS = [
                      { label: "Booked", sub: "Done" },
                      { label: "Seat picked", sub: upcoming.seat ? `Seat ${upcoming.seat}` : "Done" },
                      { label: "Check-in", sub: ciSub },
                      { label: "Board", sub: dep },
                      { label: "Arrive", sub: arr },
                    ];
                    const cur = upcoming.checked_in ? 3 : 2;            // current step (advances once checked in)
                    const n = STEPS.length;
                    return (
                      <div className="relative">
                        {/* single shared track behind the icon row — runs first→last icon centre */}
                        <div className="absolute top-[7px] left-[10%] right-[10%] h-0.5 bg-line-strong" />
                        <div className="absolute top-[7px] left-[10%] h-0.5 bg-tap-green" style={{ width: `${(cur / (n - 1)) * 80}%` }} />
                        <div className="flex items-start">
                          {STEPS.map((s, i) => (
                            <div key={s.label} className="flex-1 min-w-0 flex flex-col items-center text-center px-0.5">
                              <span className={cx("relative z-10 w-3.5 h-3.5 rounded-full border-2 shrink-0",
                                i < cur ? "bg-tap-green border-tap-green" : i === cur ? "bg-tap-green border-tap-green ring-2 ring-tap-green/30" : "bg-surface border-line-strong")} />
                              <span className={cx("text-[10px] mt-1.5 leading-tight", i === cur ? "text-tap-greenDeep font-semibold" : "text-ink-muted")}>{s.label}</span>
                              {s.sub ? <span className="text-[9px] text-ink-faint leading-tight mt-0.5 v2-num">{s.sub}</span> : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div className="min-w-[200px]"><div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Next action</div><Btn variant="primary" className="w-full" onClick={() => go("checkin")}>Check in early →</Btn><Btn variant="soft" className="w-full mt-2" onClick={() => go("checkin")}>Add mobile pass to Wallet</Btn></div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* WORTH YOUR WHILE — grey page band */}
      {anc.length > 0 && (
        <div className="mx-auto max-w-page px-4 sm:px-6 py-10">
          <section>
            <div className="flex items-end justify-between mb-4"><h2 className="text-[22px] font-bold">Worth your while{upcoming ? ` · for ${upcoming.flight?.dep || "your trip"}` : ""}</h2><span className="text-[11px] text-ink-faint">Ranked for {u.tier} commuters</span></div>
            <div className="grid md:grid-cols-3 gap-4">
              {anc.slice(0, 3).map((a, i) => {
                const s = ((a.code || "") + " " + (a.name || "")).toLowerCase();
                // HomePage #2 — every recommendation card shows a realistic photo, not a flat SVG glyph.
                // Curated JPGs where we have them; otherwise a topic-relevant photo resolved by imageFor()
                // and rendered through <Img> (which falls back to a deterministic photo, then a gradient).
                const ancPhoto = /upgrad|cabin|business/.test(s) ? ASSET + "business-upgrade.jpg"
                  : /secur|priorit|fast/.test(s) ? ASSET + "fast-track-security.jpg"
                  : /chang|flex/.test(s) ? ASSET + "flexible-change.jpg"
                  : /seat/.test(s) ? ASSET + "business-upgrade.jpg"
                  : imageFor(a.code + " " + a.name) || imageFor(s);
                return (
                  <Card key={a.code || i} className="overflow-hidden flex" style={{ borderRadius: "16px" }}>
                    <div className="w-[92px] shrink-0 self-stretch overflow-hidden" style={{ background: "#eef5e8" }}>
                      <Img seed={"anc-" + (a.code || i)} src={ancPhoto || undefined} alt={a.name || ""} className="w-full h-full" fit="cover" />
                    </div>
                    <div className="p-3.5 flex flex-col flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {a.recommended
                          ? <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ background: "rgba(241,245,236,1)", color: "rgba(46,122,14,1)" }}><span className="w-1.5 h-1.5 rounded-full bg-tap-green inline-block" /> Recommended</span>
                          : <Pill tone="slate">{i === 1 ? "Cash + miles" : "Popular · " + u.tier}</Pill>}
                      </div>
                      <div className="text-[14px] font-bold mt-1.5 truncate">{a.name}</div>
                      <div className="text-[11px] text-ink-muted mt-0.5 flex-1">{a.reason || a.desc || "Add before you fly."}</div>
                      <div className="flex items-center justify-between mt-2.5 gap-2"><div className="text-[13px] font-bold v2-num shrink-0">{EUR(a.price)} <span className="text-[11px] font-medium text-ink-faint">or {miles(Math.round(a.price / MILES_RATE))} mi</span></div><Btn size="sm" variant={i === 1 ? "outline" : "primary"} className="shrink-0" onClick={() => go("extras", { add: a.code, addName: a.name, addPrice: a.price })}>{i === 1 ? "Review" : "Add"}</Btn></div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* QUICK ACTIONS — own white band so the section alternates (zebra) from the grey page */}
      <section className="bg-surface border-y border-line">
        <div className="mx-auto max-w-page px-4 sm:px-6 py-10">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[["cart", "Manage booking", "PNR or last name", "manage"], ["check", "Online check-in", "Opens 22h before", "checkin"], ["clock", "Flight status", "Track any TP", "manage"], ["bag", "Add bag", "Cheaper before airport", "extras"], ["plane", "Change flight", u.tier + " · no fee", "rebook"], ["star", "Help center", "Chat or call", "ai"]].map(([ic, t, s, r]) => (
              <button key={t} onClick={() => go(r)} className="text-left rounded-[14px] p-4 transition-colors hover:brightness-95" style={{ background: "rgba(242,255,219,1)", border: "1px solid rgba(199,242,31,1)" }}><span className="text-tap-greenDeep"><Icon name={ic} size={16} /></span><div className="text-[13px] font-bold mt-2">{t}</div><div className="text-[11px] text-ink-muted">{s}</div></button>
            ))}
          </div>
        </div>
      </section>

      {/* DESTINATIONS — back on the grey page background */}
      <div className="mx-auto max-w-page px-4 sm:px-6 py-10">
        <DestGrid destinations={shared.destinations} go={go} />
      </div>
    </div>
  );
}

/* derive commute templates from real pattern + history */
function buildTemplates(profile, cityOf) {
  const pat = profile.pattern || {}, hist = profile.history || [], seat = (profile.prefs?.seat || "").split(" ")[0];
  const out = [];
  if (pat.usualOutNo) out.push({ label: "Mon · early", route: `${pat.origin} → ${pat.dest}`, time: pat.usualDep || "", detail: `${pat.usualOutNo} · Hand bag · seat ${seat} · default card`, used: pat.matching || pat.last || 1 });
  if (pat.usualBackNo) out.push({ label: "Thu · return", route: `${pat.dest} → ${pat.origin}`, time: pat.usualBackDep || "", detail: `${pat.usualBackNo} · Evening · ${profile.prefs?.bag || "window seat"} · Fast Track`, used: hist.filter(h => h.flight_no === pat.usualBackNo).length || 1 });
  const counts = {}; hist.forEach(h => { if (h.route) counts[h.route] = (counts[h.route] || 0) + 1; });
  const third = Object.entries(counts).sort((a, b) => b[1] - a[1]).find(([r]) => r !== pat.topRoute);
  if (third) {
    const deps = hist.filter(h => h.route === third[0]).map(h => h.dep_time).filter(Boolean).sort();
    const sameDayTime = deps.length >= 2 ? `${deps[0]} / ${deps[deps.length - 1]}` : (deps[0] || "");
    out.push({ label: "Same-day", route: third[0].replace("→", " ↔ "), time: sameDayTime, detail: `Out & back · flex fare`, used: third[1] });
  }
  out.push({ label: "Weekly shuttle", route: `${pat.origin || "MIA"} ↔ ${pat.dest || "JFK"}`, time: "", detail: "Auto-rebook each week · pause anytime", shuttle: true });
  return out.slice(0, 4);
}

function timeAgo(iso) {
  const d = new Date((iso || "").replace(" ", "T")); if (isNaN(d)) return "recently";
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + "m ago"; const h = Math.round(m / 60); if (h < 24) return h + "h ago"; return Math.round(h / 24) + "d ago";
}

/* ─────────────────────────── Placeholder + ROUTES (program map) ─────────────────────────── */
export function Placeholder({ title, phase, plan, reuses, go }) {
  return (
    <Page>
      <Card className="p-8 v2-in">
        <Pill tone="slate" className="mb-3">Phase {phase} · on the build queue</Pill>
        <h1 className="text-[24px] font-bold">{title}</h1>
        {plan && <p className="text-[13px] text-ink-muted mt-2 max-w-xl">{plan}</p>}
        {reuses && <div className="mt-4 text-[11px] text-ink-faint">Reuses live endpoints: <span className="font-mono text-ink-muted">{reuses}</span></div>}
        <div className="mt-6"><Btn variant="outline" onClick={() => go("home")}>← Back to Home</Btn></div>
      </Card>
    </Page>
  );
}

export const ROUTES = {
  home: { title: "Home", comp: Home },
  homepage: { title: "Homepage", comp: Homepage },
  results: { title: "Search results", comp: Results },
  cart: { title: "View & customize cart", comp: Cart },
  passenger: { title: "Passenger details", comp: Passenger },
  payment: { title: "Payment", comp: Payment },
  confirmation: { title: "Booking confirmed", comp: Confirmation },
  basket: { title: "My trip basket", comp: Basket },
  manage: { title: "Manage my booking", comp: ManageBooking },
  upgrade: { title: "Upgrade cabin", comp: CabinUpgrade },
  seatchange: { title: "Change seat", comp: SeatChange },
  rebook: { title: "Rebook", comp: Rebook },
  checkin: { title: "Online check-in", comp: CheckInIndirect },
  addextras: { title: "Add extras", comp: AddExtras },
  refund: { title: "Cancel & refund", comp: Refund },
  split: { title: "Change / split travellers", comp: SplitBooking },
  retrieve: { title: "Retrieve booking", comp: Retrieve },
  express: { title: "Express checkout", comp: ExpressCheckout },
  hold: { title: "Hold My Fare", phase: 2, plan: "Free 48h fare hold for tier members (A8).", reuses: "/api/fare-lock, /api/hold" },
  disruption: { title: "Disruption / IROPS", comp: DisruptionCenter },
  stopover: { title: "Portugal Stopover", comp: StopoverBuilder },
  extras: { title: "Trip Extras", comp: AddExtras },
  miles: { title: "Xperion Miles", comp: MilesShop },
  wishlist: { title: "Wishlist", phase: 3, plan: "Saved routes & destinations.", reuses: "(new)" },
  ai: { title: "Xperion AI · Travel concierge", comp: AIConcierge },
  console: { title: "Demo Console", comp: DemoConsole },
  admin: { title: "Demo Console", comp: DemoConsole },
};
