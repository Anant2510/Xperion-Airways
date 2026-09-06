// FlyTAP v2 — Xperion AI concierge, mapped to behave like v1's "Xperion AI Assistant":
// same dynamic greeting (name · usual route · recommended date · Adobe RT-CDP source),
// same suggestion chips (Express + Best-time / under $500 / in October), and the same
// LIVE agent backend (/api/ai/agent). Embedded mode replaces the hero search; full mode
// is the /ai route with a context rail.
import React, { useState, useRef, useEffect } from "react";
import { api, EUR, miles, tierProgress } from "./lib.js";

// ── currency ────────────────────────────────────────────────────────────────
// The chat renders money for whichever airline is answering, so it can't hardcode $.
// EUR() (the host app's formatter) is kept for the EUR case so Xperion output is unchanged.
const CURRENCY_SYM = { EUR: "\u20ac", GBP: "\u00a3", USD: "$", CHF: "CHF", NOK: "kr", SEK: "kr", DKK: "kr", PLN: "z\u0142" };
let ACTIVE_CURRENCY = "USD";   // set from the resolved tenant's brand on each reply
function money(n) {
  if (!ACTIVE_CURRENCY || ACTIVE_CURRENCY === "USD") return EUR(n);
  const sym = CURRENCY_SYM[ACTIVE_CURRENCY] || ACTIVE_CURRENCY;
  const v = Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return sym.length > 1 ? `${v} ${sym}` : `${sym}${v}`;
}
import { Btn, Card, Pill, Icon, Eyebrow, Divider, cx } from "./ui.jsx";

// Apply a tenant palette by overriding the --air-* CSS variables the renderer's utility
// classes read. Values default to Xperion's palette in tokens.css, so a tenant with no theme (or
// Xperion itself) renders exactly as before. Scope note: variables are set on the document root,
// which is fine for a dedicated app; a future SDK build scopes them to the widget element.
function applyTheme(theme) {
  if (!theme || typeof document === "undefined") return;
  const VARS = { accent: "--air-accent", accentDeep: "--air-accent-deep", accentDark: "--air-accent-dark",
    highlight: "--air-highlight", tint: "--air-tint", danger: "--air-danger" };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(VARS)) if (theme[k]) root.style.setProperty(v, theme[k]);
}

// ── A2UI transaction cards (vertical slice: search → select → checkout) ──
// Each card renders the agent's real result inline and routes button taps back through the same
// agent via `act(text)` (which calls send()), so the whole book flow happens in the chat.

// Step 2 — a flight has been selected; show it with the primary "pay" action + adjustments.
function SelectedCard({ card, act }) {
  const extras = card.auto_extras || [];
  return (
    <div className="rounded-xl border-2 mt-2 overflow-hidden" style={{ borderColor: "#9EFD38" }}>
      <div className="px-3.5 py-2.5 flex items-center justify-between" style={{ background: "#F5FCD9" }}>
        <div><div className="text-[13px] font-bold text-ink">{card.flight_no} · {card.route}</div><div className="text-[11px] text-ink-faint">{card.dep}{card.arr ? ` → ${card.arr}` : ""}{card.seat ? ` · seat ${card.seat}` : ""}</div></div>
        <div className="text-[15px] font-bold v2-num text-ink">{money(card.price)}</div>
      </div>
      {extras.length > 0 && <div className="px-3.5 pt-2 text-[11px] text-ink-faint">Included: {extras.join(" · ")}</div>}
      <div className="p-3 flex flex-wrap gap-2">
        <Btn size="sm" variant="primary" onClick={() => act("Pay now with my saved profile")}>Pay {money(card.price)} →</Btn>
        <button onClick={() => act("How can I pay for this?")} className="text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Payment options</button>
        <button onClick={() => act("Change my seat")} className="text-[12px] font-semibold text-ink-muted px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Change seat</button>
      </div>
    </div>
  );
}

// Step 3 — booked; show the PNR, how it was paid, and next actions (still in chat).
function ConfirmationCard({ card, act, go }) {
  const s = card.split || {};
  const parts = [s.voucher ? `${money(s.voucher)} voucher` : null, s.miles ? `${miles(s.miles)} miles` : null, s.card ? `${money(s.card)} card` : null].filter(Boolean);
  return (
    <div className="rounded-xl border border-line mt-2 overflow-hidden">
      <div className="px-3.5 py-3" style={{ background: "linear-gradient(100deg,#e8f8dc,#f5fcd9)" }}>
        <div className="flex items-center gap-2 text-[13px] font-bold air-accent-dark"><Icon name="check" size={15} className="air-accent" /> Booked · PNR {card.pnr}</div>
        <div className="text-[11px] text-ink-faint mt-0.5">{card.route}{card.dep ? ` · ${card.dep}` : ""} · {money(card.total)}{parts.length ? ` · ${parts.join(" + ")}` : ""}</div>
      </div>
      <div className="p-3 flex flex-wrap gap-2">
        <button onClick={() => act(`Choose seats for ${card.pnr}`)} className="text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Choose seats</button>
        <button onClick={() => act(`Add extras to ${card.pnr}`)} className="text-[12px] font-semibold text-ink-muted px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Add extras</button>
        <button onClick={() => go("manage")} className="text-[12px] font-semibold text-ink-muted px-3 py-2 rounded-full border border-line hover:bg-surface-mute">View in My Trips ↗</button>
      </div>
    </div>
  );
}

function FlightCard({ card, onPick }) {
  return (
    <div className="rounded-xl border border-line overflow-hidden mt-2">
      {(card.flights || []).slice(0, 3).map((f, i) => (
        <button key={f.flight_no} onClick={() => onPick(f)} className={cx("w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-surface-mute", i > 0 && "border-t border-line")}>
          <div className="text-[15px] font-bold v2-num w-14">{f.dep}</div>
          <div className="flex-1"><div className="text-[12px] font-semibold">{f.flight_no} → {f.arr}</div><div className="text-[11px] text-ink-faint">{f.duration} · Direct · Classic</div></div>
          {(f.recommended || f.lowest) && <Pill tone="lime">{f.recommended ? "Recommended" : "Lowest"}</Pill>}
          <div className="text-right"><div className="text-[13px] font-bold v2-num">{money(f.price)}</div>{f.miles_price && <div className="text-[10px] air-accent-deep v2-num">or {miles(f.miles_price)} mi</div>}</div>
        </button>
      ))}
    </div>
  );
}

// ── Post-booking A2UI cards ──
// The manage hub — one card summarising the booking with every post-booking action as a chat button.
function BookingCard({ card, act, go }) {
  const ci = card.checked_in;
  return (
    <div className="rounded-xl border border-line mt-2 overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center justify-between" style={{ background: "#FAFAF7" }}>
        <div><div className="text-[13px] font-bold text-ink">{card.pnr} · {card.route}</div><div className="text-[11px] text-ink-faint">{card.flight_no}{card.dep ? ` · ${card.dep}` : ""}{card.seat ? ` · seat ${card.seat}` : ""}{ci ? " · checked in" : ""}</div></div>
        {card.status && <Pill tone={/on time|confirmed/i.test(card.status) ? "lime" : "slate"}>{card.status}</Pill>}
      </div>
      <div className="p-3 flex flex-wrap gap-2">
        <button onClick={() => act(`Change my seat on ${card.pnr}`)} className="text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Change seat</button>
        <button onClick={() => act(`Upgrade ${card.pnr} to Business`)} className="text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Upgrade</button>
        {!ci && <button onClick={() => act(`Check me in for ${card.pnr}`)} className="text-[12px] font-semibold text-ink-muted px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Check in</button>}
        <button onClick={() => act(`Cancel ${card.pnr}`)} className="text-[12px] font-semibold air-danger px-3 py-2 rounded-full border air-hover-danger-soft" style={{ borderColor: "rgba(237,28,36,0.35)" }}>Cancel</button>
      </div>
    </div>
  );
}

// Seat change result — confirmed move, or "taken" with a one-tap alternative.
function SeatCard({ card, act }) {
  if (card.taken) {
    return (
      <div className="rounded-xl border border-line mt-2 p-3">
        <div className="text-[12px] text-ink"><span className="font-semibold">{card.seat}</span> is taken.{card.suggestion ? "" : " Try another seat."}</div>
        {card.suggestion && <button onClick={() => act(`Give me seat ${card.suggestion}`)} className="mt-2 text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Take {card.suggestion} instead →</button>}
      </div>
    );
  }
  return (
    <div className="rounded-xl border-2 mt-2 p-3" style={{ borderColor: "#9EFD38", background: "#F5FCD9" }}>
      <div className="flex items-center gap-2 text-[13px] font-bold text-ink"><Icon name="check" size={14} className="air-accent" /> Seat {card.seat}{card.cabin ? ` · ${card.cabin}` : ""}</div>
      <div className="text-[11px] text-ink-faint mt-0.5">{card.from ? `Moved from ${card.from}. ` : ""}{card.included ? "Included in your fare." : card.price ? `${money(card.price)} — added to your trip.` : ""}</div>
    </div>
  );
}

// Irreversible action awaiting an explicit yes — never fires on the button that produced it.
function ConfirmCard({ card, act }) {
  const yes = card.tool === "cancel_booking" ? "Yes, cancel it"
            : card.tool === "upgrade_cabin" ? `Yes, upgrade to ${card.cabin || "Business"}`
            : card.tool === "split_booking" ? "Yes, go ahead" : "Yes, confirm";
  const isDestructive = card.tool === "cancel_booking";
  return (
    <div className="rounded-xl border mt-2 p-3" style={{ borderColor: isDestructive ? "rgba(237,28,36,0.35)" : "#E8E8E5", background: isDestructive ? "rgba(237,28,36,0.04)" : "#FAFAF7" }}>
      <div className="text-[12px] text-ink">{card.message || "Please confirm this action."}</div>
      <div className="mt-2.5 flex gap-2">
        <button onClick={() => act(yes)} className={cx("text-[12px] font-semibold text-white px-3.5 py-2 rounded-full", isDestructive ? "air-bg-danger hover:opacity-90" : "air-bg-accent air-hover-accent-deep")}>{isDestructive ? "Confirm cancellation" : "Confirm"}</button>
        <button onClick={() => act("No, keep it")} className="text-[12px] font-semibold text-ink-muted px-3.5 py-2 rounded-full border border-line hover:bg-surface-mute">Keep it</button>
      </div>
    </div>
  );
}

function UpgradedCard({ card }) {
  return (
    <div className="rounded-xl border-2 mt-2 p-3" style={{ borderColor: "#9EFD38", background: "#F5FCD9" }}>
      <div className="flex items-center gap-2 text-[13px] font-bold text-ink"><Icon name="check" size={14} className="air-accent" /> {card.pnr} upgraded to {card.cabin}</div>
      <div className="text-[11px] text-ink-faint mt-0.5">{card.price ? `${money(card.price)} — ticket reissued.` : "Ticket reissued."}</div>
    </div>
  );
}

function CancelledCard({ card, go }) {
  const r = card.refund || {};
  const parts = [r.card ? `${money(r.card)} to card` : null, r.miles ? `${miles(r.miles)} miles back` : null, r.voucher ? `${money(r.voucher)} voucher` : null].filter(Boolean);
  return (
    <div className="rounded-xl border border-line mt-2 p-3">
      <div className="text-[13px] font-bold text-ink">Cancelled · {card.pnr}</div>
      <div className="text-[11px] text-ink-faint mt-0.5">{card.route}{parts.length ? ` · refund: ${parts.join(" · ")}` : ""}</div>
      <button onClick={() => go("manage")} className="mt-2 text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">View My Trips ↗</button>
    </div>
  );
}

// Checked in — a compact boarding-pass card with seat + boarding group.
function CheckinCard({ card, go }) {
  return (
    <div className="rounded-xl border-2 mt-2 overflow-hidden" style={{ borderColor: "#9EFD38" }}>
      <div className="px-3.5 py-3" style={{ background: "linear-gradient(100deg,#e8f8dc,#f5fcd9)" }}>
        <div className="flex items-center gap-2 text-[13px] font-bold air-accent-dark"><Icon name="check" size={15} className="air-accent" /> Checked in · {card.pnr}</div>
        <div className="text-[11px] text-ink-faint mt-0.5">{card.flight_no}{card.route ? ` · ${card.route}` : ""}{card.date ? ` · ${card.date}` : ""}</div>
      </div>
      <div className="px-3.5 py-2.5 flex items-center gap-4 text-[12px]">
        {card.seat && <div><span className="text-ink-faint">Seat</span> <span className="font-bold v2-num text-ink">{card.seat}</span></div>}
        {card.group && <div><span className="text-ink-faint">Boarding</span> <span className="font-bold text-ink">{card.group}</span></div>}
        <button onClick={() => go("manage")} className="ml-auto text-[12px] font-semibold air-accent-deep hover:underline">Boarding pass ↗</button>
      </div>
    </div>
  );
}

// Refund status — read-only progress card for an in-flight refund.
function RefundCard({ card }) {
  return (
    <div className="rounded-xl border border-line mt-2 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-bold text-ink">Refund · {card.pnr}</div>
        {card.amount != null && <div className="text-[15px] font-bold v2-num text-ink">{money(card.amount)}</div>}
      </div>
      <div className="text-[11px] text-ink-faint mt-0.5">{[card.method, card.stage].filter(Boolean).join(" · ")}</div>
      {card.eta && <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold air-accent-deep"><Icon name="clock" size={12} /> {card.eta}</div>}
    </div>
  );
}

// ── Extras & discovery A2UI cards ──
// Basket after add/remove extras — itemised, with fare + extras reconciling to the total.
function ExtrasCard({ card, act }) {
  const items = card.items || [];
  return (
    <div className="rounded-xl border border-line mt-2 overflow-hidden">
      <div className="px-3.5 py-2.5" style={{ background: "#FAFAF7" }}>
        <div className="text-[13px] font-bold text-ink">Your basket</div>
      </div>
      <div className="px-3.5 py-1">
        {items.map((it, i) => (
          <div key={it.code || i} className="flex items-center justify-between py-1.5 text-[12px]">
            <span className="text-ink">{it.name || it.code}</span>
            <span className="v2-num text-ink-muted">{it.price ? money(it.price) : "Included"}</span>
          </div>
        ))}
        {items.length === 0 && <div className="py-1.5 text-[12px] text-ink-faint">No extras yet.</div>}
      </div>
      <div className="px-3.5 py-2.5 border-t border-line flex items-center justify-between">
        <div className="text-[11px] text-ink-faint">Fare {card.fare != null ? money(card.fare) : ""}{card.extras_total ? ` + extras ${money(card.extras_total)}` : ""}</div>
        <div className="text-[15px] font-bold v2-num text-ink">{card.total != null ? money(card.total) : ""}</div>
      </div>
      <div className="p-3 pt-0"><Btn size="sm" variant="primary" onClick={() => act("Pay now with my saved profile")}>Pay {card.total != null ? money(card.total) : ""} →</Btn></div>
    </div>
  );
}

// Personalized bundle (event + hotel + flight). No book_package tool exists, so the CTA starts the
// booking flow by searching the bundle's destination rather than claiming a one-tap book.
function PackageCard({ card, act, go }) {
  return (
    <div className="rounded-xl border border-line mt-2 overflow-hidden">
      <div className="px-3.5 py-3" style={{ background: "linear-gradient(100deg,#e8f8dc,#f5fcd9)" }}>
        <div className="flex items-center gap-2">
          <div className="text-[13px] font-bold text-ink">{card.event}</div>
          {card.badge && <Pill tone="lime">{card.badge}</Pill>}
        </div>
        <div className="text-[11px] text-ink-faint mt-0.5">{[card.venue, card.city, card.date].filter(Boolean).join(" · ")}</div>
        {card.affinity_label && <div className="text-[10px] air-accent-deep font-semibold mt-1">Picked from your {card.affinity_label}</div>}
      </div>
      <div className="px-3.5 py-2 text-[12px]">
        {card.eventPrice != null && <div className="flex justify-between py-0.5"><span className="text-ink-muted">Event</span><span className="v2-num">{money(card.eventPrice)}</span></div>}
        {card.hotel && <div className="flex justify-between py-0.5"><span className="text-ink-muted">{card.hotel}{card.hotelNights ? ` · ${card.hotelNights} nights` : ""}</span><span className="v2-num">{card.hotelPrice != null ? money(card.hotelPrice) : ""}</span></div>}
        {card.flight && <div className="flex justify-between py-0.5"><span className="text-ink-muted">Return flight</span><span className="v2-num">{card.flightPrice != null ? money(card.flightPrice) : ""}</span></div>}
      </div>
      <div className="px-3.5 py-2.5 border-t border-line flex items-center justify-between">
        <span className="text-[11px] text-ink-faint">All-in</span>
        <span className="text-[15px] font-bold v2-num text-ink">{card.total != null ? money(card.total) : ""}</span>
      </div>
      <div className="p-3 pt-0 flex flex-wrap gap-2">
        <Btn size="sm" variant="primary" onClick={() => act(`Find flights to ${card.city}`)}>Start booking →</Btn>
        <button onClick={() => go("home")} className="text-[12px] font-semibold text-ink-muted px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Maybe later</button>
      </div>
    </div>
  );
}

// Network/destination list — where this airline flies from an origin. Each city is tappable.
function DestinationsCard({ card, act }) {
  const d = (card.destinations || []).slice(0, 12);
  if (!d.length) return null;
  return (
    <div className="rounded-xl border border-line mt-2 p-3">
      <div className="text-[12px] font-semibold text-ink mb-2">{card.count} destinations from {card.originCity || card.origin}</div>
      <div className="flex flex-wrap gap-1.5">
        {d.map((x, i) => (
          <button key={x.code || i} onClick={() => act(`Find flights to ${x.city || x.code}`)} className="px-2.5 py-1.5 rounded-full border border-line text-[11px] font-semibold text-ink air-hover-tint air-hover-border-accent">
            {x.city || x.code}{x.flown ? " ·\u00a0flown" : ""}
          </button>
        ))}
      </div>
      {(card.destinations || []).length > 12 && <div className="text-[11px] text-ink-faint mt-1.5">…and {(card.destinations || []).length - 12} more — just name one.</div>}
    </div>
  );
}

// Destination ideas — each chip re-asks the agent to search that city.
function SuggestionsCard({ card, act }) {
  const sug = (card.suggestions || []).slice(0, 6);
  if (!sug.length) return null;
  return (
    <div className="rounded-xl border border-line mt-2 p-3">
      <div className="text-[12px] font-semibold text-ink mb-2">Where to next?</div>
      <div className="flex flex-wrap gap-1.5">
        {sug.map((s, i) => (
          <button key={s.code || i} onClick={() => act(`Find flights to ${s.city || s.code}`)} className="px-2.5 py-1.5 rounded-full air-bg-tint air-accent-dark text-[11px] font-semibold hover:brightness-95">
            {s.city || s.code}{s.flown ? " · been" : s.searched ? " · searched" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Wallet & seat-selection A2UI cards ──
// Wallet balance — miles, voucher and card, with a prompt to spend inline.
function WalletCard({ card, act }) {
  const v = card.voucher;
  return (
    <div className="rounded-xl border border-line mt-2 overflow-hidden">
      <div className="px-3.5 py-3" style={{ background: "linear-gradient(100deg,#eef6ff,#f5fcd9)" }}>
        <div className="text-[11px] text-ink-faint">Xperion Miles &amp; Go</div>
        <div className="text-[20px] font-bold v2-num text-ink">{miles(card.miles)} <span className="text-[12px] font-semibold text-ink-muted">miles</span></div>
        {card.miles_value_eur != null && <div className="text-[11px] text-ink-faint">≈ {money(card.miles_value_eur)}</div>}
      </div>
      <div className="px-3.5 py-2 text-[12px] space-y-1">
        {v && v.amount != null && <div className="flex justify-between"><span className="text-ink-muted">Voucher {v.code || ""}</span><span className="v2-num">{money(v.amount)}{v.available ? "" : " · used"}</span></div>}
        {card.card && <div className="flex justify-between"><span className="text-ink-muted">Card</span><span className="text-ink">{card.card}</span></div>}
      </div>
      <div className="p-3 pt-1.5"><button onClick={() => act("What can I book with my miles?")} className="text-[12px] font-semibold air-accent-deep px-3 py-2 rounded-full border border-line hover:bg-surface-mute">Spend my miles →</button></div>
    </div>
  );
}

// Seat selection — per-cabin availability with tappable example seats routing through change_seat.
function SeatsCard({ card, act }) {
  const cabins = card.cabins || [];
  return (
    <div className="rounded-xl border border-line mt-2 overflow-hidden">
      <div className="px-3.5 py-2.5" style={{ background: "#FAFAF7" }}>
        <div className="text-[13px] font-bold text-ink">Choose a seat</div>
        {card.current_seat && <div className="text-[11px] text-ink-faint">Currently {card.current_seat}{card.current_cabin ? ` · ${card.current_cabin}` : ""}</div>}
      </div>
      <div className="px-3.5 py-2 space-y-2.5">
        {cabins.map((cb, i) => (
          <div key={cb.cabin || i}>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[12px] font-semibold text-ink">{cb.cabin}</div>
              <div className="text-[11px] text-ink-faint">{cb.included ? "Included" : cb.price_from != null ? `from ${money(cb.price_from)}` : ""}{cb.seats_available != null ? ` · ${cb.seats_available} free` : ""}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(cb.examples || []).slice(0, 6).map(s => (
                <button key={s} onClick={() => act(`Give me seat ${s}`)} className="px-2.5 py-1.5 rounded-lg border border-line text-[12px] font-semibold v2-num text-ink air-hover-tint air-hover-border-accent">{s}</button>
              ))}
              {(!cb.examples || cb.examples.length === 0) && <span className="text-[11px] text-ink-faint">No free seats.</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="px-3.5 pb-3 pt-1 text-[11px] text-ink-faint">Or tell me a preference — “window”, “aisle”, “business”.</div>
    </div>
  );
}


/* ── Enterprise Autonomy: proactive disruption offer, delivered by the Offer agent ── */
function DisruptionCard({ card, resolved, onResolve }) {
  const [busy, setBusy] = useState(null);
  const go = async (o) => { if (busy || resolved) return; setBusy(o ? o.id : "decline"); try { await onResolve(o, card); } finally { setBusy(null); } };
  return (
    <div className="rounded-xl border mt-2 overflow-hidden" style={{ borderColor: "#E2354B" }}>
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2" style={{ background: "#FFF2F4" }}>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: "#B4192F" }}>Weather risk · proactive</div>
          <div className="text-[13px] font-bold text-ink">{card.flight} {card.origin}→{card.dest} · {card.date}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[20px] font-black v2-num leading-none" style={{ color: "#B4192F" }}>{card.probability}%</div>
          <div className="text-[9px] text-ink-faint">disruption risk</div>
        </div>
      </div>
      {card.reasons?.length > 0 && <div className="px-3.5 pt-2 flex flex-wrap gap-1">{card.reasons.slice(0, 3).map((r, i) => <span key={i} className="text-[10px] rounded-full border border-line bg-surface px-2 py-0.5 text-ink-muted">{r}</span>)}</div>}
      <div className="px-3.5 py-2 space-y-2">
        {(card.options || []).map((o, i) => (
          <button key={o.id} disabled={!!busy || resolved} onClick={() => go(o)}
            className={cx("w-full text-left rounded-lg border p-2.5 flex items-center gap-3 transition-colors", resolved ? "border-line opacity-60" : "border-line hover:border-tap-green bg-surface")}>
            <span className="w-6 h-6 rounded-full air-bg-accent text-white text-[11px] font-bold inline-flex items-center justify-center shrink-0">{i + 1}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12px] font-bold text-ink">{o.label}</span>
              {o.detail && <span className="block text-[11px] text-ink-faint">{o.detail}</span>}
            </span>
            <span className="text-[10px] font-semibold air-accent-deep shrink-0">{busy === o.id ? "Working…" : o.tag || (o.cost || "no charge")}</span>
          </button>
        ))}
      </div>
      <div className="px-3.5 pb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] text-ink-faint">{card.holdUntil ? `Seats held until ${String(card.holdUntil).replace("T", " ").slice(0, 16)} UTC · ` : ""}nothing charged until you choose</span>
        {!resolved && <button disabled={!!busy} onClick={() => go(null)} className="text-[11px] font-semibold text-ink-muted hover:text-ink">{busy === "decline" ? "…" : "Not now"}</button>}
        {resolved && <span className="text-[11px] font-semibold air-accent-deep">Handled ✓</span>}
      </div>
    </div>
  );
}
function DisruptionConfirmedCard({ card, go }) {
  const refund = card.status === "refund_pending";
  return (
    <div className="rounded-xl border mt-2 overflow-hidden" style={{ borderColor: refund ? "#E8C75A" : "#46A41A" }}>
      <div className="px-3.5 py-2.5" style={{ background: refund ? "#FFF9EC" : "#F2FCD9" }}>
        <div className="text-[10px] font-bold uppercase tracking-wide air-accent-deep">{refund ? "Refund packaged for approval" : "Handled · nothing charged"}</div>
        <div className="text-[13px] font-bold text-ink">{card.option?.label}</div>
        <div className="text-[11px] text-ink-faint">Booking {card.pnr}{card.flight ? ` · ${card.flight}` : ""}</div>
      </div>
      <ul className="px-3.5 py-2 space-y-1">{(card.items || []).map((x, i) => <li key={i} className="flex items-start gap-2 text-[12px] text-ink"><Icon name="check" size={13} className="text-tap-green mt-0.5 shrink-0" />{x}</li>)}</ul>
      <div className="px-3.5 pb-3"><Btn size="sm" variant="outline" onClick={() => go && go("manage")}>Open My Trips →</Btn></div>
    </div>
  );
}


/* ── Destination intelligence: weather, events, advisories with sources; the customer decides ── */
function DestinationBriefCard({ card, onChoice, resolved }) {
  const [busy, setBusy] = useState(null);
  const tone = card.impact === "high" ? "#B4192F" : card.impact === "medium" ? "#B7791F" : "#2E7D33";
  const bg = card.impact === "high" ? "#FFF2F4" : card.impact === "medium" ? "#FFF8E6" : "#F2FCD9";
  const go = async (id) => { if (busy || resolved) return; setBusy(id); try { await onChoice(id, card); } finally { setBusy(null); } };
  return (
    <div className="rounded-xl border mt-2 overflow-hidden" style={{ borderColor: tone }}>
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2" style={{ background: bg }}>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: tone }}>Destination brief · {card.mode === "llm+facts" ? "researched" : "forecast only"}</div>
          <div className="text-[13px] font-bold text-ink">{card.city} · {card.window?.from?.slice(5)} to {card.window?.to?.slice(5)}</div>
        </div>
        <div className="text-right shrink-0"><div className="text-[11px] font-black uppercase" style={{ color: tone }}>{card.impact} impact</div>{card.confidence != null && <div className="text-[9px] text-ink-faint">confidence {Math.round(card.confidence * 100)}%</div>}</div>
      </div>
      <div className="px-3.5 py-2 space-y-2 text-[12px] text-ink">
        {card.summary && <div className="text-ink-muted">{card.summary}</div>}
        <div><span className="font-bold">Weather</span> · {card.weather?.alerts?.length ? card.weather.alerts.map((a) => a.headline).join(" · ") : (card.weather?.days?.length ? card.weather.days.map((d) => `${d.date.slice(5)} ${d.label}${d.tmax != null ? ` ${Math.round(d.tmin)}–${Math.round(d.tmax)}°` : ""}`).join(", ") : "no forecast yet")}</div>
        {card.events?.length > 0 && <div><div className="font-bold">Happening there</div><ul className="mt-1 space-y-1">{card.events.map((e, i) => <li key={i} className="flex items-start gap-2"><span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold uppercase text-white" style={{ background: e.impact === "high" ? "#B4192F" : e.impact === "medium" ? "#B7791F" : "#5E9A8B" }}>{e.kind}</span><span>{e.title}{e.date ? ` (${e.date})` : ""}{e.note ? ` — ${e.note}` : ""}{e.source && <a href={e.source} target="_blank" rel="noreferrer" className="ml-1 text-ink-faint underline">source</a>}</span></li>)}</ul></div>}
        {card.advisories?.length > 0 && <div><span className="font-bold">Advisory</span> · {card.advisories.map((a, i) => <span key={i}>{a.summary}{a.level ? ` (${a.level})` : ""}{a.source && <a href={a.source} target="_blank" rel="noreferrer" className="ml-1 text-ink-faint underline">source</a>} </span>)}</div>}
        {card.holidays?.length > 0 && <div><span className="font-bold">Public holidays</span> · {card.holidays.map((h) => `${h.name} (${h.date.slice(5)})`).join(", ")}</div>}
        {card.sources?.length > 0 && <div className="text-[10px] text-ink-faint">{card.sources.length} sources · generated {String(card.generated_at || "").replace("T", " ").slice(0, 16)} UTC</div>}
      </div>
      {card.options?.length > 0 && (
        <div className="px-3.5 pb-3 flex flex-wrap gap-2">
          {card.options.map((o) => <button key={o.id} disabled={!!busy || resolved} onClick={() => go(o.id)} className={cx("text-[11px] font-semibold rounded-full border px-3 py-1.5", o.id === "keep" ? "air-bg-accent text-white border-transparent" : "border-line bg-surface text-ink hover:border-tap-green", resolved && "opacity-60")}>{busy === o.id ? "…" : o.label}</button>)}
          {resolved && <span className="text-[11px] font-semibold air-accent-deep self-center">Noted ✓</span>}
        </div>
      )}
    </div>
  );
}

function Bubble({ m, onPick, onQuick, go, act }) {
  if (m.role === "user") return <div className="flex justify-end"><div className="max-w-[80%] rounded-2xl rounded-br-md bg-surface-dark text-white px-3.5 py-2.5 text-[13px]">{m.content}</div></div>;
  const c = (m.cards || [])[0];
  // Rendered as interactive A2UI cards. Any unrecognised type still shows a minimal line.
  const richSlice = c && ["flights", "selected", "confirmation", "booking", "seat", "confirm", "upgraded", "cancelled", "checkin", "refund", "extras", "package", "suggestions", "wallet", "seats", "destinations", "disruption", "disruption_confirmed", "disruption_declined", "disruption_allclear", "destination_brief", "brief_ack"].includes(c.type);
  return (
    <div className="space-y-2">
      {m.content && <div className={cx("text-[13px] text-ink leading-relaxed whitespace-pre-line", m.intro && "rounded-2xl bg-surface-mute px-4 py-3")}>{m.content}</div>}
      {c?.type === "flights" && <FlightCard card={c} onPick={onPick} />}
      {c?.type === "selected" && <SelectedCard card={c} act={act} />}
      {c?.type === "confirmation" && <ConfirmationCard card={c} act={act} go={go} />}
      {c?.type === "booking" && <BookingCard card={c} act={act} go={go} />}
      {c?.type === "seat" && <SeatCard card={c} act={act} />}
      {c?.type === "confirm" && <ConfirmCard card={c} act={act} />}
      {c?.type === "upgraded" && <UpgradedCard card={c} />}
      {c?.type === "cancelled" && <CancelledCard card={c} go={go} />}
      {c?.type === "checkin" && <CheckinCard card={c} go={go} />}
      {c?.type === "refund" && <RefundCard card={c} />}
      {c?.type === "extras" && <ExtrasCard card={c} act={act} />}
      {c?.type === "package" && <PackageCard card={c} act={act} go={go} />}
      {c?.type === "suggestions" && <SuggestionsCard card={c} act={act} />}
      {c?.type === "destinations" && <DestinationsCard card={c} act={act} />}
      {c?.type === "wallet" && <WalletCard card={c} act={act} />}
      {c?.type === "seats" && <SeatsCard card={c} act={act} />}
      {c?.type === "disruption" && <DisruptionCard card={c} resolved={!!m.resolved} onResolve={m.onResolve || (() => {})} />}
      {c?.type === "disruption_confirmed" && <DisruptionConfirmedCard card={c} go={go} />}
      {c?.type === "destination_brief" && <DestinationBriefCard card={c} resolved={!!m.resolved} onChoice={m.onBriefChoice || (() => {})} />}
      {c && !richSlice && <div className="rounded-xl border border-line bg-surface-soft p-3 text-[12px] text-ink-muted">Done.</div>}
      {m.command?.action === "show_search" && <Btn size="sm" variant="outline" className="mt-1" onClick={() => go("results", { origin: m.command.origin, dest: m.command.dest, date: m.command.date })}>View all flights →</Btn>}
      {m.command?.action === "express" && <Btn size="sm" variant="outline" className="mt-1" onClick={() => go("express")}>Open express checkout →</Btn>}
      {(m.command?.action === "navigate" && m.command.screen) && <Btn size="sm" variant="outline" className="mt-1" onClick={() => go(m.command.screen === "search" ? "results" : m.command.screen === "manage" ? "basket" : m.command.screen)}>Open →</Btn>}
      {m.quick && <div className="flex flex-wrap gap-1.5 pt-1">{m.quick.map(q => <button key={q} onClick={() => onQuick(q)} className="px-2.5 py-1 rounded-full air-bg-tint air-accent-dark text-[11px] font-semibold">+ {q}</button>)}</div>}
    </div>
  );
}

export function AIConcierge({ shared, go, embedded, onToggleOff, params, brand: brandProp, transport }) {
  const profile = shared?.profile || {};
  const u = profile.user || {};
  const pat = profile.pattern || {};
  const airports = shared?.airports || [];
  const cityOf = (c) => airports.find(a => a.code === c)?.city || c;
  const origin = pat.origin || u.home_airport || "MIA";
  const dest = pat.dest || "JFK";
  const destCity = cityOf(dest);
  const dateLabel = pat.recommendedLabel || pat.usualOut || "your usual date";
  const sourceLabel = (profile.cdp || /cdp|adobe/i.test(String(profile.source || ""))) ? "Adobe Real-Time CDP" : "Xperion";
  const greeting = `Hi ${u.first_name || "there"} ✈️ Tell me where you want to go and when — I'll plan the rest.\n\n⚡ Or book your usual ${cityOf(origin)} → ${cityOf(dest)} for ${dateLabel} in two taps with Express checkout.\n\n🔗 Personalizing from your ${sourceLabel} profile.`;
  const SUGS = [
    { label: `⚡ Express · your usual · ${dateLabel}`, send: "Book my usual flight with Express checkout", express: true },
    { label: `Best time to visit ${destCity}`, send: `When is the best time to visit ${destCity}?` },
    { label: `Flights under $500 to ${destCity}`, send: `Show me flights under $500 to ${destCity}` },
    { label: `${destCity} in October?`, send: `What are my options for ${destCity} in October?` },
  ];

  const [msgs, setMsgs] = useState([{ role: "assistant", content: greeting, intro: true }]);
  // Seed the box from ?q= handed over by the landing hero, so a query typed there survives the
  // navigation to this page instead of being lost. The user still presses send — we pre-fill, not auto-fire.
  const [input, setInput] = useState(params?.q || "");
  const [busy, setBusy] = useState(false);
  // Airline branding. The server returns `brand` for the resolved tenant on every reply, so a
  // partner deployment shows its own name without a client rebuild; the prop lets the SDK set it
  // before the first reply. Xperion's strings remain the fallback, so Xperion is unchanged.
  const [brandSrv, setBrandSrv] = useState(null);
  const brand = brandSrv || brandProp || null;
  const session = useRef("v2-" + Math.random().toString(36).slice(2, 8));

  /* Enterprise Autonomy: the disruption agents can speak first. Every proactive message the
     Offer / Execution agents wrote for this customer lands here as an assistant bubble with its
     card, exactly as if the assistant had typed it; a card tap runs the same saga as a typed
     "take the Orlando option" or a WhatsApp "2". */
  const inboxCursor = useRef(0);
  const consumed = useRef(new Set());
  const resolveOffer = async (opt, card) => {
    const r = opt ? await api.post("/autonomy/customer/accept", { optionId: opt.id, offerId: card.offerId })
                  : await api.post("/autonomy/customer/decline", {});
    if (r?.inboxId) consumed.current.add(r.inboxId);
    setMsgs(prev => [
      ...prev.map(m => (m.cards?.[0]?.offerId === card.offerId ? { ...m, resolved: true } : m)),
      { role: "assistant", content: r?.reply || (r?.ok ? "Done." : `I couldn't complete that: ${r?.error || "please try again"}.`), cards: r?.card ? [r.card] : [] },
    ]);
  };
  const briefChoice = async (id, card) => {
    const r = await api.post(`/autonomy/customer/brief/${id}`, {});
    if (r?.inboxId) consumed.current.add(r.inboxId);
    setMsgs(prev => [...prev.map(m => (m.cards?.[0]?.type === "destination_brief" && m.cards[0].pnr === card.pnr ? { ...m, resolved: true } : m)),
      ...(r?.reply ? [{ role: "assistant", content: r.reply, cards: [] }] : [])]);
    if (id === "alternatives" && r?.search) send(`flights to ${card.city} around ${r.search.date}, flexible dates`);
  };
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get(`/autonomy/customer/inbox?since=${inboxCursor.current}`);
        if (!alive || !r?.messages?.length) return;
        for (const m of r.messages) inboxCursor.current = Math.max(inboxCursor.current, m.id);
        const fresh = r.messages.filter(m => !consumed.current.has(m.id));
        fresh.forEach(m => consumed.current.add(m.id));
        if (!fresh.length) return;
        const resolvedOffers = new Set(fresh.filter(m => /^disruption_(confirmed|declined)$/.test(m.kind)).map(m => m.card?.offerId).filter(Boolean));
        setMsgs(prev => [
          ...prev.map(m => (resolvedOffers.has(m.cards?.[0]?.offerId) ? { ...m, resolved: true } : m)),
          ...fresh.map(m => ({ role: "assistant", content: m.text, cards: m.card ? [m.card] : [], proactive: true, inboxId: m.id, onResolve: resolveOffer, onBriefChoice: briefChoice, resolved: m.kind === "disruption_offer" && resolvedOffers.has(m.card?.offerId) })),
        ]);
        api.post("/autonomy/customer/inbox/seen", { ids: fresh.map(m => m.id) }).catch(() => {});
      } catch {}
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const endRef = useRef(null);
  const mounted = useRef(false);
  // Follow new messages to the bottom while chatting, but NOT on first mount —
  // otherwise navigating to Xperion AI scrolls the page down past the section header.
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs, busy]);

  async function send(text) {
    const q = (text != null ? text : input).trim(); if (!q || busy) return;
    const next = [...msgs, { role: "user", content: q }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      // omit the intro greeting from the model history
      const history = next.filter(m => !m.intro).map(m => ({ role: m.role, content: m.content }));
      // `transport` lets the SDK route this at any host with its own auth headers; the
      // in-app default keeps using the host application's api client.
      const post = transport || ((path, body) => api.post(path, body));
      const r = await post("/ai/agent", { messages: history, screen: "home", sessionId: session.current });
      if (r.brand) {
        setBrandSrv(r.brand);
        if (r.brand.currency) ACTIVE_CURRENCY = r.brand.currency;
        applyTheme(r.brand.theme);
      }
      const quick = (r.cards || [])[0]?.type === "flights" ? ["Book the first option", "Pay with miles", "Earlier outbound?"] : [];
      setMsgs([...next, { role: "assistant", content: r.reply, cards: r.cards, command: r.command, quick }]);
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: "I'm having trouble reaching the assistant right now — please try again in a moment." }]);
    } finally { setBusy(false); }
  }
  const pickFlight = (f) => send(`Book ${f.flight_no} departing ${f.dep}`);

  const Composer = (
    <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2">
      <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Tell me where you want to go and when" className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint" />
      <button className="text-ink-faint hover:text-ink"><Icon name="mic" size={16} /></button>
      <button onClick={() => send()} disabled={busy} className="w-8 h-8 rounded-full air-bg-accent text-white inline-flex items-center justify-center disabled:opacity-50"><Icon name="send" size={15} /></button>
    </div>
  );
  const Suggestions = (
    <div className="flex flex-wrap gap-1.5">
      {SUGS.map(s => (
        <button key={s.label} onClick={() => send(s.send)} className={cx("px-3 py-1.5 rounded-full text-[12px] font-semibold", s.express ? "air-bg-accent text-white" : "bg-surface border border-line text-ink hover:bg-surface-mute")}>{s.label}</button>
      ))}
    </div>
  );
  const Thread = (
    <div className={cx("space-y-3 overflow-y-auto v2-track", embedded ? "max-h-[360px] mt-3" : "flex-1 py-4")}>
      {msgs.map((m, i) => <Bubble key={i} m={m} onPick={pickFlight} onQuick={send} go={go} act={send} />)}
      {busy && <div className="text-[12px] text-ink-faint flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full air-bg-accent animate-pulse" /> Xperion AI is thinking…</div>}
      <div ref={endRef} />
    </div>
  );

  /* ── embedded (replaces hero search) ── */
  if (embedded) {
    return (
      <Card className="mt-5 p-4 sm:p-5">
        {/* v35 feedback: the hero already renders the Xperion AI toggle above this panel, so the
            panel's own toggle was a duplicate. Removed; the header is now just the title. */}
        <div>
          <div className="flex items-center gap-2 text-[15px] font-bold"><Icon name="spark" size={16} className="air-accent" /> {brand?.assistant || "Xperion AI Assistant"}</div>
          <div className="text-[11px] air-accent-deep font-semibold flex items-center gap-1 mt-0.5"><span className="w-1.5 h-1.5 rounded-full air-bg-accent" /> Online{(brand?.source || sourceLabel) ? ` · personalized from ${brand?.source || sourceLabel}` : ""}</div>
        </div>
        {Thread}
        <div className="mt-3 mb-3">{Suggestions}</div>
        {Composer}
        <button onClick={() => go("ai")} className="mt-3 text-[12px] font-semibold air-accent-deep">Expand full chat ↗</button>
      </Card>
    );
  }

  /* ── full screen (/ai route) ── */
  return (
    <div className="bg-surface-soft min-h-screen">
      <div className="mx-auto max-w-page px-4 sm:px-6 py-6 grid lg:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start">
        <Card className="p-0 flex flex-col h-[74vh] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 text-white" style={{ background: "linear-gradient(100deg,#c0392b,#a93226)" }}>
            <div className="flex items-center gap-2.5"><span className="w-8 h-8 rounded-full bg-white/15 inline-flex items-center justify-center"><Icon name="spark" size={15} /></span><div><div className="text-[14px] font-bold">Xperion AI Assistant</div><div className="text-[11px] text-white/80 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full air-bg-highlight" /> Online</div></div></div>
            <div className="flex items-center gap-3 text-[12px] font-semibold text-white/90"><button onClick={() => setMsgs([{ role: "assistant", content: greeting, intro: true }])}>+ New chat</button><button onClick={() => go("home")}>✕ Close</button></div>
          </div>
          <div className="px-5 flex-1 flex flex-col overflow-hidden">{Thread}</div>
          <div className="px-5 py-3 border-t border-line"><div className="mb-2">{Suggestions}</div>{Composer}<div className="text-[11px] text-ink-faint mt-2 flex items-center gap-1.5"><Icon name="lock" size={11} /> Private to you · not used to train AI</div></div>
        </Card>
        <aside className="space-y-4">
          <Card className="p-4">
            <Eyebrow className="mb-2">Your context</Eyebrow>
            <div className="space-y-2 text-[12px]">
              <div><div className="text-ink-faint">Tier</div><div className="font-semibold">{u.tier} · {miles(u.miles)} miles</div></div>
              <div><div className="text-ink-faint">Usual route</div><div className="font-semibold">{cityOf(origin)} → {cityOf(dest)} · {dateLabel}</div></div>
              <div><div className="text-ink-faint">Upcoming</div><div className="font-semibold">{shared?.journey?.flight_no || "—"} {shared?.journey?.origin ? `${shared.journey.origin}→${shared.journey.dest}` : ""}</div></div>
              <div><div className="text-ink-faint">Source</div><div className="font-semibold">{sourceLabel}</div></div>
            </div>
          </Card>
          <Card className="p-4 air-bg-tint air-border-highlight-soft">
            <div className="text-[13px] font-bold flex items-center gap-1.5"><Icon name="lock" size={13} className="air-accent-deep" /> Your data is private</div>
            <div className="text-[11px] text-ink-muted mt-1">Chats stay in your Xperion account. Never used to train AI. We only see traveller context you allow.</div>
            <div className="flex gap-4 mt-2 text-[12px] font-semibold air-accent-deep"><button>Manage data</button><button>Delete all</button></div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
