// FlyTAP v2 — entry. Hash router, shared data load, shell (TopNav + Footer),
// and client-side auth: the home route renders the logged-out Homepage until the
// user logs in via the top-right dialog, then re-renders as the personalized Home.
import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { api, setSessionId, authReady, onCurrencyChange, onLangChange } from "./lib.js";
import { trip, resetTrip, restoreFromSaved, loadTrip, saveTrip, saveTripToBasket, getBasketTrips, syncTripRoute } from "./trip.js";
import { TopNav, Footer } from "./shell.jsx";
import { ROUTES, Placeholder, Homepage, Home } from "./screens.jsx";
import { LoginModal } from "./auth.jsx";
import { AdminConsole } from "./admin.jsx";
import { installWebMCP, uninstallWebMCP } from "./webmcp.js";

function parseHash() {
  const h = (window.location.hash || "#/home").replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  // Params travel through the URL as strings. Structured values (notably the multi-city `legs`
  // array) are written out as JSON by go(), so decode anything that looks like JSON back into a
  // real object/array. Without this, `legs` arrived as "[object Object],[object Object]" and the
  // results page silently fell back to a single origin→dest search.
  const params = Object.fromEntries([...new URLSearchParams(qs || "")].map(([k, v]) => {
    if (typeof v === "string" && (v[0] === "[" || v[0] === "{")) {
      try { return [k, JSON.parse(v)]; } catch { }
    }
    return [k, v];
  }));
  return { route: path || "home", params };
}

function App() {
  const [{ route, params }, setLoc] = useState(parseHash());
  const [shared, setShared] = useState({ profile: null, destinations: [], airports: [], journey: null, suggested: null, loading: true });
  const [loggedIn, setLoggedIn] = useState(() => { try { return localStorage.getItem("flyxperion_auth") === "1"; } catch { return false; } });
  const [showLogin, setShowLogin] = useState(false);
  const [admin, setAdmin] = useState(() => { try { return localStorage.getItem("flyxperion_admin") === "1"; } catch { return false; } });
  const [, _curTick] = useState(0);
  useEffect(() => onCurrencyChange(() => _curTick(n => n + 1)), []);   // A7 — re-price the whole tree when the display currency changes
  useEffect(() => onLangChange(() => _curTick(n => n + 1)), []);       // B2 — re-render strings when the language changes

  useEffect(() => {
    const on = () => { setLoc(parseHash()); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r, p) => {
    // My Trip Basket #2 — auto-park an unfinished trip. When the user leaves the booking flow
    // (flights → cart → passenger → payment / basket) for a page outside it, and there's a trip
    // in progress (a chosen flight, not yet booked), save it to the basket so progress is never
    // lost. It reappears as a trip card and can be resumed or checked out later. Booked trips
    // (pnr set) and the basket page itself are excluded, and we don't duplicate an identical park.
    try {
      const fromRoute = (window.location.hash || "#/home").replace(/^#\/?/, "").split("?")[0] || "home";
      const FLOW = new Set(["results", "cart", "passenger", "payment", "express", "split"]);
      const STAYS_IN_CONTEXT = new Set(["basket", "confirmation", "hold", "passenger", "payment", "cart", "results", "express", "split", "stopover"]);
      if (FLOW.has(fromRoute) && !STAYS_IN_CONTEXT.has(r) && trip.outbound && !trip.pnr) {
        const already = getBasketTrips().some(x => (x.snap?.outbound?.flight?.flight_no || "") === (trip.outbound?.flight?.flight_no || "") && (x.snap?.date || "") === (trip.date || ""));
        if (!already) { saveTripToBasket(); resetTrip(); }
      }
    } catch { }
    const qs = p ? "?" + new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]))).toString() : "";
    window.location.hash = `#/${r}${qs}`;
  }, []);

  const loadShared = useCallback(async (skipBasketRestore = false) => {
    setShared(s => ({ ...s, loading: true }));
    try {
      const [profile, destinations, airports, journey, suggested, basket] = await Promise.all([
        api.get("/profile").catch(() => null),
        api.get("/destinations").catch(() => []),
        api.get("/airports").catch(() => []),
        api.get("/journey").catch(() => null),
        api.get("/routes/suggested").catch(() => null),
        api.get("/basket").catch(() => null),
      ]);
      // Resume an abandoned, still-open basket so a returning member sees their saved
      // add-ons (and the nav count) without re-doing anything. Skipped on a refresh that
      // already has a richer in-progress trip in localStorage (#4) — that one wins.
      if (!skipBasketRestore && basket?.status === "open") restoreFromSaved(basket);
      setShared({ profile, destinations, airports, journey, suggested, basket, loading: false });
    } catch { setShared(s => ({ ...s, loading: false })); }
  }, []);

  // Boot (#4 session persistence): re-apply the saved persona to the server so the
  // member's identity survives a hard refresh, hydrate shared data, then restore any
  // in-progress trip (cart/flights/passengers) from localStorage. Local state takes
  // precedence over the server basket so nothing the user entered is lost on refresh.
  useEffect(() => {
    (async () => {
      let hasLocal = false;
      try {
        hasLocal = !!localStorage.getItem("flyxperion_trip");
        // Server sessions are in-memory and clear on restart, so a stored sid is unreliable.
        // RE-LOGIN from the saved credential (persona or registrant email) to mint a fresh
        // binding; setSessionId on success, clear it on failure (so we never act stale).
        const authed = localStorage.getItem("flyxperion_auth") === "1";
        let body = null;
        const saved = localStorage.getItem("flyxperion_login");
        if (saved) { try { body = JSON.parse(saved); } catch { body = null; } }
        if (!body) { const p = localStorage.getItem("flyxperion_persona"); if (p) body = { persona: p }; }   // back-compat
        if (authed && body) {
          try { const r = await api.post("/auth/login", body, { ungated: true }); setSessionId(r && r.ok && r.sessionId ? r.sessionId : null); }
          catch { setSessionId(null); }
        } else { setSessionId(null); }
      } catch {}
      finally { authReady(); }   // open the boot gate on every path — parked api.* now fire with the resolved session
      await loadShared(hasLocal);
      loadTrip();
    })();
  }, [loadShared]);

  // Persist the in-progress trip on tab close/refresh so a reload restores it (#4).
  useEffect(() => {
    const on = () => saveTrip();
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, []);

  // Always land at the top of a new page, and after login the personalized home
  // commits before this runs, so the user starts at the hero — not mid-page (#5).
  useEffect(() => { requestAnimationFrame(() => window.scrollTo({ top: 0 })); }, [route, loggedIn]);

  // Log in via the canonical /api/auth/login — by persona (the 5 known) or by email
  // (registrants 6–15). Capture the returned sessionId and bind it BEFORE loadShared so
  // every subsequent request resolves to THIS user. Throws on failure (the modal shows it).
  // Cart semantics: a basket built before signing in belongs to the same person at the
  // same browser, so signing in must CARRY it over, not bin it. Only a completed booking
  // (trip.pnr) or an genuinely empty cart resets. When we carry a cart we also skip the
  // server-side basket restore so the member's older saved basket can't clobber it.
  const carryCart = () => !trip.pnr && !!(trip.outbound || trip.inbound || trip.extras.length);

  const handleLogin = useCallback(async ({ persona, email } = {}) => {
    const keep = carryCart();
    if (!keep) resetTrip();   // empty cart (or a finished booking) → clean member context
    const body = persona ? { persona } : { email };
    const r = await api.post("/auth/login", body).catch(() => null);
    if (!r || !r.ok || !r.sessionId) throw new Error((r && r.error) || "Couldn't log in — check the email or member.");
    setSessionId(r.sessionId);
    await loadShared(keep);   // keep=true → don't let the saved server basket overwrite the carried cart
    try { localStorage.setItem("flyxperion_auth", "1"); localStorage.setItem("flyxperion_login", JSON.stringify(body)); localStorage.removeItem("flyxperion_persona"); } catch {}
    setLoggedIn(true); setShowLogin(false); go("home"); window.scrollTo({ top: 0 });
  }, [loadShared, go]);

  // Register a brand-new visitor (anonymous slot 6–15) → bind their fresh session, then
  // they accrue their own history. Re-login on boot is by email (their row persists).
  const handleRegister = useCallback(async ({ first_name, email, phone, home_airport }) => {
    const keep = carryCart();   // guest → registered is still the same shopper; keep their basket
    if (!keep) resetTrip();
    const r = await api.post("/auth/register", { first_name, email, phone, home_airport }).catch(() => null);
    if (!r || !r.ok || !r.sessionId) throw new Error((r && r.error) || "Couldn't register — try a different email.");
    setSessionId(r.sessionId);
    await loadShared(keep);   // carried guest basket wins over any older saved basket
    try { localStorage.setItem("flyxperion_auth", "1"); localStorage.setItem("flyxperion_login", JSON.stringify({ email })); localStorage.removeItem("flyxperion_persona"); } catch {}
    setLoggedIn(true); setShowLogin(false); go("home"); window.scrollTo({ top: 0 });
  }, [loadShared, go]);

  // Operator sign-in → dedicated Admin Console (full-page). Binds an admin session so the
  // ops + all-users endpoints authorize; persona UI is bypassed entirely.
  const handleAdminLogin = useCallback(async ({ password }) => {
    const r = await api.post("/admin/login", { password }).catch(() => null);
    if (!r || !r.ok || !r.sessionId) throw new Error((r && r.error) || "Admin sign-in failed.");
    setSessionId(r.sessionId);
    try { localStorage.setItem("flyxperion_admin", "1"); localStorage.setItem("flyxperion_adminsid", r.sessionId); localStorage.removeItem("flyxperion_auth"); localStorage.removeItem("flyxperion_login"); localStorage.removeItem("flyxperion_persona"); } catch {}
    setShowLogin(false); setLoggedIn(false); setAdmin(true); window.scrollTo({ top: 0 });
  }, []);
  const adminLogout = useCallback(() => {
    try { api.post("/auth/logout", {}); } catch {}
    setSessionId(null);
    try { localStorage.removeItem("flyxperion_admin"); localStorage.removeItem("flyxperion_adminsid"); } catch {}
    setAdmin(false); go("home");
  }, [go]);

  // Re-bind a persisted admin session on reload so a refresh keeps the operator signed in.
  useEffect(() => { if (admin) { try { const s = localStorage.getItem("flyxperion_adminsid"); if (s) setSessionId(s); } catch {} } }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Route/itinerary consistency — the header route (trip.origin/dest) and the flight card
  // (trip.outbound's flight) must never disagree. If a stale flight from a previous, unrelated
  // search is still attached when the searched route has changed (e.g. header AMS–JFK while the
  // flight card shows DEL–JFK), drop it so every section reflects the same itinerary and the user
  // is prompted to pick the correct flight. Runs on every navigation, so no page can render a mismatch.
  useEffect(() => { syncTripRoute(); }, [route, shared.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // WebMCP — publish the 27-tool contract to in-browser AI agents. Registered
  // once for the app's lifetime; the handlers read live trip state at call time,
  // so nothing needs re-registering per route. On a browser without WebMCP (and
  // without the polyfill) installWebMCP() is a no-op and v2 is unchanged.
  useEffect(() => { installWebMCP(); return uninstallWebMCP; }, []);

  if (admin) return <AdminConsole onLogout={adminLogout} />;
  let Screen, entry = ROUTES[route] || ROUTES.home;
  if (route === "home") Screen = loggedIn ? Home : Homepage;
  else Screen = entry.comp;

  return (
    <div className="min-h-screen flex flex-col bg-surface-soft">
      <TopNav route={route} go={go} profile={shared.profile} loggedIn={loggedIn}
        onLogin={() => setShowLogin(true)} onLogout={() => { try { api.post("/auth/logout", {}); } catch {} setSessionId(null); try { localStorage.removeItem("flyxperion_auth"); localStorage.removeItem("flyxperion_persona"); localStorage.removeItem("flyxperion_login"); } catch {} resetTrip(); setLoggedIn(false); go("home"); }} />
      <main className="flex-1 overflow-x-clip">
        {Screen
          ? <Screen shared={shared} params={params} go={go} />
          : <Placeholder title={entry.title} phase={entry.phase} plan={entry.plan} reuses={entry.reuses} go={go} />}
      </main>
      <Footer />
      {showLogin && <LoginModal profile={shared.profile} onClose={() => setShowLogin(false)}
        onLogin={handleLogin} onRegister={handleRegister} onAdminLogin={handleAdminLogin} />}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
