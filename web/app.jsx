import React, { useState, useEffect, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  Plane, Sparkles, SlidersHorizontal, Lock, ShoppingBag, CreditCard, Wallet, Ticket, Building2, CheckCircle2,
  AlertTriangle, RefreshCw, Luggage, Armchair, Coffee, Wifi, Car, ChevronRight,
  X, Send, Bell, QrCode, CalendarClock, Laptop, Zap, ShieldCheck, ArrowRight, ArrowUpRight,
  Repeat, BadgeCheck, MessageCircle, Loader2, TimerReset, Database, Mail, Eye, EyeOff, RotateCcw,
  Search, MapPin, Globe, ArrowLeftRight, Calendar, Info, Clock, Cloud, Layers
} from "lucide-react";

/* ── API client — every byte of personalization comes from the backend ──
   API_BASE is derived from where the page is served, so the app works at the
   site root OR under a sub-path like /xperionportal/ behind a reverse proxy.   */
const API_BASE = (() => {
  // strip a trailing file (e.g. index.html) and trailing slash from the path
  let base = window.location.pathname.replace(/\/[^/]*$/, "");
  return base.replace(/\/$/, "");
})();
const api = {
  get: (p) => fetch(`${API_BASE}/api${p}`).then((r) => r.json()),
  post: (p, body) => fetch(`${API_BASE}/api${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json()),
};
// Stable per-tab id so the agent keeps this chat's context (active route, selected flight) separate from other sessions.
const WEB_SESSION_ID = "web-" + Math.random().toString(36).slice(2, 10);
const EUR = (n) => `€${Number(n).toFixed(Number(n) % 1 === 0 ? 0 : 2)}`;
// Format an ISO date (YYYY-MM-DD) as "Mon 15 Jun 2026"; falls back gracefully.
const fmtDate = (iso, withYear = true) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  const s = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
  return s;
};
const MILES_RATE = 0.003;
const AIRPORT_MAP = {};   // code → {city,country,region}, filled at load from /api/airports
const cityName = (code) => (AIRPORT_MAP[code] && AIRPORT_MAP[code].city) || code;
// Earliest selectable date: the real "today", but never earlier than the demo anchor.
const SEARCH_TODAY = (() => { const r = new Date().toISOString().slice(0, 10); return r > "2026-06-15" ? r : "2026-06-15"; })();
const countryName = (code) => (AIRPORT_MAP[code] && AIRPORT_MAP[code].country) || "";
// Card details are never exposed in the UI (no brand, no real digits) — fully masked for every persona.
const MASKED_PAN = "•••• •••• •••• ••••";

/* ── Theme / primitives ── */
const Fonts = () => (
  <style>{`
    :root{ --tap-green:#46A41A; --tap-deep:#063A28; --tap-ink:#0E1F18; --tap-mist:#F2F6F3;
      --tap-line:#DCE7E0; --tap-red:#E2354B; --tap-gold:#C9A227; --tap-amber:#E8930C;
      /* FLYTAP DXP dark theme */
      --dxp-bg:#0A0B0A; --dxp-surface:#141614; --dxp-surface-2:#1C1F1C; --dxp-line:#2A2E2A;
      --dxp-text:#F4F6F4; --dxp-muted:#9AA39C; --dxp-lime:#A3E635; --dxp-lime-bright:#B6F23E;
      --dxp-green:#16A34A; --dxp-green-deep:#0B5C32;
      --dxp-grad:linear-gradient(135deg,#0B5C32 0%,#16A34A 45%,#A3E635 130%);
      --dxp-grad-btn:linear-gradient(120deg,#0E7A40 0%,#22B24C 55%,#9EE82B 120%); }
    .font-display{font-family:'Archivo',sans-serif; font-stretch:85%;}
    body{font-family:'Inter',sans-serif;background:var(--tap-mist);}
    .dxp-dark{ background:var(--dxp-bg); color:var(--dxp-text); }
    .dxp-grad-text{ background:var(--dxp-grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .dxp-orb{ position:absolute; border-radius:9999px; filter:blur(90px); opacity:.5; pointer-events:none; }
    .ticket-edge{ mask:radial-gradient(circle 7px at 0 50%, transparent 98%, #000) left/14px 100% no-repeat,
      radial-gradient(circle 7px at 100% 50%, transparent 98%, #000) right/14px 100% no-repeat,
      linear-gradient(#000,#000) center/calc(100% - 26px) 100% no-repeat;
      -webkit-mask:radial-gradient(circle 7px at 0 50%, transparent 98%, #000) left/14px 100% no-repeat,
      radial-gradient(circle 7px at 100% 50%, transparent 98%, #000) right/14px 100% no-repeat,
      linear-gradient(#000,#000) center/calc(100% - 26px) 100% no-repeat;}
    @keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.35}} .pulse-dot{animation:pulseDot 1.6s ease-in-out infinite}
    @keyframes slideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}} .slide-up{animation:slideUp .35s ease both}
    @keyframes floatOrb{0%,100%{transform:translate(0,0)}50%{transform:translate(20px,-24px)}} .float-orb{animation:floatOrb 12s ease-in-out infinite}
    @media (prefers-reduced-motion: reduce){ .slide-up,.pulse-dot,.float-orb{animation:none} }
    ::selection{background:#A3E63555}
    /* Dark Home scope — remap the --tap-* tokens so every inline var() resolves to the DXP dark palette.
       This recolors the entire Home (and its shared Card/PrimaryBtn primitives) with no per-element edits. */
    .dxp-home{
      --tap-mist:#1C1F1C; --tap-ink:#F4F6F4; --tap-deep:#0B5C32; --tap-line:#2A2E2A;
      --tap-green:#22B24C;
      background:var(--dxp-bg); color:var(--dxp-text); min-height:100vh;
    }
    .dxp-home .bg-white{ background:var(--dxp-surface)!important; }
    .dxp-home .text-gray-400{ color:var(--dxp-muted)!important; }
    .dxp-home .text-gray-500{ color:#AEB6AE!important; }
    .dxp-home .text-gray-600{ color:#C2CABF!important; }
    .dxp-home .text-gray-700{ color:#D6DCD6!important; }
    .dxp-home .hover\\:bg-gray-50:hover, .dxp-home .hover\\:bg-gray-100:hover{ background:var(--dxp-surface-2)!important; }
    .dxp-home .border{ border-color:var(--dxp-line); }
    .dxp-home .dxp-primary-btn{ background:var(--dxp-grad-btn)!important; color:#06210F!important; }
    .dxp-home .dxp-primary-btn svg{ color:#06210F; }
    .dxp-home .dxp-ghost-btn{ background:var(--dxp-surface)!important; color:var(--dxp-text)!important; border-color:var(--dxp-line)!important; }
    .dxp-home .dxp-ghost-btn svg{ color:var(--dxp-lime); }
    .dxp-home .dxp-ghost-btn:hover{ border-color:var(--dxp-lime)!important; background:var(--dxp-surface-2)!important; }
    .dxp-home .dxp-pricechip{ color:var(--dxp-lime)!important; background:#101A12!important; }
    .dxp-home .dxp-chip-green{ background:rgba(34,178,76,.16)!important; color:#7BE3A0!important; }
    .dxp-home .dxp-chip-amber{ background:rgba(232,147,12,.16)!important; color:#F0B45C!important; }
    .dxp-home .dxp-chip-red{ background:rgba(226,53,75,.16)!important; color:#F08699!important; }
    .dxp-home .dxp-chip-ink{ background:var(--dxp-surface-2)!important; color:#C2CABF!important; }
    .dxp-home .dxp-chip-gold{ background:rgba(201,162,39,.16)!important; color:#E0C56A!important; }
  `}</style>
);

// Xperion Airways lockup. Rebuilt as inline SVG so it scales crisply and themes
// for light/dark. To use the exact brand asset, drop it at public/tap-logo.png and
// replace the <svg> below with <img src="/tap-logo.png" alt="Xperion Airways" .../>.
const TapLogo = ({ light = false, size = "text-xl" }) => (
  <div className="flex items-center gap-2">
    <svg width="38" height="28" viewBox="0 0 38 28" fill="none" aria-label="Xperion Airways" className="shrink-0">
      <rect x="0.5" y="0.5" width="37" height="27" rx="7" fill="var(--tap-red)"/>
      <path d="M6 21 C13 7 25 5 33 8 L33 12 C24 9.5 15 11.5 9.5 21.5 Z" fill="#ffffff"/>
      <path d="M6 21 C13 8 24 7 33 9.5 L33 12 C24 9.5 15 11.5 9.5 21.5 Z" fill="var(--tap-green)" opacity="0.95"/>
      <circle cx="29.5" cy="9" r="2.1" fill="var(--tap-gold)"/>
    </svg>
    <div className={`font-display font-black tracking-tight ${size} leading-none`}>
      <span style={{ color: light ? "#ffffff" : "var(--tap-ink)" }}>Xperion</span>
      <span className={`ml-1.5 font-semibold text-[10px] tracking-[0.18em] uppercase align-middle ${light ? "text-white/80" : "text-gray-500"}`}>Xperion Airways</span>
    </div>
  </div>
);
const TierBadge = ({ tier = "Gold" }) => {
  const styles = {
    Platinum: { background: "linear-gradient(120deg,#5A6470,#9AA6B2)", color: "#10161C" },
    Gold: { background: "linear-gradient(120deg,#C9A227,#E8C75A)", color: "#3A2D04" },
    Silver: { background: "linear-gradient(120deg,#9AA0A6,#C7CDD2)", color: "#23282C" },
  };
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wide"
      style={styles[tier] || styles.Gold}><BadgeCheck size={12}/> {(tier || "Gold").toUpperCase()}</span>
  );
};
const GoldBadge = TierBadge;
const Chip = ({ children, tone = "green", className = "" }) => {
  const tones = { green:{background:"#E2F4EA",color:"#066B3C"}, amber:{background:"#FCF1DD",color:"#8A5A06"},
    red:{background:"#FBE4E7",color:"#A31226"}, ink:{background:"#E9EFEC",color:"#26483A"}, gold:{background:"#F7EFD6",color:"#7A6112"} };
  return <span className={`dxp-chip dxp-chip-${tone} inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${className}`} style={tones[tone]}>{children}</span>;
};
/* (i) explainer — hover/tap reveals WHY a personalization was shown */
const Why = ({ text, className = "" }) => {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <span className={`relative inline-flex ${className}`}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }} aria-label="Why am I seeing this?"
        className="inline-flex items-center justify-center w-4 h-4 rounded-full" style={{ color: "var(--tap-green)" }}>
        <Info size={13}/>
      </button>
      {open && (
        <span onClick={(e) => e.stopPropagation()}
          className="absolute z-50 bottom-full right-0 mb-1.5 w-60 p-2.5 rounded-lg text-[11px] font-medium leading-snug shadow-lg"
          style={{ background: "var(--tap-deep)", color: "#fff" }}>
          <span className="block font-bold mb-0.5" style={{ color: "#8FE3B8" }}>Why you're seeing this</span>
          {text}
        </span>
      )}
    </span>
  );
};
const Card = ({ children, className = "", style = {}, ...rest }) => (
  <div className={`bg-white rounded-2xl border ${className}`} style={{ borderColor: "var(--tap-line)", ...style }} {...rest}>{children}</div>
);
const PrimaryBtn = ({ children, onClick, className = "", disabled }) => (
  <button onClick={onClick} disabled={disabled}
    className={`dxp-primary-btn inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-white text-sm transition-transform active:scale-[.98] disabled:opacity-50 ${className}`}
    style={{ background: "var(--tap-green)" }}>{children}</button>
);
const GhostBtn = ({ children, onClick, className = "" }) => (
  <button onClick={onClick}
    className={`dxp-ghost-btn inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm border transition-colors ${className}`}
    style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)", background: "#fff" }}>{children}</button>
);
const RouteRibbon = ({ from = "OPO", to = "LIS", dep, arr, small = false }) => (
  <div className={`flex items-center ${small ? "gap-2" : "gap-3"}`}>
    <div className="text-right">
      <div className={`font-display font-extrabold ${small ? "text-base" : "text-2xl"}`} style={{ color: "var(--tap-ink)" }}>{from}</div>
      {dep && <div className="text-xs text-gray-500 font-medium">{dep}</div>}
    </div>
    <div className="flex-1 flex items-center min-w-[60px]">
      <div className="h-px flex-1" style={{ background: "var(--tap-line)" }}/>
      <Plane size={small ? 13 : 16} className="mx-1.5" style={{ color: "var(--tap-green)" }}/>
      <div className="h-px flex-1" style={{ background: "var(--tap-line)" }}/>
    </div>
    <div>
      <div className={`font-display font-extrabold ${small ? "text-base" : "text-2xl"}`} style={{ color: "var(--tap-ink)" }}>{to}</div>
      {arr && <div className="text-xs text-gray-500 font-medium">{arr}</div>}
    </div>
  </div>
);
const FakeQR = ({ seed = 7, size = 120 }) => {
  const cells = useMemo(() => { const out = []; let v = seed;
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) { v = (v * 48271) % 2147483647;
      const finder = (x < 6 && y < 6) || (x > 14 && y < 6) || (x < 6 && y > 14);
      if (finder ? (x % 5 !== 2 || y % 5 !== 2) : v % 7 < 3) out.push([x, y]); } return out; }, [seed]);
  return <svg width={size} height={size} viewBox="0 0 21 21" className="rounded-md bg-white p-0.5">
    {cells.map(([x, y], i) => <rect key={i} x={x} y={y} width="1" height="1" fill="#0E1F18"/>)}</svg>;
};
const AncIcon = ({ k, size = 18 }) => {
  const map = { seat: Armchair, bag: Luggage, meal: Coffee, wifi: Wifi, car: Car, lounge: Sparkles };
  const I = map[k] || Sparkles; return <I size={size} style={{ color: "var(--tap-green)" }}/>;
};

/* Toast — used to surface backend side-effects (emails, DB writes) */
function Toasts({ list, dismiss }) {
  return (
    <div className="fixed bottom-5 left-5 z-[60] space-y-2 max-w-sm">
      {list.map((t) => (
        <div key={t.id} className="bg-white border rounded-xl shadow-lg p-3 flex items-start gap-3 slide-up" style={{ borderColor: "var(--tap-line)" }}>
          <Mail size={16} className="shrink-0 mt-0.5" style={{ color: "var(--tap-green)" }}/>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold" style={{ color: "var(--tap-ink)" }}>{t.title}</div>
            <div className="text-[11px] text-gray-500 truncate">{t.sub}</div>
          </div>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} className="text-gray-400"/></button>
        </div>
      ))}
    </div>
  );
}

/* ── LOGIN — FLYTAP DXP dark split-screen ── */
const PORTO_IMG = "https://images.unsplash.com/photo-1555881400-74d7acaacd8b?auto=format&fit=crop&w=1200&q=80";
// Famous-location photos for destination cards (Unsplash, keyed by IATA).
const CITY_PHOTOS = {
  LIS: "https://images.unsplash.com/photo-1753236431862-cd7cbf87d1f4?auto=format&fit=crop&w=800&q=80",
  OPO: "https://images.unsplash.com/photo-1555881400-74d7acaacd8b?auto=format&fit=crop&w=800&q=80",
  MAD: "https://images.unsplash.com/photo-1539037116277-4db20889f2d4?auto=format&fit=crop&w=800&q=80",
  CDG: "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=800&q=80",
  FNC: "https://images.unsplash.com/photo-1591017403286-fd8493524e1e?auto=format&fit=crop&w=800&q=80",
  BCN: "https://images.unsplash.com/photo-1583422409516-2895a77efded?auto=format&fit=crop&w=800&q=80",
  LHR: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=800&q=80",
  FCO: "https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=800&q=80",
  FRA: "https://images.unsplash.com/photo-1577462281852-279d3e1c66e7?auto=format&fit=crop&w=800&q=80",
  AMS: "https://images.unsplash.com/photo-1534351590666-13e3e96b5017?auto=format&fit=crop&w=800&q=80",
  JFK: "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?auto=format&fit=crop&w=800&q=80",
  GRU: "https://images.unsplash.com/photo-1543059080-f9b1272213d5?auto=format&fit=crop&w=800&q=80",
  MIA: "https://images.unsplash.com/photo-1506966953602-c20cc11f75e3?auto=format&fit=crop&w=800&q=80",
  FAO: "https://images.unsplash.com/photo-1591194854667-3d0b9b0a8b1f?auto=format&fit=crop&w=800&q=80",
};
const FALLBACK_PHOTO = "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=800&q=80"; // aircraft wing/sky — generic travel
const cityPhoto = (code) => CITY_PHOTOS[code] || FALLBACK_PHOTO;
// Image that degrades gracefully: on load error, fall back once to a generic travel photo,
// and sit on a dark surface so a fully-failed image still looks intentional (never a broken glyph).
const CityImg = ({ code, alt, className }) => (
  <img
    src={cityPhoto(code)}
    alt={alt || code}
    loading="lazy"
    className={className}
    style={{ background: "var(--dxp-surface-2)" }}
    onError={(e) => { if (e.currentTarget.src !== FALLBACK_PHOTO) e.currentTarget.src = FALLBACK_PHOTO; else e.currentTarget.style.visibility = "hidden"; }}
  />
);
function Login({ profile, onLogin }) {
  const [busy, setBusy] = useState(false);
  const [personas, setPersonas] = useState(null);
  const [active, setActive] = useState(null);
  const [switching, setSwitching] = useState(null);
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("demo");
  const [showPwd, setShowPwd] = useState(false);

  useEffect(() => { (async () => {
    const r = await api.get("/personas");
    setPersonas(r.personas); setActive(r.active);
    if (r.personas?.[0]) setEmail(`${r.personas[0].id}@flyxperion.demo`);
  })(); }, []);

  const enter = async (personaId) => {
    if (busy || switching) return;
    try {
      if (personaId && personaId !== active) {
        setSwitching(personaId);
        await api.post("/persona", { persona: personaId });
        setActive(personaId); setSwitching(null);
      }
      setBusy(true);
      window.location.hash = "app";
      setTimeout(() => window.location.reload(), 500);
    } catch { setBusy(false); setSwitching(null); }
  };
  // Sign-in form resolves the email → persona, then enters as that traveller.
  const signIn = () => {
    const id = (email.split("@")[0] || "").toLowerCase();
    const match = personas?.find(p => p.id === id) || personas?.find(p => p.label.toLowerCase().startsWith(id));
    enter(match ? match.id : active);
  };

  return (
    <div className="min-h-screen flex dxp-dark">
      {/* Left — Porto hero */}
      <div className="hidden lg:block w-[42%] relative overflow-hidden">
        <img src={PORTO_IMG} alt="Porto, Portugal" className="absolute inset-0 w-full h-full object-cover"/>
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(10,11,10,.15) 0%, rgba(10,11,10,.75) 100%)" }}/>
        <div className="relative h-full flex flex-col justify-between p-12">
          <span className="self-start text-[11px] font-bold tracking-[0.22em] uppercase px-3 py-1.5 rounded-full" style={{ background: "rgba(255,255,255,.14)", color: "#fff", backdropFilter: "blur(6px)" }}>FlyTAP DXP · Persona prototype</span>
          <div>
            <h1 className="font-display font-black text-white text-5xl leading-[1.04] tracking-tight">One platform.<br/>A different journey for<br/>every traveller.</h1>
            <p className="text-white/70 mt-5 max-w-md leading-relaxed">Sign in as any persona to see how the CDP and VOYAGER.AI reshape the “Offer → Order” experience in real time.</p>
          </div>
        </div>
      </div>

      {/* Right — sign-in */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md slide-up">
          <div className="font-display font-black text-3xl tracking-tight mb-8"><span className="dxp-grad-text">Xperion</span></div>
          <p className="text-sm mb-6" style={{ color: "var(--dxp-muted)" }}>Use a demo account below, or the quick-login shortcuts.</p>

          <label className="block text-xs font-bold mb-1.5" style={{ color: "var(--dxp-muted)" }}>Email</label>
          <input value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && signIn()}
            className="w-full px-4 py-3.5 rounded-xl text-sm outline-none mb-4 transition-colors focus:border-[color:var(--dxp-lime)]"
            style={{ background: "#101210", border: "1px solid var(--dxp-line)", color: "var(--dxp-text)" }} placeholder="you@flyxperion.demo"/>

          <label className="block text-xs font-bold mb-1.5" style={{ color: "var(--dxp-muted)" }}>Password</label>
          <div className="relative mb-5">
            <input type={showPwd ? "text" : "password"} value={pwd} onChange={e => setPwd(e.target.value)} onKeyDown={e => e.key === "Enter" && signIn()}
              className="w-full px-4 py-3.5 rounded-xl text-sm outline-none transition-colors focus:border-[color:var(--dxp-lime)]"
              style={{ background: "#101210", border: "1px solid var(--dxp-line)", color: "var(--dxp-text)" }}/>
            <button onClick={() => setShowPwd(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: "var(--dxp-muted)" }} aria-label="Toggle password">{showPwd ? <EyeOff size={18}/> : <Eye size={18}/>}</button>
          </div>

          <button onClick={signIn} disabled={busy || !personas}
            className="w-full py-3.5 rounded-xl font-bold text-[15px] flex items-center justify-center gap-2 transition-transform active:scale-[.99] disabled:opacity-60"
            style={{ background: "var(--dxp-grad-btn)", color: "#06210F" }}>
            {busy ? <><Loader2 className="animate-spin" size={17}/> Signing in…</> : <>Sign in →</>}
          </button>

          <div className="mt-5 text-xs" style={{ color: "var(--dxp-muted)" }}>
            <span>Demo accounts — password </span><code className="px-1.5 py-0.5 rounded" style={{ background: "var(--dxp-surface-2)", color: "var(--dxp-text)" }}>demo</code><span> for all:</span>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {personas?.map(p => (
                <button key={p.id} onClick={() => setEmail(`${p.id}@flyxperion.demo`)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] transition-colors hover:brightness-125"
                  style={{ background: "var(--dxp-surface-2)", color: email.startsWith(p.id) ? "var(--dxp-lime)" : "var(--dxp-muted)", border: "1px solid var(--dxp-line)" }}>{p.id}@flyxperion.demo</button>
              ))}
            </div>
          </div>

          <div className="h-px my-6" style={{ background: "var(--dxp-line)" }}/>

          <div className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: "var(--dxp-lime)" }}>Quick demo login</div>
          {!personas && <div className="flex items-center gap-2 text-sm" style={{ color: "var(--dxp-muted)" }}><Loader2 className="animate-spin" size={16}/> Loading profiles…</div>}
          <div className="flex flex-wrap gap-2.5">
            {personas?.map(p => (
              <button key={p.id} onClick={() => enter(p.id)} disabled={busy || switching}
                className="px-4 py-2.5 rounded-full text-sm font-semibold transition-all hover:brightness-125 active:scale-[.98] flex items-center gap-2"
                style={{ background: "var(--dxp-surface-2)", color: "var(--dxp-text)", border: "1px solid var(--dxp-line)" }}>
                {(switching === p.id) && <Loader2 className="animate-spin" size={14} style={{ color: "var(--dxp-lime)" }}/>}
                {p.label.split(" ")[0]} · <span style={{ color: "var(--dxp-muted)" }}>{p.archetype || p.blurb?.split("·").pop()?.trim() || p.tier}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
function LoginUnused({ profile, onLogin }) {
  const [busy, setBusy] = useState(false);
  const u = profile?.user;
  return (
    <div className="min-h-screen flex" style={{ background: "var(--tap-mist)" }}>
      <div className="hidden lg:flex flex-col justify-between w-[44%] p-12 text-white relative overflow-hidden"
        style={{ background: "linear-gradient(160deg, var(--tap-deep) 0%, #0A5A3C 70%, var(--tap-green) 130%)" }}>
        <TapLogo light/>
        <div>
          <div className="text-xs font-bold tracking-[0.25em] uppercase text-white/60 mb-4">Xperion Miles · Digital channel</div>
          <h1 className="font-display font-black text-5xl leading-[1.05] mb-5">Your airline already knows the way you fly.</h1>
          <p className="text-white/75 max-w-md leading-relaxed">One sign-in. Your routes, your seat, your payment, your boarding pass — served live from your customer record.</p>
        </div>
        <div className="flex items-center gap-6 text-white/60 text-xs font-medium">
          <span className="flex items-center gap-1.5"><ShieldCheck size={14}/> Secure session</span>
          <span className="flex items-center gap-1.5"><Database size={14}/> Live customer DB</span>
        </div>
        <Plane className="absolute -right-10 -bottom-10 opacity-10" size={280}/>
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md slide-up">
          <div className="lg:hidden mb-8"><TapLogo/></div>
          <h2 className="font-display font-extrabold text-3xl mb-1" style={{ color: "var(--tap-ink)" }}>Welcome back</h2>
          <p className="text-sm text-gray-500 mb-8">Sign in to Xperion Miles</p>
          <Card className="p-5 mb-4 hover:shadow-md transition-shadow">
            <button onClick={() => { setBusy(true); setTimeout(onLogin, 700); }} className="w-full flex items-center gap-4 text-left" disabled={!u}>
              <div className="w-12 h-12 rounded-full flex items-center justify-center font-display font-extrabold text-white text-lg shrink-0" style={{ background: "var(--tap-deep)" }}>DF</div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm flex items-center gap-2" style={{ color: "var(--tap-ink)" }}>{u ? u.full_name : "Loading profile…"} {u && <GoldBadge tier={u.tier}/>}</div>
                <div className="text-xs text-gray-500 mt-0.5">{u?.email}</div>
                <div className="text-xs text-gray-400 mt-0.5">{u && `Member ${u.member_no} · ${u.miles.toLocaleString()} miles`}</div>
              </div>
              {busy || !u ? <Loader2 className="animate-spin" size={18} style={{ color: "var(--tap-green)" }}/> : <ChevronRight size={18} className="text-gray-400"/>}
            </button>
          </Card>
          <div className="space-y-3 opacity-50 pointer-events-none">
            <input className="w-full px-4 py-3 rounded-xl border text-sm" style={{ borderColor: "var(--tap-line)" }} placeholder="Email or member number"/>
            <input className="w-full px-4 py-3 rounded-xl border text-sm" style={{ borderColor: "var(--tap-line)" }} placeholder="Password" type="password"/>
          </div>
          <p className="text-[11px] text-gray-400 mt-6 text-center">Profile loaded live from the customer database · tap a demo account to continue</p>
        </div>
      </div>
    </div>
  );
}

/* ── HOME — Search & Inspiration ── */
/* Xperion-style segmented quick-book widget — fully functional, DB-backed.
   Origin + Destination come from the real 100-route network (/api/routes):
   pick any origin, and the destination list shows every city Xperion actually
   flies to from there. Search runs the real flight search. */
function QuickBook({ go, bookDestination }) {
  const [tab, setTab] = useState("book");
  const [routes, setRoutes] = useState([]);
  const [origin, setOrigin] = useState("OPO");
  const [dest, setDest] = useState("");
  const [pax, setPax] = useState(1);

  useEffect(() => { (async () => {
    const r = await api.get("/routes");
    setRoutes(r || []);
  })(); }, []);

  const TABS = [
    { id: "book",   label: "Book flight",     icon: <Plane size={15}/> },
    { id: "checkin",label: "Check-in",        icon: <BadgeCheck size={15}/> },
    { id: "manage", label: "Manage booking",  icon: <CalendarClock size={15}/> },
    { id: "status", label: "Flight status",   icon: <Clock size={15}/> },
  ];

  // All origins that actually have outbound routes, with the persona's home first
  const origins = [...new Set(routes.map(r => r.origin))]
    .map(c => [c, cityName(c)])
    .sort((a, b) => a[0] === "OPO" ? -1 : b[0] === "OPO" ? 1 : a[1].localeCompare(b[1]));
  // Destinations reachable from the selected origin (real routes only)
  const dests = routes
    .filter(r => r.origin === origin)
    .map(r => [r.dest, r.destCity || cityName(r.dest)])
    .sort((a, b) => a[1].localeCompare(b[1]));

  const onTab = (id) => {
    setTab(id);
    if (id === "checkin") go("checkin");
    else if (id === "manage") go("manage");
    else if (id === "status") go("status");
  };
  const onOrigin = (o) => { setOrigin(o); setDest(""); };   // reset dest when origin changes
  const doSearch = () => {
    if (!dest) return;
    const city = (dests.find(([c]) => c === dest) || [])[1] || dest;
    bookDestination({ code: dest, city, origin, reason: `${cityName(origin)} → ${city} — searched from the home widget.` });
  };

  const selCls = "px-3 py-2.5 rounded-xl border text-sm font-semibold bg-white w-full outline-none";
  return (
    <Card className="p-2 mt-2 slide-up">
      <div className="flex flex-wrap gap-1 mb-2">
        {TABS.map(t => (
          <button key={t.id} onClick={() => onTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${t.id===tab?"text-white":"text-gray-600 hover:bg-gray-100"}`}
            style={t.id===tab?{background:"var(--tap-green)"}:{}}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      {tab === "book" && (
        <div className="flex flex-wrap items-end gap-3 p-3 pt-1">
          <div className="flex-1 min-w-[140px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1 block">Origin</label>
            <select value={origin} onChange={e=>onOrigin(e.target.value)} className={selCls} style={{borderColor:"var(--tap-line)",color:"var(--tap-ink)"}}>
              {origins.map(([c,n]) => <option key={c} value={c}>{n} ({c})</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1 block">Destination</label>
            <select value={dest} onChange={e=>setDest(e.target.value)} className={selCls}
              style={{borderColor: dest ? "var(--tap-line)" : "#e8b4b4", color: dest ? "var(--tap-ink)" : "#9ca3af"}}>
              <option value="">Choose destination ({dests.length} cities)</option>
              {dests.map(([c,n]) => <option key={c} value={c}>{n} ({c})</option>)}
            </select>
          </div>
          <div className="min-w-[110px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1 block">Passengers</label>
            <select value={pax} onChange={e=>setPax(+e.target.value)} className={selCls} style={{borderColor:"var(--tap-line)",color:"var(--tap-ink)"}}>
              {[1,2,3,4].map(n => <option key={n} value={n}>{n} adult{n>1?"s":""}</option>)}
            </select>
          </div>
          <PrimaryBtn onClick={doSearch} disabled={!dest} className="!py-2.5"><Search size={15}/> Search</PrimaryBtn>
        </div>
      )}
    </Card>
  );
}

function Home({ profile, destinations, go, openAssistant, toast, bookDestination, bookUsual, resumeJourney, startFresh, openExtras, openExpress }) {
  const [sendingOffer, setSendingOffer] = useState(false);
  const [tab, setTab] = useState("Flights");
  const [flex, setFlex] = useState(false);
  const [payMiles, setPayMiles] = useState(false);
  const [rec, setRec] = useState(null);
  useEffect(() => { (async () => { try { setRec(await api.get("/recommendation")); } catch {} })(); }, []);
  const [offer, setOffer] = useState(null);
  useEffect(() => { (async () => { try { setOffer(await api.get("/offers/today")); } catch {} })(); }, []);
  const [upcoming, setUpcoming] = useState(null);
  useEffect(() => { (async () => { try {
    const bk = await api.get("/bookings");
    const t0 = new Date(SEARCH_TODAY + "T00:00:00Z");
    const conf = (bk || []).filter(b => b.status === "confirmed" && b.flight && b.flight_date);
    const up = conf.filter(b => new Date(b.flight_date) >= t0).sort((a, b) => new Date(a.flight_date) - new Date(b.flight_date))[0]
      || conf.sort((a, b) => new Date(b.flight_date) - new Date(a.flight_date))[0];
    setUpcoming(up || null);
  } catch {} })(); }, []);

  const u = profile.user, pat = profile.pattern, ss = profile.syncedSearch;
  const home = pat.origin || u.home_airport || "OPO";
  const dest = pat.dest || "LIS";
  const tripDest = (ss && ss.dest) || dest;
  const sOrigin = (ss && ss.origin) || home;          // profiled search origin (upcoming trip → usual route)
  const sDest = tripDest;                               // profiled search destination
  const sDate = (ss && ss.travel_date) || null;         // pre-filled timeframe
  const homeCity = cityName(home), destCity = cityName(dest), tripCity = cityName(tripDest);
  // Editable flight search — defaults to the profiled route/dates, but ANY of the 92
  // network airports can be typed and searched. Re-syncs to the profile on persona switch.
  const [fromCode, setFromCode] = useState(sOrigin);
  const [toCode, setToCode] = useState(sDest);
  const [depDate, setDepDate] = useState(sDate || "");
  useEffect(() => { setFromCode(sOrigin); setToCode(sDest); setDepDate(sDate || ""); }, [sOrigin, sDest, sDate]);
  const initials = u.full_name.split(" ").map(w => w[0]).slice(0, 2).join("");
  const usualPrice = pat.usualPrice != null ? pat.usualPrice : 201;

  // Cross-channel journey (where they left off, shared across web/AI/WhatsApp).
  const STAGE_STEP = { results: 1, seat: 2, extras: 3, review: 4 };
  const READY = { results: 25, seat: 50, extras: 75, review: 92 };
  const jStage = (ss && ss.stage) || "results";
  const jItems = (() => { try { return ss && ss.items_json ? JSON.parse(ss.items_json) : []; } catch { return []; } })();
  const readyPct = READY[jStage] || 25;
  const essentials = Math.max(1, 4 - (STAGE_STEP[jStage] || 1));
  const bundleSave = +(essentials * 14.5).toFixed(2);
  const today = new Date(((profile && profile.today) || SEARCH_TODAY) + "T00:00:00Z");
  const daysTo = (() => {
    if (ss && typeof ss.days_to_go === "number") return ss.days_to_go >= 0 ? ss.days_to_go : null;
    try { const n = Math.round((new Date(ss.travel_date) - today) / 86400e3); return n >= 0 ? n : null; } catch { return null; }
  })();
  const daysPhrase =
    daysTo == null ? "" :
    daysTo === 0 ? `Your ${tripCity} trip is today. ` :
    daysTo === 1 ? `Your ${tripCity} trip is tomorrow. ` :
    `You're ${daysTo} days from your next adventure to ${tripCity}. `;
  const fmtDate = (d) => { try { return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); } catch { return d || ""; } };

  // Next BOOKED trip (confirmed) — countdown + contextual action (check-in / seat upgrade offer).
  const upF = upcoming && upcoming.flight;
  const upDays = (() => {
    if (upcoming && typeof upcoming.days_to_go === "number") return upcoming.days_to_go;
    try { return Math.round((new Date(upcoming.flight_date) - today) / 86400e3); } catch { return null; }
  })();
  const upCountdown = upDays == null ? "" : upDays <= 0 ? "DEPARTS TODAY" : upDays === 1 ? "DEPARTS TOMORROW" : `${upDays} DAYS TO GO`;
  const upSoon = upDays != null && upDays <= 1;            // inside the check-in window
  const seatPref = ((profile.prefs && profile.prefs.seat) || "").split(" ")[0];
  const upgradePrice = 15;                                  // demo seat-upgrade fare

  const sendOffer = async () => {
    setSendingOffer(true);
    const r = await api.post("/offers/send");
    setSendingOffer(false);
    toast("Personalized offer emailed", `"${r.offer.subject}" → ${r.email.to} · ${r.email.status}`);
  };
  const doSearch = () => bookDestination({ code: sDest, origin: sOrigin, date: sDate, reason: `Your ${homeCity} ⇄ ${tripCity} route — dates pre-filled from your trip.` });
  const doWidgetSearch = () => {
    if (!fromCode || !toCode) { toast("Pick a route", "Choose where you're flying from and to."); return; }
    if (fromCode === toCode) { toast("Same airports", "Origin and destination can't match."); return; }
    bookDestination({ code: toCode, origin: fromCode, date: depDate || sDate, reason: `${cityName(fromCode)} → ${cityName(toCode)}${(depDate || sDate) ? " · " + fmtDate(depDate || sDate) : ""} — your search.` });
  };
  const swapEnds = () => { setFromCode(toCode); setToCode(fromCode); };

  const TABS = ["Flights", "Flights + Hotel", "Hotels", "Experiences", "Cabs & Transfers", "Flight Status"];
  const onTab = (t) => { if (t === "Flight Status") return go("status"); setTab(t); if (t !== "Flights") toast(t, "This demo wires the Flights flow end-to-end; the other tabs are illustrative."); };

  const navItem = (label, onClick, active) => (
    <button onClick={onClick} className="px-1 pb-1 text-sm font-semibold relative whitespace-nowrap" style={{ color: active ? "var(--tap-ink)" : "#5b6b63" }}>
      {label}{active && <span className="absolute left-0 right-0 -bottom-[7px] h-[3px] rounded-full" style={{ background: "var(--tap-green)" }}/>}
    </button>
  );
  const toggle = (on, set, size = "lg") => (
    <span onClick={set} className={`${size === "lg" ? "w-10 h-6" : "w-9 h-5"} rounded-full p-0.5 transition-colors cursor-pointer shrink-0`} style={{ background: on ? "var(--tap-green)" : "#cbd5d0" }}>
      <span className={`block ${size === "lg" ? "w-5 h-5" : "w-4 h-4"} rounded-full bg-white transition-transform`} style={{ transform: on ? "translateX(16px)" : "translateX(0)" }}/>
    </span>
  );

  return (
    <div style={{ background: "var(--tap-mist)" }}>
      {/* ── Top nav (light, mirrors flyxperion.example) ── */}
      <header className="sticky top-0 z-40 bg-white border-b" style={{ borderColor: "var(--tap-line)" }}>
        <div className="max-w-[1180px] mx-auto px-5 h-16 flex items-center gap-6">
          <button onClick={() => go("home")} className="shrink-0"><TapLogo/></button>
          <nav className="hidden lg:flex items-center gap-6">
            {navItem("Book", () => go("home"), true)}
            {navItem("Trip Extras", openExtras, false)}
            {navItem("Xperion Xperion Miles", () => go("miles"), false)}
          </nav>
          <div className="flex items-center gap-3 ml-auto shrink-0">
            <button onClick={() => go("search")} className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-gray-100" aria-label="Search"><Search size={17} className="text-gray-600"/></button>
            <span className="hidden md:flex items-center gap-1 text-xs font-semibold text-gray-600"><Globe size={14}/> PT · EUR</span>
            <button onClick={() => toast("Wishlist", "Saved destinations live here.")} className="hidden sm:flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-gray-900"><Ticket size={15}/> Wishlist</button>
            <button onClick={() => go("manage")} className="hidden sm:flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-gray-900"><ShoppingBag size={15}/> My Trip Cart</button>
            <button onClick={() => go("console")} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border" style={{ color: "var(--tap-deep)", borderColor: "var(--tap-line)" }} title="Demo-only: live database view"><Database size={12}/> Demo</button>
            <button onClick={() => go("miles")} className="flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full border" style={{ borderColor: "var(--tap-line)" }}>
              <span className="w-7 h-7 rounded-full flex items-center justify-center font-display font-extrabold text-[11px] text-white" style={{ background: "var(--tap-deep)" }}>{initials}</span>
              <span className="text-sm font-bold" style={{ color: "var(--tap-ink)" }}>{u.first_name}</span>
              <span className="text-[10px] font-black px-1.5 py-0.5 rounded" style={{ background: "var(--tap-gold)", color: "#3A2D04" }}>{(u.tier || "GOLD").toUpperCase()}</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Hero (magenta→coral over the destination city) ── */}
      <section className="relative overflow-hidden">
        <CityImg code={tripDest} alt={tripCity} className="absolute inset-0 w-full h-full object-cover"/>
        <div className="absolute inset-0" style={{ background: "linear-gradient(115deg, rgba(86,28,98,.94) 0%, rgba(176,40,116,.88) 42%, rgba(240,104,58,.82) 100%)" }}/>
        <div className="relative max-w-[1180px] mx-auto px-5 pt-4 pb-24 lg:pb-28">
          <div className="grid lg:grid-cols-[1.35fr_1fr] gap-8 items-start">
            {/* Left: greeting + headline */}
            <div>
              <div className="inline-flex flex-wrap items-center gap-2.5 rounded-full pl-1.5 pr-4 py-1.5 mb-3" style={{ background: "rgba(0,0,0,.22)", backdropFilter: "blur(6px)" }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center font-display font-extrabold text-[11px] text-white" style={{ background: "rgba(255,255,255,.18)" }}>{initials}</span>
                <span className="text-[13px] text-white font-semibold">Welcome back, {u.first_name}</span>
                <span className="text-[11px] font-black px-1.5 py-0.5 rounded" style={{ background: "var(--tap-gold)", color: "#3A2D04" }}>{(u.tier || "GOLD").toUpperCase()} MEMBER</span>
                <span className="text-white/55">•</span>
                <span className="text-[13px] font-semibold" style={{ color: "#FFE7B0" }}>{u.miles.toLocaleString()} tap.miles</span>
              </div>
              <h1 className="font-display font-black text-white tracking-tight leading-[0.98] text-3xl sm:text-4xl">{u.first_name}, make your<br/>{tripCity} trip unforgettable.</h1>
              <p className="text-white/85 mt-2 text-base max-w-md leading-relaxed">{daysPhrase}Let's complete your trip — beautifully.</p>
              {offer ? (
                <div className="mt-3 rounded-2xl px-4 py-3 max-w-md" style={{ background: "rgba(0,0,0,.26)", backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,.18)" }}>
                  <div className="flex items-center gap-1.5 text-[10px] font-black tracking-wide mb-1" style={{ color: "#FFE7B0" }}>✦ {(offer.badge || "Offer of the week").toUpperCase()} · FROM YOUR TRAVEL HISTORY</div>
                  <div className="flex items-end gap-2 flex-wrap">
                    <span className="text-white font-display font-extrabold text-lg leading-tight">{offer.destCity} from {EUR(offer.price)}</span>
                    {offer.was > offer.price && <span className="text-white/55 text-sm line-through">{EUR(offer.was)}</span>}
                    {offer.discountPct > 0 && <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: "var(--tap-green)", color: "#06210F" }}>−{offer.discountPct}%</span>}
                  </div>
                  <div className="text-white/80 text-[12px] mt-1">{offer.perk}</div>
                  <button onClick={() => bookDestination({ code: offer.dest, origin: offer.origin, date: sDate, reason: offer.detail })} className="mt-2.5 text-[13px] font-bold px-3.5 py-1.5 rounded-lg inline-flex items-center gap-1" style={{ background: "var(--tap-green)", color: "#fff" }}>Book this offer <ArrowRight size={14}/></button>
                </div>
              ) : (
                <div className="inline-flex items-start gap-2.5 mt-3 rounded-2xl px-4 py-2.5 max-w-md" style={{ background: "rgba(0,0,0,.24)", backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,.16)" }}>
                  <span className="text-base leading-none mt-0.5" style={{ color: "#FFE7B0" }}>✦</span>
                  <div>
                    <div className="text-[10px] font-black tracking-wide" style={{ color: "#FFE7B0" }}>THIS WEEK FOR YOU · FROM YOUR TRAVEL HISTORY</div>
                    <div className="text-white text-[13px] font-semibold mt-0.5">Your usual {homeCity} → {destCity} from {EUR(usualPrice)} — earn double {u.tier} miles.{pat.recommendedLabel ? ` Next: ${pat.recommendedLabel}.` : ""}</div>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <button onClick={openExpress} className="inline-flex items-center gap-2 px-5 py-3 rounded-full font-bold text-white shadow-lg" style={{ background: "var(--tap-green)" }}><Zap size={16}/> Book your usual · Express checkout</button>
                <button onClick={doSearch} className="inline-flex items-center gap-2 px-4 py-3 rounded-full font-semibold text-sm bg-white/15 text-white" style={{ backdropFilter: "blur(6px)" }}><Search size={15}/> Search from {EUR(usualPrice)}</button>
                <button onClick={sendOffer} className="inline-flex items-center gap-2 px-4 py-3 rounded-full font-semibold text-sm bg-white/15 text-white" style={{ backdropFilter: "blur(6px)" }}>{sendingOffer ? <Loader2 className="animate-spin" size={15}/> : <Mail size={15}/>} Email me this week's offer</button>
              </div>
            </div>
            {/* Right: trip + hotel cards */}
            <div className="space-y-4">
              {upF ? (
                <div className="rounded-2xl p-4 text-white shadow-xl" style={{ background: "linear-gradient(180deg,#0E2A1E,#0A1C14)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-[11px] font-bold tracking-wide" style={{ color: "var(--tap-green)" }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--tap-green)" }}/> YOUR UPCOMING TRIP · {upCountdown}</div>
                    <span className="text-[10px] font-semibold text-white/45 tracking-wider shrink-0">{upcoming.flight_no} · {upcoming.pnr}</span>
                  </div>
                  <div className="font-display font-extrabold text-xl mt-2">{cityName(upF.origin)}–{cityName(upF.dest)} · {fmtDate(upcoming.flight_date)}</div>
                  <div className="text-[12px] text-white/65 mt-1">{upF.dep ? `Departs ${upF.dep}` : ""}{upcoming.seat ? ` · seat ${upcoming.seat}` : ""} · {upcoming.checked_in ? "checked in ✓" : "not checked in"}</div>
                  {upcoming.checked_in ? (
                    <div className="flex items-center justify-between mt-3">
                      <div className="text-[12px] text-white/70 inline-flex items-center gap-1.5"><QrCode size={14} style={{ color: "var(--tap-green)" }}/> Boarding pass ready</div>
                      <button onClick={() => go("manage")} className="text-[13px] font-bold inline-flex items-center gap-1" style={{ color: "var(--tap-green)" }}>View pass <ArrowRight size={14}/></button>
                    </div>
                  ) : upSoon ? (
                    <div className="flex items-center justify-between mt-3">
                      <div className="text-[12px] inline-flex items-center gap-1.5" style={{ color: "#FFE7B0" }}><QrCode size={14}/> Check-in is open</div>
                      <button onClick={() => go("checkin")} className="text-[13px] font-bold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5" style={{ background: "var(--tap-green)", color: "#06210F" }}>Check in now <ArrowRight size={14}/></button>
                    </div>
                  ) : (
                    <>
                      <div className="mt-3 rounded-xl px-3 py-2 flex items-start gap-2" style={{ background: "rgba(255,231,176,.12)", border: "1px solid rgba(255,231,176,.25)" }}>
                        <span className="leading-none mt-0.5" style={{ color: "#FFE7B0" }}>✦</span>
                        <div className="text-[12px] text-white/85">{u.tier} offer: upgrade to a front-row seat for {EUR(upgradePrice)}{seatPref ? ` — you usually sit ${seatPref}` : ""}.</div>
                      </div>
                      <div className="flex items-center justify-between mt-2.5">
                        <button onClick={() => go("manage")} className="text-[12px] font-semibold text-white/70 inline-flex items-center gap-1">Open trip <ArrowRight size={13}/></button>
                        <button onClick={() => { toast(`${u.tier} upgrade`, `Front-row seat for ${EUR(upgradePrice)} added to ${upcoming.pnr}.`); go("manage"); }} className="text-[13px] font-bold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5" style={{ background: "var(--tap-green)", color: "#06210F" }}>Add upgrade · {EUR(upgradePrice)}</button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl p-4 text-white shadow-xl" style={{ background: "linear-gradient(180deg,#0E2A1E,#0A1C14)" }}>
                  <div className="flex items-center gap-2 text-[11px] font-bold tracking-wide" style={{ color: "var(--tap-green)" }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--tap-green)" }}/> BOOK YOUR USUAL FLIGHT</div>
                  <div className="font-display font-extrabold text-xl mt-2">{homeCity}–{destCity}</div>
                  <div className="text-[12px] text-white/70 mt-1">{pat.topFlight} · {pat.usualDep}{pat.usualPrice != null ? ` · ${EUR(pat.usualPrice)}` : ""}</div>
                  {pat.recommendedLabel && <div className="text-[11px] mt-1.5 inline-flex items-center gap-1 font-semibold" style={{ color: "var(--tap-green)" }}><Calendar size={12}/> Recommended: {pat.recommendedLabel}</div>}
                  <button onClick={openExpress} className="w-full mt-3 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold" style={{ background: "var(--tap-green)", color: "#06210F" }}><Zap size={15}/> Express checkout</button>
                  <button onClick={bookUsual} className="w-full mt-2 text-[12px] font-semibold text-white/70 inline-flex items-center justify-center gap-1">or search this route <ArrowRight size={13}/></button>
                </div>
              )}

              {/* Resume search card (replaces the static hotel upsell) — pre-fills the
                  profiled route + dates and re-opens flight options on any channel. */}
              {ss && ss.dest ? (
                <div className="bg-white rounded-2xl shadow-xl p-4 border" style={{ borderColor: "var(--tap-line)" }}>
                  <div className="flex items-center gap-2 text-[11px] font-bold tracking-wide mb-2" style={{ color: "var(--tap-green)" }}><RotateCcw size={13}/> RESUME YOUR SEARCH</div>
                  <div className="flex items-center gap-2 font-display font-extrabold text-lg" style={{ color: "var(--tap-ink)" }}>
                    {cityName(sOrigin)} <ArrowRight size={15} style={{ color: "var(--tap-green)" }}/> {tripCity}
                  </div>
                  <div className="text-[12px] text-gray-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="inline-flex items-center gap-1"><Calendar size={13} className="text-gray-400"/> {sDate ? fmtDate(sDate) : "your dates"}</span>
                    {ss.device && <span className="inline-flex items-center gap-1"><Laptop size={13} className="text-gray-400"/> from your {ss.device}</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button onClick={() => resumeJourney({ origin: ss.origin, dest: ss.dest, date: ss.travel_date, stage: jStage, flight_no: ss.flight_no, seat: ss.seat, items: jItems, cabin: ss.cabin })} className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold text-white" style={{ background: "var(--tap-green)" }}>Resume search <ArrowRight size={15}/></button>
                    <button onClick={() => { startFresh(ss); toast("Cleared", "Starting a fresh search."); }} className="px-3.5 py-2.5 rounded-xl text-sm font-semibold border text-gray-600" style={{ borderColor: "var(--tap-line)" }}>Start fresh</button>
                  </div>
                </div>
              ) : (
                <div className="bg-white rounded-2xl shadow-xl p-4 border" style={{ borderColor: "var(--tap-line)" }}>
                  <div className="flex items-center gap-2 text-[11px] font-bold tracking-wide mb-2" style={{ color: "var(--tap-green)" }}><Repeat size={13}/> BOOK YOUR USUAL FLIGHT</div>
                  <div className="flex items-center gap-2 font-display font-extrabold text-lg" style={{ color: "var(--tap-ink)" }}>{cityName(sOrigin)} <ArrowRight size={15} style={{ color: "var(--tap-green)" }}/> {destCity}</div>
                  <div className="text-[12px] text-gray-500 mt-1">{pat.topFlight}{pat.usualDep ? ` · ${pat.usualDep}` : ""}{pat.usualPrice != null ? ` · ${EUR(pat.usualPrice)}` : ""}</div>
                  {pat.recommendedLabel && <div className="text-[11px] mt-1 inline-flex items-center gap-1 font-semibold" style={{ color: "var(--tap-green)" }}><Calendar size={12}/> Recommended: {pat.recommendedLabel}</div>}
                  <button onClick={openExpress} className="w-full mt-3 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold text-white" style={{ background: "var(--tap-green)" }}><Zap size={15}/> Express checkout</button>
                  <button onClick={() => bookDestination({ code: sDest, origin: sOrigin, date: sDate, reason: `Your usual ${cityName(sOrigin)} → ${destCity} route.` })} className="w-full mt-2 text-[12px] font-semibold text-gray-500 inline-flex items-center justify-center gap-1">or search this route <ArrowRight size={13}/></button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Search widget (overlaps hero bottom) ── */}
        <div className="relative max-w-[1180px] mx-auto px-5 -mt-20 lg:-mt-24 pb-2">
          <div className="bg-white rounded-3xl shadow-2xl border p-5 sm:p-6" style={{ borderColor: "var(--tap-line)" }}>
            <div className="flex flex-wrap items-center gap-1 mb-4">
              {TABS.map(t => {
                const enabled = t === "Flights" || t === "Flight Status";
                const active = t === "Flights";
                return (
                  <button key={t} disabled={!enabled}
                    onClick={enabled && t === "Flight Status" ? () => go("status") : undefined}
                    title={enabled ? undefined : "Coming soon"}
                    className={`px-3.5 py-1.5 rounded-full text-sm font-semibold transition-colors ${enabled ? "" : "cursor-not-allowed"}`}
                    style={active ? { background: "#E7F7EE", color: "var(--tap-deep)" } : enabled ? { color: "#5b6b63" } : { color: "#c3ccc7" }}>{t}</button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-xl" style={{ background: "#EAF8F0" }}>
              <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--tap-deep)" }}><Sparkles size={14} style={{ color: "var(--tap-green)" }}/> We loaded your upcoming trip · adjust or search something new</div>
              <button onClick={() => { setToCode(""); setDepDate(""); toast("Cleared", "Pick any destination and dates to search."); }} className="text-[13px] font-bold text-gray-500 hover:text-gray-700">Clear</button>
            </div>
            {profile.recentSearches && profile.recentSearches.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {profile.recentSearches.slice(0, 2).map((s, i) => (
                  <button key={i} onClick={() => bookDestination({ code: s.dest, origin: s.origin, reason: `Your recent search · ${cityName(s.origin)} → ${cityName(s.dest)}.` })}
                    className="text-left px-3.5 py-2 rounded-xl border hover:border-gray-300" style={{ borderColor: "var(--tap-line)" }}>
                    <div className="text-sm font-bold" style={{ color: "var(--tap-ink)" }}>{cityName(s.origin)}–{cityName(s.dest)}</div>
                    <div className="text-[11px] text-gray-400">{fmtDate(s.travel_date)}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {["Round trip", "Travelers", "Economy"].map(s => (
                <button key={s} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border text-sm font-semibold text-gray-700" style={{ borderColor: "var(--tap-line)" }}>{s} <ChevronRight size={14} className="rotate-90 text-gray-400"/></button>
              ))}
            </div>
            <div className="flex flex-col lg:flex-row gap-3 lg:items-end">
              <AirportInput label="From" value={fromCode} onChange={setFromCode} icon={<Plane size={12} className="text-gray-400"/>}/>
              <button onClick={swapEnds} className="lg:mb-1 self-center w-9 h-9 rounded-full border flex items-center justify-center text-gray-500 shrink-0 hover:bg-gray-50" style={{ borderColor: "var(--tap-line)" }} aria-label="Swap origin and destination"><ArrowLeftRight size={15}/></button>
              <AirportInput label="To" value={toCode} onChange={setToCode} icon={<MapPin size={12} className="text-gray-400"/>}/>
              <div className="flex-1 min-w-[150px]">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1 mb-1"><Calendar size={12}/> Depart</label>
                <input type="date" value={depDate || ""} min={SEARCH_TODAY} onChange={(e) => setDepDate(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none font-semibold" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}/>
              </div>
              <button onClick={doWidgetSearch} className="rounded-xl px-6 py-2.5 font-bold text-white inline-flex items-center justify-center gap-2 shadow-lg shrink-0" style={{ background: "var(--tap-green)" }}><Search size={17}/> Search</button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
              <div className="flex items-center gap-5">
                <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600">{toggle(flex, () => setFlex(v => !v), "sm")} Flexible dates</div>
                <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600">{toggle(payMiles, () => setPayMiles(v => !v), "sm")} Pay with Miles ✦</div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[12px] text-gray-500">
                <span className="inline-flex items-center gap-1"><CheckCircle2 size={13} style={{ color: "var(--tap-green)" }}/> Free cancellation on select fares</span>
                <span className="inline-flex items-center gap-1"><CheckCircle2 size={13} style={{ color: "var(--tap-green)" }}/> Best price guarantee</span>
                <span className="inline-flex items-center gap-1"><CheckCircle2 size={13} style={{ color: "var(--tap-green)" }}/> Earn Miles on every booking</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Complete your trip / destinations ── */}
      <div className="max-w-[1180px] mx-auto px-5 pt-12 pb-8">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={15} style={{ color: "var(--tap-amber)" }}/>
          <span className="text-[11px] font-black tracking-wide" style={{ color: "var(--tap-amber)" }}>YOUR {tripCity.toUpperCase()} TRIP IS {readyPct}% COMPLETE</span>
        </div>
        <h2 className="font-display font-black text-4xl tracking-tight" style={{ color: "var(--tap-ink)" }}>Complete your {tripCity} trip</h2>
        <p className="text-sm text-gray-500 mt-1.5 mb-6 inline-flex items-center gap-1.5">Picked from your trips, searches &amp; miles — pulled live from your profile <Why text="These destinations come from your real data: routes you've flown, trips you've booked, and places you've searched."/></p>

        <div className="grid lg:grid-cols-3 gap-4">
          {destinations.slice(0, 1).map((d) => {
            const booked = pat.destCounts && pat.destCounts[d.code] || 0;
            return (
              <button key={d.code} onClick={() => bookDestination(d)} className="lg:row-span-2 relative rounded-3xl overflow-hidden group text-left min-h-[300px] lg:min-h-[420px]">
                <CityImg code={d.code} alt={d.city} className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"/>
                <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(8,18,13,.05) 30%, rgba(8,18,13,.82) 100%)" }}/>
                {booked > 0 && <span className="absolute top-4 right-4 text-[11px] font-bold px-3 py-1.5 rounded-full text-white" style={{ background: "var(--tap-green)" }}>Booked {booked}×</span>}
                <div className="absolute left-5 bottom-5 right-5">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-white/75 mb-1">{d.code} · {countryName(d.code)}</div>
                  <div className="font-display font-black text-4xl text-white tracking-tight">{d.city}</div>
                  <div className="flex items-end justify-between mt-2">
                    <div><div className="text-[11px] text-white/60">from</div><div className="font-display font-black text-2xl text-white">{d.miles_price ? `${d.miles_price.toLocaleString()} mi` : EUR(d.price)}</div></div>
                    <span className="w-12 h-12 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 text-white" style={{ background: "var(--tap-green)" }}><ArrowUpRight size={22}/></span>
                  </div>
                </div>
              </button>
            );
          })}
          <div className="lg:col-span-2 grid sm:grid-cols-2 gap-4">
            {destinations.slice(1, 5).map((d) => {
              const booked = pat.destCounts && pat.destCounts[d.code] || 0;
              return (
                <button key={d.code} onClick={() => bookDestination(d)} className="relative rounded-3xl overflow-hidden group text-left min-h-[200px]">
                  <CityImg code={d.code} alt={d.city} className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"/>
                  <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(8,18,13,.1) 25%, rgba(8,18,13,.8) 100%)" }}/>
                  <span className="absolute top-3 right-3 text-[10px] font-bold px-2.5 py-1 rounded-full text-white" style={{ background: booked > 0 ? "var(--tap-green)" : "rgba(8,18,13,.6)", backdropFilter: "blur(4px)" }}>{booked > 0 ? `Booked ${booked}×` : (d.tag || "Popular")}</span>
                  <div className="absolute left-4 bottom-4 right-4">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-white/75 mb-0.5">{d.code} · {countryName(d.code)}</div>
                    <div className="font-display font-black text-2xl text-white tracking-tight">{d.city}</div>
                    <div className="flex items-end justify-between mt-1.5">
                      <div><div className="text-[10px] text-white/60">from</div><div className="font-display font-black text-lg text-white">{d.miles_price ? `${d.miles_price.toLocaleString()} mi` : EUR(d.price)}</div></div>
                      <span className="w-9 h-9 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 text-white" style={{ background: "var(--tap-green)" }}><ArrowUpRight size={17}/></span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Affinity package (card-spend derived) */}
        {rec && rec.package && (
          <div className="mt-10">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles size={16} style={{ color: "var(--tap-green)" }}/>
              <h2 className="font-display font-black text-2xl tracking-tight" style={{ color: "var(--tap-ink)" }}>Made for you, {u.first_name}</h2>
              <Why text={`Derived from your Xperion Miles co-branded card spend pattern. ${rec.rationale} Bundles event ticket + hotel + return flight.`}/>
            </div>
            <div className="bg-white rounded-3xl overflow-hidden border grid md:grid-cols-2" style={{ borderColor: "var(--tap-line)" }}>
              <div className="relative min-h-[240px]">
                <img src={rec.package.image} alt={rec.package.event} className="absolute inset-0 w-full h-full object-cover" style={{ background: "var(--tap-mist)" }} onError={(e) => { if (e.currentTarget.src !== FALLBACK_PHOTO) e.currentTarget.src = FALLBACK_PHOTO; }}/>
                <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(8,18,13,.08), rgba(8,18,13,.55))" }}/>
                <span className="absolute top-4 left-4 text-[11px] font-bold px-3 py-1.5 rounded-full text-white" style={{ background: "var(--tap-green)" }}>{rec.package.badge}</span>
                <div className="absolute left-5 bottom-5 right-5">
                  <div className="font-display font-black text-2xl text-white tracking-tight leading-tight">{rec.package.event}</div>
                  <div className="text-sm text-white/85 mt-1 flex items-center gap-1.5"><MapPin size={14}/> {rec.package.venue}</div>
                </div>
              </div>
              <div className="p-6">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3" style={{ background: "var(--tap-mist)", color: "var(--tap-deep)" }}><CreditCard size={12}/> {rec.affinity_label} · from your card spend</div>
                <p className="text-sm leading-relaxed mb-4 text-gray-600">{rec.package.blurb}</p>
                <div className="space-y-2 mb-4">
                  {[{ icon: Ticket, label: rec.package.event, sub: new Date(rec.package.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), price: rec.package.eventPrice },
                    { icon: Building2, label: rec.package.hotel, sub: `${rec.package.hotelNights} nights`, price: rec.package.hotelPrice },
                    { icon: Plane, label: rec.package.flightDesc, sub: "Round trip", price: rec.package.flightPrice }].map((row, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "var(--tap-mist)" }}><row.icon size={16} style={{ color: "var(--tap-green)" }}/></div>
                      <div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate" style={{ color: "var(--tap-ink)" }}>{row.label}</div><div className="text-[11px] text-gray-400">{row.sub}</div></div>
                      <div className="text-sm font-bold" style={{ color: "var(--tap-ink)" }}>{EUR(row.price)}</div>
                    </div>
                  ))}
                </div>
                {rec.package.addon && (
                  <div className="flex items-start gap-2.5 p-3 rounded-xl mb-4" style={{ background: "#F0FAF4", border: "1px solid #BDEBD0" }}>
                    <Luggage size={16} className="shrink-0 mt-0.5" style={{ color: "var(--tap-green)" }}/>
                    <div className="flex-1"><div className="text-xs font-bold" style={{ color: "var(--tap-ink)" }}>{rec.package.addon.label} — <span style={{ color: "var(--tap-green)" }}>{EUR(rec.package.addon.price)}</span> <span className="line-through text-gray-400">{EUR(rec.package.addon.normal)}</span></div><div className="text-[11px] mt-0.5 text-gray-500">{rec.package.addon.note}</div></div>
                  </div>
                )}
                <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: "var(--tap-line)" }}>
                  <div><div className="text-[11px] text-gray-400">Package total</div><div className="font-display font-black text-2xl" style={{ color: "var(--tap-ink)" }}>{EUR(rec.package.total)}</div></div>
                  <button onClick={() => { toast("Package added", `${rec.package.event} · ${rec.package.city} — ${EUR(rec.package.total)} bundle held`); bookDestination({ code: rec.package.code, city: rec.package.city, reason: `${rec.affinity_label} package: ${rec.package.event}.` }); }} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-white" style={{ background: "var(--tap-green)" }}>Book this package <ArrowRight size={15}/></button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating AI button (red, matches comp) */}
      <button onClick={openAssistant} className="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-white" style={{ background: "var(--tap-red)" }} aria-label="Open Xperion AI Assistant"><Sparkles size={24}/></button>
    </div>
  );
}

/* ── FLIGHTS — recommendations + fare lock (persisted to DB) ── */
function Flights({ flights, pattern, selectFlight, toast }) {
  const [locked, setLocked] = useState(null);
  const dest = flights[0]?.dest || "LIS";
  const origin = flights[0]?.origin || "OPO";
  const toggleLock = async (f) => {
    const active = locked !== f.flight_no;
    setLocked(active ? f.flight_no : null);
    const r = await api.post("/fare-lock", { flight_no: f.flight_no, active });
    if (active) toast("Fare locked in DB", `${f.flight_no} at ${EUR(r.price)} until ${r.expires}`);
  };
  return (
    <div className="max-w-4xl mx-auto px-4 pb-24 pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="font-display font-black text-3xl" style={{color:"var(--tap-ink)"}}>{cityName(origin)} → {cityName(dest)}</h1>
        <Chip tone="ink">{fmtDate(flights?.[0]?.flight_date) || "Selected date"} · 1 adult · Economy</Chip>
      </div>
      <p className="text-sm text-gray-500 mb-6">Sorted for you: your usual departure first, lowest fare flagged. Recommendations computed from your travel history.</p>
      <div className="space-y-3">
        {flights.map((f) => {
          const isLocked = locked === f.flight_no;
          return (
            <Card key={f.flight_no} className="ticket-edge p-0 overflow-hidden slide-up" style={f.recommended ? { boxShadow: "0 0 0 2px var(--tap-green)" } : {}}>
              <div className="p-5 flex flex-wrap items-center gap-5">
                <div className="w-[88px]">
                  <div className="text-xs font-bold text-gray-400">{f.flight_no}</div>
                  <div className="text-[11px] text-gray-400">{f.aircraft}</div>
                </div>
                <div className="flex-1 min-w-[200px]">
                  <RouteRibbon small from={`${f.origin} ${f.dep}`} to={`${f.dest} ${f.arr}`}/>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {!!f.recommended && (f.dest === pattern.topRoute?.split("→")[1]
                      ? <Chip tone="green"><Sparkles size={11}/> Recommended — matches {pattern.matching} of your last {pattern.last} departures</Chip>
                      : <Chip tone="green"><Sparkles size={11}/> Best fit — earliest arrival for your meetings</Chip>)}
                    {!!f.lowest && <Chip tone="amber">Lowest fare today</Chip>}
                    {f.seats_left < 20 && <Chip tone="red">{f.seats_left} seats left</Chip>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display font-black text-2xl" style={{color:"var(--tap-ink)"}}>{EUR(f.price)}</div>
                  <div className="text-[11px] text-gray-400">Basic · cabin bag incl.</div>
                </div>
                <div className="flex flex-col gap-2 w-full sm:w-auto">
                  <PrimaryBtn onClick={() => selectFlight(f)} className="!py-2.5">Select <ChevronRight size={15}/></PrimaryBtn>
                  <button onClick={() => toggleLock(f)}
                    className="flex items-center justify-center gap-1.5 text-xs font-bold py-1.5 rounded-lg transition-colors"
                    style={{ color: isLocked ? "#fff" : "var(--tap-deep)", background: isLocked ? "var(--tap-deep)" : "var(--tap-mist)" }}>
                    <Lock size={12}/> {isLocked ? "Fare locked 24h" : "Lock fare · free for Gold"}
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ── BASKET — persisted server-side on every change ── */
/* ── SEAT MAP — pick a seat, with a recommendation from booking history ── */
function SeatMap({ flight, seat, setSeat, go, toast, profile }) {
  const [rec, setRec] = useState(null);
  const [taken, setTaken] = useState([]);
  const tier = profile?.user?.tier || "Gold";

  useEffect(() => { (async () => {
    const r = await api.get("/seat-recommendation");
    setRec(r);
    if (r?.seat && !seat) setSeat(r.seat);
    // deterministic "occupied" seats across all cabins so the map looks alive
    const occ = ["1C","2D","3A","4F","5B","6C","7E","9A","10C","11F","12B","14A","16C","18D","20A","22F","24B","26C","28E"];
    setTaken(occ.filter(s => s !== (r?.seat || "")));
  })(); }, []);

  // ── Cabin layout: three real classes ──
  // Business: rows 1-3, 2-2 (A,C | D,F). Premium: rows 4-7, 2-3-2-ish here 6 wide extra legroom.
  // Economy: rows 8-30, standard 3-3 (A,B,C | D,E,F).
  const CABINS = [
    { id: "business", label: "Business", rows: [1, 2, 3], cols: ["A", "C", "D", "F"], aisleAfter: 1, price: 0, freeFor: ["Platinum"], note: "Lie-flat · lounge included", color: "#063A28" },
    { id: "premium", label: "Premium Economy", rows: [4, 5, 6, 7], cols: ["A", "B", "C", "D", "E", "F"], aisleAfter: 2, price: 18, freeFor: ["Platinum", "Gold"], note: "Extra legroom · priority boarding", color: "#0A5A3C" },
    { id: "economy", label: "Economy", rows: Array.from({ length: 23 }, (_, i) => i + 8), cols: ["A", "B", "C", "D", "E", "F"], aisleAfter: 2, price: 0, premiumRows: { min: 8, max: 10, price: 8 }, note: "Standard cabin · front rows are extra-legroom", color: "#00A357" },
  ];
  const recSeat = rec?.seat || "";

  const cabinOf = (row) => CABINS.find(c => c.rows.includes(row));
  const seatPriceFor = (row) => {
    const c = cabinOf(row); if (!c) return 0;
    if (c.freeFor && c.freeFor.includes(tier)) return 0;               // class included for this tier
    if (c.id === "economy" && c.premiumRows && row >= c.premiumRows.min && row <= c.premiumRows.max) return c.premiumRows.price;
    return c.price || 0;
  };
  const classOf = (s) => { const row = parseInt(s); const c = cabinOf(row); return c ? c.label : "Economy"; };

  const pick = (s, row) => {
    if (taken.includes(s)) return;
    setSeat(s);
    const p = seatPriceFor(row);
    toast("Seat selected", `${s} · ${classOf(s)}${p ? ` · €${p}` : " · included"}`);
  };

  const recClass = recSeat ? classOf(recSeat) : "";
  const recPrice = recSeat ? seatPriceFor(parseInt(recSeat)) : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 pb-24 pt-8">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="font-display font-black text-3xl" style={{ color: "var(--tap-ink)" }}>Choose your seat</h1>
        <Chip tone="green"><Armchair size={11}/> {flight?.flight_no} · {flight?.origin}→{flight?.dest}</Chip>
      </div>
      <p className="text-sm text-gray-500 mb-5">Business, Premium Economy and Economy — pick any open seat. We've pre-selected your usual.</p>

      {rec && recSeat && (
        <Card className="p-4 mb-5 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: "var(--tap-green)", background: "#FBFDFC" }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-display font-extrabold" style={{ background: "var(--tap-green)" }}>{recSeat}</div>
            <div>
              <div className="font-bold text-sm flex items-center gap-1.5" style={{ color: "var(--tap-ink)" }}>Recommended for you · {recClass} <Why text="Computed live from your past bookings — the seat and cabin you choose most often."/></div>
              <div className="text-xs text-gray-500">{rec.reason} · {recPrice ? `€${recPrice}` : `included with ${tier}`}</div>
            </div>
          </div>
          <PrimaryBtn onClick={() => { setSeat(recSeat); go("basket"); }} className="!py-2.5">Keep {recSeat} <ArrowRight size={15}/></PrimaryBtn>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2 p-5 overflow-x-auto">
          <div className="flex justify-center mb-3"><div className="text-[11px] text-gray-400 px-3 py-1 rounded-full border" style={{ borderColor: "var(--tap-line)" }}>✈ Front of cabin</div></div>
          <div className="min-w-[320px] space-y-1">
            {CABINS.map(cabin => (
              <div key={cabin.id} className="mb-2">
                <div className="flex items-center gap-2 my-2">
                  <div className="h-px flex-1" style={{ background: "var(--tap-line)" }}/>
                  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full text-white" style={{ background: cabin.color }}>{cabin.label}</span>
                  <span className="text-[9px] text-gray-400">{cabin.note}</span>
                  <div className="h-px flex-1" style={{ background: "var(--tap-line)" }}/>
                </div>
                {cabin.rows.map(row => (
                  <div key={row} className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-5 text-[10px] text-gray-400 text-right">{row}</div>
                    {cabin.cols.map((col, ci) => {
                      const s = `${row}${col}`;
                      const isTaken = taken.includes(s);
                      const isSel = seat === s;
                      const isRec = s === recSeat && !isSel;
                      const price = seatPriceFor(row);
                      const w = cabin.id === "business" ? "w-9" : "w-7";
                      return (
                        <React.Fragment key={s}>
                          <button onClick={() => pick(s, row)} disabled={isTaken}
                            title={isTaken ? "Occupied" : `Seat ${s} · ${cabin.label}${price ? ` · €${price}` : " · included"}`}
                            className={`${w} h-7 rounded-md text-[9px] font-bold flex items-center justify-center transition-all`}
                            style={{
                              background: isSel ? "var(--tap-green)" : isTaken ? "#e5e7eb" : isRec ? "#d1fae5" : "#fff",
                              color: isSel ? "#fff" : isTaken ? "#9ca3af" : "var(--tap-ink)",
                              border: `1.5px solid ${isSel ? "var(--tap-green)" : isRec ? "var(--tap-green)" : cabin.id === "business" ? "#bcd7c9" : "var(--tap-line)"}`,
                              cursor: isTaken ? "not-allowed" : "pointer",
                            }}>
                            {isSel ? "✓" : col}
                          </button>
                          {ci === cabin.aisleAfter && <div className="w-4"/>}
                        </React.Fragment>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-4 mt-4 text-[11px] text-gray-500 flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ background: "var(--tap-green)" }}/> Selected</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ background: "#d1fae5", border: "1px solid var(--tap-green)" }}/> Recommended</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-white border"/> Available</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded" style={{ background: "#e5e7eb" }}/> Occupied</span>
          </div>
        </Card>

        <div>
          <Card className="p-5 sticky top-20">
            <div className="font-display font-extrabold mb-3" style={{ color: "var(--tap-ink)" }}>Your seat</div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-display font-black text-lg" style={{ background: "var(--tap-deep)" }}>{seat || recSeat || "—"}</div>
              <div className="text-sm text-gray-600">
                {seat ? classOf(seat) : (recSeat ? classOf(recSeat) : "Pick a seat")}
                <br/><span className="text-xs text-gray-400">{(() => { const sc = seat || recSeat; if (!sc) return ""; const p = seatPriceFor(parseInt(sc)); return p ? `€${p}` : `Included with ${tier}`; })()}</span>
              </div>
            </div>
            <PrimaryBtn onClick={() => go("basket")} className="w-full"><ArrowRight size={15}/> Continue to extras</PrimaryBtn>
            <div className="text-[11px] text-gray-400 mt-3 flex items-center gap-1.5"><Database size={12}/> Seat &amp; cabin saved with your basket.</div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Basket({ flight, ancillaries, items, toggleItem, go }) {
  const extras = items.reduce((s, id) => s + (ancillaries.find(a=>a.code===id)?.price || 0), 0);
  const total = flight.price + extras;
  return (
    <div className="max-w-5xl mx-auto px-4 pb-24 pt-8">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="font-display font-black text-3xl" style={{color:"var(--tap-ink)"}}>Your trip basket</h1>
        <Chip tone="green"><ShoppingBag size={11}/> Persistent — saved to DB on every change</Chip>
      </div>
      <p className="text-sm text-gray-500 mb-6">Everything in one place. Your usual choices are pre-loaded from your preference record.</p>
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-3">
          <Card className="ticket-edge p-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-xs font-bold text-gray-400 mb-1">{flight.flight_no} · {fmtDate(flight.flight_date)}</div>
                <RouteRibbon small from={`${flight.origin} ${flight.dep}`} to={`${flight.dest} ${flight.arr}`}/>
              </div>
              <div className="font-display font-black text-xl" style={{color:"var(--tap-ink)"}}>{EUR(flight.price)}</div>
            </div>
          </Card>
          {[...ancillaries].sort((a,b) => (b.recommended?1:0)-(a.recommended?1:0) || (b.bought||0)-(a.bought||0)).map(a => {
            const on = items.includes(a.code);
            return (
              <Card key={a.code} className={`p-4 transition-all ${on ? "" : "opacity-60"}`} style={on ? { borderColor: "var(--tap-green)" } : {}}>
                <button onClick={() => toggleItem(a.code)} className="w-full flex items-center gap-4 text-left">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "var(--tap-mist)" }}><AncIcon k={a.icon}/></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold flex items-center gap-2 flex-wrap" style={{color:"var(--tap-ink)"}}>
                      {a.name}
                      {a.recommended && <Chip tone="green"><Sparkles size={10}/> Recommended for you</Chip>}
                      {!!a.auto && on && !a.recommended && <Chip tone="green">Pre-selected</Chip>}
                    </div>
                    <div className="text-xs text-gray-500">{a.descr}</div>
                    {a.reason && <div className="text-[11px] mt-0.5 font-semibold flex items-center gap-1" style={{ color: "var(--tap-green)" }}><Repeat size={10}/> {a.reason}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-bold" style={{color: a.price===0 ? "var(--tap-green)" : "var(--tap-ink)"}}>{a.price === 0 ? "Free" : EUR(a.price)}</div>
                    {a.was && <div className="text-[11px] text-gray-400 line-through">{EUR(a.was)}</div>}
                  </div>
                  <div className="w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0"
                    style={{ borderColor: on ? "var(--tap-green)" : "var(--tap-line)", background: on ? "var(--tap-green)" : "#fff" }}>
                    {on && <CheckCircle2 size={13} className="text-white"/>}
                  </div>
                </button>
              </Card>
            );
          })}
        </div>
        <div>
          <Card className="p-5 sticky top-20">
            <div className="font-display font-extrabold mb-3" style={{color:"var(--tap-ink)"}}>Summary</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-600"><span>Flight {flight.flight_no}</span><span>{EUR(flight.price)}</span></div>
              {items.map(id => { const a = ancillaries.find(x=>x.code===id); return a && (
                <div key={id} className="flex justify-between text-gray-600"><span className="truncate pr-2">{a.name}</span><span>{a.price===0?"Free":EUR(a.price)}</span></div>
              );})}
              <div className="h-px my-2" style={{background:"var(--tap-line)"}}/>
              <div className="flex justify-between font-bold text-base" style={{color:"var(--tap-ink)"}}><span>Total</span><span>{EUR(total)}</span></div>
            </div>
            <PrimaryBtn onClick={() => go("checkout")} className="w-full mt-4">Continue to checkout <ArrowRight size={15}/></PrimaryBtn>
            <div className="text-[11px] text-gray-400 mt-3 flex items-center gap-1.5"><Database size={12}/> Basket row visible in the Demo Console.</div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ── CHECKOUT — autofill from DB profile + Time-to-Think hold ── */
function Checkout({ profile, flight, ancillaries, items, go, hold, setHold, toast }) {
  const extras = items.reduce((s, id) => s + (ancillaries.find(a=>a.code===id)?.price || 0), 0);
  const total = flight.price + extras;
  const u = profile.user;
  const lastName = (u.full_name || "").replace(u.first_name || "", "").trim() || "—";
  const doHold = async () => {
    if (hold) { setHold(false); return; }
    const r = await api.post("/hold", { flight_no: flight.flight_no, items, total });
    setHold(r.expires);
    toast("Hold confirmed by email", `${r.email.subject} → ${r.email.to} · ${r.email.status}`);
  };
  return (
    <div className="max-w-3xl mx-auto px-4 pb-24 pt-8">
      <h1 className="font-display font-black text-3xl mb-1" style={{color:"var(--tap-ink)"}}>Quick review</h1>
      <p className="text-sm text-gray-500 mb-6">One screen. Every field below is fetched live from your customer record.</p>
      <Card className="p-5 mb-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>Passenger</div>
          <Chip tone="green"><Zap size={11}/> Auto-filled from users table · member {u.member_no}</Chip>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          {[["First name", u.first_name],["Last name", lastName],["Date of birth", u.dob],["Gender", u.gender],["Nationality", u.nationality],["Passport no.", u.doc_id],["Passport expiry", u.passport_exp],["Frequent flyer", `${u.member_no} · ${u.tier}`],["Email", u.email],["Mobile", u.phone]].map(([k,v])=>(
            <div key={k} className="p-3 rounded-xl" style={{background:"var(--tap-mist)"}}>
              <div className="text-[11px] text-gray-400 font-semibold uppercase tracking-wide">{k}</div>
              <div className="font-semibold" style={{color:"var(--tap-deep)"}}>{v || "—"}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card className="ticket-edge p-5 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-bold text-gray-400 mb-1">{flight.flight_no} · {fmtDate(flight.flight_date, false)} · Seat {(profile.prefs?.seat||"").split(" ")[0] || "—"}</div>
            <RouteRibbon small from={`${flight.origin} ${flight.dep}`} to={`${flight.dest} ${flight.arr}`}/>
          </div>
          <div className="text-right">
            <div className="font-display font-black text-2xl" style={{color:"var(--tap-ink)"}}>{EUR(total)}</div>
            <div className="text-[11px] text-gray-400">{items.length} extras included</div>
          </div>
        </div>
      </Card>
      <Card className="p-5 mb-6" style={{ background: hold ? "#FFF9EC" : "#fff", borderColor: hold ? "var(--tap-gold)" : "var(--tap-line)" }}>
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{background:"#F7EFD6"}}><TimerReset size={18} style={{color:"var(--tap-gold)"}}/></div>
          <div className="flex-1">
            <div className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>Need time to think?</div>
            <div className="text-xs text-gray-500 mt-0.5">Hold this booking — price, seat {(profile.prefs?.seat||"").split(" ")[0] || ""} and extras — for <b>48 hours</b>, free for {profile.user?.tier || "Gold"}. We email you the hold confirmation.</div>
            {hold && <div className="text-xs font-bold mt-2" style={{color:"var(--tap-gold)"}}>⏳ Held until {hold} · confirmation email sent · reminder 6h before expiry.</div>}
          </div>
          <GhostBtn onClick={doHold} className="shrink-0">{hold ? "Release hold" : "Hold 48h — free"}</GhostBtn>
        </div>
      </Card>
      <div className="flex gap-3">
        <GhostBtn onClick={() => go("basket")} className="flex-1">Back to basket</GhostBtn>
        <PrimaryBtn onClick={() => go("payment")} className="flex-[2]">Continue to payment · {EUR(total)} <ArrowRight size={15}/></PrimaryBtn>
      </div>
    </div>
  );
}

/* ── PAYMENT — card + miles + voucher in one transaction ── */
function Payment({ profile, flight, ancillaries, items, seat, onPaid, toast }) {
  const extras = items.reduce((s, id) => s + (ancillaries.find(a=>a.code===id)?.price || 0), 0);
  const total = flight.price + extras;
  const u = profile.user;
  const voucher = profile.vouchers[0];
  const [useVoucher, setUseVoucher] = useState(!!voucher);
  const [milesUsed, setMilesUsed] = useState(6000);
  const [paying, setPaying] = useState(false);

  const voucherVal = useVoucher && voucher ? Math.min(voucher.amount, total) : 0;
  const milesVal = Math.min(milesUsed * MILES_RATE, Math.max(0, total - voucherVal));
  const cardVal = Math.max(0, total - voucherVal - milesVal);
  const maxMiles = Math.min(u.miles, Math.ceil((total - voucherVal) / MILES_RATE));

  const pay = async () => {
    setPaying(true);
    try {
      const r = await api.post("/pay", { flight_no: flight.flight_no, items, total, seat: seat || (profile?.prefs?.seat || "").split(" ")[0] || undefined,
        voucher_amt: voucherVal, miles_used: milesVal > 0 ? Math.min(milesUsed, maxMiles) : 0, miles_amt: milesVal, card_amt: cardVal });
      if (!r || !r.ok) { toast("Couldn't complete payment", (r && r.error) || "Please try again."); setPaying(false); return; }
      if (r.email) toast("Confirmation email sent", `${r.email.subject} → ${r.email.to} · ${r.email.status}`);
      onPaid({ pnr: r.pnr, total, voucherVal, milesVal, cardVal, flight });
    } catch (e) {
      toast("Couldn't complete payment", "Please try again."); setPaying(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 pb-24 pt-8">
      <h1 className="font-display font-black text-3xl mb-1" style={{color:"var(--tap-ink)"}}>Pay your way</h1>
      <p className="text-sm text-gray-500 mb-6">Split across card, miles and vouchers — one transaction. Balances update live in the DB.</p>
      <div className="space-y-3 mb-6">
        {voucher && (
          <Card className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{background:"var(--tap-mist)"}}><Ticket size={18} style={{color:"var(--tap-green)"}}/></div>
            <div className="flex-1">
              <div className="text-sm font-bold" style={{color:"var(--tap-ink)"}}>Voucher {voucher.code} — {EUR(voucher.amount)}</div>
              <div className="text-xs text-gray-500">{voucher.reason} · expires {voucher.expiry}</div>
            </div>
            <div className="text-sm font-bold" style={{color:"var(--tap-green)"}}>−{EUR(voucherVal)}</div>
            <button onClick={()=>setUseVoucher(!useVoucher)} role="switch" aria-checked={useVoucher}
              className="w-11 h-6 rounded-full relative transition-colors shrink-0" style={{background: useVoucher ? "var(--tap-green)" : "#D6DEDA"}}>
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${useVoucher?"left-[22px]":"left-0.5"}`}/>
            </button>
          </Card>
        )}
        <Card className="p-4">
          <div className="flex items-center gap-4 mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{background:"var(--tap-mist)"}}><Wallet size={18} style={{color:"var(--tap-green)"}}/></div>
            <div className="flex-1">
              <div className="text-sm font-bold" style={{color:"var(--tap-ink)"}}>Xperion Miles balance — {u.miles.toLocaleString()} miles</div>
              <div className="text-xs text-gray-500">Drag to use miles toward this trip</div>
            </div>
            <div className="text-sm font-bold" style={{color:"var(--tap-green)"}}>−{EUR(milesVal)}</div>
          </div>
          <input type="range" min={0} max={maxMiles} step={500} value={Math.min(milesUsed, maxMiles)}
            onChange={(e)=>setMilesUsed(+e.target.value)} className="w-full accent-[#00A357]"/>
          <div className="flex justify-between text-[11px] text-gray-400 font-medium"><span>0</span><span>{Math.min(milesUsed,maxMiles).toLocaleString()} miles</span><span>{maxMiles.toLocaleString()}</span></div>
        </Card>
        <Card className="p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{background:"var(--tap-mist)"}}><CreditCard size={18} style={{color:"var(--tap-green)"}}/></div>
          <div className="flex-1">
            <div className="text-sm font-bold" style={{color:"var(--tap-ink)"}}>Saved card · {MASKED_PAN}</div>
            <div className="text-xs text-gray-500">Saved to your profile · 3-D Secure ready</div>
          </div>
          <div className="text-sm font-bold" style={{color:"var(--tap-ink)"}}>{EUR(cardVal)}</div>
        </Card>
      </div>
      <Card className="p-5" style={{background:"var(--tap-deep)", borderColor:"var(--tap-deep)"}}>
        <div className="flex justify-between text-white/70 text-sm mb-1"><span>Trip total</span><span>{EUR(total)}</span></div>
        <div className="flex justify-between text-white/70 text-sm mb-1"><span>Voucher{voucherVal>0?` ${voucher?.code||""}`:""}</span><span>−{EUR(voucherVal)}</span></div>
        <div className="flex justify-between text-white/70 text-sm mb-1"><span>{milesVal>0?`${Math.min(milesUsed,maxMiles).toLocaleString()} miles`:"Miles"}</span><span>−{EUR(milesVal)}</span></div>
        <div className="h-px my-2 bg-white/15"/>
        <div className="flex justify-between text-white font-display font-extrabold text-xl mt-2 mb-4"><span>Charge to card</span><span>{EUR(cardVal)}</span></div>
        <button onClick={pay} disabled={paying}
          className="w-full py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-transform active:scale-[.98]"
          style={{background:"var(--tap-green)", color:"#fff"}}>
          {paying ? <><Loader2 className="animate-spin" size={16}/> Confirming with your bank…</> : <><Zap size={16}/> {cardVal > 0 ? `Pay ${EUR(cardVal)} to card` : "Confirm — fully covered by voucher & miles"}</>}
        </button>
        <div className="text-[11px] text-white/50 mt-2 text-center">Trip total {EUR(total)} · {EUR(voucherVal + milesVal)} covered by voucher &amp; miles · instant confirmation, itinerary emailed</div>
      </Card>
    </div>
  );
}

/* ── EXPRESS CHECKOUT (Step 1 of 2: Review & Pay) ──
   "Book your usual flight" lands here with everything pre-filled from the profile:
   the usual round trip, saved seat, tier-free perks, saved card, miles. One Pay. */
function ExpressCheckout({ profile, flight, ancillaries, items, seat, onPaid, toast, go }) {
  const u = profile.user, pat = profile.pattern || {}, prefs = profile.prefs || {};
  const out = flight;
  const tierFree = u.tier === "Gold" || u.tier === "Platinum" || u.tier === "Silver";
  // synthesize the return leg from the recurring pattern (display only; books the outbound PNR)
  const retNo = pat.usualBackNo || ("XP" + ((parseInt((out.flight_no || "XP1923").replace(/\D/g, "")) || 1923) + 19));
  const addDays = (d, n) => { try { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); } catch { return d; } };
  const outDate = out.flight_date, retDate = addDays(outDate, 2);
  const ret = { flight_no: retNo, origin: out.dest, dest: out.origin, dep: "19:10", arr: "20:05" };
  const seatOut = (prefs.seat || "12A").split(" ")[0] || "12A";
  const seatRet = "14C";
  // price summary (itemizes the usual fare + the usual add-ons)
  const base = Math.round(out.price * 0.79), taxes = out.price - base;
  const seatPrice = 18, bagPrice = 25, carbon = 2;
  const total = base + taxes + seatPrice + bagPrice + carbon;
  const milesEarned = Math.round(total * 11);
  const statusMiles = Math.round(milesEarned * 0.2);
  const milesForTrip = Math.round(total / MILES_RATE);
  const tripsToNextTier = { Silver: 4, Gold: 2, Platinum: 1 }[u.tier] || 2;
  const voucher = profile.vouchers && profile.vouchers[0];
  const [accept, setAccept] = useState(false);
  const [useVoucher, setUseVoucher] = useState(!!voucher);
  const [milesUsed, setMilesUsed] = useState(0);
  const [paying, setPaying] = useState(false);
  // Split payment — voucher + miles reduce the cash charged to card, live (same as the normal flow).
  const voucherVal = useVoucher && voucher ? Math.min(voucher.amount, total) : 0;
  const milesVal = Math.min(milesUsed * MILES_RATE, Math.max(0, total - voucherVal));
  const cardVal = Math.max(0, total - voucherVal - milesVal);
  const maxMiles = Math.min(u.miles, Math.ceil((total - voucherVal) / MILES_RATE));
  const milesSpent = milesVal > 0 ? Math.min(milesUsed, maxMiles) : 0;

  const pay = async () => {
    if (!accept) return;
    setPaying(true);
    try {
      const r = await api.post("/pay", { flight_no: out.flight_no, items, seat: seatOut, total, date: out.flight_date,
        voucher_amt: voucherVal, miles_used: milesSpent, miles_amt: milesVal, card_amt: cardVal });
      if (!r || !r.ok) { toast("Couldn't complete payment", (r && r.error) || "Please try again."); setPaying(false); return; }
      toast("Booking confirmed", `${r.pnr} · itinerary emailed to ${u.email}`);
      onPaid({ pnr: r.pnr, total, voucherVal, milesVal, cardVal,
        express: true, milesEarned, statusMiles, tripsToNextTier, ret, retDate, seatOut, seatRet, flight: out });
    } catch (e) {
      toast("Couldn't complete payment", "Please try again."); setPaying(false);
    }
  };

  const Stepper = () => (
    <div className="flex items-center gap-3 text-sm font-semibold mb-6">
      <span className="inline-flex items-center gap-2" style={{ color: "var(--tap-ink)" }}><span className="w-5 h-5 rounded-full text-white text-[11px] flex items-center justify-center" style={{ background: "var(--tap-green)" }}>1</span> Review &amp; Pay</span>
      <span className="flex-1 h-px" style={{ background: "var(--tap-line)" }}/>
      <span className="inline-flex items-center gap-2 text-gray-400"><span className="w-5 h-5 rounded-full text-white text-[11px] flex items-center justify-center bg-gray-300">2</span> Confirmation</span>
    </div>
  );
  const Section = ({ title, action, onAction, children }) => (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-extrabold text-base" style={{ color: "var(--tap-ink)" }}>{title}</h3>
        {action && <button onClick={onAction} className="text-[13px] font-bold" style={{ color: "var(--tap-green)" }}>{action}</button>}
      </div>
      {children}
    </Card>
  );
  const Leg = ({ tag, date, dep, depCode, depCity, arr, arrCode, arrCity, no }) => (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{tag} · {date}</div>
      <div className="flex items-center gap-3">
        <div><div className="font-display font-black text-2xl" style={{ color: "var(--tap-ink)" }}>{dep}</div><div className="text-[11px] text-gray-500">{depCode} · {depCity}</div></div>
        <div className="flex-1 text-center"><div className="text-[10px] text-gray-400">55 min · Direct</div><div className="h-px my-1" style={{ background: "var(--tap-line)" }}/><div className="text-[10px] text-gray-400">{no} · A321neo</div></div>
        <div className="text-right"><div className="font-display font-black text-2xl" style={{ color: "var(--tap-ink)" }}>{arr}</div><div className="text-[11px] text-gray-500">{arrCode} · {arrCity}</div></div>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 pb-24 pt-8">
      <Stepper/>
      <h1 className="font-display font-black text-3xl mb-1" style={{ color: "var(--tap-ink)" }}>Express checkout</h1>
      <p className="text-sm text-gray-500 mb-6">Review your total and pay securely to confirm your trip. No charge has been made until you click Pay.</p>
      <div className="grid lg:grid-cols-[1fr_340px] gap-5 items-start">
        <div className="space-y-4">
          <Section title={`Your trip · ${cityName(out.origin)} ⇄ ${cityName(out.dest)}`} action="Change flight" onAction={() => go("search")}>
            <Leg tag="Outbound" date={fmtDate(outDate)} dep={out.dep} depCode={out.origin} depCity={cityName(out.origin)} arr={out.arr} arrCode={out.dest} arrCity={cityName(out.dest)} no={out.flight_no}/>
            <div className="h-px my-4" style={{ background: "var(--tap-line)" }}/>
            <Leg tag="Return" date={fmtDate(retDate)} dep={ret.dep} depCode={ret.origin} depCity={cityName(ret.origin)} arr={ret.arr} arrCode={ret.dest} arrCity={cityName(ret.dest)} no={ret.flight_no}/>
            <div className="flex items-center justify-between mt-4 pt-3 border-t" style={{ borderColor: "var(--tap-line)" }}>
              <div className="text-[13px]"><span className="font-bold" style={{ color: "var(--tap-ink)" }}>Fare: Classic</span> <span className="text-gray-500">· 23kg bag · seat select · 50% refund</span></div>
              <button className="text-[13px] font-bold" style={{ color: "var(--tap-green)" }} onClick={() => toast("Fare rules", "Classic: 23kg bag, seat select, 50% refund, changes for a fee.")}>See fare rules</button>
            </div>
          </Section>

          <Section title="Passenger" action="Edit" onAction={() => go("manage")}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full flex items-center justify-center font-display font-extrabold text-sm text-white shrink-0" style={{ background: "var(--tap-deep)" }}>{u.full_name.split(" ").map(w => w[0]).slice(0, 2).join("")}</div>
              <div>
                <div className="text-sm font-bold" style={{ color: "var(--tap-ink)" }}>{u.full_name} <span className="text-[11px] font-black px-1.5 py-0.5 rounded ml-1" style={{ background: "var(--tap-gold)", color: "#3A2D04" }}>{(u.tier || "GOLD").toUpperCase()}</span> <span className="text-[11px] text-gray-400">· {u.member_no}</span></div>
                <div className="text-[12px] text-gray-500">{u.doc_id} · Nationality {u.nationality}</div>
                <div className="text-[12px] font-semibold mt-0.5" style={{ color: "var(--tap-green)" }}>Frequent flyer benefits applied: priority boarding, lounge</div>
              </div>
            </div>
          </Section>

          <Section title="Seat selection" action="Change seat" onAction={() => go("seatmap")}>
            <div className="flex items-center justify-between text-sm mb-1">
              <div><span className="font-bold" style={{ color: "var(--tap-ink)" }}>Outbound · {seatOut}</span> <span className="text-gray-500">(Window, Extra legroom)</span></div>
              <span className="font-bold" style={{ color: "var(--tap-ink)" }}>{EUR(seatPrice)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <div><span className="font-bold" style={{ color: "var(--tap-ink)" }}>Return · {seatRet}</span> <span className="text-gray-500">(Aisle, Standard)</span></div>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: "#E2F4EA", color: "#066B3C" }}>FREE · {(u.tier || "GOLD").toUpperCase()}</span>
            </div>
          </Section>

          <Section title="Baggage &amp; extras" action="Manage" onAction={() => go("basket")}>
            {[
              { label: "Cabin bag · 8kg", sub: "Included in fare", free: true },
              { label: "Checked bag · 23kg ×1", sub: "Outbound + Return", price: bagPrice },
              { label: "Lounge access · " + cityName(out.origin), sub: "Included with " + u.tier, free: true },
              { label: "Priority boarding", sub: "Included with " + u.tier, free: true },
              { label: "Carbon offset · 0.18t CO₂e", sub: "Verified Gold Standard", price: carbon },
            ].map((x, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                <div><div className="font-semibold" style={{ color: "var(--tap-ink)" }}>{x.label}</div><div className="text-[11px] text-gray-400">{x.sub}</div></div>
                {x.free ? <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: "#E2F4EA", color: "#066B3C" }}>{x.sub.startsWith("Included in") ? "INCLUDED" : `FREE · ${(u.tier || "GOLD").toUpperCase()}`}</span> : <span className="font-bold" style={{ color: "var(--tap-ink)" }}>{EUR(x.price)}</span>}
              </div>
            ))}
          </Section>

          <Section title="Payment method" action="+ Change" onAction={() => toast("Payment", "Use your saved card, miles, MB WAY, Apple Pay or PayPal at payment.")}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold" style={{ color: "var(--tap-ink)" }}>Saved card · {MASKED_PAN}</div>
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: "#E2F4EA", color: "#066B3C" }}>🔒 Encrypted</span>
            </div>
            <div className="mt-3 rounded-xl p-3 text-[12px] text-gray-500 flex items-center gap-2" style={{ background: "var(--tap-mist)" }}>
              <span className="font-bold" style={{ color: "var(--tap-ink)" }}>3-D Secure 2.0</span> · bank verification appears here when required.
            </div>
          </Section>

          <Section title="Contact details" action="Edit" onAction={() => go("manage")}>
            <div className="text-sm" style={{ color: "var(--tap-ink)" }}>{u.email} · {u.phone}</div>
            <div className="text-[12px] text-gray-400">Boarding pass, receipt and IROPS alerts go here.</div>
          </Section>

          <label className="flex items-start gap-2 text-sm text-gray-600 cursor-pointer px-1">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 accent-[#46A41A]"/>
            I've read and accept the <span className="font-semibold" style={{ color: "var(--tap-ink)" }}>fare conditions · baggage rules · privacy policy</span>.
          </label>
        </div>

        {/* Price summary */}
        <div className="lg:sticky lg:top-20">
          <Card className="p-5">
            <h3 className="font-display font-extrabold text-base mb-3" style={{ color: "var(--tap-ink)" }}>Price summary</h3>
            {[["Base fare · 1 adult", base], ["Taxes & fees", taxes], [`Seat ${seatOut} · extra legroom`, seatPrice], ["Checked bag 23kg", bagPrice], ["Carbon offset", carbon]].map(([k, v], i) => (
              <div key={i} className="flex justify-between text-sm py-1 text-gray-600"><span>{k}</span><span style={{ color: "var(--tap-ink)" }}>{EUR(v)}</span></div>
            ))}
            <div className="h-px my-2" style={{ background: "var(--tap-line)" }}/>
            <div className="flex justify-between items-center mb-3"><span className="font-bold" style={{ color: "var(--tap-ink)" }}>Trip total</span><span className="font-display font-black text-2xl" style={{ color: "var(--tap-ink)" }}>{EUR(total)}</span></div>

            {voucher && (
              <div className="flex items-center justify-between rounded-xl px-3 py-2 mb-2" style={{ background: "var(--tap-mist)" }}>
                <div className="min-w-0 mr-2">
                  <div className="text-[12px] font-bold truncate" style={{ color: "var(--tap-ink)" }}>Voucher {voucher.code} · {EUR(voucher.amount)}</div>
                  <div className="text-[10px] text-gray-500">{useVoucher ? `−${EUR(voucherVal)} applied` : "tap to apply"}</div>
                </div>
                <button onClick={() => setUseVoucher(v => !v)} role="switch" aria-checked={useVoucher}
                  className="w-11 h-6 rounded-full relative transition-colors shrink-0" style={{ background: useVoucher ? "var(--tap-green)" : "#D6DEDA" }}>
                  <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${useVoucher ? "left-[22px]" : "left-0.5"}`}/>
                </button>
              </div>
            )}

            <div className="rounded-xl px-3 py-2 mb-3" style={{ background: "var(--tap-mist)" }}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[12px] font-bold" style={{ color: "var(--tap-ink)" }}>Use miles ✦ <span className="text-[10px] font-medium text-gray-500">({u.miles.toLocaleString()} available)</span></div>
                <div className="text-[12px] font-bold" style={{ color: "var(--tap-green)" }}>−{EUR(milesVal)}</div>
              </div>
              <input type="range" min={0} max={maxMiles} step={500} value={milesSpent}
                onChange={(e) => setMilesUsed(+e.target.value)} className="w-full accent-[#00A357]"/>
              <div className="flex justify-between text-[10px] text-gray-400 font-medium"><span>0</span><span>{milesSpent.toLocaleString()} mi</span><span>{maxMiles.toLocaleString()}</span></div>
            </div>

            <div className="flex justify-between items-center mb-3">
              <span className="text-[13px] font-bold" style={{ color: "var(--tap-ink)" }}>Charge to saved card · {MASKED_PAN}</span>
              <span className="font-display font-black text-xl" style={{ color: "var(--tap-ink)" }}>{EUR(cardVal)}</span>
            </div>

            <div className="rounded-xl px-3 py-2 text-[11px] mb-3 flex items-center gap-1.5" style={{ background: "#FCF1DD", color: "#8A5A06" }}>⏱ Price held · won't change if you pay now</div>
            <button onClick={pay} disabled={!accept || paying}
              className="w-full py-3.5 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-transform active:scale-[.98] disabled:opacity-50"
              style={{ background: "var(--tap-green)" }}>
              {paying ? <><Loader2 className="animate-spin" size={16}/> Confirming…</> : <><Zap size={16}/> {cardVal > 0 ? `Pay ${EUR(cardVal)} securely` : "Confirm — covered by voucher & miles"}</>}
            </button>
            <div className="text-[11px] text-center mt-2 font-semibold" style={{ color: "var(--tap-green)" }}>Earn {milesEarned.toLocaleString()} miles on this trip</div>
            <div className="text-[10px] text-gray-400 mt-2 text-center">Visa · Mastercard · Amex · MB WAY · Apple Pay · PayPal<br/>Free 24h cancel · 24/7 support</div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ── CONFIRMATION (Step 2 of 2) ── */
function Confirmed({ profile, flight, receipt, go }) {
  const u = profile.user;
  // Null-safe flight: the confirmation must NEVER blank out, even if the live
  // flight object isn't in React state (e.g. arriving from the chat checkout).
  // Fall back to flight basics carried on the receipt, then to safe placeholders.
  const f = flight || receipt.flight || {};
  const seat = receipt.seatOut || (profile.prefs?.seat || "").split(" ")[0] || "—";
  const total = receipt.total || f.price || 0;
  const milesEarned = receipt.milesEarned ?? Math.round(total * 11);
  const statusMiles = receipt.statusMiles ?? Math.round(milesEarned * 0.2);
  const tripsToNextTier = receipt.tripsToNextTier ?? 2;
  const paidLabel = receipt.cardVal > 0 ? "your saved card" : (receipt.milesVal > 0 ? "Xperion Miles" : "Voucher");
  const base = Math.round(total * 0.79), taxes = total - base;
  const useful = [
    { tag: "EXPERIENCE", title: `${f.dest ? cityName(f.dest) : "Your destination"} food & wine tour`, sub: "3h · 5 stops · tastings included", price: 65 },
    { tag: "DAY TRIP", title: `Sintra full-day from ${f.origin ? cityName(f.origin) : "the city"}`, sub: "Pena Palace, Regaleira & Cabo da Roca", price: 89 },
    { tag: "TRANSFER", title: `Return transfer hotel → ${f.origin || ""}`, sub: "Private sedan · save 10% when paired", price: 25 },
  ];
  return (
    <div className="max-w-5xl mx-auto px-4 pb-24 pt-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 slide-up" style={{ background: "#E2F4EA" }}><CheckCircle2 size={20} style={{ color: "var(--tap-green)" }}/></div>
        <div>
          <h1 className="font-display font-black text-3xl leading-none" style={{ color: "var(--tap-ink)" }}>Booking Confirmed</h1>
          <div className="text-sm text-gray-500 mt-1">PNR <b>{receipt.pnr}</b> · receipt sent to {u.email}</div>
        </div>
      </div>
      <div className="grid lg:grid-cols-[1fr_320px] gap-5 items-start">
        <div className="space-y-5">
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3"><span className="font-display font-extrabold text-base" style={{ color: "var(--tap-ink)" }}>Your itinerary</span><span className="text-[11px] font-bold text-white px-2 py-0.5 rounded-full" style={{ background: "var(--tap-red)" }}>PNR {receipt.pnr}</span></div>
            <div className="rounded-2xl p-4" style={{ background: "#EAF7E1" }}>
              <RouteRibbon from={`${f.origin || ""} ${f.dep || ""}`} to={`${f.dest || ""} ${f.arr || ""}`}/>
              <div className="text-[12px] text-gray-500 text-center mt-2">{f.flight_date ? fmtDate(f.flight_date) : ""} · {f.flight_no || receipt.pnr} · seat {seat} · gate info 90 min before</div>
            </div>
            <div className="flex flex-wrap gap-2 mt-3 text-[12px]">
              {[`${u.first_name} · ${seat}`, "Carry-on ×1", "Standard seat", "Snack"].map((c, i) => (
                <span key={i} className="px-2.5 py-1 rounded-full border" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}>{c}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 mt-4 text-[13px] font-bold" style={{ color: "var(--tap-green)" }}>
              <button onClick={() => go("manage")}>Add to Wallet</button>
              <button onClick={() => go("manage")}>Add to Calendar</button>
              <button onClick={() => go("manage")}>Download e-ticket</button>
            </div>
            <div className="text-[12px] text-gray-400 mt-2">Manage booking · check-in opens 24h before</div>
          </Card>

          <div>
            <h2 className="font-display font-black text-xl" style={{ color: "var(--tap-ink)" }}>Useful for your trip</h2>
            <p className="text-[12px] text-gray-400 mb-3">Limited · helpful · not pushy.</p>
            <div className="grid sm:grid-cols-3 gap-3">
              {useful.map((x, i) => (
                <Card key={i} className="p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">{x.tag}</div>
                  <div className="text-sm font-bold mb-0.5" style={{ color: "var(--tap-ink)" }}>{x.title}</div>
                  <div className="text-[11px] text-gray-500 mb-2">{x.sub}</div>
                  <div className="flex items-center justify-between">
                    <span className="font-display font-black" style={{ color: "var(--tap-ink)" }}>{EUR(x.price)}</span>
                    <span className="text-[12px] font-bold px-3 py-1 rounded-full border" style={{ borderColor: "var(--tap-green)", color: "var(--tap-green)" }}>+ Add</span>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </div>

        {/* Payment receipt */}
        <div className="lg:sticky lg:top-20 space-y-4">
          <Card className="p-5">
            <h3 className="font-display font-extrabold text-base mb-3" style={{ color: "var(--tap-ink)" }}>Payment receipt</h3>
            <div className="flex justify-between text-sm py-1 text-gray-600"><span>Fare</span><span style={{ color: "var(--tap-ink)" }}>{EUR(base)}</span></div>
            <div className="flex justify-between text-sm py-1 text-gray-600"><span>Taxes &amp; fees</span><span style={{ color: "var(--tap-ink)" }}>{EUR(taxes)}</span></div>
            <div className="h-px my-2" style={{ background: "var(--tap-line)" }}/>
            <div className="flex justify-between items-center"><span className="text-sm text-gray-500">Paid · {paidLabel}</span><span className="font-display font-black text-2xl" style={{ color: "var(--tap-green)" }}>{EUR(total)}</span></div>
            <div className="rounded-xl px-3 py-2.5 mt-3 text-[12px]" style={{ background: "#EAF7E1" }}>
              <div className="font-bold" style={{ color: "#066B3C" }}>✦ You earned {milesEarned.toLocaleString()} miles</div>
              <div className="text-gray-500">+ {statusMiles} status miles · {tripsToNextTier} trips to next tier</div>
            </div>
            <button onClick={() => go("manage")} className="w-full mt-3 py-2.5 rounded-xl font-bold text-sm border inline-flex items-center justify-center gap-2" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}>Download invoice (PDF) <ArrowRight size={14}/></button>
          </Card>
          <Card className="p-4 text-[12px] text-gray-500 space-y-1.5">
            <div className="flex items-center gap-2"><CheckCircle2 size={13} style={{ color: "var(--tap-green)" }}/> Free 24h cancellation</div>
            <div className="flex items-center gap-2"><Sparkles size={13} style={{ color: "var(--tap-green)" }}/> 24/7 Xperion Care — chat anytime</div>
          </Card>
          <PrimaryBtn onClick={() => go("manage")} className="w-full">Manage this booking <ArrowRight size={15}/></PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

/* ── MANAGE — auto check-in, boarding pass, AI disruption + emails ── */
function Manage({ profile, flight, openAssistant, toast, go }) {
  const [autoCI, setAutoCI] = useState(!!profile.prefs.auto_checkin);
  const [showPass, setShowPass] = useState(false);
  const [disrupted, setDisrupted] = useState(false);
  const [recovery, setRecovery] = useState(null);
  const [loadingRec, setLoadingRec] = useState(false);
  const [rebooked, setRebooked] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [passBooking, setPassBooking] = useState(null);

  const loadBookings = async () => setBookings(await api.get("/bookings"));
  useEffect(() => { loadBookings(); }, []);

  const active = bookings ? bookings.filter(b => b.status === "confirmed" || b.status === "rebooked") : [];
  const past = bookings ? bookings.filter(b => b.status === "completed") : [];
  const primary = active[0];   // newest active booking drives disruption demo

  const simulateDisruption = async () => {
    if (!primary) { toast("No active booking", "Book a flight first, then simulate a delay"); return; }
    setDisrupted(true); setRebooked(null); setRecovery(null); setLoadingRec(true);
    const r = await api.post("/disrupt", { flight_no: primary.flight_no });
    setRecovery(r.recovery); setLoadingRec(false);
    toast("Disruption email sent proactively", `${r.email.subject} → ${r.email.to} · ${r.email.status}`);
  };
  const acceptOption = async (opt) => {
    setRebooked(opt);
    const r = await api.post("/rebook", { option: opt });
    toast("Rebooking confirmed by email", `${r.email.subject} → ${r.email.to} · ${r.email.status}`);
    loadBookings();
  };
  const cancelBooking = async (b) => {
    const r = await api.post("/bookings/cancel", {});
    if (r.ok) toast("Booking cancelled — refund issued", `${r.pnr} · ${r.email.subject}`);
    loadBookings();
  };
  const toggleCI = async () => { setAutoCI(!autoCI); await api.post("/checkin", { auto: !autoCI }); };

  return (
    <div className="max-w-3xl mx-auto px-4 pb-24 pt-8">
      <h1 className="font-display font-black text-3xl mb-1" style={{color:"var(--tap-ink)"}}>My flights</h1>
      <p className="text-sm text-gray-500 mb-6">Live from the bookings table — {active.length} upcoming, {past.length} past. Change, cancel or check in, all in-app.</p>

      {disrupted && (
        <Card className="p-5 mb-5 slide-up" style={{ borderColor: "var(--tap-red)", background: "#FFF6F7" }}>
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{background:"#FBE4E7"}}>
              <Bell size={17} style={{color:"var(--tap-red)"}} className="pulse-dot"/>
            </div>
            <div className="flex-1">
              {loadingRec ? (
                <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="animate-spin" size={15}/> Disruption detected — AI preparing your options and emailing you…</div>
              ) : recovery && (
                <>
                  <div className="font-bold text-sm mb-1" style={{color:"var(--tap-red)"}}>{recovery.headline}</div>
                  <p className="text-sm text-gray-700 leading-relaxed mb-3">{recovery.message}</p>
                  {!rebooked ? (
                    <div className="space-y-2">
                      {recovery.options?.map((o)=>(
                        <button key={o.id} onClick={()=>acceptOption(o)}
                          className="w-full text-left p-3 rounded-xl border bg-white hover:shadow-sm transition-shadow flex items-center gap-3" style={{borderColor:"var(--tap-line)"}}>
                          <RefreshCw size={15} style={{color:"var(--tap-green)"}} className="shrink-0"/>
                          <div className="flex-1">
                            <div className="text-sm font-bold" style={{color:"var(--tap-ink)"}}>{o.label}</div>
                            <div className="text-xs text-gray-500">{o.detail}</div>
                          </div>
                          <span className="text-xs font-bold shrink-0" style={{color:"var(--tap-green)"}}>Select — free</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl flex items-center gap-2 text-sm font-semibold" style={{background:"#E2F4EA", color:"#066B3C"}}>
                      <CheckCircle2 size={16}/> Done — {rebooked.label}. New boarding pass issued, confirmation emailed.
                    </div>
                  )}
                  {recovery.compensation && <div className="text-xs text-gray-500 mt-3 flex items-start gap-1.5"><ShieldCheck size={13} className="shrink-0 mt-0.5" style={{color:"var(--tap-gold)"}}/>{recovery.compensation}</div>}
                </>
              )}
            </div>
          </div>
        </Card>
      )}

      {bookings === null && <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="animate-spin" size={16}/> Loading your bookings…</div>}

      {bookings !== null && active.length === 0 && (
        <Card className="p-8 text-center">
          <CalendarClock size={32} className="mx-auto mb-3" style={{ color: "var(--tap-line)" }}/>
          <div className="font-bold text-sm mb-1" style={{ color: "var(--tap-ink)" }}>No active bookings yet</div>
          <div className="text-xs text-gray-500 mb-4">Once you book a flight it appears here, live from the database.</div>
          <PrimaryBtn onClick={() => go("home")} className="!py-2.5"><Zap size={15}/> Book my usual flight</PrimaryBtn>
        </Card>
      )}

      {active.length > 0 && <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Upcoming</div>}

      {active.map((b, idx) => {
        const f = b.flight || {};
        const isPrimary = idx === 0;
        const delayed = isPrimary && disrupted && !rebooked;
        return (
          <Card key={b.id} className="ticket-edge p-5 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="text-xs font-bold text-gray-400">{b.pnr} · {b.flight_date} · {rebooked && isPrimary ? `rebooked to ${rebooked.id}` : b.flight_no}</div>
              <Chip tone={delayed ? "red" : "green"}>
                <span className="pulse-dot">●</span> {delayed ? `Delayed · new dep ${f.new_dep || f.dep}` : (b.status === "rebooked" ? "Rebooked" : "On time")}
              </Chip>
            </div>
            <RouteRibbon from={`${f.origin || "OPO"} ${delayed ? (f.new_dep || f.dep) : f.dep}`} to={`${f.dest || "LIS"} ${delayed ? (f.new_arr || f.arr) : f.arr}`}/>
            <div className="text-xs text-gray-500 mt-2">Seat {b.seat} · {(b.items || []).join(" · ") || "no extras"} · {b.checked_in ? "Checked in ✓" : "Auto check-in 24h before"}</div>
            <div className="h-px my-4" style={{background:"var(--tap-line)"}}/>
            <div className="grid sm:grid-cols-3 gap-2">
              <GhostBtn onClick={()=>{ setPassBooking(b); setShowPass(true); }} className="w-full"><QrCode size={15}/> Boarding pass</GhostBtn>
              <GhostBtn onClick={()=>go("search")} className="w-full"><RefreshCw size={15}/> Change flight</GhostBtn>
              <GhostBtn onClick={()=>cancelBooking(b)} className="w-full text-red-600 !border-red-100"><X size={15}/> Cancel — instant refund</GhostBtn>
            </div>
          </Card>
        );
      })}

      {past.length > 0 && (
        <div className="mt-6">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Past trips · {past.length}</div>
          <Card className="divide-y" style={{ borderColor: "var(--tap-line)" }}>
            {past.map((b) => {
              const f = b.flight || {};
              return (
                <div key={b.id} className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderColor: "var(--tap-line)" }}>
                  <div className="min-w-0">
                    <div className="font-bold text-sm" style={{ color: "var(--tap-ink)" }}>{cityName(f.origin)} → {cityName(f.dest)} <span className="text-gray-400 font-semibold">· {b.flight_no}</span></div>
                    <div className="text-xs text-gray-500">{b.flight_date} · {f.dep}–{f.arr} · seat {b.seat} · {b.pnr}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-gray-400">Flown</span>
                    <GhostBtn onClick={()=>go("search")} className="!py-1.5 !px-3 text-xs">Book again</GhostBtn>
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      )}

      {bookings && bookings.some(b => b.status === "cancelled") && (
        <div className="text-xs text-gray-400 mb-4 mt-4">+ {bookings.filter(b => b.status === "cancelled").length} cancelled booking(s) in your history (visible in Demo Console).</div>
      )}

      <Card className="p-4 mb-5 flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{background:"var(--tap-mist)"}}><BadgeCheck size={18} style={{color:"var(--tap-green)"}}/></div>
        <div className="flex-1">
          <div className="text-sm font-bold flex items-center gap-1.5" style={{color:"var(--tap-ink)"}}>Auto check-in <Why text="On because your preference record has auto check-in enabled — set from your past behaviour of always checking in early. Stored in the preferences table."/></div>
          <div className="text-xs text-gray-500">We check you in 24h before every flight and push the boarding pass here. Setting stored in your preference record.</div>
        </div>
        <button onClick={toggleCI} role="switch" aria-checked={autoCI}
          className="w-11 h-6 rounded-full relative transition-colors shrink-0" style={{background: autoCI ? "var(--tap-green)" : "#D6DEDA"}}>
          <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${autoCI?"left-[22px]":"left-0.5"}`}/>
        </button>
      </Card>

      <Card className="p-4 flex flex-wrap items-center gap-3" style={{background:"#FBFDFC"}}>
        <div className="text-xs text-gray-500 flex-1 min-w-[200px]"><b>Demo control:</b> trigger a live disruption — the ops event hits the DB, Xperion AI writes the recovery, and the notification email goes out in real time.</div>
        <button onClick={simulateDisruption} disabled={loadingRec}
          className="px-4 py-2.5 rounded-xl text-sm font-bold text-white flex items-center gap-2 disabled:opacity-50" style={{background:"var(--tap-red)"}}>
          <AlertTriangle size={15}/> Simulate flight delay
        </button>
        <GhostBtn onClick={openAssistant}><MessageCircle size={15}/> Ask Xperion AI</GhostBtn>
      </Card>

      {showPass && passBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{background:"rgba(6,30,22,.6)"}} onClick={()=>setShowPass(false)}>
          <div className="w-full max-w-sm slide-up" onClick={(e)=>e.stopPropagation()}>
            <div className="rounded-t-2xl p-5 text-white" style={{background:"var(--tap-deep)"}}>
              <div className="flex items-center justify-between mb-4"><TapLogo light size="text-base"/><button onClick={()=>setShowPass(false)} aria-label="Close"><X size={18}/></button></div>
              <div className="flex items-center justify-between">
                <div><div className="text-3xl font-display font-black">{passBooking.flight?.origin || "OPO"}</div><div className="text-xs text-white/60">{cityName(passBooking.flight?.origin || "OPO")}</div></div>
                <Plane size={20} className="text-white/60"/>
                <div className="text-right"><div className="text-3xl font-display font-black">{passBooking.flight?.dest || "LIS"}</div><div className="text-xs text-white/60">{cityName(passBooking.flight?.dest || "LIS")}</div></div>
              </div>
            </div>
            <div className="bg-white rounded-b-2xl p-5 ticket-edge">
              <div className="grid grid-cols-4 gap-2 text-center text-xs mb-4">
                {[["Flight", passBooking.flight_no],["Seat",passBooking.seat || (profile?.prefs?.seat||"").split(" ")[0] || "—"],["Group",`${profile?.user?.tier==="Silver"?"B":"A"} · ${profile?.user?.tier||"Gold"}`],["Gate","12"]].map(([k,v])=>(
                  <div key={k}><div className="text-gray-400">{k}</div><div className="font-bold" style={{color:"var(--tap-ink)"}}>{v}</div></div>
                ))}
              </div>
              <div className="flex justify-center mb-3"><FakeQR seed={42}/></div>
              <div className="text-center text-[11px] text-gray-400">Checked in automatically · {profile.user.full_name}<br/>Updates live if anything changes — this pass is always current.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── DEMO CONSOLE — live DB inspector + email center ── */
// Toggle the profile data source (SQLite ⇄ Adobe Real-Time CDP) and show the
// CDP proof (identity graph, real-time audiences, consent, XDM) when CDP is on.
function DataSourceSwitch({ onChanged }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showXdm, setShowXdm] = useState(false);
  const load = async () => { try { setD(await api.get("/datasource")); } catch {} };
  useEffect(() => { load(); }, []);
  const pick = async (id) => {
    if (busy || !d || d.source === id) return;
    setBusy(true);
    try { await api.post("/datasource", { source: id }); await load(); onChanged && onChanged(); } finally { setBusy(false); }
  };
  if (!d) return null;
  const adobe = d.source === "adobe";
  const prov = d.provenance;
  const SrcBtn = ({ id, label, sub, icon }) => {
    const on = d.source === id;
    return (
      <button onClick={() => pick(id)} disabled={busy} className="flex-1 text-left rounded-2xl border-2 p-3 transition disabled:opacity-60"
        style={{ borderColor: on ? (id === "adobe" ? "#FA0F00" : "var(--tap-green)") : "var(--tap-line)", background: on ? (id === "adobe" ? "#FFF1F0" : "#E2F4EA") : "#fff" }}>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: on ? (id === "adobe" ? "#FA0F00" : "var(--tap-green)") : "var(--tap-mist)", color: on ? "#fff" : "var(--tap-ink)" }}>{icon}</div>
          <div className="min-w-0">
            <div className="font-bold text-sm truncate" style={{ color: "var(--tap-ink)" }}>{label}</div>
            <div className="text-[10px] text-gray-500 truncate">{sub}</div>
          </div>
          {on && <CheckCircle2 size={16} className="ml-auto shrink-0" style={{ color: id === "adobe" ? "#FA0F00" : "var(--tap-green)" }}/>}
        </div>
      </button>
    );
  };
  return (
    <Card className="p-4 mb-5" style={{ borderColor: adobe ? "#FA0F00" : "var(--tap-green)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="font-display font-extrabold text-sm flex items-center gap-2" style={{ color: "var(--tap-ink)" }}>
          <Layers size={16} style={{ color: adobe ? "#FA0F00" : "var(--tap-green)" }}/> Personalization data source
        </div>
        <Chip tone={adobe ? "red" : "green"}>{adobe ? "Adobe Real-Time CDP" : "SQLite (local)"}{adobe && prov ? ` · ${prov.mode === "live" ? "LIVE tenant" : "simulated"}` : ""}</Chip>
      </div>
      <div className="text-[11px] text-gray-500 mb-3">One switch re-points <b>every</b> channel — web portal, web AI chat and WhatsApp all personalize from the selected source. Bookings &amp; transactions always stay in SQLite.</div>
      <div className="flex gap-2">
        <SrcBtn id="sqlite" label="SQLite (local)" sub="Bundled customer record" icon={<Database size={15}/>}/>
        <SrcBtn id="adobe" label="Adobe Real-Time CDP" sub="Experience Platform profile" icon={<Cloud size={15}/>}/>
      </div>
      {busy && <div className="text-[11px] text-gray-400 mt-2 flex items-center gap-1"><Loader2 size={12} className="animate-spin"/> Re-hydrating profile from {d.source === "adobe" ? "SQLite" : "Adobe RT-CDP"}…</div>}

      {adobe && prov && (
        <div className="mt-3 rounded-xl border p-3" style={{ borderColor: "#F3C9C5", background: "#FFF7F6" }}>
          {prov.mode !== "live" && <div className="text-[10px] text-gray-500 mb-2">No IMS credentials detected — running a <b>simulated</b> RT-CDP profile (the same unified profile, identity graph, audiences &amp; consent a live tenant returns). Set the <span className="font-mono">ADOBE_*</span> env vars to connect a real sandbox.</div>}
          <div className="text-[10px] text-gray-500 mb-2">Sandbox <b>{prov.sandbox}</b> · IMS Org <span className="font-mono">{prov.imsOrg}</span> · unified from {prov.unifiedFrom.length} sources</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Identity graph (stitched)</div>
              {Object.entries(prov.identityMap).filter(([k]) => k !== "primary").map(([k, v]) => (
                <div key={k} className="flex justify-between text-[11px] py-0.5 gap-2"><span className="text-gray-500">{k}</span><span className="font-mono truncate" style={{ color: "var(--tap-ink)", maxWidth: 170 }}>{String(v)}</span></div>
              ))}
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mt-2 mb-1 flex items-center gap-1"><ShieldCheck size={11}/> Consent &amp; governance</div>
              <div className="text-[11px]" style={{ color: "var(--tap-ink)" }}>Collect ✓ · Marketing ✓ · Personalize ✓ · Share ✓</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Real-time audiences ({prov.audiences.length})</div>
              <div className="flex flex-wrap gap-1">
                {prov.audiences.map(a => <span key={a.id} title={a.source} className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "#FDE5E3", color: "#B11209" }}>{a.name}</span>)}
              </div>
              <div className="text-[9px] text-gray-400 mt-1.5">These segments trigger the packages, offers &amp; nudges across all channels.</div>
            </div>
          </div>
          <button onClick={() => setShowXdm(v => !v)} className="text-[11px] font-semibold mt-3" style={{ color: "#B11209" }}>{showXdm ? "▾ Hide" : "▸ Show"} XDM individual profile (Profile API)</button>
          {showXdm && <pre className="mt-2 text-[10px] rounded-lg p-3 overflow-auto max-h-72" style={{ background: "#1b1b1b", color: "#e6e6e6" }}>{JSON.stringify(prov.xdm, null, 2)}</pre>}
        </div>
      )}
    </Card>
  );
}

/* ── DEMO CONSOLE — live DB inspector + email center ── */
function CdpProof() {
  const [d, setD] = useState(null);
  const [ev, setEv] = useState(null);
  const [flash, setFlash] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const refresh = async () => {
    const r = await api.get("/admin/cdp");
    setD(prev => {
      if (prev && r.totalRows !== prev.totalRows) { setFlash(true); setTimeout(() => setFlash(false), 900); }
      return r;
    });
    try { const e = await api.get("/admin/cdp/events"); setEv(e); } catch { /* events endpoint optional */ }
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, []);

  const copyPayload = async (e) => {
    const text = JSON.stringify(e.cdpPayload, null, 2);
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be blocked */ }
    setCopiedId(e.id); setTimeout(() => setCopiedId(null), 1500);
  };

  if (!d) return <Card className="p-4 mb-5 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="animate-spin" size={16}/> Reading database…</Card>;

  const eventTone = (t) => t.includes("cancel") ? "red" : t.includes("search") ? "amber" : t.includes("pay") || t.includes("book") || t.includes("checkin") ? "green" : "ink";
  const prettyEvent = (t) => t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  return (
    <>
    <DataSourceSwitch onChanged={refresh}/>
    <Card className="p-4 mb-5" style={{ borderColor: "var(--tap-green)" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#E2F4EA" }}><Database size={18} style={{ color: "var(--tap-green)" }}/></div>
          <div>
            <div className="font-display font-extrabold text-sm" style={{ color: "var(--tap-ink)" }}>Live database &amp; CDP bridge</div>
            <div className="text-[11px] text-gray-500 font-mono truncate">{d.db.engine} · {d.db.path}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="green"><span className={flash ? "pulse-dot" : ""}>●</span> {d.totalRows.toLocaleString()} rows · writing live</Chip>
          {ev && ev.configured && <Chip tone="ink"><Zap size={12}/> {ev.sent.toLocaleString()} events → Adobe CDP{ev.failed ? ` · ${ev.failed} failed` : ""}</Chip>}
        </div>
      </div>

      {/* live row counts */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 mb-4">
        {["events","searches","bookings","payments","wa_messages","travel_history"].map(t => (
          <div key={t} className="rounded-xl p-2 text-center" style={{ background: "var(--tap-mist)" }}>
            <div className="font-display font-black text-lg" style={{ color: "var(--tap-deep)" }}>{(d.counts[t] ?? 0).toLocaleString()}</div>
            <div className="text-[9px] uppercase tracking-wide text-gray-400 truncate">{t.replace("_"," ")}</div>
          </div>
        ))}
      </div>

      {ev && ev.configured && ev.recent && ev.recent.length > 0 && (
        <div className="rounded-xl border p-3 mb-4" style={{ borderColor: "var(--tap-green)", background: "#FBFDFC" }}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-2">Streaming live to Adobe RT-CDP — {ev.sent} sent{ev.failed ? `, ${ev.failed} failed` : ""}{ev.syncValidation ? " · validated" : ""}</div>
          <div className="flex flex-col gap-1">
            {ev.recent.slice(0, 6).map((e, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-[10px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: e.ok ? "#E2F4EA" : "#FDE5E3", color: e.ok ? "var(--tap-deep)" : "#B11209" }}>{e.eventType || e.stage}</span>
                  <span className="text-gray-400 font-mono truncate">{e.loyaltyId}</span>
                </div>
                <span className="text-gray-400 shrink-0">{e.ok ? `✓ ${e.status || "sent"}` : `✗ ${e.error ? e.error.slice(0, 36) : "failed"}`}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* architecture data-flow diagram */}
      <div className="rounded-xl border p-3 mb-4 overflow-x-auto" style={{ borderColor: "var(--tap-line)", background: "#FBFDFC" }}>
        <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-2">Data flow — capture once, activate anywhere</div>
        <div className="flex items-center gap-1.5 min-w-[640px] text-center">
          {[
            { t: "Website", s: "Plan a trip · book · check-in", ic: <Globe size={14}/> },
            { t: "WhatsApp", s: "Twilio · book · check-in", ic: <MessageCircle size={14}/> },
            { t: "Xperion AI", s: "agent tools", ic: <Sparkles size={14}/> },
          ].map((n, i) => (
            <React.Fragment key={n.t}>
              <div className="flex-1 rounded-lg px-2 py-1.5" style={{ background: "var(--tap-mist)" }}>
                <div className="flex items-center justify-center gap-1 font-bold text-[11px]" style={{ color: "var(--tap-ink)" }}>{n.ic}{n.t}</div>
                <div className="text-[8px] text-gray-400">{n.s}</div>
              </div>
              {i < 2 && <span className="text-gray-300 text-xs">/</span>}
            </React.Fragment>
          ))}
          <ArrowRight size={16} className="shrink-0" style={{ color: "var(--tap-green)" }}/>
          <div className="flex-1 rounded-lg px-2 py-1.5 text-white" style={{ background: "var(--tap-deep)" }}>
            <div className="flex items-center justify-center gap-1 font-bold text-[11px]"><Database size={13}/> Express API</div>
            <div className="text-[8px] text-white/60">one write path</div>
          </div>
          <ArrowRight size={16} className="shrink-0" style={{ color: "var(--tap-green)" }}/>
          <div className="flex-1 rounded-lg px-2 py-1.5 text-white" style={{ background: "var(--tap-green)" }}>
            <div className="flex items-center justify-center gap-1 font-bold text-[11px]"><Database size={13}/> Customer DB</div>
            <div className="text-[8px] text-white/70">SQLite → your warehouse</div>
          </div>
          <ArrowRight size={16} className="shrink-0" style={{ color: "var(--tap-green)" }}/>
          <div className="flex-1 rounded-lg px-2 py-1.5 border-2 border-dashed" style={{ borderColor: "var(--tap-green)" }}>
            <div className="flex items-center justify-center gap-1 font-bold text-[11px]" style={{ color: "var(--tap-deep)" }}><Zap size={13}/> CDP</div>
            <div className="text-[8px] text-gray-400">audiences · journeys</div>
          </div>
        </div>
        <div className="text-[9px] text-gray-400 mt-2">Every channel writes through one API to one customer record. The same event schema streams into your CDP — Segment, Adobe, Salesforce — via a connector, no re-instrumentation.</div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* event stream */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Event stream → CDP ingest <span className="text-gray-300 normal-case font-normal">· tap an event to copy its CDP payload</span></div>
          <div className="space-y-1 max-h-[260px] overflow-auto pr-1">
            {d.events.length === 0 && <div className="text-xs text-gray-400">No events yet — click around the site.</div>}
            {d.events.map(e => (
              <button key={e.id} onClick={() => copyPayload(e)} className="w-full flex items-start gap-2 py-1 border-b text-left hover:bg-gray-50 rounded transition-colors" style={{ borderColor: "var(--tap-line)" }}>
                <Chip tone={eventTone(e.type)} className="shrink-0 mt-0.5">{prettyEvent(e.type)}</Chip>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-gray-400 font-mono truncate">{JSON.stringify(e.payload)}</div>
                </div>
                {copiedId === e.id
                  ? <span className="text-[9px] font-bold shrink-0 flex items-center gap-0.5" style={{ color: "var(--tap-green)" }}><CheckCircle2 size={11}/> copied</span>
                  : <span className="text-[9px] text-gray-300 shrink-0 font-mono">{(e.at || "").slice(11, 19)}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* CDP mapping */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Maps to your CDP (Segment · Adobe · Salesforce)</div>
          <div className="space-y-1.5">
            {d.cdpMapping.map(m => (
              <div key={m.cdp} className="rounded-xl p-2.5 border" style={{ borderColor: "var(--tap-line)" }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-xs" style={{ color: "var(--tap-ink)" }}>{m.cdp}</div>
                  <div className="text-[9px] font-mono text-gray-400 truncate">{m.source}</div>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">{m.example}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="text-[10px] text-gray-400 mt-3">Every action on the site, WhatsApp and AI chat commits a real row here. The same event schema streams 1:1 into a production CDP for identity resolution, audiences and journeys — no re-instrumentation.</div>
    </Card>
    </>
  );
}

function SelfTest() {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(true);

  const run = async () => {
    setRunning(true);
    const r = await api.get("/admin/selftest");
    setResult(r); setRunning(false);
  };
  useEffect(() => { run(); }, []);

  const groups = result ? [...new Set(result.checks.map(c => c.group))] : [];
  const allGreen = result && result.ok;

  return (
    <Card className="p-4 mb-5" style={allGreen ? { borderColor: "var(--tap-green)" } : (result ? { borderColor: "var(--tap-red)" } : {})}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2.5 text-left">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: result ? (allGreen ? "#E2F4EA" : "#FBE4E7") : "var(--tap-mist)" }}>
            {running ? <Loader2 className="animate-spin" size={18} style={{ color: "var(--tap-green)" }}/>
              : result ? (allGreen ? <CheckCircle2 size={18} style={{ color: "var(--tap-green)" }}/> : <AlertTriangle size={18} style={{ color: "var(--tap-red)" }}/>)
              : <ShieldCheck size={18} style={{ color: "var(--tap-deep)" }}/>}
          </div>
          <div>
            <div className="font-display font-extrabold text-sm flex items-center gap-2" style={{ color: "var(--tap-ink)" }}>
              System self-test
              {result && <Chip tone={allGreen ? "green" : "red"}>{result.passed}/{result.total} passing</Chip>}
              {result?.advisory > 0 && <Chip tone="amber">{result.advisory} advisory</Chip>}
            </div>
            <div className="text-[11px] text-gray-500">{result ? `Live checks across data, search, personalization & integrations · ${open ? "tap to collapse" : "tap to expand"}` : "Running checks…"}</div>
          </div>
        </button>
        <GhostBtn onClick={run} className="shrink-0"><RefreshCw size={14}/> Re-run</GhostBtn>
      </div>

      {open && result && (
        <div className="mt-4 grid sm:grid-cols-2 gap-x-6 gap-y-1">
          {groups.map(g => (
            <div key={g} className="py-1">
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1 mt-1">{g}</div>
              {result.checks.filter(c => c.group === g).map(c => (
                <div key={c.name} className="flex items-start gap-2 py-0.5">
                  <span className="mt-0.5 shrink-0">
                    {c.ok ? <CheckCircle2 size={13} style={{ color: "var(--tap-green)" }}/>
                          : <AlertTriangle size={13} style={{ color: c.name.includes("AI") ? "var(--tap-amber)" : "var(--tap-red)" }}/>}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold" style={{ color: "var(--tap-ink)" }}>{c.name}</div>
                    {c.detail && <div className="text-[10px] text-gray-400 font-mono truncate">{c.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AffinityPanel() {
  const [rec, setRec] = useState(null);
  useEffect(() => { (async () => { try { setRec(await api.get("/recommendation")); } catch {} })(); const t = setInterval(async () => { try { setRec(await api.get("/recommendation")); } catch {} }, 4000); return () => clearInterval(t); }, []);
  if (!rec) return null;
  const maxShare = Math.max(...(rec.categories || []).map(c => c.share), 1);
  return (
    <div className="rounded-2xl border p-5 mb-5" style={{ borderColor: "var(--tap-line)", background: "var(--tap-mist)" }}>
      <div className="flex items-center gap-2 mb-1">
        <CreditCard size={16} style={{ color: "var(--tap-green)" }}/>
        <h3 className="font-display font-extrabold text-lg" style={{ color: "var(--tap-ink)" }}>Card-spend → affinity → offer</h3>
      </div>
      <p className="text-xs text-gray-500 mb-4">How VOYAGER.AI turns co-branded card data into an experiential package. This is the derivation behind the “Made for you” block on the home page.</p>
      <div className="grid md:grid-cols-3 gap-4 items-stretch">
        {/* 1 — card + spend categories */}
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--tap-line)", background: "var(--dxp-surface)" }}>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">1 · Card spend (CDP traits)</div>
          <div className="text-sm font-bold mb-3" style={{ color: "var(--tap-ink)" }}>Xperion Miles co-branded card <span className="text-gray-400 font-semibold">•••• ••••</span></div>
          <div className="space-y-2">
            {(rec.categories || []).map((c, i) => (
              <div key={i}>
                <div className="flex justify-between text-[11px] mb-0.5"><span className="font-semibold" style={{ color: "var(--tap-ink)" }}>{c.name}</span><span className="text-gray-400">{c.share}%</span></div>
                <div className="h-1.5 rounded-full" style={{ background: "var(--dxp-surface-2)" }}><div className="h-full rounded-full" style={{ width: `${(c.share / maxShare) * 100}%`, background: i === 0 ? "var(--dxp-lime)" : "#5E7A68" }}/></div>
              </div>
            ))}
          </div>
        </div>
        {/* 2 — derived affinity */}
        <div className="rounded-xl border p-4 flex flex-col justify-center items-center text-center" style={{ borderColor: "rgba(163,230,53,.35)", background: "#101A12" }}>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">2 · Derived affinity</div>
          <div className="text-2xl mb-1">{rec.affinity === "football" ? "⚽" : rec.affinity === "golf" ? "⛳" : "🎵"}</div>
          <div className="font-display font-black text-xl" style={{ color: "var(--dxp-lime)" }}>{rec.affinity_label}</div>
          <div className="text-[11px] text-gray-500 mt-2 leading-snug">{rec.rationale}</div>
        </div>
        {/* 3 — resulting offer */}
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--tap-line)", background: "var(--dxp-surface)" }}>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">3 · Assembled offer</div>
          <div className="text-sm font-bold mb-1" style={{ color: "var(--tap-ink)" }}>{rec.package?.event}</div>
          <div className="text-[11px] text-gray-500 mb-3">{rec.package?.city} · {rec.package?.badge}</div>
          <div className="space-y-1 text-[11px]" style={{ color: "#C2CABF" }}>
            <div className="flex justify-between"><span>Event ticket</span><span>{EUR(rec.package?.eventPrice || 0)}</span></div>
            <div className="flex justify-between"><span>Hotel · {rec.package?.hotelNights}n</span><span>{EUR(rec.package?.hotelPrice || 0)}</span></div>
            <div className="flex justify-between"><span>Return flight</span><span>{EUR(rec.package?.flightPrice || 0)}</span></div>
            {rec.package?.addon && <div className="flex justify-between" style={{ color: "var(--dxp-lime)" }}><span>+ {rec.package.addon.label}</span><span>{EUR(rec.package.addon.price)}</span></div>}
            <div className="flex justify-between font-bold pt-1.5 mt-1.5 border-t" style={{ color: "var(--tap-ink)", borderColor: "var(--tap-line)" }}><span>Bundle total</span><span>{EUR(rec.package?.total || 0)}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
function Console({ toast }) {
  const [data, setData] = useState(null);
  const [emails, setEmails] = useState([]);
  const [openEmail, setOpenEmail] = useState(null);
  const [tab, setTab] = useState("users");

  const refresh = async () => {
    const [d, e] = await Promise.all([api.get("/admin/db"), api.get("/admin/emails")]);
    setData(d); setEmails(e);
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);

  const viewEmail = async (id) => setOpenEmail(await api.get(`/admin/emails/${id}`));
  const reset = async () => { await api.post("/admin/reset"); await refresh(); toast("Demo reset", "Bookings, payments, emails and events cleared; balances restored."); };

  if (!data) return <div className="max-w-6xl mx-auto px-4 pt-12 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="animate-spin" size={16}/> Loading database…</div>;
  const tables = Object.keys(data.tables);
  const rows = data.tables[tab] || [];
  const cols = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="max-w-6xl mx-auto px-4 pb-24 pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="font-display font-black text-3xl flex items-center gap-3" style={{color:"var(--tap-ink)"}}><Database size={26} style={{color:"var(--tap-green)"}}/> Demo Console</h1>
        <div className="flex gap-2">
          <GhostBtn onClick={refresh}><RefreshCw size={14}/> Refresh</GhostBtn>
          <GhostBtn onClick={reset}><RotateCcw size={14}/> Reset demo</GhostBtn>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-1">Live view of the SQLite customer database the site runs on — every click on the site writes here. Auto-refreshes every 4s.</p>
      <p className="text-[11px] text-gray-400 mb-6 font-mono">{data.dbPath} · CDP-ready: this store maps 1:1 to customer-profile, behaviour and consent objects for later CDP sync.</p>

      <SelfTest/>
      <CdpProof/>
      <AffinityPanel/>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tables.map(t => (
              <button key={t} onClick={()=>setTab(t)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${t===tab?"text-white":"text-gray-500 bg-white border hover:bg-gray-50"}`}
                style={t===tab?{background:"var(--tap-deep)"}:{borderColor:"var(--tap-line)"}}>
                {t} <span className="opacity-60">({data.tables[t].length})</span>
              </button>
            ))}
          </div>
          <Card className="overflow-auto max-h-[480px]">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-white">
                <tr>{cols.map(c => <th key={c} className="text-left px-3 py-2 font-bold text-gray-500 border-b whitespace-nowrap" style={{borderColor:"var(--tap-line)"}}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r,i)=>(
                  <tr key={i} className={i%2?"bg-gray-50/60":""}>
                    {cols.map(c => <td key={c} className="px-3 py-1.5 whitespace-nowrap max-w-[260px] truncate font-mono" style={{color:"var(--tap-ink)"}}>{String(r[c] ?? "")}</td>)}
                  </tr>
                ))}
                {rows.length===0 && <tr><td className="px-3 py-6 text-gray-400 text-xs">No rows yet — interact with the site and refresh.</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>

        <div>
          <div className="font-display font-extrabold mb-3 flex items-center gap-2" style={{color:"var(--tap-ink)"}}><Mail size={17} style={{color:"var(--tap-green)"}}/> Email center</div>
          <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
            {emails.length===0 && <Card className="p-4 text-xs text-gray-400">No emails yet — book a flight, place a hold, send an offer, or simulate a disruption.</Card>}
            {emails.map(e => (
              <Card key={e.id} className="p-3">
                <div className="text-xs font-bold truncate" style={{color:"var(--tap-ink)"}}>{e.subject}</div>
                <div className="text-[11px] text-gray-500 truncate">to {e.to_addr} · {e.created_at}</div>
                <div className="flex items-center justify-between mt-1.5">
                  <Chip tone={e.status.startsWith("delivered") ? "green" : "amber"}>{e.status}</Chip>
                  <button onClick={()=>viewEmail(e.id)} className="text-[11px] font-bold flex items-center gap-1" style={{color:"var(--tap-green)"}}><Eye size={12}/> Preview</button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>

      {openEmail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{background:"rgba(6,30,22,.6)"}} onClick={()=>setOpenEmail(null)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col slide-up" onClick={(e)=>e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between" style={{borderColor:"var(--tap-line)"}}>
              <div className="min-w-0">
                <div className="text-sm font-bold truncate" style={{color:"var(--tap-ink)"}}>{openEmail.subject}</div>
                <div className="text-[11px] text-gray-500">to {openEmail.to_addr} · {openEmail.status}</div>
              </div>
              <button onClick={()=>setOpenEmail(null)} aria-label="Close"><X size={18} className="text-gray-400"/></button>
            </div>
            <iframe title="email preview" srcDoc={openEmail.html} className="flex-1 w-full min-h-[420px]" sandbox=""/>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── ASSISTANT — Xperion AI concierge via backend ── */
/* ── Inline cards rendered inside the chat by the agent ── */
function ChatCards({ cards, onSelectFlight, cardBrand = "card" }) {
  if (!cards || !cards.length) return null;
  return (
    <div className="space-y-2">
      {cards.map((c, i) => {
        if (c.type === "flights") return (
          <div key={i} className="bg-white border rounded-2xl p-3 space-y-2" style={{borderColor:"var(--tap-line)"}}>
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{c.city} · {c.date}</div>
            {c.flights.map(f => (
              <div key={f.flight_no} className="flex items-center justify-between gap-2 py-1.5 border-b last:border-0" style={{borderColor:"var(--tap-line)"}}>
                <div className="min-w-0">
                  <div className="font-bold text-sm flex items-center gap-1.5" style={{color:"var(--tap-ink)"}}>
                    {f.flight_no} {f.recommended && <span className="text-[9px] px-1.5 py-0.5 rounded-full text-white" style={{background:"var(--tap-green)"}}>For you</span>}
                    {f.status==="delayed" && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">delayed</span>}
                  </div>
                  <div className="text-xs text-gray-500">{f.dep}–{f.arr}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>{EUR(f.price)}</span>
                  <button onClick={()=>onSelectFlight(f.flight_no)} className="text-xs font-bold px-3 py-1.5 rounded-lg text-white" style={{background:"var(--tap-green)"}}>Select</button>
                </div>
              </div>
            ))}
          </div>
        );
        if (c.type === "selected") return (
          <div key={i} className="bg-white border rounded-2xl p-3" style={{borderColor:"var(--tap-line)"}}>
            <div className="text-[11px] font-bold uppercase tracking-wide" style={{color:"var(--tap-green)"}}>In your basket</div>
            <div className="font-bold text-sm mt-0.5" style={{color:"var(--tap-ink)"}}>{c.flight_no} · {c.route}</div>
            <div className="text-xs text-gray-500">{c.dep}–{c.arr} · seat {c.seat} · {EUR(c.price)}</div>
          </div>
        );
        if (c.type === "confirmation") return (
          <div key={i} className="rounded-2xl p-3 text-white" style={{background:"var(--tap-deep)"}}>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-white/70"><BadgeCheck size={13}/> Booked</div>
            <div className="font-extrabold text-base mt-0.5">{c.pnr}</div>
            <div className="text-xs text-white/80 mt-1">{c.route} · {c.dep} · {EUR(c.total)}</div>
            <div className="text-[11px] text-white/60 mt-1">Voucher −{EUR(c.split.voucher)} · {c.split.miles.toLocaleString()} miles −{EUR(c.split.miles_eur)} · {cardBrand} {EUR(c.split.card)}</div>
          </div>
        );
        if (c.type === "suggestions") return (
          <div key={i} className="bg-white border rounded-2xl p-3" style={{borderColor:"var(--tap-line)"}}>
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Picked from your history</div>
            <div className="flex flex-wrap gap-1.5">{c.suggestions.map(s => <span key={s.code} className="text-xs px-2 py-1 rounded-full border" style={{borderColor:"var(--tap-line)",color:"var(--tap-ink)"}}>{s.city} {s.flown?`· flown ${s.flown}×`:s.searched?`· searched ${s.searched}×`:""}</span>)}</div>
          </div>
        );
        if (c.type === "destinations") return (
          <div key={i} className="bg-white border rounded-2xl p-3" style={{borderColor:"var(--tap-line)"}}>
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">From {c.originCity || c.origin} · {c.count} destinations</div>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">{c.destinations.map(d => <span key={d.code} className="text-xs px-2 py-1 rounded-full border" style={{borderColor: d.flown ? "var(--tap-green)" : "var(--tap-line)", color:"var(--tap-ink)"}}>{d.city}{d.flown?` · flown ${d.flown}×`:""}</span>)}</div>
          </div>
        );
        if (c.type === "package") return (
          <div key={i} className="rounded-2xl border overflow-hidden" style={{borderColor:"var(--dxp-line)", background:"var(--dxp-surface)"}}>
            <div className="p-3" style={{background:"#101A12"}}>
              <div className="text-[10px] font-bold uppercase tracking-wide" style={{color:"var(--dxp-lime)"}}>{c.affinity==="football"?"⚽":c.affinity==="golf"?"⛳":"🎵"} {c.affinity_label} · {c.badge}</div>
              <div className="font-display font-black text-base mt-0.5" style={{color:"var(--dxp-text)"}}>{c.event}</div>
              <div className="text-[11px]" style={{color:"var(--dxp-muted)"}}>{c.venue}</div>
            </div>
            <div className="p-3 space-y-1 text-xs" style={{color:"#C2CABF"}}>
              <div className="flex justify-between"><span>🎟️ Event ticket</span><span>{EUR(c.eventPrice)}</span></div>
              <div className="flex justify-between"><span>🏨 {c.hotel} · {c.hotelNights}n</span><span>{EUR(c.hotelPrice)}</span></div>
              <div className="flex justify-between"><span>✈️ {c.flight}</span><span>{EUR(c.flightPrice)}</span></div>
              {c.addon && <div className="flex justify-between" style={{color:"var(--dxp-lime)"}}><span>🧳 {c.addon.label}</span><span>{EUR(c.addon.price)}</span></div>}
              <div className="flex justify-between font-bold pt-1.5 mt-1 border-t" style={{color:"var(--dxp-text)",borderColor:"var(--dxp-line)"}}><span>Bundle total</span><span>{EUR(c.total)}</span></div>
            </div>
          </div>
        );
        if (c.type === "seat") return (
          <div key={i} className="bg-white border rounded-2xl p-3 flex items-center gap-3" style={{borderColor:"var(--tap-green)"}}>
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-display font-black" style={{background:"var(--tap-green)"}}>{c.seat}</div>
            <div className="min-w-0">
              <div className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>Seat changed to {c.seat}</div>
              <div className="text-xs text-gray-500">{c.cabin}{c.included?" · included":` · ${EUR(c.price)}`}{c.from?` · was ${c.from}`:""}</div>
            </div>
          </div>
        );
        if (c.type === "booking") return (
          <div key={i} className="bg-white border rounded-2xl p-3" style={{borderColor:"var(--tap-line)"}}>
            <div className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>{c.pnr} · {c.route}</div>
            <div className="text-xs text-gray-500">{c.dep} · seat {c.seat} · {c.status==="delayed"?"⚠️ delayed":"on time"} · {c.checked_in?"checked in":"auto check-in"}</div>
          </div>
        );
        if (c.type === "checkin") return (
          <div key={i} className="rounded-2xl p-3 text-white" style={{background:"var(--tap-green)"}}>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-white/80"><QrCode size={13}/> Checked in</div>
            <div className="font-extrabold text-base mt-0.5">{c.pnr}</div>
            <div className="text-xs text-white/85 mt-0.5">Boarding group {c.group} · seat {c.seat} · pass issued in the app</div>
          </div>
        );
        if (c.type === "cancelled") return (
          <div key={i} className="bg-white border rounded-2xl p-3" style={{borderColor:"#fecaca"}}>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-red-600"><X size={13}/> Cancelled · instant refund</div>
            <div className="font-bold text-sm mt-0.5" style={{color:"var(--tap-ink)"}}>{c.pnr}</div>
            <div className="text-xs text-gray-500 mt-0.5">Refunded: {c.refund.miles?.toLocaleString?.()||c.refund.miles} miles · voucher reactivated · {EUR(c.refund.card||0)} to {cardBrand}</div>
          </div>
        );
        if (c.type === "wallet") return (
          <div key={i} className="bg-white border rounded-2xl p-3" style={{borderColor:"var(--tap-line)"}}>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide" style={{color:"var(--tap-green)"}}><Wallet size={13}/> Your wallet</div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div className="rounded-xl p-2" style={{background:"var(--tap-mist)"}}>
                <div className="text-[10px] text-gray-400">Xperion Miles</div>
                <div className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>{c.miles?.toLocaleString()} <span className="text-[10px] text-gray-400">≈ {EUR(c.miles_value_eur)}</span></div>
              </div>
              <div className="rounded-xl p-2" style={{background:"var(--tap-mist)"}}>
                <div className="text-[10px] text-gray-400">Voucher</div>
                <div className="font-bold text-sm" style={{color:"var(--tap-ink)"}}>{c.voucher?.available ? `${EUR(c.voucher.amount)} ✓` : (c.voucher ? "used" : "—")}</div>
              </div>
            </div>
            <div className="text-[10px] text-gray-400 mt-1.5">Pay any trip with voucher + miles + {c.card}.</div>
          </div>
        );
        return null;
      })}
    </div>
  );
}

function Assistant({ open, onClose, screen, profile, onCommand, onSelectFlight }) {
  const firstName = profile?.user?.first_name || "there";
  const d1 = cityName(profile?.pattern?.dest || profile?.user?.home_airport || "LIS");
  const d2 = cityName((profile?.pattern?.searchedDests && profile.pattern.searchedDests[0]?.code) || profile?.user?.home_airport || "OPO");
  const pat = profile?.pattern || {};
  const usualRoute = `${cityName(pat.origin || profile?.user?.home_airport || "OPO")} → ${cityName(pat.dest || "LIS")}`;
  const recLabel = pat.recommendedLabel || "";
  const tier = profile?.user?.tier || "";
  // The in-progress search is read LIVE from the server each time the chat opens, so the
  // greeting + "Resume your search" always reflect the latest route — never a stale
  // mount-time snapshot (it must not keep showing OPO→LIS after another route was searched).
  const normJourney = (j) => (j && j.dest) ? { origin: j.origin, dest: j.dest, travel_date: j.date || j.travel_date, stage: j.stage, flight_no: j.flight_no, seat: j.seat, items: j.items, cabin: j.cabin } : null;
  const [journey, setJourney] = useState(null);
  const ss = journey || profile?.syncedSearch;
  const inProgress = !!(ss && ss.dest);
  const resumeRoute = inProgress ? `${cityName(ss.origin)} → ${cityName(ss.dest)}` : "";
  const buildGreeting = (s) => {
    const ip = !!(s && s.dest);
    const rr = ip ? `${cityName(s.origin)} → ${cityName(s.dest)}` : "";
    return `Hi ${firstName} ✈️ Tell me where you want to go and when — I'll plan the rest.`
      + (ip ? `\n\n↩️ You have a search in progress (${rr}) — tap "Resume your search" below to finish it.` : "")
      + `\n\n⚡ Or book your usual ${usualRoute}${recLabel ? ` for ${recLabel}` : ""} in two taps with Express checkout.`
      + (profile?.source === "adobe" ? `\n\n🔗 Personalizing from your Adobe Real-Time CDP profile.` : "");
  };
  const [msgs, setMsgs] = useState([{ role: "assistant", content: buildGreeting(profile?.syncedSearch) }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, open]);
  // Pull the current in-progress search from the server whenever the chat opens, so the
  // greeting and Resume chip track the latest route (not the seeded/stale one).
  useEffect(() => {
    if (!open) return;
    api.get("/journey").then(j => {
      const live = (j && j.stage && j.dest) ? j : null;
      setJourney(normJourney(live));
      setMsgs(m => (m.length <= 1 ? [{ role: "assistant", content: buildGreeting(normJourney(live) || profile?.syncedSearch) }] : m));
    }).catch(() => {});
  }, [open]);

  const send = async (preset) => {
    const q = (preset || input).trim(); if (!q || busy) return;
    const history = msgs.filter(m => typeof m.content === "string").map(m => ({ role: m.role, content: m.content }));
    const next = [...history.slice(1), { role: "user", content: q }];
    setMsgs(m => [...m, { role: "user", content: q }]); setInput(""); setBusy(true);
    try {
      const r = await api.post("/ai/agent", { messages: next, screen, sessionId: WEB_SESSION_ID });
      setMsgs(m => [...m, { role: "assistant", content: r.reply, cards: r.cards }]);
      if (r.command) onCommand?.(r.command);   // chat drives the main screen
      // A search/select in chat advances the shared journey — re-read it so the
      // Resume chip + greeting never lag behind the latest route within a session.
      if (r.command) api.get("/journey").then(j => setJourney(normJourney((j && j.stage && j.dest) ? j : null))).catch(() => {});
    } catch {
      setMsgs(m => [...m, { role: "assistant", content: "Something went wrong reaching the agent — try again." }]);
    }
    setBusy(false);
  };

  // Direct actions (resume / express) — drive the main screen via onCommand, with a
  // confirming bubble. These don't round-trip the agent, so they work in any mode.
  const act = (kind) => {
    if (busy) return;
    if (kind === "resume") {
      setMsgs(m => [...m, { role: "user", content: "Resume my search" }, { role: "assistant", content: `↩️ Reopening your ${resumeRoute || "search"} where you left off — finish it on screen now.` }]);
      onCommand?.({ action: "resume" });
    } else {
      setMsgs(m => [...m, { role: "user", content: "Express checkout my usual flight" }, { role: "assistant", content: `⚡ Opening Express checkout for your usual ${usualRoute}${recLabel ? ` · recommended ${recLabel}` : ""} — seat, bags, saved card${tier ? ` and ${tier} perks` : ""} are pre-filled. Say "pay" here to confirm, or use the sheet on screen.` }]);
      onCommand?.({ action: "express" });
    }
  };

  if (!open) return null;
  const chips = [`Best time to visit ${d1}`, `Flights under €500 to ${d2}`, `${d2} in October?`];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-0 sm:p-6" onClick={onClose}>
      <div className="w-full h-full sm:w-[390px] sm:h-[600px] sm:max-h-[82vh] bg-white sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden slide-up" onClick={(e) => e.stopPropagation()} style={{ border: "1px solid var(--tap-line)" }}>
        {/* red header */}
        <div className="px-4 py-3.5 flex items-center justify-between" style={{ background: "linear-gradient(120deg,#E2354B 0%,#C01030 100%)" }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,.2)" }}><Sparkles size={18} className="text-white"/></div>
            <div>
              <div className="text-white font-extrabold text-[15px] leading-tight">Xperion AI Assistant</div>
              <div className="text-white/85 text-[11px] flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: "#4ADE80" }}/> Online</div>
            </div>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white" aria-label="Close assistant"><X size={20}/></button>
        </div>
        {/* messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ background: "#FAFBFA" }}>
          {msgs.map((m, i) => (
            <div key={i} className="space-y-2">
              {m.content && <div className={`max-w-[88%] px-4 py-2.5 rounded-2xl text-[15px] leading-relaxed whitespace-pre-wrap ${m.role === "user" ? "ml-auto text-white rounded-br-md" : "rounded-bl-md"}`}
                style={m.role === "user" ? { background: "var(--tap-green)" } : { background: "#EEF1EF", color: "var(--tap-ink)" }}>{m.content}</div>}
              {m.cards && <ChatCards cards={m.cards} cardBrand="saved card" onSelectFlight={(no) => { onSelectFlight?.(no); setMsgs(mm => [...mm, { role: "assistant", content: `Selected ${no} — it's in your basket and on screen now. Say "check out" to pay with your voucher + miles.` }]); }}/>}
            </div>
          ))}
          {busy && <div className="px-4 py-2.5 rounded-2xl rounded-bl-md w-fit" style={{ background: "#EEF1EF" }}><Loader2 className="animate-spin" size={15} style={{ color: "var(--tap-green)" }}/></div>}
          <div ref={endRef}/>
        </div>
        {/* chips + input */}
        <div className="p-3 border-t bg-white" style={{ borderColor: "var(--tap-line)" }}>
          {/* primary actions — resume an in-progress search + express-checkout the usual flight */}
          <div className="flex flex-wrap gap-2 mb-2">
            {inProgress && (
              <button onClick={() => act("resume")} className="text-[12px] font-bold px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 text-white" style={{ background: "var(--tap-green)" }}><RotateCcw size={13}/> Resume your search</button>
            )}
            <button onClick={() => act("express")} className="text-[12px] font-bold px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 text-white" style={{ background: "var(--tap-green)" }}><Zap size={13}/> Express · your usual{recLabel ? ` · ${recLabel}` : ""}</button>
          </div>
          <div className="flex flex-wrap gap-2 mb-2.5">
            {chips.map(s => (
              <button key={s} onClick={() => send(s)} className="text-[12px] font-semibold px-3 py-1.5 rounded-full" style={{ background: "#F1F3F2", color: "var(--tap-deep)" }}>{s}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-full pl-4 pr-1.5 py-1.5" style={{ background: "#F1F3F2" }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Tell me where you want to go and when" className="flex-1 bg-transparent text-[15px] outline-none" style={{ color: "var(--tap-ink)" }}/>
            <button onClick={() => send()} disabled={busy} className="w-9 h-9 rounded-full flex items-center justify-center text-white shrink-0" style={{ background: "var(--tap-green)" }} aria-label="Send"><Send size={16}/></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── AIRPORT AUTOCOMPLETE ── */
function AirportInput({ label, value, onChange, icon }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(async () => {
      const rows = await api.get(`/airports?q=${encodeURIComponent(q)}`);
      setOpts(q.trim() ? rows : (rows || []).slice(0, 8));
    }, 120);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const display = value ? `${cityName(value)} (${value})` : "";
  return (
    <div className="flex-1 min-w-[160px] relative" ref={boxRef}>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1 mb-1">{icon}{label}</label>
      <input
        value={open ? q : display}
        onFocus={() => { setOpen(true); setQ(""); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        placeholder="City or airport"
        className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none font-semibold"
        style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}/>
      {open && opts.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg max-h-64 overflow-auto" style={{ borderColor: "var(--tap-line)" }}>
          {opts.map((a) => (
            <button key={a.code} onMouseDown={() => { onChange(a.code); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between">
              <span><span className="font-semibold text-sm" style={{ color: "var(--tap-ink)" }}>{a.city}</span> <span className="text-xs text-gray-400">{a.country}</span></span>
              <span className="text-xs font-bold text-gray-400">{a.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── SEARCH SCREEN — search any of the 100 network routes ── */
function SearchScreen({ origin, setOrigin, dest, setDest, date, setDate, onSearch, results, searching, selectFlight, routes, suggested, prefilledReason }) {
  const swap = () => { const o = origin; setOrigin(dest); setDest(o); };
  const [showAll, setShowAll] = useState(false);
  const [cabin, setCabin] = useState("Economy");
  const [maxPrice, setMaxPrice] = useState(null);   // null until results arrive
  const CABINS = [{ id: "Economy", mult: 1 }, { id: "Premium", mult: 1.6 }, { id: "Business", mult: 2.4 }];
  const cabinMult = CABINS.find(c => c.id === cabin)?.mult || 1;
  // Apply the cabin multiplier to base fares so the price bar matches the chosen cabin.
  const priced = (results?.flights || []).map(f => ({ ...f, cabinPrice: Math.round(f.price * cabinMult) }));
  const priceFloor = priced.length ? Math.min(...priced.map(f => f.cabinPrice)) : 0;
  const priceCeil = priced.length ? Math.max(...priced.map(f => f.cabinPrice)) : 0;
  // Reset the slider to the max whenever a new search returns or the cabin changes.
  useEffect(() => { if (priced.length) setMaxPrice(priceCeil); }, [results, cabin]);
  const effMax = maxPrice == null ? priceCeil : maxPrice;
  const visibleFlights = priced.filter(f => f.cabinPrice <= effMax);
  const hiddenCount = priced.length - visibleFlights.length;
  // Date options are generated from "today" (rolls forward; never a past date) and always
  // include whatever date is currently selected — so a chat-driven date (e.g. today) shows
  // correctly instead of silently falling back to the first hardcoded option.
  const _WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const _MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const _isoLabel = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${_WD[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${_MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const _addDays = (iso, n) => { const x = new Date(iso + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const _today = (() => { const r = new Date().toISOString().slice(0, 10); return r > "2026-06-15" ? r : "2026-06-15"; })();
  const DATES = Array.from(new Set([_today, _addDays(_today, 1), _addDays(_today, 2), _addDays(_today, 7), _addDays(_today, 14), date].filter(Boolean)))
    .sort()
    .map(v => ({ v, label: _isoLabel(v) }));

  // Personalized first (scored from real history/searches/bookings), then network filler
  const personalized = suggested?.personalized || [];
  const filler = suggested?.filler || (routes || []);
  const list = showAll
    ? [...personalized, ...filler]
    : (personalized.length ? personalized.slice(0, 6) : filler.slice(0, 8));

  return (
    <div className="max-w-4xl mx-auto px-4 pb-24 pt-8">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="font-display font-black text-3xl" style={{ color: "var(--tap-ink)" }}>Search flights</h1>
        <Chip tone="green"><Globe size={11}/> {routes?.length || 100} routes worldwide · {routes?.filter(r => r.region === "Europe").length || 50} in Europe</Chip>
      </div>
      <p className="text-sm text-gray-500 mb-5">Every search is logged to the database and shapes what we recommend you next.</p>

      {prefilledReason && (
        <Card className="p-3 mb-4 flex items-center gap-2 slide-up" style={{ background: "#FBFDFC", borderColor: "var(--tap-green)" }}>
          <Sparkles size={15} style={{ color: "var(--tap-green)" }}/>
          <span className="text-sm" style={{ color: "var(--tap-deep)" }}><b>{cityName(origin)} → {cityName(dest)}</b> is pre-filled for you. Just pick a date and search.</span>
          <Why text={prefilledReason} className="ml-auto"/>
        </Card>
      )}

      <Card className="p-5 mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <AirportInput label="From" value={origin} onChange={setOrigin} icon={<MapPin size={11}/>}/>
          <button onClick={swap} className="mb-1 p-2.5 rounded-xl border hover:bg-gray-50 shrink-0" style={{ borderColor: "var(--tap-line)" }} aria-label="Swap"><ArrowLeftRight size={16} style={{ color: "var(--tap-green)" }}/></button>
          <AirportInput label="To" value={dest} onChange={setDest} icon={<MapPin size={11}/>}/>
          <div className="min-w-[150px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1 mb-1"><Calendar size={11}/>Date</label>
            <select value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border text-sm font-semibold bg-white outline-none cursor-pointer" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}>
              {DATES.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1 mb-1"><Armchair size={11}/>Cabin</label>
            <select value={cabin} onChange={(e) => setCabin(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border text-sm font-semibold bg-white outline-none cursor-pointer" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}>
              {CABINS.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
            </select>
          </div>
          <PrimaryBtn onClick={onSearch} disabled={searching || !origin || !dest} className="!py-2.5 mb-[1px]">
            {searching ? <Loader2 className="animate-spin" size={16}/> : <Search size={16}/>} Search
          </PrimaryBtn>
        </div>
      </Card>

      {searching && <div className="flex items-center gap-3 text-sm text-gray-500"><Loader2 className="animate-spin" size={16} style={{ color: "var(--tap-green)" }}/> Searching the network…</div>}

      {!searching && results && !results.ok && (
        <Card className="p-5 mb-6" style={{ borderColor: "var(--tap-red)", background: "#FFF6F7" }}>
          <div className="text-sm font-semibold" style={{ color: "var(--tap-red)" }}>{results.message}</div>
        </Card>
      )}

      {!searching && results && results.ok && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-extrabold text-lg" style={{ color: "var(--tap-ink)" }}>{cityName(results.origin)} → {cityName(results.dest)}</h2>
            <Chip tone="ink">{visibleFlights.length} of {priced.length} · {cabin} · {fmtDate(results.date, false)}</Chip>
          </div>

          {/* Live price filter — starts at the max fare; drag down to trim pricier flights */}
          {priced.length > 1 && (
            <Card className="p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--tap-ink)" }}>
                  <SlidersHorizontal size={15} style={{ color: "var(--tap-green)" }}/> Max price
                  <Why text="Drag to set your budget. Flights priced above the bar drop out instantly. The range reflects the cabin you picked — Business fares sit higher than Economy."/>
                </div>
                <div className="font-display font-black text-xl" style={{ color: "var(--tap-ink)" }}>{EUR(effMax)}</div>
              </div>
              <input type="range" min={priceFloor} max={priceCeil} value={effMax} step={1}
                onChange={(e) => setMaxPrice(+e.target.value)}
                className="w-full dxp-range" style={{ accentColor: "var(--tap-green)" }}/>
              <div className="flex justify-between text-[11px] mt-1" style={{ color: "#6b7280" }}>
                <span>{EUR(priceFloor)}</span>
                <span>{hiddenCount > 0 ? `${hiddenCount} hidden above ${EUR(effMax)}` : "All flights shown"}</span>
                <span>{EUR(priceCeil)}</span>
              </div>
            </Card>
          )}

          <div className="space-y-3">
            {visibleFlights.length === 0 && (
              <Card className="p-5 text-sm" style={{ color: "#6b7280" }}>No {cabin} flights under {EUR(effMax)}. Raise the bar to see more.</Card>
            )}
            {visibleFlights.map((f) => (
              <Card key={f.flight_no} className="ticket-edge p-0 overflow-hidden" style={f.recommended ? { boxShadow: "0 0 0 2px var(--tap-green)" } : {}}>
                <div className="p-4 flex flex-wrap items-center gap-4">
                  <div className="w-[84px]"><div className="text-xs font-bold text-gray-400">{f.flight_no}</div><div className="text-[11px] text-gray-400">{f.aircraft}</div></div>
                  <div className="flex-1 min-w-[200px]">
                    <RouteRibbon small from={`${f.origin} ${f.dep}`} to={`${f.dest} ${f.arr}`}/>
                    <div className="flex gap-2 mt-2 flex-wrap">
                      <Chip tone="ink">{f.duration}</Chip>
                      <Chip tone="green">{cabin}</Chip>
                      {!!f.recommended && <Chip tone="green"><Sparkles size={11}/> Recommended for you <Why text="This departure is closest to the time you usually fly this route, based on your travel history. If it's a new route, it's the earliest option — best for business arrivals."/></Chip>}
                      {!!f.lowest && <Chip tone="amber">Lowest fare</Chip>}
                      {f.seats_left < 15 && <Chip tone="red">{f.seats_left} seats left</Chip>}
                    </div>
                  </div>
                  <div className="text-right"><div className="font-display font-black text-2xl" style={{ color: "var(--tap-ink)" }}>{EUR(f.cabinPrice)}</div>{cabinMult !== 1 && <div className="text-[11px]" style={{ color: "#6b7280" }}>{cabin}</div>}</div>
                  <PrimaryBtn onClick={() => selectFlight({ ...f, price: f.cabinPrice, cabin })} className="!py-2.5">Select <ChevronRight size={15}/></PrimaryBtn>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display font-extrabold text-lg" style={{ color: "var(--tap-ink)" }}>
            {personalized.length ? "Suggested for you" : "Popular routes"}
          </h2>
          <button onClick={() => setShowAll(!showAll)} className="text-xs font-bold" style={{ color: "var(--tap-green)" }}>{showAll ? "Show fewer" : `See all ${routes?.length || 100}`}</button>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          {personalized.length ? "Ranked live from your flights, bookings and searches." : "Start searching — these adapt to your activity."}
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {list.map((r) => {
            const whyText = r.reasons && r.reasons.length
              ? `Ranked by your activity: ${r.reasons.join("; ")}. Score ${r.score}.`
              : `A popular ${r.destRegion} route from your home airport — shown because you don't have history here yet.`;
            return (
              <div key={`${r.origin}-${r.dest}`} className="relative p-3 rounded-xl border bg-white hover:shadow-sm transition-shadow flex items-center justify-between" style={{ borderColor: r.reason ? "var(--tap-green)" : "var(--tap-line)" }}>
                <button onClick={() => { setOrigin(r.origin); setDest(r.dest); onSearch(r.origin, r.dest); }} className="text-left min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate" style={{ color: "var(--tap-ink)" }}>{r.originCity} → {r.destCity}</div>
                  {r.reason
                    ? <div className="text-[11px] font-semibold truncate" style={{ color: "var(--tap-green)" }}>{r.reason}</div>
                    : <div className="text-[11px] text-gray-400">{r.origin}–{r.dest} · {r.destRegion}</div>}
                </button>
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  <span className="text-sm font-bold" style={{ color: "var(--tap-green)" }}>{EUR(r.base_fare)}</span>
                  <Why text={whyText}/>
                </div>
              </div>
            );
          })}
          {list.length === 0 && <div className="text-sm text-gray-400 col-span-full py-4">Loading routes…</div>}
        </div>
      </div>
    </div>
  );
}

/* ── APP SHELL ── */
// Nav mirrors the real flyxperion.example labels, with our cleaner styling.
const NAV = [
  { id: "home",   label: "Plan a trip" },
  { id: "manage", label: "My flights" },
  { id: "checkin",label: "Check-in" },
  { id: "miles",  label: "Xperion Miles" },
  { id: "help",   label: "Help" },
];
// which nav item is "active" for a given screen
const NAV_ACTIVE = {
  home: "home", search: "home", flights: "home", basket: "home", checkout: "home", payment: "home", confirmed: "manage",
  manage: "manage", checkin: "checkin", miles: "miles", help: "help", console: null,
};

function FlightStatus({ go }) {
  const [booking, setBooking] = useState(undefined);
  useEffect(() => { (async () => {
    const rows = await api.get("/bookings");
    setBooking((rows || []).find(b => b.status === "confirmed") || null);
  })(); }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 pb-24 pt-8">
      <h1 className="font-display font-black text-3xl mb-1" style={{ color: "var(--tap-ink)" }}>Flight status</h1>
      <p className="text-sm text-gray-500 mb-6">Live status of your next flight, straight from the operations feed.</p>

      {booking === undefined && <div className="flex items-center gap-3 text-sm text-gray-500"><Loader2 className="animate-spin" size={16} style={{ color: "var(--tap-green)" }}/> Checking the latest status…</div>}

      {booking === null && (
        <Card className="p-6 text-center">
          <div className="text-sm text-gray-500 mb-3">You have no upcoming flight to track right now.</div>
          <PrimaryBtn onClick={() => go("home")} className="!py-2.5"><Plane size={15}/> Book a flight</PrimaryBtn>
        </Card>
      )}

      {booking && (() => {
        const f = booking.flight || {};
        const delayed = f.status === "delayed";
        const cancelled = f.status === "cancelled";
        return (
          <Card className="p-5">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="font-display font-extrabold text-xl" style={{ color: "var(--tap-ink)" }}>{f.flight_no} · {cityName(f.origin)} → {cityName(f.dest)}</div>
              <Chip tone={cancelled ? "red" : delayed ? "amber" : "green"}>
                <span className="pulse-dot">●</span> {cancelled ? "Cancelled" : delayed ? "Delayed" : "On time"}
              </Chip>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-xl" style={{ background: "var(--tap-mist)" }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Departure</div>
                <div className="font-bold" style={{ color: "var(--tap-ink)" }}>{delayed && f.new_dep ? <><span className="line-through text-gray-400">{f.dep}</span> {f.new_dep}</> : f.dep}</div>
                <div className="text-xs text-gray-500">{cityName(f.origin)} · {booking.flight_date}</div>
              </div>
              <div className="p-3 rounded-xl" style={{ background: "var(--tap-mist)" }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Arrival</div>
                <div className="font-bold" style={{ color: "var(--tap-ink)" }}>{delayed && f.new_arr ? <><span className="line-through text-gray-400">{f.arr}</span> {f.new_arr}</> : f.arr}</div>
                <div className="text-xs text-gray-500">{cityName(f.dest)}</div>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-3">{booking.pnr} · seat {booking.seat} · {booking.checked_in ? "checked in ✓" : "auto check-in 24h before"}</div>
            {(delayed || cancelled) && (
              <div className="mt-4">
                <PrimaryBtn onClick={() => go("manage")} className="!py-2.5"><RefreshCw size={15}/> See rebooking options</PrimaryBtn>
              </div>
            )}
          </Card>
        );
      })()}
    </div>
  );
}

function CheckIn({ go, toast, profile }) {
  const [booking, setBooking] = useState(undefined);   // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const u = profile?.user || {};
  // Real check-in form fields, pre-filled from the profile (as the live site does)
  const [docId, setDocId] = useState(u.doc_id || "");
  const [nationality, setNationality] = useState(u.nationality || "Portugal");
  const [ackBags, setAckBags] = useState(false);
  useEffect(() => { (async () => {
    const rows = await api.get("/bookings");
    const active = (rows || []).find(b => b.status === "confirmed");
    setBooking(active || null);
    if (active?.checked_in) setDone({ state: "already_checked_in", pnr: active.pnr, seat: active.seat, group: `${profile?.user?.tier === "Silver" ? "B" : "A"} (${profile?.user?.tier || "Gold"})` });
  })(); }, []);

  const canSubmit = docId.trim().length >= 5 && ackBags && !busy;
  const doCheckIn = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const r = await api.post("/bookings/checkin", { doc_id: docId, nationality });
    setBusy(false);
    if (r.ok) { setDone(r); toast(r.state === "already_checked_in" ? "Already checked in" : "Checked in", `${r.pnr} · group ${r.group} · seat ${r.seat}`); }
    else toast("Nothing to check in", r.message || "Book a flight first");
  };

  return (
    <div className="max-w-2xl mx-auto px-4 pb-24 pt-8">
      <h1 className="font-display font-black text-3xl mb-1" style={{ color: "var(--tap-ink)" }}>Check-in</h1>
      <p className="text-sm text-gray-500 mb-6">Online check-in opens 24h before departure. As {u.tier || "Gold"}, you board with Group {(u.tier === "Silver") ? "B" : "A"}.</p>

      {booking === undefined && <div className="flex items-center gap-3 text-sm text-gray-500"><Loader2 className="animate-spin" size={16} style={{ color: "var(--tap-green)" }}/> Loading your trip…</div>}

      {booking === null && (
        <Card className="p-6 text-center">
          <div className="text-sm text-gray-500 mb-3">You have no upcoming flight to check in for.</div>
          <PrimaryBtn onClick={() => go("home")} className="!py-2.5"><Zap size={15}/> Book a flight</PrimaryBtn>
        </Card>
      )}

      {booking && done?.state === "already_checked_in" && (
        <Card className="p-6 text-center">
          <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ background: "var(--tap-mist)" }}><BadgeCheck size={22} style={{ color: "var(--tap-green)" }}/></div>
          <div className="font-display font-extrabold text-xl mb-1" style={{ color: "var(--tap-ink)" }}>You're already checked in</div>
          <div className="text-sm text-gray-600 mb-4">{booking.pnr} · {booking.flight?.flight_no} {cityName(booking.flight?.origin)}→{cityName(booking.flight?.dest)} · boarding group {profile?.user?.tier === "Silver" ? "B" : "A"} ({profile?.user?.tier || "Gold"}), seat {booking.seat}. Nothing more to do.</div>
          <PrimaryBtn onClick={() => go("manage")} className="!py-2.5"><QrCode size={15}/> View boarding pass</PrimaryBtn>
        </Card>
      )}

      {booking && !done && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Your upcoming flight</div>
              <div className="font-display font-extrabold text-xl" style={{ color: "var(--tap-ink)" }}>{booking.flight?.flight_no} · {cityName(booking.flight?.origin)} → {cityName(booking.flight?.dest)}</div>
              <div className="text-sm text-gray-500">{booking.flight_date} · {booking.flight?.dep}–{booking.flight?.arr} · seat {booking.seat} · {booking.pnr}</div>
            </div>
            <Chip tone="amber">Not checked in</Chip>
          </div>

          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Passenger & document</div>
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Passenger</label>
                <div className="px-3 py-2.5 rounded-xl border text-sm font-semibold" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}>{u.full_name || "—"}</div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Frequent flyer</label>
                <div className="px-3 py-2.5 rounded-xl border text-sm font-semibold" style={{ borderColor: "var(--tap-line)", color: "var(--tap-ink)" }}>{u.tier || "Gold"} · {u.member_no || "—"}</div>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Travel document (passport / ID) *</label>
                <input value={docId} onChange={(e) => setDocId(e.target.value)} placeholder="e.g. PT-CC-12345678"
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none" style={{ borderColor: "var(--tap-line)", background: "var(--tap-mist)", color: "var(--tap-ink)" }}/>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Nationality</label>
                <input value={nationality} onChange={(e) => setNationality(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none" style={{ borderColor: "var(--tap-line)", background: "var(--tap-mist)", color: "var(--tap-ink)" }}/>
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" checked={ackBags} onChange={(e) => setAckBags(e.target.checked)} className="mt-0.5"/>
              I confirm my details are correct and I've read the dangerous-goods / baggage rules.
            </label>
          </div>

          <div className="h-px my-4" style={{ background: "var(--tap-line)" }}/>
          <PrimaryBtn onClick={doCheckIn} disabled={!canSubmit} className="w-full !py-2.5">
            {busy ? <Loader2 className="animate-spin" size={16}/> : <BadgeCheck size={16}/>} Confirm & check in
          </PrimaryBtn>
          {!canSubmit && !busy && <div className="text-[11px] text-gray-400 mt-2 text-center">Enter your travel document and tick the confirmation to continue.</div>}
        </Card>
      )}

      {done && done.state !== "already_checked_in" && (
        <Card className="p-6 text-center" style={{ borderColor: "var(--tap-green)" }}>
          <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ background: "var(--tap-green)" }}><QrCode size={22} className="text-white"/></div>
          <div className="font-display font-extrabold text-xl mb-1" style={{ color: "var(--tap-ink)" }}>You're checked in!</div>
          <div className="text-sm text-gray-600 mb-4">{done.pnr} · {done.route} · boarding group {done.group}, seat {done.seat}. Your boarding pass is ready in My flights.</div>
          <PrimaryBtn onClick={() => go("manage")} className="!py-2.5"><QrCode size={15}/> View boarding pass</PrimaryBtn>
        </Card>
      )}
    </div>
  );
}

function MilesGo({ profile, go }) {
  const u = profile.user;
  const nextTier = 60000;
  const pct = Math.min(100, Math.round((u.miles / nextTier) * 100));
  const voucher = (profile.vouchers || []).find(v => v.status === "active") || (profile.vouchers || [])[0] || null;
  const PERKS = {
    Silver: [
      "Priority security lanes where available",
      "One free checked bag on every Xperion flight",
      "Seat selection and 24h fare lock included",
      "Group B priority boarding",
      "25% bonus miles on Xperion flights",
    ],
    Gold: [
      "Priority check-in, boarding (Group A) and baggage",
      "Two free checked bags on every Xperion flight",
      "Lounge access at Lisbon, Porto and partner lounges",
      "Free 24h fare lock and seat selection",
      "Double miles on your weekly commute routes",
    ],
    Platinum: [
      "Top-priority check-in, boarding (Group A) and baggage",
      "Three free checked bags plus extra weight allowance",
      "Unlimited lounge access, including Star Alliance lounges",
      "Complimentary upgrades when available",
      "Triple miles plus Executive bonus awards",
    ],
  };
  const perks = PERKS[u.tier] || PERKS.Gold;
  return (
    <div className="max-w-4xl mx-auto px-4 pb-24 pt-8">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="font-display font-black text-3xl" style={{ color: "var(--tap-ink)" }}>Xperion Miles</h1>
        <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: "linear-gradient(120deg,#C9A227,#E8C75A)", color: "#3A2D04" }}>{u.tier} member</span>
      </div>
      <p className="text-sm text-gray-500 mb-6">Member {u.member_no || "—"} · {u.full_name}</p>

      <Card className="p-6 mb-5">
        <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Miles balance</div>
            <div className="font-display font-black text-4xl" style={{ color: "var(--tap-green)" }}>{u.miles.toLocaleString()}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-gray-400">{(nextTier - u.miles).toLocaleString()} miles to next status</div>
            <div className="text-xs font-semibold" style={{ color: "var(--tap-ink)" }}>{pct}% there</div>
          </div>
        </div>
        <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--tap-green)" }}/>
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <Card className="p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Your wallet</div>
          <div className="flex items-center justify-between py-1.5 border-b" style={{ borderColor: "var(--tap-line)" }}>
            <span className="text-sm text-gray-600">Travel voucher</span><span className="font-bold text-sm" style={{ color: "var(--tap-ink)" }}>€{voucher?.amount ?? 0}</span>
          </div>
          <div className="flex items-center justify-between py-1.5 border-b" style={{ borderColor: "var(--tap-line)" }}>
            <span className="text-sm text-gray-600">Saved card</span><span className="font-bold text-sm" style={{ color: "var(--tap-ink)" }}>{MASKED_PAN}</span>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-sm text-gray-600">Miles value (approx)</span><span className="font-bold text-sm" style={{ color: "var(--tap-ink)" }}>€{Math.round(u.miles / 1000 * 3).toLocaleString()}</span>
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Your {u.tier} benefits</div>
          <ul className="space-y-1.5">
            {perks.map((p, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-600"><BadgeCheck size={15} style={{ color: "var(--tap-green)" }} className="mt-0.5 shrink-0"/>{p}</li>
            ))}
          </ul>
        </Card>
      </div>

      <PrimaryBtn onClick={() => go("home")} className="!py-2.5"><Zap size={15}/> Use miles on your next trip</PrimaryBtn>
    </div>
  );
}

function Help({ openAssistant }) {
  const faqs = [
    { q: "How do I change or cancel a booking?", a: "Open My trips, or just ask Xperion AI — it can rebook, change seats, or cancel with an instant refund in one step." },
    { q: "When does online check-in open?", a: "24 hours before departure. With auto check-in on, your boarding pass is issued automatically and appears in the app." },
    { q: "What can I spend my miles on?", a: "Flights, seat upgrades, extra bags and lounge passes. Your current balance and its approximate value are on the Xperion Miles page." },
    { q: "What happens if my flight is disrupted?", a: "We notify you proactively with rebooking options — by email and on WhatsApp — and your Gold + EU261 entitlements are applied automatically." },
  ];
  return (
    <div className="max-w-3xl mx-auto px-4 pb-24 pt-8">
      <h1 className="font-display font-black text-3xl mb-1" style={{ color: "var(--tap-ink)" }}>Help</h1>
      <p className="text-sm text-gray-500 mb-6">Quick answers — or ask Xperion AI anything and it'll handle it for you.</p>

      <Card className="p-5 mb-5 flex items-center justify-between gap-3 flex-wrap" style={{ background: "#FBFDFC", borderColor: "var(--tap-green)" }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "var(--tap-green)" }}><Sparkles size={18} className="text-white"/></div>
          <div>
            <div className="font-bold text-sm" style={{ color: "var(--tap-ink)" }}>Ask Xperion AI</div>
            <div className="text-xs text-gray-500">Find flights, book, check in or cancel — right in the chat.</div>
          </div>
        </div>
        <PrimaryBtn onClick={openAssistant} className="!py-2.5"><MessageCircle size={15}/> Open Xperion AI</PrimaryBtn>
      </Card>

      <div className="space-y-3">
        {faqs.map((f, i) => (
          <Card key={i} className="p-4">
            <div className="font-bold text-sm mb-1" style={{ color: "var(--tap-ink)" }}>{f.q}</div>
            <div className="text-sm text-gray-600">{f.a}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [screen, setScreen] = useState(() => (typeof window !== "undefined" && window.location.hash === "#app") ? "home" : "login");
  const [profile, setProfile] = useState(null);
  const [flights, setFlights] = useState([]);
  const [ancillaries, setAncillaries] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [flight, setFlight] = useState(null);
  const [items, setItems] = useState([]);
  const [hold, setHold] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [activeDest, setActiveDest] = useState("LIS");
  // Flight search
  const [routes, setRoutes] = useState([]);
  const [suggested, setSuggested] = useState(null);
  const [searchOrigin, setSearchOrigin] = useState("OPO");
  const [searchDest, setSearchDest] = useState("LIS");
  const [searchDate, setSearchDate] = useState(() => { const r = new Date().toISOString().slice(0, 10); return r > "2026-06-15" ? r : "2026-06-15"; });
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [prefilledReason, setPrefilledReason] = useState(null);

  const toast = (title, sub) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, title, sub }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 9000);
  };

  useEffect(() => {
    (async () => {
      try {
        const [p, f, a, d, b, ap, rt, sug] = await Promise.all([
          api.get("/profile"), api.get("/flights?dest=LIS"), api.get("/ancillaries"), api.get("/destinations"), api.get("/basket"),
          api.get("/airports"), api.get("/routes"), api.get("/routes/suggested"),
        ]);
        (ap || []).forEach(x => { AIRPORT_MAP[x.code] = x; });   // populate city-name lookup
        setRoutes(rt || []); setSuggested(sug || []);
        setProfile(p); setFlights(f || []); setAncillaries(a || []); setDestinations(d || []);
        setSearchOrigin((p?.syncedSearch?.origin) || (p?.pattern?.origin) || p?.user?.home_airport || "OPO");
        setSearchDest((p?.syncedSearch?.dest) || (p?.pattern?.dest) || "");
        if (p?.syncedSearch?.travel_date) setSearchDate(p.syncedSearch.travel_date);
        const rec = (f || []).find(x => x.recommended) || (f || [])[0];
        if (b && b.flight_no) { setFlight((f || []).find(x => x.flight_no === b.flight_no) || rec); setItems(b.items || []); }
        else { setFlight(rec); setItems((a || []).filter(x => x.auto).map(x => x.code)); }
      } catch (e) {
        console.error("Initial load failed:", e);
      }
    })();
  }, []);

  // When the active persona changes in-app (member number differs), realign the flight
  // search to the new traveller's profiled trip: origin, destination AND dates pre-filled
  // from their upcoming/usual route (nothing from the previous persona lingers).
  const lastPersona = useRef(null);
  useEffect(() => {
    const u = profile?.user;
    if (!u?.member_no) return;
    if (lastPersona.current && lastPersona.current !== u.member_no) {
      const ss = profile?.syncedSearch, pat = profile?.pattern;
      setSearchOrigin((ss && ss.origin) || (pat && pat.origin) || u.home_airport || "OPO");
      setSearchDest((ss && ss.dest) || (pat && pat.dest) || "");
      if (ss && ss.travel_date) setSearchDate(ss.travel_date);
      setActiveDest((pat && pat.dest) || u.home_airport || "OPO");
    }
    lastPersona.current = u.member_no;
  }, [profile]);

  const refreshSuggested = async () => setSuggested(await api.get("/routes/suggested"));
  const refreshProfile = async () => setProfile(await api.get("/profile"));
  const go = (s) => { setScreen(s); window.scrollTo(0, 0); if (s === "login" && typeof window !== "undefined") window.location.hash = ""; if (s === "home") refreshProfile(); if (s === "search") refreshSuggested(); };
  const [seat, setSeat] = useState("");

  // ── Cross-channel journey: stage ↔ web screen, and save/restore helpers ──
  const STAGE_SCREEN = { results: "search", seat: "seatmap", extras: "basket", review: "checkout" };
  const STAGE_LABEL = { results: "Choosing a flight", seat: "Selecting a seat", extras: "Adding extras", review: "Reviewing & payment" };
  // Persist the current step to the shared journey (fire-and-forget).
  const saveJourney = (stage, extra = {}) => {
    const origin = extra.origin || flight?.origin || searchOrigin;
    const dest = extra.dest || flight?.dest || searchDest;
    if (!origin || !dest) return;
    api.post("/journey", {
      origin, dest, date: extra.date || searchDate, device: "Web app", stage,
      flight_no: extra.flight_no !== undefined ? extra.flight_no : flight?.flight_no,
      seat: extra.seat !== undefined ? extra.seat : (seat || undefined),
      items: extra.items !== undefined ? extra.items : items,
      cabin: extra.cabin || flight?.cabin || "Economy",
    }).catch(() => {});
  };
  // Restore selections from a saved journey and jump to the exact screen.
  const resumeJourney = async (jArg) => {
    let j = jArg;
    // The server is the source of truth — always resume the most recent in-progress
    // search, even if the passed snapshot (e.g. mount-time profile) is stale.
    try {
      const live = await api.get("/journey");
      if (live && live.stage && live.dest) j = { origin: live.origin, dest: live.dest, date: live.date, stage: live.stage, flight_no: live.flight_no, seat: live.seat, items: live.items, cabin: live.cabin };
    } catch {}
    if (!j || !j.stage) return;
    api.post("/journey/resume", { device: "Web app" }).catch(() => {});   // stream a distinct searchResumed event to CDP
    const origin = j.origin, dest = j.dest;
    setSearchOrigin(origin); setSearchDest(dest); if (j.date) setSearchDate(j.date);
    setPrefilledReason(`Resuming where you left off — ${STAGE_LABEL[j.stage] || "your search"}.`);
    // Always (re)load the route's flights so the chosen flight object is available.
    const r = await api.get(`/search?origin=${origin}&dest=${dest}&date=${j.date || searchDate}`);
    setSearchResults(r);
    const chosen = j.flight_no && r?.flights ? r.flights.find(x => x.flight_no === j.flight_no) : null;
    if (chosen) {
      setFlight(chosen);
      const restoreItems = (j.items && j.items.length) ? j.items : items;
      setItems(restoreItems);
      if (j.seat) setSeat(j.seat);
      await api.post("/basket", { flight_no: chosen.flight_no, items: restoreItems });
    }
    go(STAGE_SCREEN[j.stage] || "search");
  };
  // Explicit start-over: clear shared journey, go to a clean search.
  const startFresh = async (j) => {
    await api.post("/journey/clear").catch(() => {});
    setFlight(null); setSeat(""); setItems(ancillaries.filter(x => x.auto).map(x => x.code));
    setSearchResults(null); setPrefilledReason(null);
    await refreshProfile();
    go("search");
  };

  const selectFlight = async (f) => { setFlight(f); await api.post("/basket", { flight_no: f.flight_no, items }); saveJourney("seat", { flight_no: f.flight_no, origin: f.origin, dest: f.dest, items }); go("seatmap"); };

  // Reactively persist the cross-channel journey as the user moves through the
  // web booking funnel, so any channel can resume at the exact step + selections.
  useEffect(() => {
    const SCREEN_STAGE = { seatmap: "seat", basket: "extras", checkout: "review" };
    const stage = SCREEN_STAGE[screen];
    if (stage && flight?.flight_no) {
      saveJourney(stage, { flight_no: flight.flight_no, origin: flight.origin, dest: flight.dest, seat: seat || undefined, items });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, flight, seat, items]);

  // Flight search — logs to DB, feeds personalization.
  // keepReason=true preserves the "picked for you" banner (set by bookDestination).
  const runSearch = async (o, d, keepReason = false, dateArg) => {
    const origin = (typeof o === "string" ? o : searchOrigin);
    const dest = (typeof d === "string" ? d : searchDest);
    const date = dateArg || searchDate;
    setSearching(true); setSearchResults(null);
    if (!keepReason) setPrefilledReason(null);
    const r = await api.get(`/search?origin=${origin}&dest=${dest}&date=${date}`);
    setSearchResults(r); setSearching(false);
    if (r.ok) toast("Search logged to DB", `${cityName(origin)} → ${cityName(dest)} · ${r.flights.length} flights · feeds personalization`);
    refreshSuggested();   // searching this route nudges it up the suggested list
  };

  // Card tap → pre-fill the route + reason, jump to search, AND run the search
  // so flight options appear immediately (route already selected, ready to book).
  const bookDestination = (d) => {
    const code = d?.code || "LIS";
    const origin = d?.origin || profile?.user?.home_airport || "OPO";
    const date = d?.date || searchDate;
    setSearchOrigin(origin);
    setSearchDest(code);
    if (d?.date) setSearchDate(d.date);
    setSearchResults(null);
    setPrefilledReason(d?.reason || d?.reasons?.join("; ") || d?.tag || `Suggested route to ${cityName(code)}.`);
    go("search");
    runSearch(origin, code, true, date);   // keepReason=true; explicit date avoids stale state
  };
  const bookUsual = async () => {
    const o = profile?.pattern?.origin || profile?.user?.home_airport || "OPO";
    const dst = profile?.pattern?.dest || "LIS";
    const f = await api.get(`/flights?dest=${dst}&origin=${o}`);
    setFlights(f);
    const usual = f.find(x => x.flight_no === (profile?.pattern?.topFlight)) || f.find(x => x.recommended) || f[0];
    if (!usual) { toast("No usual flight found", `${cityName(o)} → ${cityName(dst)}`); return; }
    await selectFlight(usual);   // one-tap path: usual flight → seat map → extras → pay
  };
  // "Trip Extras" nav → the Basket (extras) view. If a trip is already in progress,
  // open its basket; otherwise spin up the traveller's usual flight so there's a
  // trip to add extras to, and land directly on extras.
  const openExtras = async () => {
    if (flight) { go("basket"); return; }
    const o = profile?.pattern?.origin || profile?.user?.home_airport || "OPO";
    const dst = profile?.pattern?.dest || "LIS";
    const f = await api.get(`/flights?dest=${dst}&origin=${o}`);
    setFlights(f);
    const usual = f.find(x => x.flight_no === (profile?.pattern?.topFlight)) || f.find(x => x.recommended) || f[0];
    if (!usual) { toast("No trip to add extras to", "Search for a flight first."); go("search"); return; }
    setFlight(usual);
    await api.post("/basket", { flight_no: usual.flight_no, items });
    go("basket");   // the journey-persist effect saves the "extras" stage automatically
  };
  // "Book your usual flight" → Express checkout (review & pay), everything pre-filled.
  const openExpress = async () => {
    const o = profile?.pattern?.origin || profile?.user?.home_airport || "OPO";
    const dst = profile?.pattern?.dest || "LIS";
    const recDate = profile?.pattern?.recommendedDate;
    let f = [];
    try { f = await api.get(`/flights?dest=${dst}&origin=${o}${recDate ? `&date=${recDate}` : ""}`); } catch { f = []; }
    if (!Array.isArray(f) || !f.length) { toast("Couldn't open express checkout", `${cityName(o)} → ${cityName(dst)} — try search instead.`); go("search"); return; }
    setFlights(f);
    const usual = f.find(x => x.flight_no === (profile?.pattern?.topFlight)) || f.find(x => x.recommended) || f[0];
    if (!usual) { toast("No usual flight found", `${cityName(o)} → ${cityName(dst)}`); go("search"); return; }
    setFlight(usual);
    const seatPref = (profile?.prefs?.seat || "").split(" ")[0] || "";
    setSeat(seatPref);
    // Express checkout is a standalone 2-step flow — it deliberately does NOT write
    // the shared cross-channel journey, so it never collides with "Resume your search".
    go("express");
  };
  const toggleItem = async (code) => {
    const next = items.includes(code) ? items.filter(x => x !== code) : [...items, code];
    setItems(next);
    await api.post("/basket", { flight_no: flight.flight_no, items: next });
  };
  const onPaid = (r) => { setReceipt(r); setAssistantOpen(false); refreshProfile(); go("confirmed"); };

  // ── Agent command bridge: the chat is primary; the main screen follows ──
  const handleAgentCommand = async (cmd) => {
    if (!cmd) return;
    if (cmd.action === "show_search") {
      setSearchOrigin(cmd.origin); setSearchDest(cmd.dest); if (cmd.date) setSearchDate(cmd.date);
      const r = await api.get(`/search?origin=${cmd.origin}&dest=${cmd.dest}&date=${cmd.date || searchDate}`);
      setSearchResults(r); setPrefilledReason(`Found in chat — ${cityName(cmd.origin)} → ${cityName(cmd.dest)}.`);
      go("search");
    } else if (cmd.action === "navigate") {
      go(cmd.screen);
    } else if (cmd.action === "select_flight") {
      let picked = (searchResults?.flights || flights || []).find(x => x.flight_no === cmd.flight_no);
      if (!picked) { const all = await api.get(`/search?origin=${searchOrigin}&dest=${searchDest}&date=${searchDate}`); picked = (all.flights||[]).find(x=>x.flight_no===cmd.flight_no); }
      if (picked) { setFlight(picked); await api.post("/basket", { flight_no: picked.flight_no, items }); go("basket"); }
    } else if (cmd.action === "show_confirmation") {
      setAssistantOpen(false);
      await refreshProfile();
      let latest = null;
      try { const bookings = await api.get("/bookings"); latest = (bookings || []).find(b => b.pnr === cmd.pnr) || (bookings || [])[0] || null; } catch {}
      if (latest?.flight) setFlight(latest.flight);
      setReceipt({ pnr: cmd.pnr, flight: latest?.flight, total: latest?.total, seatOut: latest?.seat });
      go("confirmed");
    } else if (cmd.action === "express") {
      // chat → open the 2-step Express Checkout for the usual flight
      setAssistantOpen(false);
      openExpress();
    } else if (cmd.action === "resume") {
      // chat → reopen the in-progress search/booking at the saved step
      setAssistantOpen(false);
      const ss = profile?.syncedSearch;
      if (ss && ss.dest) {
        let it = []; try { it = ss.items_json ? JSON.parse(ss.items_json) : []; } catch {}
        resumeJourney({ origin: ss.origin, dest: ss.dest, date: ss.travel_date, stage: ss.stage || "results", flight_no: ss.flight_no, seat: ss.seat, items: it, cabin: ss.cabin });
      } else {
        go("search");
      }
    }
  };

  if (!profile || screen === "login")
    return (<><Fonts/><Login profile={profile} onLogin={() => go("home")}/><Toasts list={toasts} dismiss={(id)=>setToasts(t=>t.filter(x=>x.id!==id))}/></>);

  const activeNav = NAV_ACTIVE[screen] || null;

  const onHome = false;
  const isHome = screen === "home";
  return (
    <div className="min-h-screen" style={{background: "var(--tap-mist)"}}>
      <Fonts/>
      {isHome && <Home profile={profile} destinations={destinations} go={go} openAssistant={()=>setAssistantOpen(true)} toast={toast} bookDestination={bookDestination} bookUsual={bookUsual} resumeJourney={resumeJourney} startFresh={startFresh} openExtras={openExtras} openExpress={openExpress}/>}
      {!isHome && (<>
      <header className="sticky top-0 z-40 border-b" style={{background: "#fff", borderColor: "var(--tap-line)"}}>
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <button onClick={()=>go("home")}><TapLogo light={onHome}/></button>
          <nav className="hidden md:flex items-center gap-1">
            {NAV.map((s)=>(
              <button key={s.id} onClick={()=>go(s.id)}
                className={`px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${s.id===activeNav?"text-white":(onHome?"hover:bg-white/10":"text-gray-600 hover:bg-gray-100")}`}
                style={s.id===activeNav?{background:"var(--tap-green)"}:(onHome?{color:"#C2CABF"}:{})}>
                {s.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2.5 shrink-0">
            {/* Demo Console — set apart as a small demo-only badge */}
            <button onClick={()=>go("console")}
              className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors"
              style={screen==="console"
                ? {background:"var(--tap-deep)", color:"white", borderColor:"var(--tap-deep)"}
                : (onHome ? {color:"var(--dxp-lime)", borderColor:"var(--dxp-line)"} : {color:"var(--tap-deep)", borderColor:"var(--tap-line)"})}
              title="Demo-only: live view of the database">
              <Database size={12}/> Demo
            </button>
            <button className={`hidden md:flex w-8 h-8 rounded-full items-center justify-center ${onHome?"hover:bg-white/10":"hover:bg-gray-100"}`} aria-label="Search"><Search size={16} style={{color: onHome ? "var(--dxp-muted)" : undefined}} className={onHome?"":"text-gray-500"}/></button>
            <div className="hidden sm:block text-right leading-tight">
              <div className="text-xs font-bold" style={{color: onHome ? "var(--dxp-text)" : "var(--tap-ink)"}}>Hi, {profile.user.first_name}</div>
              <div className="text-[10px]" style={{color: onHome ? "var(--dxp-muted)" : undefined}}>{!onHome && null}<span className={onHome?"":"text-gray-400"}>{profile.user.tier} · {profile.user.miles.toLocaleString()} miles</span></div>
            </div>
            <div className="w-9 h-9 rounded-full flex items-center justify-center font-display font-extrabold text-sm" style={{background: onHome ? "var(--dxp-lime)" : "var(--tap-deep)", color: onHome ? "#06210F" : "#fff"}}>{profile.user.full_name.split(" ").map(w=>w[0]).slice(0,2).join("")}</div>
            <span className="hidden md:flex items-center gap-1 text-[11px] font-bold border rounded-full px-2 py-1" style={{borderColor: onHome ? "var(--dxp-line)" : "var(--tap-line)", color: onHome ? "var(--dxp-muted)" : "#6b7280"}}>🇬🇧 EN</span>
          </div>
        </div>
      </header>

      {/* Inner screens now use the light Xperion theme, matching Home */}
      <div>
      {screen === "search" && <SearchScreen origin={searchOrigin} setOrigin={setSearchOrigin} dest={searchDest} setDest={setSearchDest} date={searchDate} setDate={setSearchDate} onSearch={runSearch} results={searchResults} searching={searching} selectFlight={selectFlight} routes={routes} suggested={suggested} prefilledReason={prefilledReason}/>}
      {screen === "flights" && <Flights flights={flights} pattern={profile.pattern} selectFlight={selectFlight} toast={toast}/>}
      {screen === "seatmap" && <SeatMap flight={flight} seat={seat} setSeat={setSeat} go={go} toast={toast} profile={profile}/>}
      {screen === "basket" && flight && <Basket flight={flight} ancillaries={ancillaries} items={items} toggleItem={toggleItem} go={go}/>}
      {screen === "express" && flight && <ExpressCheckout profile={profile} flight={flight} ancillaries={ancillaries} items={items} seat={seat} onPaid={onPaid} toast={toast} go={go}/>}
      {screen === "checkout" && flight && <Checkout profile={profile} flight={flight} ancillaries={ancillaries} items={items} go={go} hold={hold} setHold={setHold} toast={toast}/>}
      {screen === "payment" && flight && <Payment profile={profile} flight={flight} ancillaries={ancillaries} items={items} seat={seat} onPaid={onPaid} toast={toast}/>}
      {screen === "confirmed" && receipt && <Confirmed profile={profile} flight={flight} receipt={receipt} go={go}/>}
      {screen === "manage" && <Manage profile={profile} flight={flight} openAssistant={()=>setAssistantOpen(true)} toast={toast} go={go}/>}
      {screen === "checkin" && <CheckIn go={go} toast={toast} profile={profile}/>}
      {screen === "status" && <FlightStatus go={go}/>}
      {screen === "miles" && <MilesGo profile={profile} go={go}/>}
      {screen === "help" && <Help openAssistant={()=>setAssistantOpen(true)}/>}
      {screen === "console" && <div className="dxp-home"><Console toast={toast}/></div>}
      </div>
      </>)}

      <Assistant open={assistantOpen} onClose={()=>setAssistantOpen(false)} screen={screen} profile={profile} onCommand={handleAgentCommand} onSelectFlight={(no)=>handleAgentCommand({action:"select_flight",flight_no:no})}/>
      <Toasts list={toasts} dismiss={(id)=>setToasts(t=>t.filter(x=>x.id!==id))}/>

      <footer className="border-t py-4 text-center text-[11px]" style={{borderColor: "var(--tap-line)", color: "#94a3a0"}}>
        Demo · Reimagined pre-travel journey · personalized live per traveller · Frontend + Express API + SQLite + Email + AI
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App/>);
