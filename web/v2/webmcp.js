// FlyTAP v2 — WebMCP surface.
//
// Publishes the full 27-tool agent contract to in-browser AI agents (Gemini in
// Chrome, Copilot in Edge, any WebMCP client) so they can operate the v2 site
// directly instead of scraping the DOM.
//
// ── Design ───────────────────────────────────────────────────────────────────
// Tools are NOT reimplemented here. Every handler posts to /api/ai/tool, which
// runs the same agentRunTool() against the same tenant adapter that the v2 chat
// (/api/ai/agent) and the WhatsApp webhook already use. One implementation, one
// session, three surfaces — nothing to keep in sync.
//
// What this file adds on top of a plain API call is the thing only in-page code
// can do: it projects the tool's result onto the client trip state in trip.js
// and drives the hash router. So when an agent adds a bag, the nav basket badge
// ticks, the right-rail summary re-prices and the cart screen updates — because
// trip.js's notify() pub/sub fires, exactly as it does for a human click.
//
// The schemas come from GET /api/ai/tools at boot rather than a local copy, so
// a change to AGENT_TOOLS in server.js reaches browser agents on next load, and
// a tenant whose adapter implements only part of the contract (nordvind: 18/27)
// publishes only what it can actually fulfil.
//
// ── Spec note ────────────────────────────────────────────────────────────────
// The registration getter moved from Navigator to Document in the May 2026
// draft; Chrome 150 deprecated navigator.modelContext. We resolve document
// first, then navigator, then give up silently — on a browser with neither this
// module is inert and v2 behaves exactly as it does today.

import { api } from "./lib.js";
import {
  trip, setLeg, toggleExtra, setFareHold, syncTripRoute,
  tripSnapshot, pingBasket,
} from "./trip.js";

/* ── host resolution ─────────────────────────────────────────────────────── */

function host() {
  if (typeof document !== "undefined" && "modelContext" in document) return document.modelContext;
  if (typeof navigator !== "undefined" && "modelContext" in navigator) return navigator.modelContext;
  return null;
}

export const isSupported = () => !!host();

/* ── agent session identity ──────────────────────────────────────────────── */
// The server keys agent state (lastSearch, selected, pending confirmations) by
// `${tenant}::${sessionId}`. ai.jsx currently mints a random key per mount, so
// its state dies on reload and is never shared. We persist one key instead, so
// a browser agent picks up where the customer left off — and so the chat can
// share it by reading the same value (see README note).
const SKEY = "flyxperion_agent_sid";
function agentSessionId() {
  try {
    let v = localStorage.getItem(SKEY);
    if (!v) { v = "v2-" + Math.random().toString(36).slice(2, 10); localStorage.setItem(SKEY, v); }
    return v;
  } catch { return "v2-web"; }
}

/* ── MCP result envelopes ────────────────────────────────────────────────── */
// Agents read `content`; we also return `structuredContent` so a client that
// understands it can use the object rather than re-parsing the JSON text.
const wrap = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
  structuredContent: obj,
});
const fail = (message) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/* ── navigation ──────────────────────────────────────────────────────────── */
// buildUI() speaks in screen names from the v1 app. Map them onto v2 routes
// (see ROUTES in screens.jsx). Kept as data so it is obvious what an agent can
// make the page do.
const SCREEN_ROUTE = {
  search: "results",
  manage: "basket",      // parity with ai.jsx, which opens the basket for "manage"
  seatmap: "seatchange",
  miles: "miles",
  confirmation: "confirmation",
  express: "express",
};

// list_seats emits navigate→"miles", which is why asking about seats currently
// moves the page to Frequent Flyer (a known defect: navigation is attached to
// the tool, not to intent). Fixing it at source in server.js buildUI() would
// also fix the chat — worth doing separately.
//
// Where the seat picker actually lives is context-dependent, and getting this
// wrong is worse than the original bug:
//   • pre-purchase — the picker is the cart's "01 · Seats & baggage" module
//   • post-purchase — it is the SeatChange screen at #/seatchange
// SeatChange opens with useActiveBooking(), i.e. the CONFIRMED booking. Sending
// a customer there while a cart is in progress shows them a seat map for a
// different journey entirely (the old PNR, already checked in) while the agent
// says "here are your seats" — confidently wrong, which is worse than landing
// on the wrong tab.
//
// list_seats itself is flight-agnostic: it returns cabin availability from the
// static SEAT_CABINS model plus session.selected?.seat. It never looked up a
// booking. The journey mismatch was always navigation, never the tool.
function seatRoute() {
  return (trip.outbound && !trip.pnr) ? "cart" : "seatchange";
}
const SCREEN_OVERRIDE = { list_seats: seatRoute };

function goto(route, params) {
  if (!route) return null;
  const qs = params && Object.keys(params).length
    ? "?" + new URLSearchParams(params).toString() : "";
  window.location.hash = "#/" + route + qs;
  return route;
}

function applyCommand(toolName, command, result) {
  if (SCREEN_OVERRIDE[toolName]) return goto(SCREEN_OVERRIDE[toolName]());
  if (!command) return null;
  switch (command.action) {
    case "show_search":
      return goto("results", { origin: command.origin, dest: command.dest, ...(command.date ? { date: command.date } : {}) });
    case "select_flight":   return goto("cart");
    case "show_confirmation": return goto("confirmation");
    case "express":         return goto("express");
    case "resume":          return goto(result?.stage === "seat" ? "seatchange" : "cart");
    case "navigate":        return goto(SCREEN_ROUTE[command.screen] || command.screen);
    default:                return null;
  }
}

/* ── client state projection ─────────────────────────────────────────────── */
// The server owns booking truth; trip.js owns what the customer is looking at.
// These functions are the bridge, and they are the whole reason for running the
// tool in the page rather than calling the API from outside it.

let _lastFlights = [];   // cache from the most recent search, so select_flight
                         // does not need a second round trip in the common case

async function flightObject(flight_no) {
  const hit = _lastFlights.find(f => f.flight_no === flight_no);
  if (hit && hit.price != null) return hit;
  if (!trip.origin || !trip.dest) return null;
  try {
    const r = await api.get(
      `/search?origin=${trip.origin}&dest=${trip.dest}${trip.date ? "&date=" + trip.date : ""}&pax=${trip.pax || 1}`
    );
    return (r.flights || []).find(f => f.flight_no === flight_no) || null;
  } catch { return null; }
}

// Replace trip.extras with the server's authoritative item list, preserving the
// category and source metadata the UI groups by (extrasBySource / byCategory).
function syncExtras(items) {
  if (!Array.isArray(items)) return;
  const prior = new Map(trip.extras.map(e => [e.code, e]));
  const next = items.map(it => {
    const was = prior.get(it.code);
    return {
      code: it.code,
      name: it.name || (was && was.name) || it.code,
      price: it.price != null ? it.price : (was ? was.price : 0),
      qty: (was && was.qty) || 1,
      cat: (was && was.cat) || "Extras",
      source: (was && was.source) || "recommended",
    };
  });
  trip.extras.length = 0;
  trip.extras.push(...next);
  pingBasket();   // notify() → nav badge, right rail, cart screen all re-render
}

const PROJECT = {
  async search_flights(r) {
    if (!r.ok) return;
    // The tool result's flights carry no origin/dest — the route lives one level
    // up on the result. /api/search returns them per-flight, and syncTripRoute()
    // compares trip.outbound.flight.origin/dest against the searched route, so a
    // flight cached without them gets dropped as "stale" the next time anything
    // calls syncTripRoute(). Stamp the route on as we cache.
    _lastFlights = (r.flights || []).map(f => ({ ...f, origin: r.origin, dest: r.dest }));
    trip.origin = r.origin; trip.dest = r.dest;
    if (r.date) trip.date = r.date;
    syncTripRoute();
    pingBasket();
  },

  async select_flight(r) {
    if (!r.ok) return;
    const f = await flightObject(r.flight_no);
    // setLeg fires notify(); without the flight object the cart cannot price it,
    // so fall back to a minimal shape built from the tool result. origin/dest are
    // forced on either way — syncTripRoute() drops any outbound whose flight does
    // not carry the searched route.
    setLeg("outbound", {
      flight: {
        flight_no: r.flight_no, dep: r.dep, arr: r.arr, price: r.price,
        ...(f || {}),
        origin: (f && f.origin) || trip.origin,
        dest: (f && f.dest) || trip.dest,
      },
      fare: trip.outbound?.fare || "Classic",
      price: r.price,
    });
  },

  async add_extras(r)    { if (r.ok) syncExtras(r.items); },
  async remove_extras(r) { if (r.ok) syncExtras(r.items); },

  async change_seat(r) {
    if (!r.ok) return;
    trip.seat = r.seat;
    // A paid seat is a basket line; keep it visible alongside the other extras.
    if (!r.included && r.price) {
      toggleExtra({ code: "seat", name: `Seat ${r.seat}`, price: r.price, cat: "Seats", source: "user" });
    } else {
      pingBasket();
    }
  },

  async hold_fare(r) {
    if (!r.ok) return;
    setFareHold({ flight_no: r.flight_no, price: r.price, duration: r.duration, expires_at: r.expires_at });
  },

  async checkout(r) { if (r.ok) { trip.pnr = r.pnr; pingBasket(); } },

  async park_trip(r) { if (r.ok) pingBasket(); },

  async get_journey(r) {
    if (!r.ok || !r.in_progress) return;
    if (r.origin) trip.origin = r.origin;
    if (r.dest) trip.dest = r.dest;
    if (r.date) trip.date = r.date;
    syncTripRoute();
    pingBasket();
  },

  async express_usual(r) {
    if (!r.ok) return;
    trip.origin = r.origin; trip.dest = r.dest;
    if (r.recommendedDate) trip.date = r.recommendedDate;
    syncTripRoute();
  },
};

/* ── confirmation gate ───────────────────────────────────────────────────── */
// Tools run in the page as the signed-in user, so a single hallucinated or
// injected call must never be able to charge or cancel. The server already
// returns state:"needs_confirm" first for cancel/upgrade/split; this gate makes
// that non-bypassable from the browser: confirm:true is only forwarded if THIS
// page has actually seen a needs_confirm for the same tool. checkout has no
// confirm flag in the server contract, so we add one client-side and require it.
const CONFIRM_REQUIRED = new Set(["cancel_booking", "upgrade_cabin", "split_booking", "checkout"]);
const pending = new Map();   // tool name → the input that produced needs_confirm

function confirmGate(name, input) {
  if (!CONFIRM_REQUIRED.has(name)) return null;
  const asked = input.confirm === true;

  if (name === "checkout") {
    if (!asked) {
      const snap = tripSnapshot();
      if (!snap.outbound) return fail("Nothing to check out — no flight selected.");
      pending.set(name, input);
      return wrap({
        state: "needs_confirm",
        message: "This will charge the customer. Ask them to confirm, then call again with confirm=true.",
        flight: snap.outbound?.flight?.flight_no,
        route: `${snap.origin}→${snap.dest}`,
        extras: (snap.extras || []).map(e => e.name),
      });
    }
    if (!pending.has(name)) {
      return fail("Call checkout without confirm first, show the customer what will be charged, and only then call again with confirm=true.");
    }
    pending.delete(name);
    return null;   // proceed; the server contract ignores the extra flag
  }

  if (asked && !pending.has(name)) {
    return fail(`${name} is irreversible. Call it without confirm first to get the confirmation details, show them to the customer, then call again with confirm=true.`);
  }
  if (asked) pending.delete(name);
  return null;
}

/* ── the call path ───────────────────────────────────────────────────────── */

async function runTool(name, input) {
  const gated = confirmGate(name, input || {});
  if (gated) return gated;

  let out;
  try {
    // api.post prefixes /api and attaches X-Session-Id, so the server resolves
    // the same customer the page is logged in as.
    out = await api.post("/ai/tool", { name, input: input || {}, sessionId: agentSessionId() });
  } catch (e) {
    return fail(`${name} could not reach the server: ${e.message}`);
  }
  if (!out || out.ok === false) {
    return fail(out?.message || out?.error || `${name} failed.`);
  }

  const result = out.result || {};

  // Remember a server-issued confirmation request so the follow-up is allowed.
  if (result.state === "needs_confirm") pending.set(name, input || {});

  // Project onto client state, then move the page. Projection failures must not
  // lose the agent's result, so they are contained.
  try { if (PROJECT[name]) await PROJECT[name](result); }
  catch (e) { console.warn("[webmcp] projection failed for", name, e); }

  let navigated = null;
  try { navigated = applyCommand(name, out.command, result); }
  catch (e) { console.warn("[webmcp] navigation failed for", name, e); }

  // Hand the agent the tool result plus what the page did about it — so it can
  // say "I've put that in your cart" truthfully rather than guessing.
  return wrap({ ...result, _ui: { navigated_to: navigated, card: out.cards?.[0]?.type || null } });
}

/* ── registration ────────────────────────────────────────────────────────── */

// checkout gains a confirm flag that the server schema does not declare, so the
// advertised schema has to say so or an agent will never send it.
function schemaFor(tool) {
  const s = JSON.parse(JSON.stringify(tool.input_schema || { type: "object", properties: {} }));
  if (tool.name === "checkout") {
    s.properties = s.properties || {};
    s.properties.confirm = {
      type: "boolean",
      description: "Must be true to actually charge. Call once without it to get the amount, show the customer, then call again with confirm=true.",
    };
  }
  return s;
}

let _installed = [];

export async function installWebMCP(opts = {}) {
  const mc = host();
  if (!mc) return () => {};
  if (_installed.length) return uninstallWebMCP;   // idempotent across HMR / remounts

  let contract;
  try {
    contract = await api.get("/ai/tools");
  } catch (e) {
    console.warn("[webmcp] could not load the tool contract:", e.message);
    return () => {};
  }

  const skip = new Set(opts.exclude || []);
  const tools = (contract.tools || [])
    .filter(t => t.implemented && !skip.has(t.name))
    .map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: schemaFor(t),
      execute: (input) => runTool(t.name, input),
      // Some clients read `handler` rather than `execute`; publishing both keeps
      // us compatible with the polyfill and with Chrome's native implementation.
      handler: (input) => runTool(t.name, input),
    }));

  for (const t of tools) {
    try { mc.registerTool(t); _installed.push(t.name); }
    catch (e) { console.warn("[webmcp]", t.name, e.message); }
  }

  console.info(
    `[webmcp] ${_installed.length}/${(contract.tools || []).length} tools registered for tenant "${contract.tenant}"`
  );
  return uninstallWebMCP;
}

export function uninstallWebMCP() {
  const mc = host();
  if (!mc) return;
  for (const name of _installed) { try { mc.unregisterTool(name); } catch {} }
  _installed = [];
  pending.clear();
}

/* ── screen-scoped tools ─────────────────────────────────────────────────── */
// Register from the component that owns a screen, so a tool only exists while
// the customer is on the page it acts on. Keeps the published tool list small
// and unambiguous, and stops an agent acting on a screen nobody is looking at.
//
//   useEffect(() => registerScreenTool({
//     name: "pick_seat_on_map",
//     description: "Select a specific seat on the seat map currently open.",
//     inputSchema: { type: "object", properties: { seat: { type: "string" } }, required: ["seat"] },
//     execute: async ({ seat }) => { setSeat(seat); return { content: [{ type: "text", text: `Selected ${seat}` }] }; },
//   }), []);
export function registerScreenTool(tool) {
  const mc = host();
  if (!mc) return () => {};
  const t = { ...tool, handler: tool.handler || tool.execute };
  try { mc.registerTool(t); } catch (e) { console.warn("[webmcp]", tool.name, e.message); }
  return () => { try { mc.unregisterTool(tool.name); } catch {} };
}

/* ── screen-scoped: the open seat map ────────────────────────────────────── */
// The contract tools operate on booking state. They cannot see or answer the
// decisions the SEAT MAP SCREEN itself asks for — which cabin tab is open, which
// passenger is active, whether the chosen row needs an exit-row declaration,
// whether Confirm is even reachable. Without these an agent picks a seat via
// change_seat, the screen shows something else, and the customer is stranded in
// front of a Confirm button the agent cannot reach.
//
// Registered by SeatChange's own effect and torn down on unmount, so these exist
// only while that screen is open. Pass a GETTER, not values: seatByPax and
// activePax change every render, and a closure captured at registration time
// would go stale on the first click.
//
//   const wm = useRef(null);
//   wm.current = { booking, C, cabinKey, CABINS, taken, sel, setSel, safeSeat,
//                  paxList, activePax, setActivePax, eligOk, setEligOk,
//                  feeOf, isExit, canConfirm, confirm, setCabin, done };
//   useEffect(() => registerSeatMapTools(() => wm.current), []);

const seatConfirmPending = { armed: false };

const _screenTools = new Map();   // name → execute, for console access without a host

export function registerSeatMapTools(getCtx) {
  const mc = host();

  const freeSeatsIn = (C, taken) =>
    C.rows.flatMap(r => C.cols.map(col => `${r}${col}`)).filter(s => !taken.has(s));

  const tools = [
    {
      name: "seat_map_state",
      description:
        "Read the seat map currently open on screen: the booking it belongs to, the " +
        "cabin tab in view, the active passenger, their current seat, which seats are " +
        "free, and what is blocking confirmation. Read-only. Call this before picking " +
        "a seat so you describe the map the customer is actually looking at.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const c = getCtx();
        if (!c || !c.booking) return fail("The seat map is not open.");
        const free = freeSeatsIn(c.C, c.taken);
        return wrap({
          pnr: c.booking.pnr,
          route: `${c.booking.flight?.origin}→${c.booking.flight?.dest}`,
          flight_date: c.booking.flight_date,
          aircraft: c.booking.flight?.aircraft,
          cabin_open: c.cabinKey,
          cabins_available: Object.keys(c.CABINS),
          passenger: c.paxList[c.activePax]?.first || `Passenger ${c.activePax + 1}`,
          passenger_index: c.activePax,
          passengers: c.paxList.map(p => p.first),
          current_seat: c.safeSeat,
          selected_seat: c.sel || null,
          seats_free: free.length,
          examples: free.slice(0, 8),
          extra_legroom_rows: c.C.extraRows,
          exit_rows: c.C.exitRows,
          exit_row_declared: !!c.eligOk,
          can_confirm: !!c.canConfirm,
          // Say plainly what is missing, so the agent doesn't guess.
          blocked_by: c.canConfirm ? null
            : (!c.sel || c.sel === c.safeSeat) ? "no new seat selected"
            : "exit-row declaration outstanding",
        });
      },
    },

    {
      name: "pick_seat_on_map",
      description:
        "Select a seat on the seat map currently open. Validates the seat against the " +
        "cabin layout in view and reports any extra-legroom fee. Selecting only — it " +
        "does not reissue the boarding pass; call confirm_seat_change for that.",
      inputSchema: {
        type: "object",
        properties: {
          seat: { type: "string", description: "Seat id as shown on the map, e.g. 22A." },
          cabin: { type: "string", description: "Optional: switch cabin tab first (Economy, Premium, Business)." },
          passenger_index: { type: "number", description: "Optional: which passenger to seat, 0-based." },
        },
        required: ["seat"],
      },
      async execute({ seat, cabin, passenger_index }) {
        const c = getCtx();
        if (!c || !c.booking) return fail("The seat map is not open.");

        if (cabin && c.CABINS[cabin] && cabin !== c.cabinKey) {
          c.setCabin(cabin);
          return wrap({
            state: "cabin_switched", cabin,
            message: `Switched to the ${cabin} cabin. Call seat_map_state to see its seats, then pick again.`,
          });
        }
        if (passenger_index != null) {
          if (!c.paxList[passenger_index]) return fail(`There is no passenger ${passenger_index} on this booking.`);
          c.setActivePax(passenger_index);
        }

        const id = String(seat).toUpperCase().replace(/\s+/g, "");
        const layout = c.C;
        const m = id.match(/^(\d+)([A-Z])$/);
        if (!m || !layout.cols.includes(m[2]) || !layout.rows.includes(+m[1])) {
          return fail(
            `${id} is not a seat in the ${c.cabinKey} cabin. Rows ${layout.rows[0]}–` +
            `${layout.rows[layout.rows.length - 1]}, columns ${layout.cols.join("")}.`
          );
        }
        if (c.taken.has(id)) {
          const alt = freeSeatsIn(layout, c.taken)
            .find(s => s.endsWith(m[2])) || freeSeatsIn(layout, c.taken)[0];
          return wrap({ ok: false, seat: id, taken: true, suggestion: alt,
            message: `${id} is taken.${alt ? ` ${alt} is free and in the same column.` : ""}` });
        }

        c.setSel(id);
        const fee = c.feeOf(id);
        const exit = c.isExit(id);

        // An exit-row seat requires the passenger to declare they are 16+,
        // able-bodied, and willing to assist in an emergency. That is a legal
        // declaration about a person's physical capability. An agent must not
        // make it on their behalf, so we deliberately do NOT tick the box —
        // the seat is selected and the human completes the declaration.
        return wrap({
          ok: true,
          seat: id,
          cabin: c.cabinKey,
          passenger: c.paxList[c.activePax]?.first,
          extra_legroom_fee: fee,
          exit_row: exit,
          state: exit && !c.eligOk ? "needs_customer_declaration" : "selected",
          message: exit && !c.eligOk
            ? `${id} selected. It is an exit-row seat, so the customer must tick the ` +
              `eligibility box on screen themselves — confirming they are 16+, able-bodied ` +
              `and willing to assist in an emergency. You cannot declare this for them.`
            : `${id} selected${fee ? ` · extra-legroom fee ${fee}` : ""}. Confirm to reissue the boarding pass.`,
        });
      },
    },

    {
      name: "confirm_seat_change",
      description:
        "Apply the seat currently selected on the open map: reissues the boarding pass " +
        "and invalidates the old one. Always call once without confirm to see what will " +
        "change, show the customer, then call again with confirm=true.",
      inputSchema: {
        type: "object",
        properties: { confirm: { type: "boolean", description: "Must be true to actually apply." } },
      },
      async execute({ confirm }) {
        const c = getCtx();
        if (!c || !c.booking) return fail("The seat map is not open.");
        if (!c.canConfirm) {
          return fail(
            (!c.sel || c.sel === c.safeSeat)
              ? "No new seat is selected yet — call pick_seat_on_map first."
              : "The exit-row declaration is still outstanding, and only the customer can make it."
          );
        }
        if (!confirm) {
          seatConfirmPending.armed = true;
          return wrap({
            state: "needs_confirm",
            pnr: c.booking.pnr,
            from: c.safeSeat, to: c.sel,
            extra_legroom_fee: c.feeOf(c.sel),
            effect: "A new boarding pass is issued and the old one is invalidated.",
            message: "Show this to the customer, then call again with confirm=true.",
          });
        }
        if (!seatConfirmPending.armed) {
          return fail("Call confirm_seat_change without confirm first, show the customer what changes, then confirm.");
        }
        seatConfirmPending.armed = false;
        await c.confirm();
        return wrap({ ok: true, pnr: c.booking.pnr, seat: c.sel,
          message: "Seat confirmed and boarding pass reissued." });
      },
    },
  ];

  // Register locally first so window.__tapTools.screen() works on a browser with
  // no WebMCP host (Edge today), then publish to the host when there is one.
  for (const t of tools) _screenTools.set(t.name, t.execute);
  if (mc) {
    for (const t of tools) {
      try { mc.registerTool({ ...t, handler: t.execute }); }
      catch (e) { console.warn("[webmcp:seatmap]", t.name, e.message); }
    }
  }
  console.info(`[webmcp] seat map open — ${tools.length} screen tools available${mc ? " and registered" : " (no WebMCP host)"}`);

  return () => {
    seatConfirmPending.armed = false;
    for (const t of tools) {
      _screenTools.delete(t.name);
      if (mc) { try { mc.unregisterTool(t.name); } catch {} }
    }
  };
}

/* ── test / console access ───────────────────────────────────────────────── */
// Exposed so the tools can be exercised from DevTools without an agent — useful
// when demoing on a browser where the flag is unavailable:
//   await window.__tapTools.run("search_flights", { origin: "MIA", dest: "JFK" })
if (typeof window !== "undefined") {
  window.__tapTools = {
    run: runTool,
    list: () => _installed.slice(),
    supported: isSupported,
    // screen-scoped tools, only present while their screen is mounted
    screen: (name, input) => {
      const fn = _screenTools.get(name);
      return fn ? fn(input || {})
        : Promise.reject(new Error(`${name} is not available — is that screen open?`));
    },
    screenList: () => [..._screenTools.keys()],
  };
}
