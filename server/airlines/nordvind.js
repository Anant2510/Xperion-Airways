// ─────────────────────────────────────────────────────────────────────────────
// Nordvind Air — reference second-airline adapter (Phase 3).
//
// PURPOSE: prove the adapter seam actually detaches the chat from Xperion, and serve
// as the starter template a partner airline's engineers copy.
//
// THE IMPORTANT PROPERTY: this file imports NOTHING from the Xperion server — no db,
// no cityName, no helpers. Its entire "reservation system" is the in-memory store
// below. A real partner swaps these functions for calls to their own APIs and
// changes nothing else; the agent loop, the 27-tool contract, buildUI and all 15
// A2UI card types are shared and untouched.
//
// Implements 18 of the 27 contract tools. The remaining 9 are deliberately left
// out to exercise the partial-tenant path: they return
// "<tool> isn't available for nordvind yet." instead of breaking the chat — which
// is what a real airline's day-one integration looks like.
// ─────────────────────────────────────────────────────────────────────────────

const AIRPORTS = {
  OSL: "Oslo", BGO: "Bergen", CPH: "Copenhagen", ARN: "Stockholm",
  HEL: "Helsinki", KEF: "Reykjavik", LHR: "London", AMS: "Amsterdam",
};
const ROUTES = {
  OSL: ["BGO", "CPH", "ARN", "HEL", "KEF", "LHR", "AMS"],
  BGO: ["OSL", "CPH"], CPH: ["OSL", "LHR", "ARN"], ARN: ["OSL", "CPH", "HEL"],
  HEL: ["OSL", "ARN"], KEF: ["OSL"], LHR: ["OSL", "CPH"], AMS: ["OSL"],
};
const EXTRAS = {
  bag: { code: "bag", name: "Checked bag · 23kg", price: 28 },
  meal: { code: "meal", name: "Nordic hot meal", price: 14 },
  wifi: { code: "wifi", name: "Onboard wifi", price: 9 },
  lounge: { code: "lounge", name: "Vinter lounge access", price: 32 },
};
const CABINS = [
  { cabin: "Nordic Business", rows: [1, 4], base: 240 },
  { cabin: "Nordic Plus", rows: [8, 12], base: 60 },
  { cabin: "Nordic Economy", rows: [14, 32], base: 0 },
];

const city = (code) => AIRPORTS[String(code || "").toUpperCase()] || String(code || "").toUpperCase();
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const today = () => new Date().toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, "0");

// ── in-memory "reservation system" ───────────────────────────────────────────
const store = new Map();
function acct(uid) {
  const key = String(uid ?? "guest");
  if (!store.has(key)) {
    store.set(key, {
      profile: { first_name: "Ingrid", tier: "Silver", home: "OSL" },
      wallet: { miles: 42500, voucher: { code: "NV20", amount: 20, status: "active", expiry: "2026-12-31" } },
      selected: null, extras: [], bookings: [], seqno: 0, refunds: [],
    });
  }
  return store.get(key);
}

// Deterministic schedule: same route+date always yields the same flights, so the
// agent can refer back to "the 08:00 one" across turns.
function schedule(origin, dest, date) {
  const seed = hash(`${origin}${dest}${date}`);
  return [0, 1, 2, 3].map((i) => {
    const depH = 6 + ((seed >>> (i * 3)) % 4) + i * 4;
    const dur = 75 + ((seed >>> i) % 90);
    const dep = `${pad(Math.min(depH, 22))}:${pad(((seed >>> i) % 6) * 10)}`;
    const arrM = Math.min(depH, 22) * 60 + ((seed >>> i) % 6) * 10 + dur;
    return {
      flight_no: `NV${100 + ((seed >>> (i * 2)) % 800)}`,
      dep, arr: `${pad(Math.floor(arrM / 60) % 24)}:${pad(arrM % 60)}`,
      price: 79 + ((seed >>> (i * 4)) % 190),
      status: "On time", recommended: i === 0 ? 1 : 0,
      origin, dest, flight_date: date, duration_min: dur,
    };
  }).sort((a, b) => a.dep.localeCompare(b.dep));
}

const seatCabin = (seat) => {
  const row = parseInt(String(seat || "").replace(/\D/g, ""), 10) || 20;
  return (CABINS.find((c) => row >= c.rows[0] && row <= c.rows[1]) || CABINS[2]).cabin;
};
const activeBooking = (a) => a.bookings.find((b) => b.status === "confirmed") || null;
const basket = (a) => {
  const fare = a.selected ? a.selected.price : 0;
  const items = a.extras.map((c) => EXTRAS[c]).filter(Boolean);
  const extras_total = items.reduce((s, x) => s + x.price, 0);
  return { items, fare, extras_total, total: +(fare + extras_total).toFixed(2) };
};

// ── the 18 implemented contract tools ────────────────────────────────────────
const tools = {
  search_flights(input, ctx) {
    const a = acct(ctx.uid);
    const origin = String(input.origin || a.profile.home).toUpperCase();
    const dest = String(input.dest || "").toUpperCase();
    const date = input.date || today();
    if (!dest) return { ok: false, message: "Which destination? Ask me to list where Nordvind flies from here." };
    if (!(ROUTES[origin] || []).includes(dest)) {
      return { ok: false, message: `Nordvind doesn't fly ${city(origin)}→${city(dest)}.`,
        available_destinations: (ROUTES[origin] || []).map((d) => ({ code: d, city: city(d) })) };
    }
    const flights = schedule(origin, dest, date);
    if (ctx.session) ctx.session.lastSearch = { origin, dest, date, flights };
    return { ok: true, origin, dest, city: city(dest), date, flights };
  },

  list_destinations(input, ctx) {
    const origin = String(input.origin || acct(ctx.uid).profile.home).toUpperCase();
    const dests = (ROUTES[origin] || []).map((d) => ({ code: d, city: city(d), flown: 0 }))
      .sort((x, y) => x.city.localeCompare(y.city));
    if (!dests.length) return { ok: false, message: `Nordvind doesn't operate from ${city(origin)}.` };
    return { ok: true, origin, originCity: city(origin), count: dests.length, destinations: dests };
  },

  get_suggestions(input, ctx) {
    const a = acct(ctx.uid);
    const sug = (ROUTES[a.profile.home] || []).slice(0, 5)
      .map((d) => ({ code: d, city: city(d), flown: 0, searched: 0 }));
    return { ok: true, suggestions: sug };
  },

  get_flight_info(input, ctx) {
    const ls = ctx.session && ctx.session.lastSearch;
    const no = String(input.flight_no || "").toUpperCase();
    const f = ls && ls.flights.find((x) => x.flight_no === no);
    if (!f) return { ok: false, message: `${no || "That flight"} isn't in the latest Nordvind results — search the route first.` };
    return { ok: true, ...f, route: `${city(f.origin)}→${city(f.dest)}`, seats_left: 3 + (hash(no) % 20) };
  },

  select_flight(input, ctx) {
    const a = acct(ctx.uid);
    const ls = ctx.session && ctx.session.lastSearch;
    const no = String(input.flight_no || "").toUpperCase();
    const f = ls && ls.flights.find((x) => x.flight_no === no);
    if (!f) return { ok: false, message: `${no || "That flight"} isn't in the latest results — search the route first.` };
    a.selected = { ...f, seat: `${14 + (hash(no) % 12)}A` };
    if (ctx.session) ctx.session.selected = { flight_no: f.flight_no };
    return { ok: true, flight_no: f.flight_no, route: `${city(f.origin)}→${city(f.dest)}`,
      dep: f.dep, arr: f.arr, price: f.price, seat: a.selected.seat, auto_extras: [] };
  },

  add_extras(input, ctx) {
    const a = acct(ctx.uid);
    if (!a.selected) return { ok: false, message: "No Nordvind flight selected yet." };
    const code = String(input.code || input.item || "").toLowerCase();
    if (!EXTRAS[code]) return { ok: false, message: `Nordvind extras: ${Object.keys(EXTRAS).join(", ")}.` };
    if (!a.extras.includes(code)) a.extras.push(code);
    return { ok: true, ...basket(a) };
  },

  remove_extras(input, ctx) {
    const a = acct(ctx.uid);
    const code = String(input.code || input.item || "").toLowerCase();
    a.extras = a.extras.filter((c) => c !== code);
    return { ok: true, ...basket(a) };
  },

  checkout(input, ctx) {
    const a = acct(ctx.uid);
    if (!a.selected) return { ok: false, message: "Nothing selected to pay for yet." };
    const b = basket(a);
    const useVoucher = input.use_voucher !== false && a.wallet.voucher && a.wallet.voucher.status === "active";
    const voucher = useVoucher ? Math.min(a.wallet.voucher.amount, b.total) : 0;
    const useMiles = input.use_miles !== false;
    const milesEur = useMiles ? Math.min(+(a.wallet.miles * 0.0025).toFixed(2), b.total - voucher) : 0;
    const milesUsed = useMiles ? Math.round(milesEur / 0.0025) : 0;
    const card = +(b.total - voucher - milesEur).toFixed(2);
    if (useVoucher) a.wallet.voucher.status = "used";
    a.wallet.miles -= milesUsed;
    const pnr = `NV${(hash(a.selected.flight_no + (++a.seqno)) % 90000 + 10000)}`;
    const booking = {
      pnr, flight_no: a.selected.flight_no, route: `${city(a.selected.origin)}→${city(a.selected.dest)}`,
      dep: a.selected.dep, date: a.selected.flight_date, seat: a.selected.seat,
      cabin: seatCabin(a.selected.seat), status: "confirmed", checked_in: 0,
      total: b.total, items: [...a.extras],
    };
    a.bookings.unshift(booking);
    a.selected = null; a.extras = [];
    return { ok: true, pnr, total: b.total, date: booking.date, route: booking.route, dep: booking.dep,
      split: { voucher, miles: milesUsed, miles_eur: milesEur, card } };
  },

  get_booking(input, ctx) {
    const a = acct(ctx.uid);
    const want = String(input.pnr || "").toUpperCase();
    const b = want ? a.bookings.find((x) => x.pnr === want) : activeBooking(a);
    if (!b) return { ok: false, message: "No Nordvind booking on file." };
    return { ok: true, booking: { ...b, checked_in: !!b.checked_in } };
  },

  list_seats(input, ctx) {
    const a = acct(ctx.uid);
    const b = activeBooking(a) || a.selected;
    const cur = b ? b.seat : null;
    const cabins = CABINS.map((c) => {
      const seed = hash(c.cabin + (b ? b.flight_no : "any"));
      const examples = ["A", "C", "D", "F"].slice(0, 3).map((L, i) => `${c.rows[0] + ((seed >>> (i * 2)) % Math.max(1, c.rows[1] - c.rows[0]))}${L}`);
      return { cabin: c.cabin, price_from: c.base, included: c.base === 0,
        seats_available: 4 + (seed % 30), examples };
    });
    return { ok: true, current_seat: cur, current_cabin: cur ? seatCabin(cur) : null, tier: a.profile.tier, cabins };
  },

  change_seat(input, ctx) {
    const a = acct(ctx.uid);
    const b = activeBooking(a) || a.selected;
    if (!b) return { ok: false, message: "No Nordvind booking to change a seat on." };
    const want = String(input.seat || "").toUpperCase();
    if (!/^\d{1,2}[A-F]$/.test(want)) return { ok: false, message: "Give me a seat like 12C." };
    if (hash(want + b.flight_no) % 7 === 0) {
      const alt = `${parseInt(want, 10) + 1}${want.slice(-1)}`;
      return { ok: true, taken: true, seat: want, suggestion: alt, message: `${want} is taken on ${b.flight_no}.` };
    }
    const from = b.seat; const cabin = seatCabin(want);
    const price = (CABINS.find((c) => c.cabin === cabin) || {}).base || 0;
    b.seat = want;
    return { ok: true, seat: want, cabin, from, price, included: price === 0 };
  },

  upgrade_cabin(input, ctx) {
    const a = acct(ctx.uid);
    const b = activeBooking(a);
    if (!b) return { ok: false, message: "No Nordvind booking to upgrade." };
    const target = String(input.cabin || "Nordic Business");
    const price = target.toLowerCase().includes("business") ? 240 : 60;
    if (input.confirm !== true) {
      return { ok: false, state: "needs_confirm", pnr: b.pnr, cabin: target, price,
        message: `Upgrade ${b.pnr} to ${target} for $${price}?` };
    }
    b.cabin = target; b.seat = target.toLowerCase().includes("business") ? "2A" : "9C"; b.total += price;
    return { ok: true, pnr: b.pnr, cabin: target, price };
  },

  check_in(input, ctx) {
    const a = acct(ctx.uid);
    const b = activeBooking(a);
    if (!b) return { ok: false, state: "no_booking", message: "No upcoming Nordvind flight to check in for." };
    if (b.checked_in) {
      return { ok: true, state: "already_checked_in", pnr: b.pnr, flight_no: b.flight_no,
        route: b.route, date: b.date, seat: b.seat };
    }
    b.checked_in = 1;
    return { ok: true, state: "checked_in_now", pnr: b.pnr, flight_no: b.flight_no, route: b.route,
      date: b.date, seat: b.seat, group: a.profile.tier === "Silver" ? "Group 2 (Silver)" : "Group 3" };
  },

  cancel_booking(input, ctx) {
    const a = acct(ctx.uid);
    const b = activeBooking(a);
    if (!b) return { ok: false, state: "no_booking", message: "No Nordvind booking to cancel." };
    if (input.confirm !== true) {
      return { ok: false, state: "needs_confirm", pnr: b.pnr, route: b.route, date: b.date,
        message: `Cancel ${b.pnr} (${b.route}, ${b.date})?` };
    }
    b.status = "cancelled";
    const refund = { card: +(b.total * 0.8).toFixed(2), miles: 0, voucher: 0 };
    a.refunds.unshift({ pnr: b.pnr, amount: refund.card, method: "Original card",
      stage: "Processing with your bank", eta: "5–7 business days" });
    return { ok: true, state: "cancelled", pnr: b.pnr, route: b.route, refund };
  },

  get_refund_status(input, ctx) {
    const a = acct(ctx.uid);
    const r = a.refunds[0];
    if (!r) return { ok: true, refund: false, message: "No Nordvind refunds in progress." };
    return { ok: true, refund: true, ...r,
      message: `Refund for ${r.pnr} — $${r.amount} back to your original payment method (${r.eta}).` };
  },

  get_wallet(input, ctx) {
    const a = acct(ctx.uid);
    const v = a.wallet.voucher;
    return { ok: true, miles: a.wallet.miles, miles_value_eur: +(a.wallet.miles * 0.0025).toFixed(2),
      miles_rate: "1,000 miles ≈ $2.50",
      voucher: v ? { ...v, available: v.status === "active" } : null,
      card: "your saved card",
      note: "Nordvind lets you split a booking across voucher, miles and card." };
  },

  get_journey(input, ctx) {
    const a = acct(ctx.uid);
    if (!a.selected) return { ok: true, in_progress: false };
    return { ok: true, in_progress: true, stage: "flight selected", route: `${city(a.selected.origin)}→${city(a.selected.dest)}`,
      date: a.selected.flight_date, flight_no: a.selected.flight_no,
      origin: a.selected.origin, dest: a.selected.dest };
  },

  express_usual(input, ctx) {
    const a = acct(ctx.uid);
    const last = a.bookings[0];
    if (!last) return { ok: false, message: "No previous Nordvind trip to repeat yet." };
    return { ok: true, route: last.route, flight_no: last.flight_no, date: last.date,
      message: `Repeating ${last.route} on ${last.flight_no}.` };
  },
};

module.exports = {
  id: "nordvind",
  tools,
  config: {
    name: "Nordvind Air",
    shortName: "Nordvind",
    homeAirport: "OSL",
    currency: "EUR",       // see AIRLINE-ADAPTER.md: card rendering is EUR-only until Phase 4
    locale: "en-GB",
    theme: { accent: "#0b6ea8", accentDeep: "#075178", accentDark: "#05374f",
      highlight: "#7fd3f7", tint: "#e8f6fd", danger: "#c2372d" },   // Nordvind ice-blue
    brandLine: "Nordvind tiers: Blue, Silver, Gold. Cabins: Nordic Economy, Nordic Plus, Nordic Business.",
    cdp: false,
  },
  // Optional non-contract hook used by the chat endpoint for the situational note.
  profile: ({ uid }) => ({ first_name: acct(uid).profile.first_name }),
};
