// FlyTAP v2 — design-system primitives. Faithful to the approved Figma tokens:
// Inter, white surfaces, dark-navy panels, lime accent, Xperion green/red.
import React, { useState } from "react";

export const cx = (...a) => a.filter(Boolean).join(" ");

/* ---- Relevant imagery: keyword-based real photos (New York→New York, Cancún→Cancún…) ----
   imageFor() builds a LoremFlickr URL from city/topic keywords; Img falls back to a
   deterministic photo, then a gradient, if a source 404s. Production swaps in AEM/DAM. */
const CITY_KW = { lisbon: "lisbon,portugal", porto: "porto,portugal", funchal: "funchal,madeira", madeira: "madeira,island", madrid: "madrid,spain", barcelona: "barcelona,spain", paris: "paris,france", london: "london,england", rome: "rome,italy", milan: "milan,italy", amsterdam: "amsterdam", berlin: "berlin,germany", brussels: "brussels", geneva: "geneva,switzerland", zurich: "zurich", "são paulo": "saopaulo,brazil", "sao paulo": "saopaulo,brazil", "rio de janeiro": "rio,brazil", "new york": "newyork,city", boston: "boston,city", faro: "faro,algarve", azores: "azores,island", cascais: "cascais,portugal", sintra: "sintra,palace" };
const CODE_KW = { lis: "lisbon", opo: "porto", fnc: "funchal", mad: "madrid", bcn: "barcelona", cdg: "paris", ory: "paris", lon: "london", lgw: "london", lhr: "london", fco: "rome", gru: "saopaulo", gig: "rio", jfk: "newyork", bos: "boston", fao: "faro" };
const TOPIC_KW = { hotel: "hotel,room", memmo: "boutique,hotel", bairro: "hotel,lisbon", quinta: "resort,pool", lounge: "airport,lounge", priority: "airport,boarding", fasttrack: "airport,security", douro: "vineyard,wine", wine: "vineyard,wine", belem: "pastry,food", food: "portuguese,food", sintra: "sintra,palace", surf: "surfing,beach", fado: "fado,guitar", train: "train,railway", transfer: "car,road", car: "car,road", seat: "airplane,seat", bag: "luggage,suitcase", meal: "airplane,meal", insurance: "travel,documents", insur: "travel,documents", kid: "family,travel", veg: "salad,healthy", carry: "cabin,luggage", checked: "luggage,airport", flexible: "calendar,schedule", change: "calendar,schedule", upgrade: "business,class", business: "business,class", experience: "tour,sightseeing" };
function tokens(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" "); }
export function imageFor(key, cityName) {
  const city = String(cityName || "").toLowerCase().trim();
  if (city && CITY_KW[city]) return flickr(CITY_KW[city] + ",cityscape", key || city);
  const toks = tokens(key);
  for (const t of toks) { if (TOPIC_KW[t]) return flickr(TOPIC_KW[t], key); }
  for (const t of toks) { if (CITY_KW[t]) return flickr(CITY_KW[t], key); if (CODE_KW[t]) return flickr(CITY_KW[CODE_KW[t]] || CODE_KW[t], key); }
  if (city) return flickr(city + ",city", key || city);
  return null;
}
function flickr(kw, lockKey) { let h = 0; for (const c of String(lockKey || kw)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `https://loremflickr.com/800/450/${kw}?lock=${(h % 40) + 1}`; }

const IMG_GRADS = [["#2e7d33", "#9efd38"], ["#1a1f29", "#46a41a"], ["#0a3d2e", "#c7f21f"], ["#163a4a", "#5ec6c0"], ["#3a2a1f", "#e8a23a"]];
function gradFromSeed(seed) { let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0; const g = IMG_GRADS[h % IMG_GRADS.length]; return `linear-gradient(135deg, ${g[0]}, ${g[1]})`; }
export function Img({ seed = "xperion", src, alt = "", className = "", w = 800, h = 450, fit = "cover" }) {
  const picsum = `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
  const [stage, setStage] = useState(src ? 0 : 1); // 0=relevant src · 1=deterministic photo · 2=gradient
  const url = stage === 0 ? src : stage === 1 ? picsum : null;
  if (stage >= 2 || !url) return <div className={className} style={{ background: gradFromSeed(seed) }} aria-hidden="true" />;
  return <img src={url} alt={alt} loading="lazy" onError={() => setStage(s => s + 1)} className={className} style={{ objectFit: fit }} />;
}

/* ---- Buttons ---- */
export function Btn({ variant = "primary", size = "md", className = "", children, ...p }) {
  const base = "inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
  const sizes = { sm: "text-[12px] px-3 py-1.5", md: "text-[13px] px-4 py-2.5", lg: "text-[14px] px-5 py-3" };
  const variants = {
    primary: "bg-tap-green text-white hover:bg-tap-greenDeep",
    lime: "bg-lime text-ink hover:bg-lime-alt",
    soft: "bg-lime-tint text-tap-greenDeep hover:bg-lime/40",
    dark: "bg-surface-dark text-white hover:bg-ink-strong",
    outline: "border border-tap-green text-tap-greenDeep hover:bg-lime-tint",
    ghost: "text-ink hover:bg-surface-mute",
    danger: "bg-tap-red text-white hover:opacity-90",
  };
  return <button className={cx(base, sizes[size], variants[variant], className)} {...p}>{children}</button>;
}

/* ---- Surfaces ---- */
export const Card = ({ className = "", children, ...p }) =>
  <div className={cx("bg-surface rounded-2xl border border-line shadow-card", className)} {...p}>{children}</div>;

export const Pill = ({ tone = "lime", className = "", children }) => {
  const tones = {
    lime: "bg-lime-tint text-tap-greenDark border-lime/40",
    green: "bg-tap-green/10 text-tap-greenDeep border-tap-green/20",
    dark: "bg-surface-dark text-white border-transparent",
    slate: "bg-surface-mute text-ink-slate border-line",
    red: "bg-tap-red/10 text-tap-red border-tap-red/20",
    gold: "bg-gradient-to-br from-[#E8C75A] to-[#C9A227] text-ink border-transparent",
  };
  return <span className={cx("inline-flex items-center gap-1 text-[10px] font-bold tracking-wide uppercase px-2 py-1 rounded-full border", tones[tone], className)}>{children}</span>;
};

/* ---- "Why am I seeing this?" explainability ----
   A small (i) control placed on any personalized surface (offer, recommendation, upsell).
   Opening it reveals the logic + the supporting signals — all derived from the member's own
   DB records (bookings · searches · travel history · loyalty), so a demo can show *why* each
   personalization fired and point to the same records in the database. Pass `reason` (a string,
   which may be " · "-separated) and/or `signals` (an explicit array of supporting facts). */
export function WhyChip({ reason, signals, source = "From your Xperion records: bookings · searches · travel history (DB)", label = "Why this?", dark = false, className = "" }) {
  const [open, setOpen] = useState(false);
  const items = (signals && signals.length ? signals : String(reason || "").split(/\s·\s|;\s/)).map(s => String(s).trim()).filter(Boolean);
  if (!items.length) return null;
  return (
    <div className={cx("text-left", className)}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Why am I seeing this?"
        className={cx("inline-flex items-center gap-1 text-[10px] font-semibold transition-colors", dark ? "text-white/70 hover:text-lime" : "text-ink-muted hover:text-tap-greenDeep")}>
        <span className="w-3.5 h-3.5 rounded-full border border-current inline-flex items-center justify-center text-[9px] font-bold leading-none">i</span>
        {label && <span>{label}</span>}
      </button>
      {open && (
        <div className={cx("mt-1.5 rounded-lg border p-2.5 animate-[v2fade_.2s_ease]", dark ? "border-white/15 bg-white/10" : "border-line bg-surface-2")}>
          <div className={cx("text-[10px] font-bold uppercase tracking-wide flex items-center gap-1", dark ? "text-lime" : "text-tap-greenDeep")}><Icon name="spark" size={11} /> Why you're seeing this</div>
          <ul className="mt-1 space-y-0.5">
            {items.map((s, i) => <li key={i} className={cx("text-[11px] flex items-start gap-1.5", dark ? "text-white/80" : "text-ink-700")}><span className={dark ? "text-lime leading-tight" : "text-tap-green leading-tight"}>•</span><span>{s}</span></li>)}
          </ul>
          <div className={cx("mt-1.5 pt-1.5 border-t text-[9px]", dark ? "border-white/15 text-white/50" : "border-line text-ink-faint")}>{source}</div>
        </div>
      )}
    </div>
  );
}

export function TierBadge({ tier = "Gold", className = "" }) {
  const map = { Platinum: "from-slate-300 to-slate-500 text-ink", Gold: "from-[#E8C75A] to-[#C9A227] text-ink", Silver: "from-slate-200 to-slate-400 text-ink" };
  return <span className={cx("inline-flex items-center text-[10px] font-extrabold tracking-widest px-2 py-0.5 rounded-full bg-gradient-to-br", map[tier] || map.Gold, className)}>{(tier || "Member").toUpperCase()}</span>;
}

export const Eyebrow = ({ children, className = "" }) =>
  <div className={cx("text-[10px] font-bold tracking-[0.14em] uppercase text-ink-slate", className)}>{children}</div>;

// Highlighted "Personalized for you" pill — soft green background, padding, rounded-full,
// dot + bold uppercase label. Reusable so the personalization badge is consistent everywhere.
export const PersonalizedTag = ({ children = "Personalized for you", className = "" }) =>
  <span className={cx("inline-flex items-center gap-1.5 rounded-full bg-lime-tint px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-tap-greenDeep", className)}>
    <span className="w-1.5 h-1.5 rounded-full bg-tap-green inline-block" /> {children}
  </span>;

export const Avatar = ({ initials = "D", className = "" }) =>
  <span className={cx("inline-flex items-center justify-center w-8 h-8 rounded-full bg-surface-dark text-white text-[12px] font-bold", className)}>{initials}</span>;

/* ---- Form field ---- */
export function Field({ label, children, className = "" }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1.5">{label}</span>}
      {children}
    </label>
  );
}
export const Input = ({ className = "", ...p }) =>
  <input className={cx("w-full bg-surface border border-line rounded-[10px] px-[14px] py-2.5 min-h-[48px] text-[15px] font-medium text-ink placeholder:text-ink-faint placeholder:font-normal focus:border-tap-green outline-none", className)} {...p} />;

/* ---- Icons (inline, currentColor) ---- */
export const Icon = ({ name, size = 16, className = "", style }) => {
  const paths = {
    plane: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5Z",
    arrow: "M5 12h14M13 6l6 6-6 6",
    swap: "M4 9h12M13 6l3 3-3 3M20 15H8M11 12l-3 3 3 3",
    shield: "M12 3l7 3v5c0 4-3 7.5-7 8.5-4-1-7-4.5-7-8.5V6l7-3z",
    seat: "M5 11V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6M5 11h6M5 11v6a2 2 0 0 0 2 2h9M14 9h3a2 2 0 0 1 2 2v8",
    globe: "M12 3a9 9 0 100 18 9 9 0 000-18M3.5 9h17M3.5 15h17M12 3c2.6 2.4 2.6 15.6 0 18M12 3c-2.6 2.4-2.6 15.6 0 18",
    leaf: "M11 20A7 7 0 019 6c4-2 8-2 11-3-1 3-1 7-3 11a7 7 0 01-6 6zM9 17c2-4 4-6 7-8",
    chevron: "M6 9l6 6 6-6",
    "chevron-left": "M15 18l-6-6 6-6",
    "chevron-right": "M9 18l6-6-6-6",
    search: "M11 19a8 8 0 1 1 5.29-14A8 8 0 0 1 11 19Zm10 2-4.35-4.35",
    spark: "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z",
    bolt: "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
    bag: "M6 7h12l1 14H5L6 7Zm3 0V5a3 3 0 0 1 6 0v2",
    star: "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19l1-5.8L3.5 9.2l5.9-.9L12 3Z",
    clock: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z",
  calendar: "M8 3v4M16 3v4M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    heart: "M12 21s-7-4.5-9.5-9A5 5 0 0 1 12 6a5 5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9Z",
    cart: "M3 4h2l2 12h11l2-8H7M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
    check: "M5 12l5 5L20 7",
    chevR: "M9 6l6 6-6 6",
    lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5V11Z",
    mail: "M3 6h18v12H3V6Zm0 1 9 6 9-6",
    doc: "M6 2h8l4 4v16H6V2Zm8 0v4h4",
    info: "M12 16v-4M12 8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z",
    refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v4h-4",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
    x: "M6 6l12 12M18 6 6 18",
    mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0M12 19v3",
    send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
    db: "M12 3c4.4 0 8 1.2 8 2.7S16.4 8.4 12 8.4 4 7.2 4 5.7 7.6 3 12 3Zm8 2.7v6c0 1.5-3.6 2.7-8 2.7s-8-1.2-8-2.7v-6m16 6v6c0 1.5-3.6 2.7-8 2.7s-8-1.2-8-2.7v-6",
    grid: "M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z",
    menu: "M4 6h16M4 12h16M4 18h16",
    home: "M3 11 12 4l9 7M5 9.5V20h14V9.5M10 20v-5h4v5",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true">
      <path d={paths[name] || paths.check} />
    </svg>
  );
};

export const Divider = ({ className = "" }) => <div className={cx("h-px bg-line", className)} />;
