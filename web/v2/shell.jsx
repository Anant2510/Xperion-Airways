// FlyTAP v2 — shell: top navigation + footer + page layout.
import React, { useState, useEffect, useRef } from "react";
import { Avatar, Btn, Icon, TierBadge, cx } from "./ui.jsx";
import { miles, api, setCurrency, setLang, t } from "./lib.js";
import { trip, onTripChange } from "./trip.js";

export const TapLogo = ({ onDark = false }) => (
  <img src="/v2/assets/homepage/tap-logo.png" alt="Xperion Airways" className={cx("object-contain select-none", onDark && "bg-white rounded px-2 py-1")} style={{ height: onDark ? "22px" : "24px", width: "auto", boxSizing: onDark ? "content-box" : undefined }} />
);

const NAV = [
  { key: "home", label: "Book", tk: "book" },
  { key: "stopover", label: "Portugal Stopover" },
  { key: "extras", label: "Trip Extras", tk: "extras" },
  { key: "miles", label: "Xperion Miles" },
  { key: "ai", label: "Xperion AI" },
];

const SEARCH_DESTS = [
  { code: "MCO", city: "Orlando", country: "Spain" }, { code: "MAD", city: "Madrid", country: "Spain" },
  { code: "LHR", city: "London", country: "United Kingdom" }, { code: "CDG", city: "Paris", country: "France" },
  { code: "FCO", city: "Rome", country: "Italy" }, { code: "AMS", city: "Amsterdam", country: "Netherlands" },
  { code: "BRU", city: "Brussels", country: "Belgium" }, { code: "CUN", city: "Cancún", country: "Cancún" },
  { code: "JFK", city: "New York", country: "Portugal" }, { code: "MIA", city: "Miami", country: "Portugal" },
  { code: "GRU", city: "São Paulo", country: "Brazil" }, { code: "GIG", city: "Rio de Janeiro", country: "Brazil" },
  { code: "JFK", city: "New York", country: "United States" }, { code: "MXP", city: "Milan", country: "Italy" },
  { code: "MUC", city: "Munich", country: "Germany" }, { code: "BER", city: "Berlin", country: "Germany" },
];

// #5 — inline smart-search overlay: replaces the redirect with a modal that has predictive
// autocomplete, recent searches, a shortcut to the user's trips, and popular destinations.
function SearchOverlay({ go, upcoming = [], onClose }) {
  const [q, setQ] = useState("");
  const overlayInputRef = useRef(null);
  // Focus the search field without the browser scrolling the (locked) page underneath — matches
  // the dropdown fix: default focus-on-mount scroll can nudge the background before the fixed
  // overlay paints. preventScroll keeps the viewport steady on first open.
  useEffect(() => { const t = setTimeout(() => { try { overlayInputRef.current?.focus({ preventScroll: true }); } catch { overlayInputRef.current?.focus(); } }, 0); return () => clearTimeout(t); }, []);
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem("tap.recentSearch") || "[]")); } catch { setRecent([]); }
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const pick = (d) => {
    try { localStorage.setItem("tap.recentSearch", JSON.stringify([d, ...recent.filter(r => r.code !== d.code)].slice(0, 4))); } catch { /* noop */ }
    onClose();
    go("results", { dest: d.code });
  };
  const ql = q.trim().toLowerCase();
  const matches = ql ? SEARCH_DESTS.filter(d => d.city.toLowerCase().includes(ql) || d.code.toLowerCase().includes(ql) || d.country.toLowerCase().includes(ql)).slice(0, 6) : [];
  const popular = SEARCH_DESTS.filter(d => ["MCO", "LHR", "CDG", "FCO", "MAD", "AMS"].includes(d.code));
  const Row = ({ d, sub }) => (
    <button onClick={() => pick(d)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-mute text-left">
      <span className="w-9 h-9 rounded-lg bg-lime-tint text-tap-greenDeep inline-flex items-center justify-center shrink-0"><Icon name="plane" size={16} /></span>
      <span className="flex-1 min-w-0"><span className="block font-semibold text-ink text-[14px] truncate">{d.city} <span className="text-ink-faint font-normal">· {d.code}</span></span><span className="block text-[11px] text-ink-faint truncate">{sub || d.country}</span></span>
      <Icon name="arrow" size={14} className="text-ink-faint shrink-0" />
    </button>
  );
  return (
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />
      <div className="relative mx-auto mt-[8vh] w-[92%] max-w-[640px] bg-surface rounded-2xl shadow-pop border border-line overflow-hidden" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <Icon name="search" size={18} className="text-ink-muted shrink-0" />
          <input ref={overlayInputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search destinations, e.g. Orlando" className="flex-1 bg-transparent outline-none text-[15px] text-ink placeholder:text-ink-faint" />
          <button onClick={onClose} className="text-[11px] font-semibold text-ink-muted border border-line rounded px-2 py-1 hover:bg-surface-mute shrink-0">Esc</button>
        </div>
        <div className="max-h-[62vh] overflow-y-auto p-2">
          {ql
            ? (matches.length
                ? <><div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-ink-faint">Destinations</div>{matches.map(d => <Row key={d.code} d={d} />)}</>
                : <div className="px-3 py-8 text-center text-[13px] text-ink-faint">No destinations match “{q}”.</div>)
            : <>
                {recent.length > 0 && <><div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-ink-faint">Recent searches</div>{recent.map(d => <Row key={d.code} d={d} sub="Recent" />)}</>}
                {upcoming.length > 0 && <><div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-ink-faint">Your trips</div>
                  <button onClick={() => { onClose(); go("manage"); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-mute text-left"><span className="w-9 h-9 rounded-lg bg-surface-mute text-ink inline-flex items-center justify-center shrink-0"><Icon name="check" size={16} /></span><span className="flex-1 min-w-0"><span className="block font-semibold text-ink text-[14px]">{upcoming.length} upcoming {upcoming.length === 1 ? "trip" : "trips"}</span><span className="block text-[11px] text-ink-faint">View, check in, or change your bookings</span></span><Icon name="arrow" size={14} className="text-ink-faint shrink-0" /></button></>}
                <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-ink-faint">Popular destinations</div>{popular.map(d => <Row key={d.code} d={d} />)}
              </>}
        </div>
      </div>
    </div>
  );
}

export function TopNav({ route, go, profile, loggedIn, onLogin, onLogout }) {
  const user = profile?.user;
  const [menu, setMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);   // J2 — mobile primary-nav dropdown (hidden on lg+)
  const [searchOpen, setSearchOpen] = useState(false);   // #5 — inline smart-search overlay
  // #6 — the "My trips" dropdown summary must reflect the user's real bookings, not a fixed string.
  const [trips, setTrips] = useState(null);
  useEffect(() => {
    if (!loggedIn) { setTrips(null); return; }
    let alive = true;
    const load = () => api.get("/bookings").then(r => { if (alive) setTrips(r || []); }).catch(() => { if (alive) setTrips([]); });
    load();
    const onChange = () => load();
    window.addEventListener("tap:booking-changed", onChange);
    return () => { alive = false; window.removeEventListener("tap:booking-changed", onChange); };
  }, [loggedIn]);
  const CITY = { MIA: "Miami", JFK: "New York", MAD: "Madrid", LHR: "London", CDG: "Paris", CUN: "Cancún", MCO: "Orlando", FCO: "Rome", GIG: "Rio de Janeiro", GRU: "São Paulo", JFK: "New York", EWR: "Newark", BRU: "Brussels", AMS: "Amsterdam", ORY: "Paris" };
  const cityOf = (c) => CITY[c] || c || "";
  const upcomingTrips = (trips || []).filter(b => (b.days_to_go ?? 0) >= 0 && b.status !== "cancelled");
  const nextTrip = upcomingTrips.slice().sort((a, b) => (a.days_to_go ?? 99) - (b.days_to_go ?? 99))[0];
  const nextRoute = nextTrip?.flight ? `${cityOf(nextTrip.flight.origin)}–${cityOf(nextTrip.flight.dest)}` : "";
  const tripsSummary = trips == null ? "View your bookings"
    : upcomingTrips.length === 0 ? "No upcoming trips"
    : `${upcomingTrips.length} upcoming${nextRoute ? " · " + nextRoute : ""}`;
  const [mobileMenu, setMobileMenu] = useState(false);
  const [curMenu, setCurMenu] = useState(false);
  const [cur, setCur] = useState(() => { try { return localStorage.getItem("flyxperion_curlabel") || "PT · EUR"; } catch { return "PT · EUR"; } });
  const pickCur = (label, code, lang) => { setCur(label); try { localStorage.setItem("flyxperion_curlabel", label); } catch { } setCurrency(code); setLang(lang); setCurMenu(false); };
  const [, _basketTick] = useState(0);
  useEffect(() => onTripChange(() => _basketTick(n => n + 1)), []); // re-render the badge the moment the basket changes
  const basketCount = trip.pnr ? 0 : (trip.outbound ? 1 + (trip.extras?.length || 0) : 0);   // 0 once booked or with no chosen flight; otherwise flight + add-ons (matches the basket page)
  const bookActive = ["home", "results", "cart", "basket", "express", "passenger", "payment", "customize"].includes(route);
  return (
    <header className="sticky top-0 z-40 bg-surface-mute/85 backdrop-blur border-b border-line">
      {searchOpen && <SearchOverlay go={go} upcoming={upcomingTrips} onClose={() => setSearchOpen(false)} />}
      <div className="mx-auto max-w-page px-4 sm:px-6 h-16 flex items-center gap-6">
        <button onClick={() => go("home")} className="shrink-0"><TapLogo /></button>
        <div className="relative lg:hidden">
          <button onClick={() => setMobileNav(o => !o)} className="p-2 -ml-1 rounded-lg text-ink hover:bg-surface-mute" aria-label="Menu"><Icon name={mobileNav ? "x" : "menu"} size={20} /></button>
          {mobileNav && (
            <div className="absolute left-0 mt-2 w-56 bg-surface rounded-xl border border-line shadow-pop py-1 z-50">
              {NAV.map(n => { const on = n.key === "home" ? bookActive : route === n.key; return (
                <button key={n.key} onClick={() => { go(n.key); setMobileNav(false); }} className={cx("w-full text-left px-4 py-2.5 text-[14px]", on ? "text-ink font-semibold bg-surface-mute" : "text-ink font-medium hover:bg-surface-mute")}>{n.tk ? t(n.tk) : n.label}</button>
              ); })}
            </div>
          )}
        </div>
        <nav className="hidden lg:flex items-center gap-1 ml-2">
          {NAV.map(n => { const on = n.key === "home" ? bookActive : route === n.key; return (
            <button key={n.key} onClick={() => go(n.key)}
              className={cx("px-3 py-2 text-[13px] transition-colors border-b-2 inline-flex items-center gap-1",
                on ? "text-ink font-semibold border-tap-green" : "text-ink font-medium hover:text-ink border-transparent")}>
              {n.tk ? t(n.tk) : n.label}{n.key === "extras" && <Icon name="chevron" size={13} />}
            </button>
          ); })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setSearchOpen(true)} className="p-2 rounded-lg text-ink hover:bg-surface-mute" title="Search"><Icon name="search" /></button>
          <div className="relative hidden lg:block">
            <button onClick={() => setCurMenu(m => !m)} className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] font-semibold text-ink hover:bg-surface-mute"><Icon name="globe" size={15} /> {cur} <Icon name="chevron" size={13} /></button>
            {curMenu && <div className="absolute right-0 mt-2 w-44 bg-surface rounded-xl border border-line shadow-pop py-1 text-[13px] z-50">
              {[["US · USD", "USD", "en"], ["EU · EUR", "EUR", "en"], ["EN · GBP", "GBP", "en"], ["BR · BRL", "BRL", "pt-BR"], ["PT · EUR", "EUR", "pt-PT"]].map(([c, code, lang]) => <button key={c} onClick={() => pickCur(c, code, lang)} className={cx("w-full text-left px-3 py-2 hover:bg-surface-mute flex items-center justify-between", c === cur && "font-semibold text-tap-greenDeep")}>{c}{c === cur && <Icon name="check" size={13} />}</button>)}
            </div>}
          </div>
          <button onClick={() => go("wishlist")} className="hidden lg:inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] font-medium text-ink-muted hover:text-ink hover:bg-surface-mute" title="Wishlist"><Icon name="heart" size={16} /> Wishlist</button>
          <button onClick={() => go("basket")} className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] font-medium text-ink-muted hover:text-ink hover:bg-surface-mute" title="My Trip Basket">
            <Icon name="cart" size={16} /><span className="hidden lg:inline">My Trip Basket</span>
            {basketCount > 0 && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-tap-red text-white text-[10px] font-bold inline-flex items-center justify-center">{basketCount}</span>}
          </button>
          <button onClick={() => go("console")} className="hidden lg:inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[12px] font-semibold text-ink-muted hover:bg-surface-mute border border-line" title="Demo-only: live backend view"><Icon name="db" size={14} /> Demo</button>
          {loggedIn && user
            ? <div className="relative">
                <button onClick={() => setMenu(m => !m)} className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-surface-mute">
                  <Avatar initials={((user.first_name || "D")[0] + (user.full_name || "").split(" ")[1]?.[0] || "")} />
                  <span className="hidden sm:block text-[13px] font-semibold">{user.first_name}</span>
                  <TierBadge tier={user.tier} />
                  <span className="text-ink-faint text-[10px]">▾</span>
                </button>
                {menu && (
                  <div className="absolute right-0 mt-2 w-[300px] bg-surface rounded-2xl border border-line shadow-pop overflow-hidden text-[13px]">
                    <div className="p-4 text-white flex items-center gap-3" style={{ background: "linear-gradient(110deg,#b8860b,#caa53d)" }}>
                      <span className="w-11 h-11 rounded-full bg-white/90 text-[#8a6d12] inline-flex items-center justify-center text-[14px] font-bold">{(user.first_name || "D")[0]}{((user.full_name || "").split(" ")[1] || "")[0] || ""}</span>
                      <div className="flex-1 min-w-0"><div className="font-bold text-[15px] leading-tight">{user.full_name || user.first_name}</div><div className="text-[11px] text-white/80 truncate">{user.email || "you@email.com"}</div></div>
                      <span className="shrink-0 text-[10px] font-bold bg-white text-[#8a6d12] rounded px-2 py-1 whitespace-nowrap">{user.tier?.toUpperCase() || "GOLD"} · {miles(user.miles || 42180)} mi</span>
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto py-1">
                      {[["Account", [["user", "My profile", "Personal info, passport, contacts", "manage"], ["star", "Xperion Miles", `${miles(user.miles || 42180)} mi · ${user.tier || "Gold"} tier`, "miles"], ["doc", "Payment methods", "2 cards saved", "manage"]]],
                        ["Travel", [["plane", "My trips", tripsSummary, "manage"], ["check", "Check-in & boarding passes", "Opens 24h before departure", "manage"], ["seat", "Travel preferences", "Seat, meal, assistance", "manage"], ["globe", "Saved travelers", "3 companions", "manage"]]],
                        ["Settings", [["info", "Notifications", "Push, SMS, email", "manage"], ["globe", "Language & region", "EN · Portugal (EUR)", "manage"], ["info", "Help & support", "24/7 contact", "ai"]]]
                      ].map(([sec, items]) => (
                        <div key={sec}>
                          <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-ink-faint">{sec}</div>
                          {items.map(([ic, t, s, r]) => (
                            <button key={t} onClick={() => { setMenu(false); go(r); }} className={cx("w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-mute", t === "Xperion Miles" && "bg-lime-tint/40")}>
                              <Icon name={ic} size={16} className="text-ink-muted shrink-0" />
                              <span className="flex-1 min-w-0"><span className="block font-semibold text-ink">{t}</span><span className="block text-[11px] text-ink-faint truncate">{s}</span></span>
                              <span className="text-ink-faint text-[12px]">›</span>
                            </button>
                          ))}
                        </div>
                      ))}
                      <div className="h-px bg-line my-1" />
                      <button onClick={() => { setMenu(false); onLogout?.(); }} className="w-full flex items-center gap-2 px-4 py-3 text-left text-tap-red font-semibold hover:bg-surface-mute"><Icon name="refresh" size={15} /> Sign out</button>
                    </div>
                  </div>
                )}
              </div>
            : <Btn size="sm" variant="dark" onClick={() => onLogin?.()}>Login or Sign up</Btn>}
          <button onClick={() => setMobileMenu(m => !m)} className="lg:hidden p-2 rounded-lg text-ink-muted hover:bg-surface-mute" aria-label="Menu" aria-expanded={mobileMenu}><Icon name={mobileMenu ? "x" : "menu"} /></button>
        </div>
      </div>
      {mobileMenu && (
        <div className="lg:hidden border-t border-line bg-surface">
          <div className="mx-auto max-w-page px-4 py-2">
            {NAV.map(n => { const on = n.key === "home" ? bookActive : route === n.key; return (
              <button key={n.key} onClick={() => { setMobileMenu(false); go(n.key); }}
                className={cx("w-full text-left px-3 py-2.5 rounded-lg text-[14px] font-medium", on ? "text-ink bg-surface-mute" : "text-ink-muted hover:text-ink hover:bg-surface-mute")}>{n.label}</button>
            ); })}
            <div className="h-px bg-line my-1.5" />
            <button onClick={() => { setMobileMenu(false); go("wishlist"); }} className="w-full text-left px-3 py-2.5 rounded-lg text-[14px] text-ink-muted hover:bg-surface-mute flex items-center gap-2"><Icon name="heart" size={15} /> Wishlist</button>
            <button onClick={() => { setMobileMenu(false); go("basket"); }} className="w-full text-left px-3 py-2.5 rounded-lg text-[14px] text-ink-muted hover:bg-surface-mute flex items-center gap-2"><Icon name="cart" size={15} /> My Trip Basket{basketCount > 0 && <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-tap-red text-white text-[10px] font-bold inline-flex items-center justify-center">{basketCount}</span>}</button>
            <button onClick={() => { setMobileMenu(false); go("console"); }} className="w-full text-left px-3 py-2.5 rounded-lg text-[14px] text-ink-muted hover:bg-surface-mute flex items-center gap-2"><Icon name="db" size={15} /> Demo console</button>
            <div className="px-3 py-2 text-[12px] text-ink-faint">PT · EUR</div>
          </div>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  const cols = [
    ["Flights & Stopover", ["Book a flight", "Portugal Stopover", "Multi-city", "Flight status", "Manage booking", "Online check-in"]],
    ["Trip Extras", ["Hotels", "Cars & Transfers", "Experiences", "Travel insurance", "Airport parking", "Pet travel"]],
    ["voa.miles", ["Join the program", "Use my miles", "Status & tiers", "Star Alliance partners", "Club voa.miles", "Credit cards"]],
    ["Help", ["Customer support", "Delays & cancellations", "Refunds", "Special assistance", "Baggage", "Travel documents"]],
  ];
  return (
    <footer className="mt-16 bg-surface-dark text-white">
      <div className="mx-auto max-w-page px-4 sm:px-6 py-12 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] gap-8">
        <div className="col-span-2 md:col-span-3 lg:col-span-1">
          <TapLogo onDark />
          <p className="text-[12px] text-white/55 mt-3 max-w-[230px]">An original premium airline concept connecting the Americas to Europe through Portugal.</p>
          <div className="flex gap-2 mt-4">{["IG", "f", "in", "X"].map(s => <span key={s} className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-[11px] font-bold">{s}</span>)}</div>
          <div className="mt-6"><div className="text-[10px] font-bold uppercase tracking-wide text-lime">Newsletter</div><div className="text-[12px] text-white/90 mt-1 mb-2">Get fare alerts and Stopover offers.</div>
            <div className="flex gap-2"><input placeholder="you@email.com" className="flex-1 bg-white/10 border border-white/15 rounded-lg px-3 py-2 text-[12px] placeholder:text-white/40 outline-none" /><Btn size="sm" variant="lime">Join</Btn></div></div>
        </div>
        {cols.map(([h, items]) => (
          <div key={h}><div className="text-[12px] font-bold mb-3">{h}</div><ul className="space-y-2">{items.map(i => <li key={i}><a className="text-[12px] text-white/55 hover:text-white">{i}</a></li>)}</ul></div>
        ))}
      </div>
      <div className="border-t border-white/10"><div className="mx-auto max-w-page px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3 text-[11px] text-white/40">
        <span>© 2026 FlyTap · Privacy · Terms · Cookies · Accessibility</span>
        <span>Portugal · Brasil · United States</span>
      </div></div>
    </footer>
  );
}

export const Page = ({ children, wide = false }) =>
  <div className={cx("mx-auto px-4 sm:px-6 py-6 sm:py-8 w-full max-w-full overflow-x-hidden", wide ? "max-w-page" : "max-w-content")}>{children}</div>;
