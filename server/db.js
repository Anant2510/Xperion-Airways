/* ──────────────────────────────────────────────────────────────
   Xperion Demo — SQLite database layer (file: data/tap.db)
   Uses Node's built-in sqlite (Node >= 22). No native builds.
   This is the customer data store we'd later sync with a CDP.
   ────────────────────────────────────────────────────────────── */
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const { AIRPORTS, ROUTES } = require("./routes-data");

/* Data location is env-overridable so a second deployment (different port,
   different folder) never shares a database file with another instance.
   DB_PATH wins outright; otherwise DATA_DIR + DB_FILE; otherwise ./data/mar.db */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, process.env.DB_FILE || "mar.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, member_no TEXT UNIQUE, first_name TEXT, full_name TEXT,
  email TEXT, phone TEXT, tier TEXT, miles INTEGER, nationality TEXT,
  doc_id TEXT, home_airport TEXT, card_brand TEXT, card_last4 TEXT, card_exp TEXT,
  card_product TEXT, card_categories TEXT, affinity TEXT, affinity_label TEXT,
  dob TEXT, gender TEXT, passport_exp TEXT
);
CREATE TABLE IF NOT EXISTS preferences (
  user_id INTEGER PRIMARY KEY, seat TEXT, seat_note TEXT, bag TEXT, meal TEXT, auto_checkin INTEGER
);
CREATE TABLE IF NOT EXISTS app_state (
  k TEXT PRIMARY KEY, v TEXT
);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY, user_id INTEGER, code TEXT, amount REAL, reason TEXT, expiry TEXT, status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS travel_history (
  id INTEGER PRIMARY KEY, user_id INTEGER, flight_no TEXT, route TEXT, trip_date TEXT, dep_time TEXT, purpose TEXT
);
CREATE TABLE IF NOT EXISTS synced_searches (
  id INTEGER PRIMARY KEY, user_id INTEGER, origin TEXT, dest TEXT, travel_date TEXT, pax INTEGER,
  device TEXT, created_at TEXT,
  stage TEXT, flight_no TEXT, seat TEXT, items_json TEXT, cabin TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY, flight_no TEXT, origin TEXT, dest TEXT, dep TEXT, arr TEXT,
  duration TEXT, aircraft TEXT, price REAL, seats_left INTEGER, flight_date TEXT,
  recommended INTEGER DEFAULT 0, lowest INTEGER DEFAULT 0, status TEXT DEFAULT 'scheduled',
  new_dep TEXT, new_arr TEXT
);
CREATE TABLE IF NOT EXISTS ancillaries (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, descr TEXT, price REAL, was REAL, auto INTEGER, icon TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER, pnr TEXT, event TEXT, channel TEXT,
  recipient TEXT, status TEXT, provider_id TEXT, body TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS airports (
  code TEXT PRIMARY KEY, city TEXT, country TEXT, region TEXT
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY, origin TEXT, dest TEXT, duration_min INTEGER, base_fare REAL, region TEXT
);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY, user_id INTEGER, origin TEXT, dest TEXT, travel_date TEXT, pax INTEGER,
  results INTEGER, device TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY, city TEXT, code TEXT, tag TEXT, price REAL, miles_price INTEGER, emoji TEXT
);
CREATE TABLE IF NOT EXISTS baskets (
  id INTEGER PRIMARY KEY, user_id INTEGER, flight_no TEXT, items_json TEXT,
  snapshot_json TEXT, status TEXT DEFAULT 'open', updated_at TEXT
);
CREATE TABLE IF NOT EXISTS fare_locks (
  id INTEGER PRIMARY KEY, user_id INTEGER, flight_no TEXT, locked_price REAL, expires_at TEXT, status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY, user_id INTEGER, flight_no TEXT, items_json TEXT, total REAL,
  expires_at TEXT, status TEXT DEFAULT 'active', created_at TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, pnr TEXT, user_id INTEGER, flight_no TEXT, flight_date TEXT,
  seat TEXT, status TEXT DEFAULT 'confirmed', checked_in INTEGER DEFAULT 0,
  items_json TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, booking_id INTEGER, total REAL, voucher_amt REAL,
  miles_used INTEGER, miles_amt REAL, card_amt REAL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, type TEXT, payload_json TEXT, created_at TEXT, app TEXT DEFAULT 'v1'
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY, user_id INTEGER, to_addr TEXT, subject TEXT, email_type TEXT,
  html TEXT, status TEXT, provider_id TEXT, created_at TEXT, app TEXT DEFAULT 'v1'
);
CREATE TABLE IF NOT EXISTS chat_turns (
  id INTEGER PRIMARY KEY, user_id INTEGER, channel TEXT, role TEXT, content TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY, direction TEXT, wa_id TEXT, msg_type TEXT, body TEXT,
  payload_json TEXT, status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS members (
  member_no TEXT PRIMARY KEY, email TEXT, full_name TEXT, first_name TEXT,
  tier TEXT, miles INTEGER, affinity TEXT, affinity_label TEXT, home_airport TEXT
);
`);

// users.wa_id stores the last WhatsApp sender so the portal can push proactively
try { db.exec("ALTER TABLE users ADD COLUMN wa_id TEXT"); } catch {}

// members.phone — PSS / partner-channel customers register with email + mobile, so the
// same number resolves them for transaction/offer emails and the WhatsApp flow.
try { db.exec("ALTER TABLE members ADD COLUMN phone TEXT"); } catch {}

// Per-app event attribution: tag each event with the originating frontend (v1 / v2) so
// each Demo Console shows only its own app's events. No-op if the column already exists.
try { db.exec("ALTER TABLE events ADD COLUMN app TEXT DEFAULT 'v1'"); } catch (e) { /* already migrated */ }
try { db.exec("ALTER TABLE emails ADD COLUMN app TEXT DEFAULT 'v1'"); } catch (e) { /* already migrated */ }

// ── PSS (Passenger Service System) integration ───────────────────────────────
// Third-party bookings/transactions land via the governed /api/pss/ingest path.
// Additive, idempotent migrations (same try/catch ALTER pattern used above):
//  • bookings.source / pss_ref  — distinguish web vs PSS-origin records (mirrors X-App)
//  • events.source/delivery/idem_key — the events table doubles as the CDP outbox:
//      delivery = pending|sent|failed, retried by the forwarder; idem_key dedupes replays
//  • pss_ingest_log — one row per processed PSS event so re-delivered webhooks are no-ops
try { db.exec("ALTER TABLE bookings ADD COLUMN source TEXT DEFAULT 'web'"); } catch {}
try { db.exec("ALTER TABLE bookings ADD COLUMN pss_ref TEXT"); } catch {}
try { db.exec("ALTER TABLE flights ADD COLUMN cabin_prices TEXT"); } catch {}   // ops demo: per-cabin price override (JSON)
try { db.exec("ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'web'"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN delivery TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN idem_key TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN user_id INTEGER"); } catch {}   // acting user per event → correct CDP attribution (multi-user)
db.exec(`CREATE TABLE IF NOT EXISTS pss_ingest_log (
  id INTEGER PRIMARY KEY, idem_key TEXT UNIQUE, pss_ref TEXT, event_type TEXT, booking_id INTEGER, created_at TEXT
);`);

// PSS bookings stamp the member they belong to. The unified, multi-row profile +
// identity stitching + segments live in cdp_profiles (see cdp-profile.js).
try { db.exec("ALTER TABLE bookings ADD COLUMN member_no TEXT"); } catch {}
// baskets.snapshot_json was added to the CREATE TABLE above after data/tap.db had
// already been committed, and CREATE TABLE IF NOT EXISTS never alters an existing
// table — so every environment reusing the shipped db (the VM only ever pulls) was
// missing the column and park_trip threw "no such column" on the INSERT. That broke
// "save this for later" on the AI chat and WhatsApp alike.
try { db.exec("ALTER TABLE baskets ADD COLUMN snapshot_json TEXT"); } catch {}
// #15 — capture the full booking context (fare/cabin, passengers, inbound leg) so My Trip renders
// the actual booked flight & travellers instead of defaults. Additive; seeded bookings stay null.
try { db.exec("ALTER TABLE bookings ADD COLUMN meta_json TEXT"); } catch {}

// ── CDP unified profile store (Phase 3) ──────────────────────────────────────
// A local mirror of the Adobe RT-CDP profile: one row per resolved identity
// (multi-row, unlike the single-active users record), accumulating touches from
// BOTH channels (pss = offline/partner, web = online). identities_json holds the
// stitched identity graph; segments_json is recomputed on every touch. This is
// what makes "offline + online stitched into one 360° profile → segment → offer"
// real and queryable without refactoring the single-active-user operational model.
db.exec(`CREATE TABLE IF NOT EXISTS cdp_profiles (
  id INTEGER PRIMARY KEY, loyalty_id TEXT UNIQUE, email TEXT, ecid TEXT, name TEXT, tier TEXT, affinity TEXT,
  identities_json TEXT, channels_json TEXT, segments_json TEXT,
  bookings INTEGER DEFAULT 0, pss_events INTEGER DEFAULT 0, web_events INTEGER DEFAULT 0,
  total_spend REAL DEFAULT 0, miles INTEGER DEFAULT 0, lounge_flag INTEGER DEFAULT 0, stitched INTEGER DEFAULT 0,
  first_seen TEXT, last_seen TEXT
);`);

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// Original reference day the demo data was authored around (kept for narrative copy).
const ANCHOR = "2026-06-15";
// Canonical "today" for the demo: the REAL current date, but never before the anchor.
// Everything (upcoming trip, currentBooking, undated searches) keys off this, so the
// demo stays evergreen — the "next trip" is always relative to whenever it's shown.
const TODAY = (() => { const r = new Date().toISOString().slice(0, 10); return r > ANCHOR ? r : ANCHOR; })();
const isoAdd = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isoDiff = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400e3);
// Default date for an UNDATED flight search — never in the past (rolls to real today).
const searchToday = () => { const r = new Date().toISOString().slice(0, 10); return r > ANCHOR ? r : ANCHOR; };
// How many days to shift a persona's FUTURE (confirmed) dates so their soonest upcoming
// booking always lands on TOMORROW relative to real today. Past/completed trips are left
// untouched. This is what keeps a live, checkable "upcoming trip" in the demo every day.
const personaShift = (P) => {
  const conf = (P.bookings || []).filter(b => b[9] === "confirmed").map(b => b[7]).sort();
  if (!conf.length) return 0;
  return isoDiff(conf[0], isoAdd(TODAY, 1));
};
// The customer's CURRENT trip = soonest confirmed booking on/after today,
// otherwise the most recent past confirmed booking. This mirrors the home
// screen's logic so every channel (web, AI chat, WhatsApp) shows the SAME trip.
const currentBooking = (uid = 1) =>
  db.prepare("SELECT * FROM bookings WHERE user_id=? AND status='confirmed' AND flight_date >= ? ORDER BY flight_date ASC, id ASC LIMIT 1").get(uid, TODAY)
  || db.prepare("SELECT * FROM bookings WHERE user_id=? AND status='confirmed' ORDER BY flight_date DESC, id DESC LIMIT 1").get(uid);

// Seeded recent searches — reused by initial seed AND by reset, so the demo
// always starts with realistic behavioural signals.
function seedSearches(uid, persona) {
  const P = (persona && PERSONAS[persona]) || PERSONAS[DEFAULT_PERSONA];
  const isr = db.prepare(`INSERT INTO searches (user_id,origin,dest,travel_date,pax,results,device,created_at) VALUES (?,?,?,?,?,?,?,?)`);
  const dayAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString().replace("T", " ").slice(0, 19);
  // each search row: [origin, dest, date, pax, results, device, daysAgo]
  P.searches.forEach(([o, d, date, pax, results, device, ago]) => isr.run(uid, o, d, date, pax, results, device, dayAgo(ago)));
}

// Seeded bookings — 10 total: 8 past (completed) + 2 active/upcoming. Reused by
// initial seed AND reset, so Daniel always has a real booking history that drives
// personalization across the site, web chat, WhatsApp and the AI planner.
// Each booking needs a matching flights row (personalization joins bookings→flights),
// so we seed those too.
/* ── PERSONAS ──────────────────────────────────────────────────────
   Three full personas, each with the same depth of data as Daniel.
   Exactly ONE persona occupies the live customer record (user_id=1) at a
   time; switching persona re-seeds with that persona's profile, history,
   bookings, ancillary patterns, searches and destinations. This keeps all
   existing single-user queries working while showing the personalization
   engine adapt to genuinely different travellers. */
const PERSONAS = {
  daniel: {
    id: "daniel", label: "Daniel Ferreira", blurb: "Gold · Miami business commuter", archetype: "Digital Commuter",
    user: { member_no: "PT-990001", first_name: "Daniel", full_name: "Daniel Ferreira", email: "anant.direct2links+daniel@gmail.com", phone: "+1 305 442 7781", tier: "Gold", miles: 48230, nationality: "American", dob: "12 Mar 1984", gender: "Male", passport_exp: "14 Sep 2031", doc_id: "US •••• 3391", home_airport: "MIA", card_brand: "Visa", card_last4: "4417", card_exp: "08/28", card_product: "Xperion Miles Visa Gold", card_categories: JSON.stringify([{ name: "Sports & Stadiums", share: 34 }, { name: "Sports Streaming", share: 18 }, { name: "Dining & Bars", share: 16 }, { name: "Rideshare", share: 12 }]), affinity: "football", affinity_label: "Football fan" },
    prefs: { seat: "4C — front aisle", seat_note: "Chosen on 11 of your last 12 flights", bag: "Cabin bag only", meal: "Cold brew + breakfast burrito", auto_checkin: 1 },
    voucher: { code: "2291", amount: 35, reason: "Service recovery", expiry: "30 Sep 2026" },
    synced: { origin: "MIA", dest: "JFK", date: "2026-06-15", device: "MacBook Pro", stage: "seat", flight_no: "XP1927", seat: null, items: ["bag"], cabin: "Economy" },
    ancillaries: [
      ["seat","Seat 4C — front aisle","Your usual seat. Free for Gold.",0,9,1,"seat"],
      ["bag","Cabin bag 10kg","Included in your fare.",0,null,1,"bag"],
      ["meal","Cold brew + breakfast burrito","Pre-ordered to seat. Your usual.",4.5,null,1,"meal"],
      ["wifi","Wi-Fi messaging pass","Stay reachable in the air.",3,null,0,"wifi"],
      ["transfer","New York airport transfer","Driver to Brickell Avenue, 09:30.",18,null,0,"car"],
      ["lounge","Xperion Premium Lounge MIA","Complimentary — Gold benefit.",0,null,0,"lounge"],
    ],
    destinations: [
      ["New York","JFK","Your weekly route",62,null,"🌉"],
      ["Madrid","MAD","Clients you visited in March",89,null,"🏛️"],
      ["Paris","CDG","Searched 3× this month",121,null,"🗼"],
      ["Cancún","CUN","Weekend escape · miles eligible",54,15000,"🌴"],
    ],
    history: [
      ["XP1927","MIA→JFK","2026-02-23","07:05","Business"],["XP1943","JFK→MIA","2026-02-26","18:35","Business"],
      ["XP1927","MIA→JFK","2026-03-02","07:05","Business"],["XP1943","JFK→MIA","2026-03-05","18:35","Business"],
      ["XP1921","MIA→JFK","2026-03-09","06:35","Business"],["XP1943","JFK→MIA","2026-03-12","18:35","Business"],
      ["XP1927","MIA→JFK","2026-03-16","07:05","Business"],["XP1943","JFK→MIA","2026-03-19","18:35","Business"],
      ["XP1927","MIA→JFK","2026-03-23","07:05","Business"],["XP1943","JFK→MIA","2026-03-26","18:35","Business"],
      ["XP1927","MIA→JFK","2026-04-06","07:05","Business"],["XP1943","JFK→MIA","2026-04-09","18:35","Business"],
      ["XP1931","MIA→JFK","2026-04-13","09:10","Business"],["XP1927","MIA→JFK","2026-04-20","07:05","Business"],
      ["XP1927","MIA→JFK","2026-05-04","07:05","Business"],["XP1927","MIA→JFK","2026-05-11","07:05","Business"],
      ["XP1937","MIA→JFK","2026-05-18","12:40","Business"],["XP1927","MIA→JFK","2026-06-01","07:05","Business"],
      ["XP1080","MIA→MAD","2026-03-11","07:40","Business"],["XP1081","MAD→MIA","2026-03-13","19:30","Business"],
      ["XP1080","MIA→MAD","2026-04-15","07:40","Business"],["XP1081","MAD→MIA","2026-04-17","19:30","Business"],
      ["XP1080","MIA→MAD","2026-05-20","07:40","Business"],["XP1081","MAD→MIA","2026-05-22","19:30","Business"],
      ["XP440","MIA→CDG","2026-02-10","08:20","Business"],["XP441","CDG→MIA","2026-02-12","20:10","Business"],
      ["XP1690","MIA→CUN","2026-04-25","09:15","Leisure"],["XP1691","CUN→MIA","2026-04-27","17:00","Leisure"],
    ],
    bookings: [
      ["XPQ4K2","XP1927","MIA","JFK","07:05","08:00",86,"2026-03-02","22C","completed",1,["seat","bag","meal"]],
      ["XPM8R1","XP1943","JFK","MIA","18:35","19:30",84,"2026-03-05","22C","completed",1,["seat","bag","meal","wifi"]],
      ["XPW2N7","XP1080","MIA","MAD","07:40","09:55",97,"2026-03-11","22C","completed",1,["seat","bag","meal","lounge"]],
      ["XPL9V3","XP1927","MIA","JFK","07:05","08:00",86,"2026-03-23","22C","completed",1,["seat","bag","meal","wifi"]],
      ["XPF5J8","XP1080","MIA","MAD","07:40","09:55",92,"2026-04-15","22C","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPB7H4","XP1690","MIA","CUN","09:15","10:45",54,"2026-04-25","11A","completed",1,["seat","bag","meal"]],
      ["XPX1C9","XP1927","MIA","JFK","07:05","08:00",79,"2026-05-04","22C","completed",1,["seat","bag","meal","wifi","transfer"]],
      ["XPK6D2","XP1080","MIA","MAD","07:40","09:55",95,"2026-05-20","22C","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPN3T5","XP1927","MIA","JFK","07:05","08:00",86,"2026-06-15","22C","confirmed",0,["seat","bag","meal"]],
      ["XPG8Y1","XP1080","MIA","MAD","07:40","09:55",98,"2026-06-22","22C","confirmed",0,["seat","bag","meal"]],
    ],
    searches: [
      ["MIA","CDG","2026-06-19",1,3,"MacBook Pro",2],
      ["MIA","CDG","2026-07-03",1,3,"MacBook Pro",1],
      ["JFK","CUN","2026-08-01",3,2,"MacBook Pro",6],
    ],
  },

  sofia: {
    id: "sofia", label: "Sofia Marques", blurb: "Silver · New York leisure & family", archetype: "Family Explorer",
    user: { member_no: "PT-990002", first_name: "Sofia", full_name: "Sofia Marques", email: "anant.direct2links+sofia@gmail.com", phone: "+1 917 220 1184", tier: "Silver", miles: 21450, nationality: "American", dob: "27 Jul 1990", gender: "Female", passport_exp: "03 Jun 2029", doc_id: "US •••• 7720", home_airport: "JFK", card_brand: "Mastercard", card_last4: "8852", card_exp: "05/27", card_product: "Xperion Miles Mastercard", card_categories: JSON.stringify([{ name: "Golf & Country Clubs", share: 29 }, { name: "Sporting Goods", share: 21 }, { name: "Resorts & Spas", share: 17 }, { name: "Family Dining", share: 14 }]), affinity: "golf", affinity_label: "Golf enthusiast" },
    prefs: { seat: "14F — window", seat_note: "Window seat on 7 of your last 9 family trips", bag: "2 checked bags", meal: "Kids meal + vegetarian", auto_checkin: 1 },
    voucher: { code: "7741", amount: 50, reason: "Flight delay goodwill", expiry: "31 Dec 2026" },
    synced: { origin: "JFK", dest: "MCO", date: "2026-07-20", device: "iPhone", stage: "extras", flight_no: "XP1042", seat: "14F", items: ["bag","meal"], cabin: "Economy" },
    ancillaries: [
      ["seat","Seat 14F — window","Window for the kids. Extra legroom row.",6,12,1,"seat"],
      ["bag","2 checked bags 23kg","You always travel with checked luggage.",0,null,1,"bag"],
      ["meal","Kids meal + vegetarian","Pre-ordered for the family.",0,null,1,"meal"],
      ["wifi","Wi-Fi full pass","Keep the kids entertained.",6,null,0,"wifi"],
      ["transfer","Orlando family transfer","7-seater to the hotel.",32,null,0,"car"],
      ["lounge","Xperion Family Lounge JFK","Kids zone + snacks.",24,null,0,"lounge"],
    ],
    destinations: [
      ["Orlando","MCO","Your summer favourite",78,null,"🏖️"],
      ["Cancún","CUN","Family weekends · 4× this year",54,12000,"🌴"],
      ["Las Vegas","LAS","Searched 4× — beach season",39,null,"☀️"],
      ["Rome","FCO","On your wishlist",132,null,"🏛️"],
    ],
    history: [
      ["XP1696","JFK→CUN","2026-02-14","10:20","Leisure"],["XP1697","CUN→JFK","2026-02-17","18:10","Leisure"],
      ["XP1696","JFK→CUN","2026-04-03","10:20","Leisure"],["XP1697","CUN→JFK","2026-04-06","18:10","Leisure"],
      ["XP1030","JFK→MCO","2026-04-28","11:15","Leisure"],["XP1031","MCO→JFK","2026-05-02","19:40","Leisure"],
      ["XP1696","JFK→CUN","2026-05-23","10:20","Leisure"],["XP1697","CUN→JFK","2026-05-26","18:10","Leisure"],
      ["XP1240","JFK→LAS","2026-03-15","09:30","Leisure"],["XP1241","LAS→JFK","2026-03-17","20:00","Leisure"],
      ["XP1696","JFK→CUN","2026-06-06","10:20","Leisure"],["XP1697","CUN→JFK","2026-06-08","18:10","Leisure"],
    ],
    bookings: [
      ["XPS1A2","XP1696","JFK","CUN","10:20","11:50",58,"2026-02-14","14F","completed",1,["seat","bag","meal"]],
      ["XPS2B3","XP1030","JFK","MCO","11:15","13:35",82,"2026-04-28","14F","completed",1,["seat","bag","meal","wifi"]],
      ["XPS3C4","XP1696","JFK","CUN","10:20","11:50",61,"2026-04-03","14F","completed",1,["seat","bag","meal"]],
      ["XPS4D5","XP1240","JFK","LAS","09:30","10:25",42,"2026-03-15","14F","completed",1,["seat","bag","meal","wifi"]],
      ["XPS5E6","XP1696","JFK","CUN","10:20","11:50",58,"2026-05-23","14F","completed",1,["seat","bag","meal","transfer"]],
      ["XPS6F7","XP1696","JFK","CUN","10:20","11:50",55,"2026-06-06","14F","completed",1,["seat","bag","meal","wifi"]],
      ["XPS7G8","XP1030","JFK","MCO","11:15","13:35",79,"2026-07-20","14F","confirmed",0,["seat","bag","meal","wifi"]],
      ["XPS8H9","XP1696","JFK","CUN","10:20","11:50",60,"2026-08-15","14F","confirmed",0,["seat","bag","meal"]],
    ],
    searches: [
      ["JFK","LAS","2026-07-10",4,4,"iPhone",1],
      ["JFK","MCO","2026-07-20",4,2,"iPhone",2],
      ["JFK","FCO","2026-09-05",2,1,"iPhone",4],
    ],
  },

  lars: {
    id: "lars", label: "Lars Andersen", blurb: "Platinum · Frankfurt long-haul exec", archetype: "Long-haul Executive",
    user: { member_no: "DE-990003", first_name: "Lars", full_name: "Lars Andersen", email: "anant.direct2links+lars@gmail.com", phone: "+49 151 2244 7788", tier: "Platinum", miles: 184920, nationality: "German", dob: "05 Nov 1979", gender: "Male", passport_exp: "21 Jan 2032", doc_id: "DE •••• 1180", home_airport: "FRA", card_brand: "Amex", card_last4: "1009", card_exp: "11/29", card_product: "Xperion Miles Amex Platinum", card_categories: JSON.stringify([{ name: "Live Music & Concerts", share: 31 }, { name: "Music Streaming", share: 19 }, { name: "Fine Dining", share: 18 }, { name: "Luxury Hotels", share: 15 }]), affinity: "music", affinity_label: "Live-music lover" },
    prefs: { seat: "2A — business window", seat_note: "Business window on 12 of your last 14 long-hauls", bag: "2 bags + priority", meal: "Business — no pork", auto_checkin: 1 },
    voucher: { code: "9930", amount: 120, reason: "Platinum loyalty bonus", expiry: "30 Jun 2027" },
    synced: { origin: "FRA", dest: "JFK", date: "2026-07-08", device: "ThinkPad", stage: "review", flight_no: "XP201", seat: "2A", items: ["bag","meal","lounge"], cabin: "Business" },
    ancillaries: [
      ["seat","Seat 2A — business window","Your usual business window.",0,90,1,"seat"],
      ["bag","2 bags + priority","Included with Platinum.",0,null,1,"bag"],
      ["meal","Business — no pork","Pre-set dietary preference.",0,null,1,"meal"],
      ["wifi","Full-flight Wi-Fi","You buy this every long-haul.",18,null,1,"wifi"],
      ["transfer","Manhattan chauffeur","Black car to Midtown.",95,null,0,"car"],
      ["lounge","Xperion Club Lounge","Complimentary — Platinum.",0,null,1,"lounge"],
    ],
    destinations: [
      ["New York","JFK","Your most-flown route",612,null,"🗽"],
      ["São Paulo","GRU","Quarterly client visits",740,null,"🌆"],
      ["New York","JFK","Frequent connection hub",148,null,"🌉"],
      ["Miami","MIA","Searched 2× this month",588,null,"🌴"],
    ],
    history: [
      ["XP201","FRA→JFK","2026-02-04","10:40","Business"],["XP202","JFK→FRA","2026-02-09","18:20","Business"],
      ["XP201","FRA→JFK","2026-03-03","10:40","Business"],["XP202","JFK→FRA","2026-03-07","18:20","Business"],
      ["XP8050","FRA→GRU","2026-03-20","21:50","Business"],["XP8051","GRU→FRA","2026-03-27","19:10","Business"],
      ["XP201","FRA→JFK","2026-04-08","10:40","Business"],["XP202","JFK→FRA","2026-04-13","18:20","Business"],
      ["XP201","FRA→JFK","2026-05-06","10:40","Business"],["XP202","JFK→FRA","2026-05-11","18:20","Business"],
      ["XP8050","FRA→GRU","2026-05-19","21:50","Business"],["XP8051","GRU→FRA","2026-05-26","19:10","Business"],
      ["XP201","FRA→JFK","2026-06-03","10:40","Business"],["XP202","JFK→FRA","2026-06-08","18:20","Business"],
    ],
    bookings: [
      ["XPL1A2","XP201","FRA","JFK","10:40","13:30",612,"2026-02-04","2A","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPL2B3","XP8050","FRA","GRU","21:50","05:20",740,"2026-03-20","2A","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPL3C4","XP201","FRA","JFK","10:40","13:30",598,"2026-03-03","2A","completed",1,["seat","bag","meal","wifi","lounge","transfer"]],
      ["XPL4D5","XP201","FRA","JFK","10:40","13:30",625,"2026-04-08","2A","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPL5E6","XP201","FRA","JFK","10:40","13:30",610,"2026-05-06","2A","completed",1,["seat","bag","meal","wifi","lounge","transfer"]],
      ["XPL6F7","XP8050","FRA","GRU","21:50","05:20",728,"2026-05-19","2A","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPL7G8","XP201","FRA","JFK","10:40","13:30",612,"2026-07-08","2A","confirmed",0,["seat","bag","meal","wifi","lounge"]],
      ["XPL8H9","XP8050","FRA","GRU","21:50","05:20",740,"2026-07-25","2A","confirmed",0,["seat","bag","meal","wifi","lounge"]],
    ],
    searches: [
      ["FRA","MIA","2026-08-12",1,2,"ThinkPad",1],
      ["FRA","JFK","2026-07-08",1,3,"ThinkPad",3],
      ["FRA","GRU","2026-07-25",1,1,"ThinkPad",5],
    ],
  },

  // ── New Goal-B sample users (§6) — uids 4 & 5, wired into seed() in step 7b ──
  // Maria: low-tier, low-miles, foodie (affinity 'food' → no package, degrades to null
  // gracefully). NO voucher (exercises the no-voucher checkout path). JFK-based leisure.
  // marketing-CONSENTED per §6 — note: consent is a CDP-layer concept (cdp.js), there is
  // no users-table/persona field for it, so it is not encoded here.
  maria: {
    id: "maria", label: "Maria Costa", blurb: "Bronze · New York foodie & weekend traveller", archetype: "Culinary Explorer",
    user: { member_no: "PT-990004", first_name: "Maria", full_name: "Maria Costa", email: "anant.direct2links+maria@gmail.com", phone: "+1 407 558 3360", tier: "Bronze", miles: 3200, nationality: "American", dob: "09 May 1995", gender: "Female", passport_exp: "18 Apr 2030", doc_id: "US •••• 5512", home_airport: "JFK", card_brand: "Mastercard", card_last4: "6634", card_exp: "02/28", card_product: "Xperion Miles Mastercard", card_categories: JSON.stringify([{ name: "Dining & Restaurants", share: 38 }, { name: "Food Markets & Delis", share: 22 }, { name: "Cafés & Bakeries", share: 15 }, { name: "Grocery", share: 11 }]), affinity: "food", affinity_label: "Foodie" },
    prefs: { seat: "16C — aisle", seat_note: "Aisle on 5 of your last 6 trips", bag: "1 checked bag", meal: "Vegetarian", auto_checkin: 1 },
    // no voucher — entry-tier; exercises the no-voucher checkout path (§6)
    synced: { origin: "JFK", dest: "FCO", date: "2026-07-12", device: "iPhone", stage: "results", flight_no: "XP838", seat: null, items: ["bag"], cabin: "Economy" },
    ancillaries: [
      ["seat","Seat 16C — aisle","Your usual aisle seat.",6,12,1,"seat"],
      ["bag","1 checked bag 23kg","You usually check one bag.",0,null,1,"bag"],
      ["meal","Vegetarian meal","Pre-ordered to seat. Your usual.",0,null,1,"meal"],
      ["wifi","Wi-Fi messaging pass","Stay reachable in the air.",3,null,0,"wifi"],
      ["transfer","Rome airport transfer","Driver to the city centre.",26,null,0,"car"],
      ["lounge","Xperion Lounge JFK","Relax before your flight.",28,null,0,"lounge"],
    ],
    destinations: [
      ["Rome","FCO","Foodie city · searched 3×",149,null,"🍝"],
      ["Madrid","MAD","Tapas weekend",74,null,"🥘"],
      ["Orlando","MCO","On your wishlist",84,null,"🥘"],
      ["Las Vegas","LAS","Seafood by the coast",59,8000,"🦐"],
    ],
    history: [
      ["XP838","JFK→FCO","2026-03-06","11:30","Leisure"],["XP839","FCO→JFK","2026-03-09","15:10","Leisure"],
      ["XP1018","JFK→MAD","2026-04-11","08:45","Leisure"],["XP1019","MAD→JFK","2026-04-13","20:05","Leisure"],
      ["XP1244","JFK→LAS","2026-05-02","09:30","Leisure"],["XP1245","LAS→JFK","2026-05-04","19:40","Leisure"],
      ["XP838","JFK→FCO","2026-05-29","11:30","Leisure"],["XP839","FCO→JFK","2026-06-01","15:10","Leisure"],
      ["XP1032","JFK→MCO","2026-06-13","12:15","Leisure"],["XP1033","MCO→JFK","2026-06-15","21:00","Leisure"],
    ],
    bookings: [
      ["XPMA12","XP838","JFK","FCO","11:30","14:25",149,"2026-03-06","16C","completed",1,["seat","bag","meal"]],
      ["XPMB34","XP1018","JFK","MAD","08:45","10:05",74,"2026-04-11","16C","completed",1,["seat","bag","meal"]],
      ["XPMC56","XP1244","JFK","LAS","09:30","10:20",59,"2026-05-02","16C","completed",1,["seat","bag"]],
      ["XPMD78","XP838","JFK","FCO","11:30","14:25",152,"2026-05-29","16C","completed",1,["seat","bag","meal","wifi"]],
      ["XPME90","XP838","JFK","FCO","11:30","14:25",149,"2026-07-12","16C","confirmed",0,["seat","bag"]],
    ],
    searches: [
      ["JFK","FCO","2026-07-12",1,3,"iPhone",2],
      ["JFK","MAD","2026-08-08",2,2,"iPhone",3],
      ["JFK","MCO","2026-09-02",2,1,"iPhone",5],
    ],
  },

  // James: non-Portugal home (LHR) + high miles → Miles-Rich INCLUDES him, Frequent-MIA/JFK
  // audiences EXCLUDE him; UK-corridor (LHR↔JFK/MIA) journey. affinity 'business' → no package
  // (degrades to null gracefully). marketing-NOT-consented per §6 — again a CDP-layer concept,
  // no persona/users field exists for it, so not encoded here.
  james: {
    id: "james", label: "James Bennett", blurb: "Gold · London UK-corridor business traveller", archetype: "Corporate Connector",
    user: { member_no: "GB-990005", first_name: "James", full_name: "James Bennett", email: "anant.direct2links+james@gmail.com", phone: "+44 7700 900812", tier: "Gold", miles: 61000, nationality: "British", dob: "22 Oct 1981", gender: "Male", passport_exp: "07 Mar 2031", doc_id: "GB •••• 4480", home_airport: "LHR", card_brand: "Amex", card_last4: "2207", card_exp: "09/28", card_product: "Xperion Miles Amex Gold", card_categories: JSON.stringify([{ name: "Hotels & Lodging", share: 33 }, { name: "Car Rental", share: 24 }, { name: "Business Services", share: 16 }, { name: "Airport Dining", share: 12 }]), affinity: "business", affinity_label: "Business traveller" },
    prefs: { seat: "3C — front aisle", seat_note: "Front aisle on 10 of your last 12 trips", bag: "2 bags + priority", meal: "Standard — no shellfish", auto_checkin: 1 },
    voucher: { code: "5530", amount: 60, reason: "Gold loyalty bonus", expiry: "31 Mar 2027" },
    synced: { origin: "LHR", dest: "JFK", date: "2026-07-06", device: "iPad", stage: "seat", flight_no: "XP1358", seat: null, items: ["bag"], cabin: "Economy" },
    ancillaries: [
      ["seat","Seat 3C — front aisle","Your usual front aisle. Free for Gold.",0,12,1,"seat"],
      ["bag","2 bags + priority","Included with Gold.",0,null,1,"bag"],
      ["meal","Standard — no shellfish","Pre-set dietary preference.",4.5,null,1,"meal"],
      ["wifi","Full-flight Wi-Fi","You buy this most trips.",6,null,1,"wifi"],
      ["transfer","New York city transfer","Black car to the hotel.",30,null,0,"car"],
      ["lounge","Xperion Premium Lounge LHR","Complimentary — Gold benefit.",0,null,0,"lounge"],
    ],
    destinations: [
      ["New York","JFK","Your weekly corridor",134,null,"🌉"],
      ["Miami","MIA","Client visits",139,null,"🍷"],
      ["New York","JFK","Quarterly long-haul",499,null,"🗽"],
      ["Dublin","DUB","Searched 2× this month",74,null,"☘️"],
    ],
    history: [
      ["XP1358","LHR→JFK","2026-02-17","07:50","Business"],["XP1359","JFK→LHR","2026-02-20","19:25","Business"],
      ["XP1358","LHR→JFK","2026-03-10","07:50","Business"],["XP1359","JFK→LHR","2026-03-13","19:25","Business"],
      ["XP1366","LHR→MIA","2026-03-31","08:15","Business"],["XP1367","MIA→LHR","2026-04-02","20:10","Business"],
      ["XP1358","LHR→JFK","2026-04-21","07:50","Business"],["XP1359","JFK→LHR","2026-04-24","19:25","Business"],
      ["XP1374","LHR→JFK","2026-05-05","10:25","Business"],["XP1375","JFK→LHR","2026-05-12","18:40","Business"],
      ["XP1358","LHR→JFK","2026-05-26","07:50","Business"],["XP1359","JFK→LHR","2026-05-29","19:25","Business"],
      ["XP1358","LHR→JFK","2026-06-16","07:50","Business"],["XP1359","JFK→LHR","2026-06-19","19:25","Business"],
    ],
    bookings: [
      ["XPJA12","XP1358","LHR","JFK","07:50","10:35",139,"2026-02-17","3C","completed",1,["seat","bag","meal","wifi"]],
      ["XPJB34","XP1366","LHR","MIA","08:15","10:55",142,"2026-03-31","3C","completed",1,["seat","bag","meal","wifi"]],
      ["XPJC56","XP1358","LHR","JFK","07:50","10:35",134,"2026-04-21","3C","completed",1,["seat","bag","meal","wifi","lounge"]],
      ["XPJD78","XP1374","LHR","JFK","10:25","13:55",499,"2026-05-05","3C","completed",1,["seat","bag","meal","wifi","lounge","transfer"]],
      ["XPJE90","XP1358","LHR","JFK","07:50","10:35",136,"2026-05-26","3C","completed",1,["seat","bag","meal","wifi"]],
      ["XPJF12","XP1358","LHR","JFK","07:50","10:35",134,"2026-07-06","3C","confirmed",0,["seat","bag","meal"]],
      ["XPJG34","XP1366","LHR","MIA","08:15","10:55",139,"2026-07-20","3C","confirmed",0,["seat","bag","meal"]],
    ],
    searches: [
      ["LHR","DUB","2026-07-15",1,2,"iPad",1],
      ["LHR","JFK","2026-07-06",1,3,"iPad",2],
      ["LHR","MIA","2026-07-20",1,2,"iPad",4],
    ],
  },

  // ── Doc persona: Luís — Comfort seeker (Chapters 2 & 4) ──────────────
  luis: {
    id: "luis", label: "Luís Carvalho", blurb: "Gold · transatlantic Business", archetype: "Comfort Seeker",
    user: { member_no: "PT-990006", first_name: "Luís", full_name: "Luís Carvalho", email: "anant.direct2links+luis@gmail.com", phone: "+1 415 776 5540", tier: "Gold", miles: 96540, nationality: "American", dob: "18 Feb 1971", gender: "Male", passport_exp: "22 Nov 2030", doc_id: "US •••• 8841", home_airport: "JFK", card_brand: "Amex", card_last4: "1007", card_exp: "11/29", card_product: "Xperion Miles Amex Platinum", card_categories: JSON.stringify([{ name: "Fine Dining", share: 31 }, { name: "Luxury Hotels", share: 24 }, { name: "Business Travel", share: 19 }, { name: "Wine & Spirits", share: 12 }]), affinity: "wine", affinity_label: "Fine dining & wine" },
    prefs: { seat: "1A — Business, lie-flat window", seat_note: "Business window on 9 of your last 10 flights", bag: "2 checked bags · 32kg", meal: "Premium dining + wine pairing", auto_checkin: 1 },
    voucher: { code: "6120", amount: 120, reason: "Business service recovery", expiry: "31 Dec 2026" },
    synced: { origin: "JFK", dest: "JFK", date: "2026-06-18", device: "iPad Pro", stage: "seat", flight_no: "XP205", seat: "1A", items: ["seat", "lounge"], cabin: "Business" },
    ancillaries: [
      ["seat", "Seat 1A — Business suite", "Lie-flat window. Included in Business.", 0, null, 1, "seat"],
      ["lounge", "Xperion Premium Lounge — JFK", "Complimentary — Gold + Business.", 0, null, 1, "lounge"],
      ["bag", "2 checked bags · 32kg", "Included in Business fare.", 0, null, 1, "bag"],
      ["meal", "Premium dining + wine pairing", "Chef menu, pre-ordered to your seat.", 0, null, 1, "meal"],
      ["transfer", "Chauffeur to JFK airport", "Door-to-door — Business benefit.", 0, null, 0, "car"],
      ["wifi", "Wi-Fi Full Pass", "Full internet, whole flight.", 0, null, 0, "wifi"],
    ],
    destinations: [
      ["New York", "JFK", "Your quarterly board meeting", 449, null, "🗽"],
      ["São Paulo", "GRU", "Family + business", 529, null, "🌆"],
      ["London", "LHR", "Weekend with your wife", 134, null, "🎩"],
      ["Cancún", "CUN", "Anniversary escape · miles eligible", 89, 20000, "🌴"],
    ],
    history: [
      ["XP205", "JFK→JFK", "2026-02-14", "10:30", "Business"], ["XP206", "JFK→JFK", "2026-02-20", "19:45", "Business"],
      ["XP205", "JFK→JFK", "2026-03-18", "10:30", "Business"], ["XP206", "JFK→JFK", "2026-03-24", "19:45", "Business"],
      ["XP1360", "JFK→LHR", "2026-04-05", "08:40", "Business"], ["XP1361", "LHR→JFK", "2026-04-08", "20:10", "Business"],
      ["XP205", "JFK→JFK", "2026-05-12", "10:30", "Business"], ["XP206", "JFK→JFK", "2026-05-18", "19:45", "Business"],
    ],
    bookings: [
      ["XPLUI01", "XP205", "JFK", "JFK", "10:30", "13:50", 1180, "2026-02-14", "1A", "completed", 1, ["seat", "bag", "meal", "lounge"], "Business", "Executive Flex"],
      ["XPLUI02", "XP1360", "JFK", "LHR", "08:40", "11:20", 640, "2026-04-05", "2A", "completed", 1, ["seat", "bag", "meal", "lounge"], "Business", "Executive Flex"],
      ["XPLUI03", "XP205", "JFK", "JFK", "10:30", "13:50", 1240, "2026-06-18", "1A", "confirmed", 0, ["seat", "bag", "meal", "lounge"], "Business", "Executive Flex", "web", [{ first: "Luís", last: "Carvalho" }, { first: "Inês", last: "Carvalho" }]],
      ["XPLUI04", "XP1690", "JFK", "CUN", "09:15", "10:45", 320, "2026-07-12", "6A", "confirmed", 0, ["seat", "bag", "meal"], "Premium", "Premium Flex"],
    ],
    searches: [
      ["JFK", "JFK", "2026-06-18", 2, 4, "iPad Pro", 2],
      ["JFK", "GRU", "2026-09-02", 2, 4, "iPad Pro", 5],
      ["JFK", "LHR", "2026-08-15", 2, 4, "iPad Pro", 8],
    ],
  },

  // ── Doc persona: Marcela — Travelling mom (Chapter 8) ────────────────
  marcela: {
    id: "marcela", label: "Marcela Rocha", blurb: "Economy · travelling with 2 children", archetype: "Travelling Mom",
    user: { member_no: "BR-990007", first_name: "Marcela", full_name: "Marcela Rocha", email: "anant.direct2links+marcela@gmail.com", phone: "+55 11 98422 6610", tier: "Member", miles: 4120, nationality: "Brazilian", dob: "03 Sep 1989", gender: "Female", passport_exp: "09 Jul 2029", doc_id: "BR •••• 2245", home_airport: "GRU", card_brand: "Visa", card_last4: "3390", card_exp: "04/27", card_product: "Visa Crédito", card_categories: JSON.stringify([{ name: "Family Dining", share: 33 }, { name: "Supermarkets", share: 26 }, { name: "Kids & Toys", share: 18 }, { name: "Pharmacy", share: 11 }]), affinity: "family", affinity_label: "Family traveller" },
    prefs: { seat: "22A — window, seated together", seat_note: "Window for the kids on your last 3 trips", bag: "2 checked bags", meal: "Kids meals + vegetarian", auto_checkin: 0 },
    voucher: { code: "3080", amount: 40, reason: "Schedule change goodwill", expiry: "31 Oct 2026" },
    synced: { origin: "GRU", dest: "JFK", date: "2026-07-05", device: "Android phone", stage: "review", flight_no: "XP073", seat: "22A", items: ["seat", "bag", "meal"], cabin: "Economy" },
    ancillaries: [
      ["seat", "Seats 22A/22B/22C — together", "Family block, one row.", 24, null, 1, "seat"],
      ["bag", "2 checked bags · 23kg", "For the family's luggage.", 25, null, 1, "bag"],
      ["meal", "2 kids meals + 1 vegetarian", "Pre-ordered for the children.", 18, null, 1, "meal"],
      ["assist", "Family boarding + stroller", "Priority boarding with children.", 0, null, 0, "user"],
      ["wifi", "Wi-Fi messaging pass", "Keep the kids entertained.", 5, null, 0, "wifi"],
      ["insurance", "Family travel insurance", "Covers all 3 travellers.", 29, null, 0, "shield"],
    ],
    destinations: [
      ["New York", "JFK", "Visiting the grandparents", 529, null, "👵"],
      ["Miami", "MIA", "Family holiday", 545, null, "🌉"],
      ["Las Vegas", "LAS", "Beach with the kids", 560, null, "🏖️"],
      ["Madrid", "MAD", "Short family break", 118, null, "🏛️"],
    ],
    history: [
      ["XP073", "GRU→JFK", "2025-12-20", "22:10", "Leisure"], ["XP074", "JFK→GRU", "2026-01-08", "12:30", "Leisure"],
      ["XP073", "GRU→JFK", "2026-06-28", "22:10", "Leisure"],
    ],
    bookings: [
      ["XPMAR01", "XP073", "GRU", "JFK", "22:10", "13:05", 1587, "2025-12-20", "22A", "completed", 1, ["seat", "bag", "meal"], "Economy", "Classic", "web", [{ first: "Marcela", last: "Rocha" }, { first: "Beatriz", last: "Rocha" }, { first: "Tomás", last: "Rocha" }]],
      ["XPMAR02", "XP073", "GRU", "JFK", "22:10", "13:05", 1629, "2026-07-05", "22A", "confirmed", 0, ["seat", "bag", "meal"], "Economy", "Classic", "web", [{ first: "Marcela", last: "Rocha" }, { first: "Beatriz", last: "Rocha" }, { first: "Tomás", last: "Rocha" }]],
    ],
    searches: [
      ["GRU", "JFK", "2026-07-05", 3, 2, "Android phone", 3],
      ["GRU", "MIA", "2026-12-18", 3, 2, "Android phone", 9],
    ],
  },

  // ── Doc persona: Peter — Penny saver (Chapter 7) ─────────────────────
  peter: {
    id: "peter", label: "Peter Nowak", blurb: "Economy · budget student backpacker", archetype: "Penny Saver",
    user: { member_no: "US-990008", first_name: "Peter", full_name: "Peter Nowak", email: "anant.direct2links+peter@gmail.com", phone: "+1 617 555 0142", tier: "Member", miles: 1850, nationality: "American", dob: "14 Jan 2003", gender: "Male", passport_exp: "28 Feb 2032", doc_id: "US •••• 7013", home_airport: "BOS", card_brand: "Visa", card_last4: "5521", card_exp: "09/28", card_product: "Student Debit", card_categories: JSON.stringify([{ name: "Fast Food", share: 34 }, { name: "Transit & Rideshare", share: 22 }, { name: "Streaming", share: 16 }, { name: "Hostels", share: 12 }]), affinity: "backpacking", affinity_label: "Budget backpacker" },
    prefs: { seat: "Any available — cheapest", seat_note: "You skip paid seats to save", bag: "Cabin bag only", meal: "No meal — bring own", auto_checkin: 0 },
    voucher: { code: "1015", amount: 15, reason: "Cashback promo", expiry: "31 Dec 2026" },
    synced: { origin: "BOS", dest: "JFK", date: "2026-08-22", device: "Android phone", stage: "results", flight_no: "XP217", seat: null, items: [], cabin: "Economy" },
    ancillaries: [
      ["seat", "Any available seat", "Free auto-assign — saves $.", 0, null, 1, "seat"],
      ["bag", "Cabin bag 10kg", "Included — no checked bag.", 0, null, 1, "bag"],
      ["meal", "Skip meal", "No meal — you bring your own.", 0, null, 1, "meal"],
      ["wifi", "Wi-Fi messaging pass", "Cheapest connectivity option.", 3, null, 0, "wifi"],
      ["transfer", "Hostel shuttle — New York", "Shared budget transfer.", 9, null, 0, "car"],
      ["insurance", "Basic travel insurance", "Low-cost student cover.", 12, null, 0, "shield"],
    ],
    destinations: [
      ["New York", "JFK", "Backpacking Europe", 429, null, "🎒"],
      ["Orlando", "MCO", "Cheap onward hop", 84, null, "🏖️"],
      ["Miami", "MIA", "Hostels + port wine", 445, null, "🍷"],
      ["Madrid", "MAD", "Budget city break", 74, null, "🏛️"],
    ],
    history: [
      ["XP217", "BOS→JFK", "2026-01-05", "21:30", "Leisure"], ["XP1030", "JFK→MCO", "2026-01-09", "11:15", "Leisure"],
      ["XP218", "JFK→BOS", "2026-01-22", "10:40", "Leisure"],
    ],
    bookings: [
      ["XPPET01", "XP217", "BOS", "JFK", "21:30", "08:45", 452, "2026-01-05", "27B", "completed", 1, ["seat", "bag"], "Economy", "Basic"],
      ["XPPET02", "XP1030", "JFK", "MCO", "11:15", "13:35", 84, "2026-01-09", "29C", "completed", 1, ["seat", "bag"], "Economy", "Basic"],
      ["XPPET03", "XP217", "BOS", "JFK", "21:30", "08:45", 469, "2026-08-22", "28E", "confirmed", 0, ["seat", "bag"], "Economy", "Basic"],
    ],
    searches: [
      ["BOS", "JFK", "2026-08-22", 1, 5, "Android phone", 1],
      ["JFK", "MCO", "2026-08-29", 1, 4, "Android phone", 1],
      ["JFK", "MAD", "2026-09-02", 1, 5, "Android phone", 4],
    ],
  },

  // ── Doc persona: Mr. & Mrs. Pinto — Passport pensioners (Chapter 13, indirect) ──
  pinto: {
    id: "pinto", label: "Mr. & Mrs. Pinto", blurb: "Economy · agency-booked, reduced mobility", archetype: "Passport Pensioners",
    user: { member_no: "BR-990009", first_name: "António", full_name: "António Pinto", email: "anant.direct2links+pinto@gmail.com", phone: "+55 21 99655 4120", tier: "Member", miles: 620, nationality: "Brazilian", dob: "11 Apr 1957", gender: "Male", passport_exp: "30 Aug 2028", doc_id: "BR •••• 9930", home_airport: "GRU", card_brand: "Mastercard", card_last4: "7742", card_exp: "06/27", card_product: "Mastercard Crédito", card_categories: JSON.stringify([{ name: "Pharmacy & Health", share: 37 }, { name: "Supermarkets", share: 24 }, { name: "Travel Agency", share: 18 }, { name: "Utilities", share: 10 }]), affinity: "heritage", affinity_label: "Heritage traveller" },
    prefs: { seat: "20A/20B — front, step-free", seat_note: "Front row for step-free access", bag: "2 checked bags", meal: "Low-sodium", auto_checkin: 0 },
    voucher: null,
    synced: { origin: "GRU", dest: "JFK", date: "2026-07-28", device: "iPad", stage: "search", flight_no: null, seat: null, items: [], cabin: "Economy" },
    ancillaries: [
      ["assist", "Wheelchair assistance (WCHR)", "Airport + boarding assistance.", 0, null, 1, "user"],
      ["seat", "Seats 20A/20B — front, step-free", "Front row, easy access.", 30, null, 1, "seat"],
      ["bag", "2 checked bags · 23kg", "Booked via agency.", 0, null, 1, "bag"],
      ["meal", "2 low-sodium meals", "Dietary — pre-ordered.", 0, null, 1, "meal"],
      ["lounge", "Assistance waiting area", "Quiet area before boarding.", 0, null, 0, "lounge"],
    ],
    destinations: [
      ["New York", "JFK", "Visiting the grandchildren", 529, null, "👴"],
      ["Miami", "MIA", "Family reunion", 545, null, "🌉"],
    ],
    history: [
      ["XP073", "GRU→JFK", "2025-11-10", "22:10", "Leisure"], ["XP074", "JFK→GRU", "2025-11-30", "12:30", "Leisure"],
    ],
    bookings: [
      ["XPPIN01", "XP073", "GRU", "JFK", "22:10", "13:05", 1710, "2025-11-10", "20A", "completed", 1, ["seat", "bag", "meal", "assist"], "Economy", "Classic", "agency", [{ first: "António", last: "Pinto" }, { first: "Fernanda", last: "Pinto" }]],
      ["XPPIN02", "XP073", "GRU", "JFK", "22:10", "13:05", 1745, "2026-07-28", "20A", "confirmed", 0, ["seat", "bag", "meal", "assist"], "Economy", "Classic", "agency", [{ first: "António", last: "Pinto" }, { first: "Fernanda", last: "Pinto" }]],
    ],
    searches: [
      ["GRU", "JFK", "2026-07-28", 2, 3, "iPad", 6],
    ],
  },

  // ── Doc persona: Arthur — Anxious honeymooner (Chapters 3, 9, 14) ────
  arthur: {
    id: "arthur", label: "Arthur Hayes", blurb: "Business · honeymoon, checked in", archetype: "Anxious Honeymooner",
    user: { member_no: "US-990010", first_name: "Arthur", full_name: "Arthur Hayes", email: "anant.direct2links+arthur@gmail.com", phone: "+1 415 555 0193", tier: "Gold", miles: 58230, nationality: "American", dob: "27 Jun 1993", gender: "Male", passport_exp: "15 May 2031", doc_id: "US •••• 4471", home_airport: "JFK", card_brand: "Amex", card_last4: "2208", card_exp: "03/29", card_product: "Amex Gold", card_categories: JSON.stringify([{ name: "Restaurants", share: 29 }, { name: "Hotels & Resorts", share: 27 }, { name: "Experiences", share: 19 }, { name: "Flights", share: 14 }]), affinity: "honeymoon", affinity_label: "Special-occasion traveller" },
    prefs: { seat: "2A — Business, seated together", seat_note: "Seated with your fiancée every flight", bag: "2 checked bags", meal: "Premium dining", auto_checkin: 1 },
    voucher: { code: "8090", amount: 90, reason: "Anniversary goodwill", expiry: "31 Dec 2026" },
    synced: { origin: "JFK", dest: "JFK", date: "2026-06-19", device: "iPhone", stage: "extras", flight_no: "XP206", seat: "2A", items: ["seat", "lounge", "stopover"], cabin: "Business" },
    ancillaries: [
      ["seat", "Seats 2A/2D — Business, together", "Lie-flat, side by side.", 0, null, 1, "seat"],
      ["lounge", "Xperion Premium Lounge — JFK", "Complimentary — Gold + Business.", 0, null, 1, "lounge"],
      ["meal", "Premium dining · celebration", "Champagne toast on board.", 0, null, 1, "meal"],
      ["bag", "2 checked bags · 32kg", "Included in Business.", 0, null, 1, "bag"],
      ["stopover", "New York stopover · boutique hotel", "2 nights before Rome.", 240, null, 0, "lounge"],
      ["wifi", "Wi-Fi Full Pass", "Stay reachable — eases nerves.", 0, null, 0, "wifi"],
    ],
    destinations: [
      ["New York", "JFK", "Honeymoon stopover", 449, null, "💍"],
      ["Rome", "FCO", "Honeymoon — main leg", 165, null, "🏛️"],
      ["Paris", "CDG", "City of love", 121, null, "🗼"],
      ["Athens", "ATH", "Island hopping", 189, null, "🏖️"],
    ],
    history: [
      ["XP206", "JFK→JFK", "2026-03-02", "22:20", "Business"], ["XP205", "JFK→JFK", "2026-03-14", "10:30", "Business"],
      ["XP206", "JFK→JFK", "2026-05-06", "22:20", "Business"], ["XP205", "JFK→JFK", "2026-05-16", "10:30", "Business"],
    ],
    bookings: [
      ["XPART01", "XP206", "JFK", "JFK", "22:20", "09:40", 1210, "2026-03-02", "2A", "completed", 1, ["seat", "bag", "meal", "lounge"], "Business", "Executive Flex", "web", [{ first: "Arthur", last: "Hayes" }, { first: "Sophie", last: "Bennett" }]],
      ["XPART02", "XP206", "JFK", "JFK", "22:20", "09:40", 1290, "2026-06-19", "2A", "confirmed", 1, ["seat", "bag", "meal", "lounge"], "Business", "Executive Flex", "web", [{ first: "Arthur", last: "Hayes" }, { first: "Sophie", last: "Bennett" }]],
      ["XPART03", "XP840", "JFK", "FCO", "13:20", "17:05", 320, "2026-06-24", "6A", "confirmed", 0, ["seat", "bag", "meal"], "Premium", "Premium Flex", "web", [{ first: "Arthur", last: "Hayes" }, { first: "Sophie", last: "Bennett" }]],
    ],
    searches: [
      ["JFK", "JFK", "2026-06-19", 2, 3, "iPhone", 2],
      ["JFK", "FCO", "2026-06-24", 2, 2, "iPhone", 2],
      ["JFK", "CDG", "2026-06-26", 2, 3, "iPhone", 5],
    ],
  },

  // ── Doc persona: Eliane — Homesick emigrant (Chapters 6, 10, 12) ─────
  eliane: {
    id: "eliane", label: "Eliane Moreira", blurb: "Silver · high-frequency BR–PT", archetype: "Homesick Emigrant",
    user: { member_no: "BR-990011", first_name: "Eliane", full_name: "Eliane Moreira", email: "anant.direct2links+eliane@gmail.com", phone: "+55 11 97733 8820", tier: "Silver", miles: 71240, nationality: "Brazilian", dob: "22 Oct 1979", gender: "Female", passport_exp: "04 Mar 2030", doc_id: "BR •••• 6650", home_airport: "GRU", card_brand: "Visa", card_last4: "9914", card_exp: "12/28", card_product: "Xperion Miles Visa", card_categories: JSON.stringify([{ name: "Money Transfer", share: 30 }, { name: "Groceries", share: 23 }, { name: "Telecoms", share: 17 }, { name: "Flights", share: 15 }]), affinity: "family", affinity_label: "Keeping family close" },
    prefs: { seat: "22F — window", seat_note: "Window on 8 of your last 10 flights", bag: "2 checked bags · gifts", meal: "Vegetarian", auto_checkin: 1 },
    voucher: { code: "5044", amount: 60, reason: "Loyalty goodwill", expiry: "31 Dec 2026" },
    synced: { origin: "GRU", dest: "JFK", date: "2026-07-02", device: "Android phone", stage: "seat", flight_no: "XP073", seat: "22F", items: ["seat", "bag"], cabin: "Economy" },
    ancillaries: [
      ["seat", "Seat 22F — window", "Your usual window.", 12, null, 1, "seat"],
      ["bag", "2 checked bags · 23kg", "Gifts for the family.", 25, null, 1, "bag"],
      ["meal", "Vegetarian meal", "Pre-ordered to your seat.", 8, null, 1, "meal"],
      ["wifi", "Wi-Fi Full Pass", "Video-call the kids at home.", 6, null, 0, "wifi"],
      ["transfer", "Airport transfer — New York", "To your mother's home.", 18, null, 0, "car"],
      ["lounge", "Xperion Lounge — GRU", "Silver rate.", 24, null, 0, "lounge"],
    ],
    destinations: [
      ["New York", "JFK", "Home — visiting family", 529, 90000, "❤️"],
      ["Miami", "MIA", "Your sister lives here", 545, null, "🌉"],
      ["Rio de Janeiro", "GIG", "Where you grew up", 179, null, "🏖️"],
      ["Madrid", "MAD", "Layover shopping", 118, null, "🏛️"],
    ],
    history: [
      ["XP073", "GRU→JFK", "2026-01-14", "22:10", "Leisure"], ["XP074", "JFK→GRU", "2026-02-02", "12:30", "Leisure"],
      ["XP073", "GRU→JFK", "2026-03-20", "22:10", "Leisure"], ["XP074", "JFK→GRU", "2026-04-06", "12:30", "Leisure"],
      ["XP083", "JFK→GIG", "2026-05-01", "23:40", "Leisure"], ["XP084", "GIG→JFK", "2026-05-20", "18:10", "Leisure"],
    ],
    bookings: [
      ["XPELI01", "XP073", "GRU", "JFK", "22:10", "13:05", 548, "2026-01-14", "22F", "completed", 1, ["seat", "bag", "meal"], "Economy", "Classic"],
      ["XPELI02", "XP074", "JFK", "GRU", "12:30", "20:55", 542, "2026-02-02", "22F", "completed", 1, ["seat", "bag", "meal"], "Economy", "Classic"],
      ["XPELI03", "XP073", "GRU", "JFK", "22:10", "13:05", 561, "2026-07-02", "22F", "confirmed", 0, ["seat", "bag", "meal"], "Economy", "Classic", "web", [{ first: "Eliane", last: "Moreira" }, { first: "Rafael", last: "Moreira" }, { first: "Clara", last: "Moreira" }]],
      ["XPELI04", "XP083", "JFK", "GIG", "23:40", "07:20", 189, "2026-08-10", "24D", "confirmed", 0, ["seat", "bag"], "Economy", "Classic"],
    ],
    searches: [
      ["GRU", "JFK", "2026-07-02", 3, 3, "Android phone", 1],
      ["JFK", "GRU", "2026-07-24", 3, 3, "Android phone", 1],
      ["GIG", "MIA", "2026-09-15", 1, 4, "Android phone", 7],
    ],
  },
};
const DEFAULT_PERSONA = "daniel";

function seedBookings(uid, persona) {
  const P = (persona && PERSONAS[persona]) || PERSONAS[DEFAULT_PERSONA];
  const B = P.bookings;
  // Route-accurate duration/aircraft so long-haul personas (Luís, Arthur, Eliane) display correctly.
  const routeDur = {}; for (const [o, d, dur] of ROUTES) { routeDur[o + "-" + d] = dur; routeDur[d + "-" + o] = dur; }
  const fmtDur = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
  // Seed ONE flights row per unique flight_no (personalization joins bookings→flights;
  // duplicate flight_no rows would inflate counts). Booking carries its own date/seat.
  const seenFlights = new Set(db.prepare("SELECT flight_no FROM flights").all().map(r => r.flight_no));
  const insF = db.prepare(`INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,recommended,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'scheduled')`);
  const insB = db.prepare(`INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,meta_json,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO payments (booking_id,total,voucher_amt,miles_used,miles_amt,card_amt,created_at)
    VALUES (?,?,?,?,?,?,?)`);
  const shift = personaShift(P);
  // Rows: [pnr,fno,o,d,dep,arr,price,date,seat,status,ci,items, cabin?, fare?, source?, passengers?]
  B.forEach(([pnr, fno, o, d, dep, arr, price, date, seat, status, ci, items, cabin, fare, source, passengers]) => {
    // Upcoming (confirmed) trips roll forward so the soonest is ~tomorrow; past trips stay put.
    const bdate = status === "confirmed" ? isoAdd(date, shift) : date;
    if (!seenFlights.has(fno)) {
      const dm = routeDur[o + "-" + d];
      const dur = dm ? fmtDur(dm) : (d === "CUN" ? "1h30" : (d === "MAD" ? "2h15" : "0h55"));
      const aircraft = (dm || 0) >= 360 ? "A330neo" : "A320neo";   // wide-body on long-haul
      insF.run(fno, o, d, dep, arr, dur, aircraft, price, 9, bdate, fno === "XP1927" ? 1 : 0);
      seenFlights.add(fno);
    }
    const createdAt = date + " 08:30:00";
    // meta_json carries cabin/fare (so the migration keeps cabin-correct seats) and any extra passengers.
    const meta = (cabin || fare || passengers)
      ? JSON.stringify({ cabin: cabin || "Economy", fare: fare || "Classic", ...(passengers ? { passengers } : {}) })
      : null;
    const r = insB.run(pnr, uid, fno, bdate, seat, status, ci, JSON.stringify(items), meta, source || "web", createdAt);
    insP.run(Number(r.lastInsertRowid), price, 0, 0, 0, +price.toFixed(2), createdAt);
  });
}

// The 11 known/pre-seeded personas — fixed uid↔persona mapping. uids 12–21 are the
// anonymous registration slots, created on demand at register time (NOT seeded here).
const KNOWN_USERS = [[1, "daniel"], [2, "sofia"], [3, "lars"], [4, "maria"], [5, "james"], [6, "luis"], [7, "marcela"], [8, "peter"], [9, "pinto"], [10, "arthur"], [11, "eliane"]];

function seed() {
  seedMembersDirectory();                       // all 5 personas → members directory (idempotent)
  const c = db.prepare("SELECT COUNT(*) n FROM users").get().n;
  if (c > 0) return;                            // already seeded — idempotent gate
  seedSharedCatalogs();                         // airports/routes/ancillaries/destinations — once, shared
  for (const [uid, p] of KNOWN_USERS) seedUser(uid, p);
  // Global default persona for unbound / legacy callers (bound sessions resolve per-session).
  db.prepare("INSERT INTO app_state (k,v) VALUES ('persona',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(DEFAULT_PERSONA);
}

// The members directory holds ALL personas (not just the live id=1 record), so PSS
// bookings for any member resolve, accrue miles, and can be segmented. Idempotent.
function seedMembersDirectory() {
  const ins = db.prepare(`INSERT OR REPLACE INTO members (member_no,email,full_name,first_name,tier,miles,affinity,affinity_label,home_airport)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const p of Object.values(PERSONAS)) {
    const u = p.user;
    ins.run(u.member_no, u.email, u.full_name, u.first_name, u.tier, u.miles, u.affinity, u.affinity_label, u.home_airport);
  }
}

// Shared catalogs — airports, route network, ancillary catalog, destination cards.
// Seeded ONCE (count-gated), independent of any single user, so seeding 5 users never
// collides on these global tables. The ancillary/destination CONTENT is taken from the
// default persona; per-user personalization is computed at read time from each user's own
// bookings/history (see /api/ancillaries, /api/destinations), not from these rows.
function seedSharedCatalogs(personaId = DEFAULT_PERSONA) {
  const P = PERSONAS[personaId] || PERSONAS[DEFAULT_PERSONA];

  // Airports & route network
  if (db.prepare("SELECT COUNT(*) c FROM airports").get().c === 0) {
    const ia = db.prepare("INSERT OR IGNORE INTO airports (code,city,country,region) VALUES (?,?,?,?)");
    for (const [code, a] of Object.entries(AIRPORTS)) ia.run(code, a.city, a.country, a.region);
    const ir = db.prepare("INSERT INTO routes (origin,dest,duration_min,base_fare,region) VALUES (?,?,?,?,?)");
    for (const [o, d, dur, fare] of ROUTES) {
      const region = AIRPORTS[o].region === AIRPORTS[d].region ? "Regional" : "Intercontinental";
      ir.run(o, d, dur, fare, region);
    }
  }
  // Keep route timings/fares in sync with the source-of-truth ROUTES on every boot,
  // so corrected durations apply on deploy without needing a full DB reset.
  {
    const ins = db.prepare("INSERT OR IGNORE INTO routes (origin,dest,duration_min,base_fare,region) VALUES (?,?,?,?,?)");
    const upd = db.prepare("UPDATE routes SET duration_min=?, base_fare=? WHERE origin=? AND dest=?");
    for (const [o, d, dur, fare] of ROUTES) {
      const region = AIRPORTS[o] && AIRPORTS[d] && AIRPORTS[o].region === AIRPORTS[d].region ? "Regional" : "Intercontinental";
      ins.run(o, d, dur, fare, region);
      upd.run(dur, fare, o, d);
    }
  }

  // Ancillary catalog (shared; count-gated so it isn't re-seeded per user)
  if (db.prepare("SELECT COUNT(*) c FROM ancillaries").get().c === 0) {
    const an = db.prepare("INSERT INTO ancillaries (code,name,descr,price,was,auto,icon) VALUES (?,?,?,?,?,?,?)");
    P.ancillaries.forEach(a => an.run(...a));
  }
  // Destination cards (shared; count-gated)
  if (db.prepare("SELECT COUNT(*) c FROM destinations").get().c === 0) {
    const de = db.prepare("INSERT INTO destinations (city,code,tag,price,miles_price,emoji) VALUES (?,?,?,?,?,?)");
    P.destinations.forEach(d => de.run(...d));
  }
}

// Inserts everything for ONE persona into a SPECIFIC user row (id=uid). Used by initial
// seed (uids 1–5) and by the reset path. Does NOT touch shared catalogs (see above).
function seedUser(uid, personaId) {
  const P = PERSONAS[personaId] || PERSONAS[DEFAULT_PERSONA];
  const u = P.user;
  db.prepare(`INSERT INTO users (id,member_no,first_name,full_name,email,phone,tier,miles,nationality,doc_id,home_airport,card_brand,card_last4,card_exp,card_product,card_categories,affinity,affinity_label,dob,gender,passport_exp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid, u.member_no, u.first_name, u.full_name, u.email /* Adobe identity = persona's real unique email; DEMO_EMAIL_TO only overrides the SMTP recipient in email.js, so a shared inbox no longer collapses all personas into one CDP profile */, u.phone, u.tier, u.miles, u.nationality, u.doc_id, u.home_airport, u.card_brand, u.card_last4, u.card_exp, u.card_product, u.card_categories, u.affinity, u.affinity_label, u.dob, u.gender, u.passport_exp);

  const p = P.prefs;
  db.prepare(`INSERT INTO preferences VALUES (?,?,?,?,?,?)`).run(uid, p.seat, p.seat_note, p.bag, p.meal, p.auto_checkin);
  if (P.voucher) {   // entry-tier personas (e.g. Maria) have no voucher
    const v = P.voucher;
    db.prepare(`INSERT INTO vouchers (user_id,code,amount,reason,expiry) VALUES (?,?,?,?,?)`).run(uid, v.code, v.amount, v.reason, v.expiry);
  }

  // Travel history (drives "Picked for you" reasons)
  const ih = db.prepare("INSERT INTO travel_history (user_id,flight_no,route,trip_date,dep_time,purpose) VALUES (?,?,?,?,?,?)");
  P.history.forEach(h => ih.run(uid, ...h));

  // Bookings (+ matching flights + payments) and behavioural searches
  seedBookings(uid, personaId);
  seedSearches(uid, personaId);

  // The live "continue your last search" banner — now carries a journey STAGE + selections
  const s = P.synced;
  const sDate = isoAdd(s.date, personaShift(P));   // keep the resume journey aligned with the upcoming trip
  db.prepare(`INSERT INTO synced_searches (user_id,origin,dest,travel_date,pax,device,created_at,stage,flight_no,seat,items_json,cabin,updated_at)
    VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
      uid, s.origin, s.dest, sDate, s.device, now(),
      s.stage || "results",            // where the customer left off
      s.flight_no || null,             // selected flight (if past results)
      s.seat || null,                  // chosen seat (if past seat step)
      JSON.stringify(s.items || []),   // chosen add-ons
      s.cabin || "Economy",
      now());

  // Make sure the in-progress journey's flight exists in the flights table so
  // "Resume where you left off" can hydrate it on every channel. A persona's
  // synced flight may not be pinned or previously booked (e.g. Sofia's XP1042),
  // in which case it wouldn't otherwise be in `flights` and resume couldn't load it.
  if (s.flight_no && !db.prepare("SELECT id FROM flights WHERE flight_no=?").get(s.flight_no)) {
    const r = db.prepare("SELECT duration_min, base_fare FROM routes WHERE origin=? AND dest=?").get(s.origin, s.dest);
    const durMin = (r && r.duration_min) || 120;
    const p2 = (n) => String(n).padStart(2, "0");
    const depMin = 11 * 60 + 15;                 // a plausible mid-morning departure
    const arrMin = depMin + durMin;
    const hhmm = (m) => `${p2(Math.floor(m / 60) % 24)}:${p2(m % 60)}`;
    const durLbl = durMin >= 60 ? `${Math.floor(durMin / 60)}h${durMin % 60 ? p2(durMin % 60) : ""}` : `${durMin}m`;
    db.prepare(`INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,recommended,lowest,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,'scheduled')`)
      .run(s.flight_no, s.origin, s.dest, hhmm(depMin), hhmm(arrMin), durLbl, "A320neo", (r && r.base_fare) || 100, 22, sDate);
  }

  db.prepare("INSERT INTO events (type,payload_json,created_at) VALUES ('db_seeded',?,?)").run(JSON.stringify({ persona: personaId, uid }), now());
  console.log(`✓ Seeded user ${uid} ← persona '${personaId}' (${u.member_no}) → ` + DB_PATH);
}
seed();

// The 5 original personas seed only on a fresh DB (seed() is count-gated). The 6 doc
// personas (uids 6–11) must ALSO appear on an already-seeded VM DB without a wipe, so
// seed them here idempotently: add each missing persona (matched by member_no) at its
// designated uid, but only if that uid is free (never clobber an anonymous registration).
(function ensureDocPersonas() {
  try {
    const NEW = [[6, "luis"], [7, "marcela"], [8, "peter"], [9, "pinto"], [10, "arthur"], [11, "eliane"]];
    let added = 0, blocked = 0;
    for (const [uid, pid] of NEW) {
      const P = PERSONAS[pid]; if (!P) continue;
      if (db.prepare("SELECT id FROM users WHERE member_no=?").get(P.user.member_no)) continue;   // already present
      if (db.prepare("SELECT id FROM users WHERE id=?").get(uid)) { blocked++; continue; }          // uid taken (e.g. anon reg) — skip
      seedUser(uid, pid);
      added++;
    }
    if (added) console.log(`[seed] added ${added} doc persona(s) to existing DB`);
    if (blocked) console.warn(`[seed] ${blocked} doc persona uid(s) occupied by other users — reset the DB to seat all 11 personas cleanly`);
  } catch (e) { console.warn("[seed] ensureDocPersonas skipped:", e.message); }
})();

// Unconditional, idempotent route-network sync — runs on EVERY boot, independent of the
// initial seed (which is gated on a fresh DB). Ensures new/reverse routes added to
// routes-data.js (the inbound legs that make round-trips work) are ingested into an
// existing DB on deploy, with no reset or persona switch required.
{
  // The routes table has no uniqueness on (origin,dest), so prior INSERT OR IGNORE syncs
  // (here and in seedPersonaData) appended duplicates on every reset/persona-switch. Clean
  // up any accumulated dupes (keep the earliest row per pair), then enforce uniqueness so
  // all future syncs are genuinely idempotent.
  const before = db.prepare("SELECT COUNT(*) c FROM routes").get().c;
  db.exec("DELETE FROM routes WHERE id NOT IN (SELECT MIN(id) FROM routes GROUP BY origin, dest)");
  const deduped = before - db.prepare("SELECT COUNT(*) c FROM routes").get().c;
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_od ON routes(origin, dest)"); } catch (e) { /* exists */ }

  const ins = db.prepare("INSERT OR IGNORE INTO routes (origin,dest,duration_min,base_fare,region) VALUES (?,?,?,?,?)");
  let added = 0;
  for (const [o, d, dur, fare] of ROUTES) {
    if (!(AIRPORTS[o] && AIRPORTS[d])) continue;
    const region = AIRPORTS[o].region === AIRPORTS[d].region ? "Regional" : "Intercontinental";
    const r = ins.run(o, d, dur, fare, region);
    if (r && r.changes) added++;
  }
  if (deduped || added) console.log(`✓ Route network synced (-${deduped} dupes, +${added} routes → ${db.prepare("SELECT COUNT(*) c FROM routes").get().c} bidirectional) → ` + DB_PATH);
}

/* ── Data-source toggle: SQLite (local) vs Adobe Real-Time CDP ──────────
   The active source decides where the customer PROFILE + traits are hydrated
   from (identity, loyalty, affinity, card-spend traits, preferences, wallet).
   Operational/transactional tables (bookings, searches, payments, flights…)
   always remain in SQLite — RT-CDP is a profile/traits store, not a booking
   engine — which is exactly how a real deployment is wired. Because every
   channel reads the `users`/`preferences` rows, swapping the source re-points
   ALL personalization (web portal + web AI chat + WhatsApp) at once. */
function getDataSource() {
  const r = db.prepare("SELECT v FROM app_state WHERE k='datasource'").get();
  return (r && r.v) || (process.env.PROFILE_SOURCE === "adobe" ? "adobe" : "sqlite");
}
function setDataSource(s) {
  const v = s === "adobe" ? "adobe" : "sqlite";
  db.prepare("INSERT INTO app_state (k,v) VALUES ('datasource',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(v);
  return v;
}
// Overwrite the live PROFILE (users + preferences + vouchers) from a normalized
// { user, prefs, voucher } object — used to hydrate traits from either the local
// persona (SQLite) or Adobe RT-CDP. Leaves all operational tables untouched, so
// switching source never wipes bookings/searches/history.
function applyProfile(profile, uid = 1) {
  if (!profile || !profile.user) return;
  const u = profile.user;
  db.prepare(`UPDATE users SET member_no=?, first_name=?, full_name=?, email=?, phone=?, tier=?, miles=?, nationality=?, doc_id=?, home_airport=?, card_brand=?, card_last4=?, card_exp=?, card_product=?, card_categories=?, affinity=?, affinity_label=?, dob=?, gender=?, passport_exp=? WHERE id=?`)
    .run(u.member_no, u.first_name, u.full_name, u.email /* Adobe identity = persona's real unique email; DEMO_EMAIL_TO only overrides the SMTP recipient in email.js, so a shared inbox no longer collapses all personas into one CDP profile */, u.phone, u.tier, u.miles, u.nationality, u.doc_id, u.home_airport, u.card_brand, u.card_last4, u.card_exp, u.card_product, u.card_categories, u.affinity, u.affinity_label, u.dob, u.gender, u.passport_exp, uid);
  if (profile.prefs) { db.prepare("DELETE FROM preferences WHERE user_id=?").run(uid); const p = profile.prefs; db.prepare(`INSERT INTO preferences VALUES (?,?,?,?,?,?)`).run(uid, p.seat, p.seat_note, p.bag, p.meal, p.auto_checkin); }
  if (profile.voucher) { db.prepare("DELETE FROM vouchers WHERE user_id=?").run(uid); const v = profile.voucher; db.prepare(`INSERT INTO vouchers (user_id,code,amount,reason,expiry) VALUES (?,?,?,?,?)`).run(uid, v.code, v.amount, v.reason, v.expiry); }
}
// The normalized profile for a persona straight from the local SQLite seed.
function localProfile(personaId) {
  const P = PERSONAS[personaId] || PERSONAS[DEFAULT_PERSONA];
  return { user: { ...P.user }, prefs: { ...P.prefs }, voucher: { ...P.voucher } };
}

/* ── Migration: realign stored seat & cabin on Premium/Business/Plus bookings ──────────
   Bookings created before cabin-aware seating stored an economy-default seat (e.g. "4C")
   and cabin "Economy" even when the fare was Premium/Executive/Plus, so My Trips showed
   the wrong seat/cabin. This realigns the stored seat to the fare's cabin entitlement and
   corrects meta.cabin. Runs every boot but is idempotent: it only rewrites a seat that is
   still a generic economy default (so an explicit non-default seat pick is preserved), and
   only when the value actually disagrees with the fare. Economy bookings are left untouched. */
(function realignCabinSeats() {
  try {
    // Canonical cabin layouts (must match SEAT_CABINS in checkout.jsx and CABINS in mmb.jsx).
    const MAP = {
      Business: { cols: ["A", "D"], rows: [1, 2, 3, 4, 5] },
      Premium: { cols: ["A", "C", "D", "F"], rows: [6, 7, 8, 9, 10, 11] },
      Economy: { cols: ["A", "B", "C", "D", "E", "F"], rows: Array.from({ length: 13 }, (_, i) => 20 + i) },
    };
    const DEFAULT_SEAT = { Business: "1A", Premium: "6A", Economy: "22C" };
    const cabinOf = (fare, cabin) => /exec|business/i.test(String(cabin || fare || "")) ? "Business" : /premium/i.test(String(cabin || fare || "")) ? "Premium" : "Economy";
    const seatForFare = (fare) => { const f = String(fare || ""); return /exec/i.test(f) ? "1A" : /premium/i.test(f) ? "6A" : /plus/i.test(f) ? "22D" : null; };
    const seatValid = (seat, cab) => { const m = String(seat || "").match(/^(\d+)([A-Za-z])$/); const c = MAP[cab] || MAP.Economy; return !!(m && c.cols.includes(m[2].toUpperCase()) && c.rows.includes(+m[1])); };
    const rows = db.prepare("SELECT id, seat, meta_json FROM bookings").all();
    const upd = db.prepare("UPDATE bookings SET seat=?, meta_json=? WHERE id=?");
    const updSeat = db.prepare("UPDATE bookings SET seat=? WHERE id=?");
    let n = 0;
    for (const r of rows) {
      let meta = null; try { meta = r.meta_json ? JSON.parse(r.meta_json) : null; } catch { /* keep null */ }
      const fare = meta ? (meta.fare || meta.cabin) : "";
      const cab = cabinOf(fare, meta && meta.cabin);
      let seat = r.seat, m2 = meta, changed = false;
      // Validate the ACTUAL seat against the cabin map; remap ANY seat that doesn't exist in that cabin.
      if (!seatValid(seat, cab)) { const want = seatForFare(fare) || DEFAULT_SEAT[cab]; if (want !== r.seat) { seat = want; changed = true; } }
      // Keep meta.cabin consistent with a Business/Premium fare.
      const wantCabin = /exec/i.test(String(fare)) ? "Business" : /premium/i.test(String(fare)) ? "Premium" : null;
      if (meta && wantCabin && meta.cabin !== wantCabin) { m2 = { ...meta, cabin: wantCabin }; changed = true; }
      if (changed) { m2 ? upd.run(seat, JSON.stringify(m2), r.id) : updSeat.run(seat, r.id); n++; }
    }
    if (n) console.log(`[migrate] realigned ${n} booking seat(s) to a valid seat for the cabin`);
  } catch (e) { console.warn("[migrate] cabin-seat realign skipped:", e.message); }
})();

/* ── Ensure Daniel's My Trips is always populated with a rich, cabin-varied set ──────────
   The demo /pay bookings a user creates are transient and vanish whenever the DB is rebuilt,
   leaving only the base seed (2 Economy trips). This idempotently tops Daniel (user_id=1) up
   to a representative set across cabins (Economy / Plus / Premium / Business), with correct
   seats, fares and meta, so My Trips always looks complete. Skips any PNR that already exists,
   and only runs when Daniel is the live record. Dates roll forward from today on every boot. */
(function ensureDanielUpcoming() {
  try {
    const u = db.prepare("SELECT id, member_no FROM users WHERE id=1").get();
    if (!u || u.member_no !== "PT-990001") return;   // only when Daniel occupies the live record
    // [pnr, flight_no, origin, dest, dep, arr, duration, price, seat, fare, cabin, dayOffset, items]
    const TRIPS = [
      ["XPDAN02", "XP1931", "MIA", "JFK", "09:10", "10:05", "0h55", 128, "22D", "Plus", "Economy", 3, ["seat", "bag"]],
      ["XPDAN03", "XP1937", "MIA", "JFK", "12:40", "13:35", "0h55", 214, "6A", "Premium Flex", "Premium", 6, ["seat", "bag", "meal", "lounge"]],
      ["XPDAN04", "XP1943", "JFK", "MIA", "18:35", "19:30", "0h55", 342, "1A", "Executive Flex", "Business", 9, ["seat", "bag", "meal", "lounge"]],
      ["XPDAN05", "XP1520", "MIA", "LHR", "20:50", "23:30", "2h40", 298, "6A", "Premium Flex", "Premium", 14, ["seat", "carbon", "ins-plus"]],
      ["XPDAN06", "XP1080", "MIA", "MAD", "07:40", "09:55", "2h15", 156, "22C", "Classic", "Economy", 21, ["seat", "bag", "meal"]],
    ];
    const has = db.prepare("SELECT 1 c FROM bookings WHERE pnr=? AND user_id=1");
    const seenF = new Set(db.prepare("SELECT flight_no FROM flights").all().map(r => r.flight_no));
    const insF = db.prepare("INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,recommended,status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'scheduled')");
    const insB = db.prepare("INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const insP = db.prepare("INSERT INTO payments (booking_id,total,voucher_amt,miles_used,miles_amt,card_amt,created_at) VALUES (?,?,?,?,?,?,?)");
    let n = 0;
    for (const [pnr, fno, o, d, dep, arr, dur, price, seat, fare, cabin, off, items] of TRIPS) {
      if (has.get(pnr)) continue;
      const bdate = isoAdd(TODAY, off);
      const aircraft = d === "LHR" ? "A321neo" : "A320neo";
      if (!seenF.has(fno)) { insF.run(fno, o, d, dep, arr, dur, aircraft, price, 9, bdate, 0); seenF.add(fno); }
      const meta = { fare, cabin, origin: o, dest: d, dep, arr, aircraft };
      const r = insB.run(pnr, 1, fno, bdate, seat, "confirmed", 0, JSON.stringify(items), JSON.stringify(meta), TODAY + " 08:30:00");
      insP.run(Number(r.lastInsertRowid), price, 0, 0, 0, +price.toFixed(2), TODAY + " 08:30:00");
      n++;
    }
    if (n) console.log(`[seed] ensured ${n} upcoming demo booking(s) for Daniel across cabins`);
  } catch (e) { console.warn("[seed] ensureDanielUpcoming skipped:", e.message); }
})();

/* Group booking with a LIVE disruption, so the mixed / per-passenger resolution flow is actually
   reachable in the demo. That flow has two hard gates: DisruptionCenter only surfaces a booking
   whose meta.passengers holds more than one traveller, and /api/disrupt only returns recovery
   options when the flight itself is delayed or cancelled. The stock seed set has neither (every
   booking is single-pax, no flight is disrupted), so the whole per-passenger capability was built
   but invisible. This seeds one 3-traveller booking on a cancelled flight, carrying real
   ancillaries so the refund/voucher/rebook dispositions have something to price.
   Idempotent: creates the booking once, then re-arms the cancellation on each boot for as long as
   the booking is still unresolved (so a VM restart always leaves the demo ready). */
(function ensureDanielGroupDisruption() {
  try {
    const u = db.prepare("SELECT id, member_no FROM users WHERE id=1").get();
    if (!u || u.member_no !== "PT-990001") return;      // only when Daniel occupies the live record
    const PNR = "XPDAN07", FNO = "XP1949";
    const GROUP = [
      { first: "Daniel", last: "Ferreira", type: "adult" },
      { first: "Marta", last: "Ferreira", type: "adult" },
      { first: "Tomas", last: "Ferreira", type: "adult" },
    ];
    const row = db.prepare("SELECT id, status, flight_date, meta_json FROM bookings WHERE pnr=? AND user_id=1").get(PNR);
    if (row) {
      // Already seeded. This is a DEMO FIXTURE, so re-arm it on every boot: a completed mixed
      // resolution removes the refunded/vouchered travellers from the PNR (correct behaviour),
      // which would otherwise leave the flow un-demoable until the database was reset by hand.
      let m = {}; try { m = JSON.parse(row.meta_json || "{}") || {}; } catch { }
      const spent = row.status !== "confirmed" || ((m.passengers || []).length !== GROUP.length);
      m.passengers = GROUP; m.pax = GROUP.length; delete m.disruptionResolved;
      db.prepare("UPDATE bookings SET status='confirmed', flight_no=?, meta_json=? WHERE id=?")
        .run(FNO, JSON.stringify(m), row.id);
      db.prepare("UPDATE flights SET status='cancelled' WHERE flight_no=? AND flight_date=?").run(FNO, row.flight_date);
      if (spent) console.log("[seed] re-armed " + PNR + " group disruption (mixed-resolution demo ready again)");
      return;
    }
    const bdate = isoAdd(TODAY, 2);
    const meta = {
      fare: "Plus", cabin: "Economy", origin: "JFK", dest: "CDG",
      dep: "07:20", arr: "10:55", aircraft: "A320neo", pax: 3,
      passengers: GROUP,
    };
    const items = ["seat", "bag", "meal"];
    if (!db.prepare("SELECT 1 FROM flights WHERE flight_no=? AND flight_date=?").get(FNO, bdate)) {
      db.prepare("INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,recommended,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(FNO, "JFK", "CDG", "07:20", "10:55", "2h35", "A320neo", 189, 6, bdate, 0, "cancelled");
    } else {
      db.prepare("UPDATE flights SET status='cancelled' WHERE flight_no=? AND flight_date=?").run(FNO, bdate);
    }
    const r = db.prepare("INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(PNR, 1, FNO, bdate, "14A", "confirmed", 0, JSON.stringify(items), JSON.stringify(meta), TODAY + " 08:30:00");
    db.prepare("INSERT INTO payments (booking_id,total,voucher_amt,miles_used,miles_amt,card_amt,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(Number(r.lastInsertRowid), 567, 0, 0, 0, 567, TODAY + " 08:30:00");
    console.log("[seed] group booking " + PNR + " (3 travellers, " + FNO + " cancelled) ready for mixed-resolution demo");
  } catch (e) { console.warn("[seed] ensureDanielGroupDisruption skipped:", e.message); }
})();

/* Second disruption fixture: a SOLO traveller on a DELAYED flight. The group fixture above covers
   the per-passenger (mixed refund / voucher / rebook) flow; this one covers the single-traveller
   "Rebook flight & reassociate extras" screen, and exercises the delay branch of the recovery
   engine rather than the cancellation branch. Carries a seat + bag so the reassociation panel has
   real ancillaries to transfer. Same self-re-arming behaviour as the group fixture. */
(function ensureDanielSoloDisruption() {
  try {
    const u = db.prepare("SELECT id, member_no FROM users WHERE id=1").get();
    if (!u || u.member_no !== "PT-990001") return;
    const PNR = "XPDAN08", FNO = "XP1953";
    const row = db.prepare("SELECT id, status, flight_date FROM bookings WHERE pnr=? AND user_id=1").get(PNR);
    if (row) {
      if (row.status !== "confirmed") db.prepare("UPDATE bookings SET status='confirmed', flight_no=? WHERE id=?").run(FNO, row.id);
      db.prepare("UPDATE flights SET status='delayed', new_dep='16:45', new_arr='19:30' WHERE flight_no=? AND flight_date=?")
        .run(FNO, row.flight_date);
      return;
    }
    const bdate = isoAdd(TODAY, 4);
    const meta = {
      fare: "Classic", cabin: "Economy", origin: "MIA", dest: "AMS",
      dep: "13:15", arr: "16:00", aircraft: "A320neo", pax: 1,
      passengers: [{ first: "Daniel", last: "Ferreira", type: "adult" }],
    };
    if (!db.prepare("SELECT 1 FROM flights WHERE flight_no=? AND flight_date=?").get(FNO, bdate)) {
      db.prepare("INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,recommended,status,new_dep,new_arr) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(FNO, "MIA", "AMS", "13:15", "16:00", "2h45", "A320neo", 164, 8, bdate, 0, "delayed", "16:45", "19:30");
    } else {
      db.prepare("UPDATE flights SET status='delayed', new_dep='16:45', new_arr='19:30' WHERE flight_no=? AND flight_date=?").run(FNO, bdate);
    }
    const r = db.prepare("INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(PNR, 1, FNO, bdate, "12C", "confirmed", 0, JSON.stringify(["seat", "bag"]), JSON.stringify(meta), TODAY + " 08:30:00");
    db.prepare("INSERT INTO payments (booking_id,total,voucher_amt,miles_used,miles_amt,card_amt,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(Number(r.lastInsertRowid), 164, 0, 0, 0, 164, TODAY + " 08:30:00");
    console.log("[seed] solo booking " + PNR + " (" + FNO + " delayed) ready for rebook + reassociate demo");
  } catch (e) { console.warn("[seed] ensureDanielSoloDisruption skipped:", e.message); }
})();

module.exports = { db, now, TODAY, searchToday, currentBooking, DB_PATH, seedSearches, seedBookings, seedUser, seedSharedCatalogs, KNOWN_USERS, PERSONAS, DEFAULT_PERSONA, getDataSource, setDataSource, applyProfile, localProfile };
