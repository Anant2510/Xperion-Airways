// FlyTAP v2 — API client + formatters. Same-origin: the v2 app is served at /v2/,
// the backend API lives at /api/* (unchanged). No build/server changes required.
const API = "/api";
const j = (r) => r.json();

// Per-session identity: the sessionId returned by /api/auth/login|register. Sent as
// X-Session-Id on EVERY request so the server resolves the right user (multi-user seam).
// Hydrated from localStorage so it survives a page reload (re-minted on boot via re-login,
// since server sessions are in-memory — see main.jsx). This is the single choke point.
let SID = (() => { try { return localStorage.getItem("flyxperion_sid") || null; } catch { return null; } })();
export function setSessionId(id) {
  SID = id || null;
  try { id ? localStorage.setItem("flyxperion_sid", id) : localStorage.removeItem("flyxperion_sid"); } catch {}
}
export const getSessionId = () => SID;

// Boot session gate. Server sessions are in-memory and clear on restart, so the sid
// hydrated from localStorage above is unreliable until the app re-logs-in on boot. Until
// then a request would carry the STALE sid and the server falls back to its default user —
// which surfaced the wrong person in once-on-mount panels (e.g. the 360° profile fired on
// mount before re-login finished). So api.* parks every call on this gate until main.jsx
// settles the session and calls authReady(). A timeout fallback guarantees the gate always
// opens, so a missing/hung re-login can never brick the app. The boot re-login itself is
// the call that settles the session, so it passes { ungated:true } to skip the gate.
let _openGate, _gateOpen = false;
const _gate = new Promise((res) => { _openGate = res; });
export function authReady() { if (!_gateOpen) { _gateOpen = true; _openGate(); } }
setTimeout(authReady, 5000);   // belt-and-suspenders: never hold boot calls longer than this

// Base headers + the session header when bound. Built per-call so a fresh login is picked up.
const hdrs = (extra) => ({ "X-App": "v2", ...(SID ? { "X-Session-Id": SID } : {}), ...(extra || {}) });
const _send = (p, init, opts) => {
  const go = () => fetch(API + p, init).then(j);
  return (opts && opts.ungated) ? go() : _gate.then(go);   // gate held until the session is settled
};
export const api = {
  get: (p, opts) => _send(p, { headers: hdrs() }, opts),
  post: (p, body, opts) => _send(p, { method: "POST", headers: hdrs({ "Content-Type": "application/json" }), body: JSON.stringify(body || {}) }, opts),
};

// ── A7 · Multi-currency (merchant-controlled pricing) ───────────────────────
// One source of truth for the active display currency. money() converts a EUR
// base amount into the active currency and formats it; the EUR base stays the
// billing/source-of-truth on the server. Selecting a currency re-prices the
// whole UI (components subscribe via onCurrencyChange).
export const CURRENCIES = {
  EUR: { code: "EUR", symbol: "€", rate: 1, locale: "en-IE", label: "EUR" },
  USD: { code: "USD", symbol: "$", rate: 1.08, locale: "en-US", label: "USD" },
  GBP: { code: "GBP", symbol: "£", rate: 0.85, locale: "en-GB", label: "GBP" },
  BRL: { code: "BRL", symbol: "R$ ", rate: 5.39, locale: "pt-BR", label: "BRL" },
};
let _cur = (() => { try { return CURRENCIES[localStorage.getItem("flyxperion_cur")] ? localStorage.getItem("flyxperion_cur") : "EUR"; } catch { return "EUR"; } })();
const _curListeners = new Set();
export function onCurrencyChange(fn) { _curListeners.add(fn); return () => _curListeners.delete(fn); }
export function setCurrency(code) { if (!CURRENCIES[code]) return; _cur = code; try { localStorage.setItem("flyxperion_cur", code); } catch {} _curListeners.forEach(f => { try { f(); } catch {} }); }
export const getCurrency = () => CURRENCIES[_cur] || CURRENCIES.EUR;
export function money(eurAmount, opts = {}) {
  if (eurAmount == null || Number.isNaN(Number(eurAmount))) return "—";
  const c = getCurrency();
  const v = Number(eurAmount) * c.rate;
  const dp = opts.dp != null ? opts.dp : (v % 1 === 0 ? 0 : 2);
  return c.symbol + v.toLocaleString(c.locale, { minimumFractionDigits: dp, maximumFractionDigits: 2 });
}
// EUR() now honours the active currency so every existing call site re-prices.
export const EUR = (n) => money(n);
// Show the EUR reference alongside a non-EUR primary (e.g. "≈ €212"). Empty when EUR is active.
export const eurRef = (n) => getCurrency().code === "EUR" ? "" : `≈ €${Number(n || 0).toLocaleString("en-IE", { minimumFractionDigits: Number(n) % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
export const miles = (n) => Number(n || 0).toLocaleString("en-GB");

// ── B2 · Regional localization (European vs Brazilian Portuguese) ────────────
// A real language layer. The dictionary is curated to surface genuine pt-PT vs
// pt-BR terminology differences (not just accents) so a Brazilian member sees
// Brazilian wording, not European. t(key) resolves against the active language.
export const LANGS = { "en": "English", "pt-PT": "Português (Portugal)", "pt-BR": "Português (Brasil)" };
let _lang = (() => { try { return LANGS[localStorage.getItem("flyxperion_lang")] ? localStorage.getItem("flyxperion_lang") : "en"; } catch { return "en"; } })();
const _langListeners = new Set();
export function onLangChange(fn) { _langListeners.add(fn); return () => _langListeners.delete(fn); }
export function setLang(code) { if (!LANGS[code]) return; _lang = code; try { localStorage.setItem("flyxperion_lang", code); } catch { } _langListeners.forEach(f => { try { f(); } catch { } }); }
export const getLang = () => _lang;
// key: [en, pt-PT, pt-BR]. Bolded entries below differ between PT and BR.
const I18N = {
  book: ["Book", "Reservar", "Reservar"],
  myTrips: ["My Trips", "As minhas viagens", "Minhas viagens"],
  extras: ["Extras", "Extras", "Adicionais"],
  checkIn: ["Check-in", "Check-in", "Check-in"],
  manage: ["Manage booking", "Gerir reserva", "Gerenciar reserva"],
  carryOn: ["Carry-on bag", "Bagagem de mão", "Bagagem de mão"],
  checkedBag: ["Checked bag", "Bagagem de porão", "Bagagem despachada"],
  seat: ["Seat", "Lugar", "Assento"],
  boardingPass: ["Boarding pass", "Cartão de embarque", "Cartão de embarque"],
  gate: ["Gate", "Porta de embarque", "Portão de embarque"],
  breakfast: ["Breakfast", "Pequeno-almoço", "Café da manhã"],
  bus: ["Bus", "Autocarro", "Ônibus"],
  train: ["Train", "Comboio", "Trem"],
  oneWay: ["One way", "Só ida", "Somente ida"],
  roundTrip: ["Round trip", "Ida e volta", "Ida e volta"],
  passenger: ["Passenger", "Passageiro", "Passageiro"],
  payment: ["Payment", "Pagamento", "Pagamento"],
  refund: ["Refund", "Reembolso", "Reembolso"],
  legroom: ["Extra legroom", "Mais espaço para as pernas", "Mais espaço para as pernas"],
  lounge: ["Lounge access", "Acesso ao lounge", "Acesso à sala VIP"],
  window: ["Window seat", "Lugar à janela", "Assento na janela"],
  aisle: ["Aisle seat", "Lugar de coxia", "Assento no corredor"],
  economy: ["Economy", "Económica", "Econômica"],
  wifi: ["Wi-Fi on board", "Wi-Fi a bordo", "Wi-Fi a bordo"],
};
export function t(key) { const e = I18N[key]; if (!e) return key; const idx = _lang === "pt-PT" ? 1 : _lang === "pt-BR" ? 2 : 0; return e[idx] || e[0]; }
export const I18N_TABLE = I18N;
export const MILES_RATE = 0.003; // ~1,000 mi ≈ €3 (matches server)

// Trigger a real client-side file download from in-memory content (used by the booking-
// confirmed quick actions: e-ticket, boarding pass, calendar — #13).
export function downloadFile(filename, content, mime = "text/plain") {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch { return false; }
}
// Minimal RFC-5545 VEVENT so "Add to Calendar" produces a file any calendar app imports.
export function buildICS({ title, start, end, location, description }) {
  const fmt = (d) => { const x = new Date(d); return isNaN(x.getTime()) ? "" : x.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Xperion Airways//FlyTAP//EN", "BEGIN:VEVENT",
    `UID:${Date.now()}@flyxperion`, `DTSTAMP:${fmt(new Date())}`, start ? `DTSTART:${fmt(start)}` : "",
    end ? `DTEND:${fmt(end)}` : "", `SUMMARY:${title || "Xperion flight"}`,
    location ? `LOCATION:${location}` : "", description ? `DESCRIPTION:${description}` : "",
    "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
}

// Tier ladder (demo thresholds; progress is computed from LIVE miles so it's truthful)
export const TIERS = [
  { name: "Silver", at: 0 },
  { name: "Gold", at: 35000 },
  { name: "Platinum", at: 56000 },
];
export function tierProgress(tier, milesBalance) {
  const i = Math.max(0, TIERS.findIndex(t => t.name === tier));
  const next = TIERS[i + 1];
  if (!next) return { next: null, pct: 100, toGo: 0 };
  const base = TIERS[i].at;
  const pct = Math.max(0, Math.min(100, Math.round(((milesBalance - base) / (next.at - base)) * 100)));
  return { next: next.name, pct, toGo: Math.max(0, next.at - milesBalance) };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (iso, withYear = false) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00"); if (isNaN(d)) return iso;
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;
};
export const cityFromMap = (map, code) => (map[code] && map[code].city) || code;
