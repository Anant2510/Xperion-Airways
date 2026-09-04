// FlyTAP v2 — login. Login is reached from the home screen's top-right button:
// it opens this dialog (username + password). On submit the user is logged in and
// the SAME home route re-renders as the personalized view (no separate login page).
// Credentials are cosmetic in the demo (the active persona is user_id=1); any
// password works and the field is prefilled for a one-click demo.
import React, { useState, useEffect } from "react";
import { Btn, Icon, TierBadge } from "./ui.jsx";
import { api } from "./lib.js";
import { TapLogo } from "./shell.jsx";

// Each demo persona has a distinct identity. Match the entered email / member number to a
// persona so logging in as Daniel actually switches the live record to Daniel. (Previously
// login ignored the field and signed you in as whatever persona was last active — which is
// why entering Daniel's email still showed Lars.)
const ACCOUNTS = {
  "anant.direct2links+daniel@gmail.com": "daniel", "pt-990001": "daniel", "daniel": "daniel", "daniel ferreira": "daniel",
  "anant.direct2links+sofia@gmail.com": "sofia", "pt-990002": "sofia", "sofia": "sofia", "sofia marques": "sofia",
  "anant.direct2links+lars@gmail.com": "lars", "de-100294": "lars", "de-990003": "lars", "lars": "lars", "lars andersen": "lars",
  "anant.direct2links+maria@gmail.com": "maria", "pt-990004": "maria", "maria": "maria", "maria costa": "maria",
  "anant.direct2links+james@gmail.com": "james", "gb-990005": "james", "james": "james", "james bennett": "james",
};
function resolvePersona(v) {
  const k = (v || "").trim().toLowerCase();
  if (!k) return null;
  if (ACCOUNTS[k]) return ACCOUNTS[k];
  // Lenient demo matching: any email whose local-part names a member resolves to them
  // (e.g. daniel@flyxperion.demo, sofia@anything). Exact seeded emails, names, full names
  // and member numbers all still work.
  const local = k.split("@")[0].replace(/[._-].*$/, "");   // "daniel.ferreira" → "daniel"
  if (ACCOUNTS[local]) return ACCOUNTS[local];
  const compact = k.replace(/[\s-]/g, "");                  // "pt884512" → matches "pt-884512"
  for (const key in ACCOUNTS) if (key.replace(/[\s-]/g, "") === compact) return ACCOUNTS[key];
  return null;
}

// One-tap demo sign-in so any of the three members can be reached without typing the exact
// email (which is why login kept defaulting to whoever was active — usually Daniel).
const DEMO = [
  { id: "daniel", name: "Daniel Ferreira", tier: "Gold", hub: "Porto · OPO", email: "anant.direct2links+daniel@gmail.com" },
  { id: "sofia", name: "Sofia Marques", tier: "Silver", hub: "Lisbon · LIS", email: "anant.direct2links+sofia@gmail.com" },
  { id: "lars", name: "Lars Andersen", tier: "Platinum", hub: "Frankfurt · FRA", email: "anant.direct2links+lars@gmail.com" },
  { id: "maria", name: "Maria Costa", tier: "Bronze", hub: "Lisbon · LIS", email: "anant.direct2links+maria@gmail.com" },
  { id: "james", name: "James Bennett", tier: "Gold", hub: "London · LHR", email: "anant.direct2links+james@gmail.com" },
];

export function LoginModal({ profile, onClose, onLogin, onRegister, onAdminLogin }) {
  // Two modes: log in (one of the 5 known personas, OR a registrant by email) and register
  // (a brand-new anonymous slot 6–15). Start blank — never prefill from the active member.
  const [mode, setMode] = useState("login");   // "login" | "register" | "admin"
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("demo");
  const [adminPw, setAdminPw] = useState("");
  // register fields
  const [firstName, setFirstName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [home, setHome] = useState("LIS");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // One-tap chips are data-driven from /api/personas so EVERY seeded persona appears
  // (not just the original 5). Falls back to the hardcoded seed list if the call fails.
  const [demoList, setDemoList] = useState(DEMO);
  useEffect(() => {
    let alive = true;
    api.get("/personas").then(d => {
      if (!alive || !d || !Array.isArray(d.personas) || !d.personas.length) return;
      const CITY = { OPO: "Porto", LIS: "Lisbon", FRA: "Frankfurt", LHR: "London", GRU: "São Paulo", BOS: "Boston", JFK: "New York", MAD: "Madrid", CDG: "Paris", FCO: "Rome", BCN: "Barcelona" };
      setDemoList(d.personas.map(p => ({ id: p.id, name: p.label || p.id, tier: p.tier, hub: (CITY[p.home] ? CITY[p.home] + " · " : "") + (p.home || "") })));
    }).catch(() => { });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  // Centralized: run an auth action, surface any thrown error (e.g. 404 unknown / 409 full).
  const run = async (fn) => {
    if (busy) return;
    setErr(""); setBusy(true);
    try { await fn(); } catch (e) { setErr((e && e.message) || "Something went wrong — try again."); }
    finally { setBusy(false); }
  };

  // Log in: a known persona resolves to {persona}; anything else is tried as a registrant
  // {email} so members 6–15 can sign in too. The server rejects truly-unknown identities.
  // Resolve a typed identity: the known seed accounts via ACCOUNTS, plus ANY fetched
  // persona matched by id, first name, or full name (so doc personas sign in by typing too).
  const resolveAny = (v) => {
    const hit = resolvePersona(v); if (hit) return hit;
    const k = (v || "").trim().toLowerCase(); if (!k) return null;
    const local = k.split("@")[0].replace(/[._-].*$/, "");
    const m = demoList.find(d => d.id === k || d.id === local || (d.name || "").toLowerCase() === k || (d.name || "").toLowerCase().split(" ")[0] === local);
    return m ? m.id : null;
  };
  const submitLogin = (e) => {
    e?.preventDefault?.();
    const v = (email || "").trim();
    if (!v) { setErr("Enter your email or member number."); return; }
    const id = resolveAny(v);
    run(() => onLogin(id ? { persona: id } : { email: v }));
  };
  const loginChip = (d) => run(() => onLogin({ persona: d.id }));

  const submitRegister = (e) => {
    e?.preventDefault?.();
    const fn = (firstName || "").trim(), em = (regEmail || "").trim();
    if (!fn || !em) { setErr("First name and email are required."); return; }
    run(() => onRegister({ first_name: fn, email: em, phone: (phone || "").trim() || undefined, home_airport: (home || "LIS").trim().toUpperCase() }));
  };
  const submitAdmin = (e) => {
    e?.preventDefault?.();
    if (!adminPw.trim()) { setErr("Enter the admin password."); return; }
    run(() => onAdminLogin({ password: adminPw }));
  };

  const swap = (m) => { setMode(m); setErr(""); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[380px] max-h-[90vh] overflow-y-auto bg-surface rounded-2xl shadow-pop border border-line p-6 v2-in">
        <button onClick={onClose} className="absolute top-3 right-3 p-1.5 rounded-lg text-ink-faint hover:bg-surface-mute" aria-label="Close">✕</button>
        <TapLogo />

        {mode === "login" ? (<>
          <h2 className="text-[20px] font-bold mt-4">Log in to your account</h2>
          <p className="text-[12px] text-ink-muted mt-1">Welcome back — pick up your trips, Xperion Miles and saved preferences.</p>
          <form className="mt-5 space-y-3" onSubmit={submitLogin}>
            <label className="block">
              <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">Email or member number</span>
              <input value={email} onChange={e => { setEmail(e.target.value); if (err) setErr(""); }} autoFocus
                placeholder="daniel@flyxperion.demo, a name, or member no."
                className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] focus:border-tap-green outline-none" />
            </label>
            <label className="block">
              <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">Password</span>
              <input type="password" value={pw} onChange={e => setPw(e.target.value)}
                className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] focus:border-tap-green outline-none" />
            </label>
            <div className="flex items-center justify-between text-[12px]">
              <label className="flex items-center gap-1.5 text-ink-muted"><input type="checkbox" defaultChecked className="accent-[#46a41a]" /> Keep me signed in</label>
              <a className="text-tap-greenDeep font-semibold">Forgot password?</a>
            </div>
            {err && <div className="rounded-lg bg-tap-red/10 text-tap-red text-[12px] font-medium px-3 py-2">{err}</div>}
            <Btn size="lg" className="w-full" type="submit" disabled={busy}>{busy ? "Signing in…" : <>Log in <Icon name="arrow" size={14} /></>}</Btn>
          </form>
          <div className="mt-5 pt-4 border-t border-line">
            <div className="text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-2">Demo accounts · one-tap sign-in</div>
            <div className="space-y-1.5">
              {demoList.map(d => (
                <button key={d.id} disabled={busy} onClick={() => loginChip(d)}
                  className="w-full flex items-center justify-between rounded-xl border border-line-strong px-3 py-2.5 text-left hover:border-tap-green disabled:opacity-50 transition-colors">
                  <span><span className="text-[13px] font-semibold">{d.name}</span><span className="block text-[11px] text-ink-faint">{d.hub}</span></span>
                  <TierBadge tier={d.tier} />
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 text-[11px] text-ink-faint text-center">New to Xperion? <button onClick={() => swap("register")} className="text-tap-greenDeep font-semibold">Create an account</button> · <button onClick={() => swap("admin")} className="text-ink-slate font-semibold hover:text-ink">Admin console</button></div>
        </>) : mode === "admin" ? (<>
          <h2 className="text-[20px] font-bold mt-4">Admin console</h2>
          <p className="text-[12px] text-ink-muted mt-1">Operator sign-in — full DB visibility and disruption / pricing control.</p>
          <form className="mt-5 space-y-3" onSubmit={submitAdmin}>
            <label className="block">
              <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">Admin password</span>
              <input type="password" value={adminPw} onChange={e => { setAdminPw(e.target.value); if (err) setErr(""); }} autoFocus placeholder="••••••" className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] focus:border-tap-green outline-none" />
            </label>
            {err && <div className="rounded-lg bg-tap-red/10 text-tap-red text-[12px] font-medium px-3 py-2">{err}</div>}
            <Btn size="lg" className="w-full" type="submit" disabled={busy}>{busy ? "Signing in…" : <>Enter Admin Console <Icon name="arrow" size={14} /></>}</Btn>
          </form>
          <div className="mt-4 text-[11px] text-ink-faint text-center">Not an operator? <button onClick={() => swap("login")} className="text-tap-greenDeep font-semibold">Member log in</button></div>
        </>) : (<>
          <h2 className="text-[20px] font-bold mt-4">Create your account</h2>
          <p className="text-[12px] text-ink-muted mt-1">Start fresh — your trips, searches and Xperion Miles build as you go.</p>
          <form className="mt-5 space-y-3" onSubmit={submitRegister}>
            <label className="block">
              <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">First name</span>
              <input value={firstName} onChange={e => { setFirstName(e.target.value); if (err) setErr(""); }} autoFocus
                placeholder="Your name"
                className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] focus:border-tap-green outline-none" />
            </label>
            <label className="block">
              <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">Email</span>
              <input value={regEmail} onChange={e => { setRegEmail(e.target.value); if (err) setErr(""); }}
                placeholder="you@example.com"
                className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] focus:border-tap-green outline-none" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">Phone <span className="text-ink-faint normal-case font-medium">(optional)</span></span>
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+351 …"
                  className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] focus:border-tap-green outline-none" />
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold tracking-wide uppercase text-ink-slate mb-1">Home airport</span>
                <input value={home} onChange={e => setHome(e.target.value)} placeholder="LIS" maxLength={3}
                  className="w-full bg-surface border border-line-strong rounded-xl px-3 py-2.5 text-[14px] uppercase focus:border-tap-green outline-none" />
              </label>
            </div>
            {err && <div className="rounded-lg bg-tap-red/10 text-tap-red text-[12px] font-medium px-3 py-2">{err}</div>}
            <Btn size="lg" className="w-full" type="submit" disabled={busy}>{busy ? "Creating…" : <>Create account <Icon name="arrow" size={14} /></>}</Btn>
          </form>
          <div className="mt-4 text-[11px] text-ink-faint text-center">Already have an account? <button onClick={() => swap("login")} className="text-tap-greenDeep font-semibold">Log in</button></div>
        </>)}
      </div>
    </div>
  );
}
