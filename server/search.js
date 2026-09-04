/* ──────────────────────────────────────────────────────────────
   Xperion Demo — flight search engine
   Generates realistic, deterministic flights for any route in the
   network. Same route + date always yields the same flights, so the
   demo is stable, but we never seed tens of thousands of rows.
   Recommendations are personalized from the customer's own history.
   ────────────────────────────────────────────────────────────── */
const { db } = require("./db");
const { AIRPORTS } = require("./routes-data");

// Small seeded PRNG so generated flights are stable per route+date
function rng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), h | 1); h ^= h + Math.imul(h ^ (h >>> 7), h | 61); return ((h ^ (h >>> 14)) >>> 0) / 4294967296; };
}

const AIRCRAFT_SHORT = ["A319", "A320neo", "A321neo", "Embraer E195"];
const AIRCRAFT_LONG = ["A330neo", "A321LR", "Boeing 787-9", "A330-900"];
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (mins) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
const durLabel = (m) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ""}` : `${m}m`;

// Realistic haul estimate (minutes) by unordered region pair, used to synthesize a
// route for any served-airport pair that isn't in the curated network — so round-trip
// inbound legs and arbitrary multi-city legs always return flights.
const REGION_MIN = {
  "Europe|Europe": 120, "North America|North America": 300, "South America|South America": 180,
  "Africa|Africa": 200, "Asia|Asia": 240, "Middle East|Middle East": 120,
  "Africa|Europe": 330, "Europe|Middle East": 330, "Asia|Europe": 690,
  "Europe|South America": 630, "Europe|North America": 480, "Africa|Middle East": 300,
  "Africa|North America": 660, "Africa|South America": 600, "Africa|Asia": 600,
  "Middle East|North America": 720, "Middle East|South America": 780, "Asia|Middle East": 420,
  "Asia|North America": 720, "North America|South America": 510, "Asia|South America": 900,
};
function synthRoute(origin, dest) {
  const A = AIRPORTS[origin], B = AIRPORTS[dest];
  if (!A || !B || origin === dest) return null;   // only synthesize between served airports
  const base = REGION_MIN[[A.region, B.region].sort().join("|")] || 240;
  let h = 0; for (const c of origin + dest) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const duration_min = Math.round(base * (0.85 + (h % 30) / 100));   // deterministic ±15% per pair
  const base_fare = Math.max(55, Math.round(duration_min * 0.86));
  const region = A.region === "Europe" && B.region === "Europe" ? "Europe" : "Intercontinental";
  return { origin, dest, duration_min, base_fare, region };
}

function getRoute(origin, dest) {
  const r = db.prepare("SELECT * FROM routes WHERE origin=? AND dest=?").get(origin, dest);
  if (r) return r;
  const syn = synthRoute(origin, dest);   // any served-airport pair becomes flyable (persisted once)
  if (syn) { try { db.prepare("INSERT OR IGNORE INTO routes (origin,dest,duration_min,base_fare,region) VALUES (?,?,?,?,?)").run(syn.origin, syn.dest, syn.duration_min, syn.base_fare, syn.region); } catch { } }
  return syn;
}

// The home shuttle has fixed, real flight numbers so the persona's history lines up
const PINNED = {
  "OPO-LIS": [
    { flight_no: "XP1921", dep: "06:35", arr: "07:30", aircraft: "A320neo", price: 74, seats_left: 31 },
    { flight_no: "XP1927", dep: "07:05", arr: "08:00", aircraft: "A321neo", price: 86, seats_left: 18, recommended: 1 },
    { flight_no: "XP1931", dep: "09:10", arr: "10:05", aircraft: "A320neo", price: 62, seats_left: 44, lowest: 1 },
    { flight_no: "XP1937", dep: "12:40", arr: "13:35", aircraft: "A319",    price: 69, seats_left: 52 },
    { flight_no: "XP1943", dep: "18:35", arr: "19:30", aircraft: "A321neo", price: 91, seats_left: 12 },
  ],
  // Sofia's leisure commute (Lisbon ⇄ Madeira) — her usual is XP1696
  "LIS-FNC": [
    { flight_no: "XP1690", dep: "07:30", arr: "09:10", aircraft: "A320neo", price: 52, seats_left: 41, lowest: 1 },
    { flight_no: "XP1696", dep: "10:20", arr: "12:00", aircraft: "A321neo", price: 58, seats_left: 23, recommended: 1 },
    { flight_no: "XP1698", dep: "15:10", arr: "16:50", aircraft: "A319",    price: 66, seats_left: 38 },
    { flight_no: "XP1702", dep: "19:25", arr: "21:05", aircraft: "A320neo", price: 61, seats_left: 29 },
  ],
  // Sofia's in-progress search (Lisbon → Barcelona) — her saved journey is on XP1042
  "LIS-BCN": [
    { flight_no: "XP1038", dep: "06:50", arr: "08:35", aircraft: "A320neo", price: 66, seats_left: 44, lowest: 1 },
    { flight_no: "XP1042", dep: "11:30", arr: "13:15", aircraft: "A321neo", price: 74, seats_left: 21, recommended: 1 },
    { flight_no: "XP1050", dep: "18:40", arr: "20:25", aircraft: "A320neo", price: 70, seats_left: 33 },
  ],
  // Lars's transatlantic commute (Frankfurt ⇄ New York) — his usual is XP201 (Business)
  "FRA-JFK": [
    { flight_no: "XP201", dep: "10:40", arr: "13:30", aircraft: "A330neo", price: 612, seats_left: 14, recommended: 1 },
    { flight_no: "XP207", dep: "16:55", arr: "19:45", aircraft: "A339",    price: 668, seats_left: 9 },
  ],
  "JFK-FRA": [
    { flight_no: "XP202", dep: "18:20", arr: "08:05", aircraft: "A330neo", price: 598, seats_left: 12, recommended: 1, lowest: 1 },
    { flight_no: "XP208", dep: "21:30", arr: "11:15", aircraft: "A339",    price: 640, seats_left: 17 },
  ],
};

// Cabin fares carried on every generated flight so a search in ANY class
// (Economy / Premium / Business) always has authoritative pricing. Multipliers
// match the client's deriveFares defaults (Premium ~3.6×, Business ~7.43×).
function cabinPricesFor(price) {
  return { Economy: Math.round(price), Premium: Math.round(price * 3.6), Business: Math.round(price * 7.43) };
}
const depToMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

// Build `count` deterministic flights spread across the day for a route.
// `used` pre-seeds taken flight numbers (e.g. pinned) so the batch stays collision-free.
function genRandom(origin, dest, date, route, count, rand, used = new Set()) {
  const long = route.duration_min >= 240;
  const depStart = long ? 8 * 60 : 6 * 60;
  const depEnd = long ? 22 * 60 : Math.min(21 * 60, 23 * 60 + 30 - route.duration_min);
  const span = Math.max(60, depEnd - depStart);
  const flights = [];
  for (let i = 0; i < count; i++) {
    const base = count > 1 ? depStart + Math.round((span / (count - 1)) * i) : depStart + Math.floor(span / 2);
    const depMin = Math.min(depEnd, Math.max(depStart, base + Math.floor((rand() - 0.5) * 30))); // ±15m jitter
    const arrMin = depMin + route.duration_min;
    const price = Math.round(route.base_fare * (0.8 + rand() * 0.6));   // ±
    const ac = (long ? AIRCRAFT_LONG : AIRCRAFT_SHORT)[Math.floor(rand() * 4)];
    const seats = 6 + Math.floor(rand() * 60);
    let flightNo, guard = 0;
    do { flightNo = "XP" + (100 + Math.floor(rand() * 1899)); } while (used.has(flightNo) && ++guard < 50);
    used.add(flightNo);
    flights.push({
      flight_no: flightNo, origin, dest, dep: hhmm(depMin), arr: hhmm(arrMin), _depMin: depMin,
      duration: durLabel(route.duration_min), aircraft: ac,
      price, seats_left: seats, flight_date: date, cabin_prices: cabinPricesFor(price),
      recommended: 0, lowest: 0, status: "scheduled", new_dep: null, new_arr: null,
    });
  }
  return flights;
}

// Generate the day's flights for a route. Every route returns at least MIN_FLIGHTS
// options, each priced in Economy / Premium / Business. Same route+date is stable.
const MIN_FLIGHTS = 6;
function generateFlights(origin, dest, date) {
  const route = getRoute(origin, dest);
  if (!route) return [];
  const rand = rng(`${origin}-${dest}-${date}`);

  let flights = [];
  const pin = PINNED[`${origin}-${dest}`];
  if (pin) {
    // Pinned routes keep their named persona flights, then pad up to MIN_FLIGHTS with
    // generated options so even the commute routes offer a full choice across cabins.
    flights = pin.map(p => ({
      flight_no: p.flight_no, origin, dest, dep: p.dep, arr: p.arr,
      duration: durLabel(route.duration_min), aircraft: p.aircraft,
      price: p.price, seats_left: p.seats_left, flight_date: date, cabin_prices: cabinPricesFor(p.price),
      recommended: p.recommended ? 1 : 0, lowest: p.lowest ? 1 : 0,
      status: "scheduled", new_dep: null, new_arr: null, _depMin: depToMin(p.dep),
    }));
    if (flights.length < MIN_FLIGHTS) {
      const used = new Set(flights.map(p => p.flight_no));
      const extra = genRandom(origin, dest, date, route, (MIN_FLIGHTS - flights.length) + 2, rand, used);
      flights = flights.concat(extra).slice(0, Math.max(MIN_FLIGHTS, flights.length));
    }
  } else {
    const long = route.duration_min >= 240;
    const count = MIN_FLIGHTS + Math.floor(rand() * (long ? 2 : 3));   // long-haul 6-7, short-haul 6-8
    flights = genRandom(origin, dest, date, route, count, rand);
  }

  flights.sort((a, b) => a._depMin - b._depMin);

  // Lowest fare flag
  const minPrice = Math.min(...flights.map(f => f.price));
  flights.forEach(f => { if (f.price === minPrice) f.lowest = 1; });

  // Personalized recommendation from the customer's own history on this route
  const route_str = `${origin}→${dest}`;
  const hist = db.prepare("SELECT flight_no, dep_time, COUNT(*) c FROM travel_history WHERE user_id=1 AND route=? GROUP BY flight_no ORDER BY c DESC").all(route_str);
  let recIdx = -1;
  if (hist.length) {
    const usualMin = (() => { const t = hist[0].dep_time?.split(":"); return t ? (+t[0]) * 60 + (+t[1]) : null; })();
    if (usualMin != null) {
      let best = Infinity;
      flights.forEach((f, idx) => { const d = Math.abs(f._depMin - usualMin); if (d < best) { best = d; recIdx = idx; } });
    }
  }
  if (recIdx === -1) recIdx = 0; // default: earliest departure (good for business)
  if (flights[recIdx]) flights[recIdx].recommended = 1;

  flights.forEach(f => delete f._depMin);
  return flights;
}

module.exports = { generateFlights, getRoute };
