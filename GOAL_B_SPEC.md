# FlyTAP Goal-B — Multi-User (Concurrent Sessions) Engineering Spec

**Status:** design approved, ready to execute
**Branch:** `goal-b-multisession`
**Gate at every step:** `node scripts/_qa_multiuser.mjs --base http://localhost:7801 --compare baseline.json` must stay green (and grow green checks as new capability lands).
**Audience:** Claude Code (or an engineer) executing against the full repo on the VM/Mac.

---

## 0. What we are building (and why the current app can't do it)

### Goal
Up to **15 concurrent, independently-isolated users** driving the **full transactional web app** at once, each as their own identity:

- **5 known/pre-seeded users** with published logins: Daniel, Sofia, Lars + **2 new sample users** (defined in §6).
- **10 anonymous slots** that visitors **register** into; they start blank and accrue their own history as they act.
- **Per-session profile source** (option **b**): each session can independently be SQLite- or Adobe-hydrated.
- **Identity stitching** PSS↔web → journey trigger (largely already built; see §8).
- **All users' data flows to Adobe** RT-CDP.
- **Global "reset demo"** restoring all 15 to baseline (5 seeded + history, 10 open slots).

### The core obstacle
The app today is built on **one global mutable user at `users.id = 1`**. "Being a persona" means **destroying and re-seeding the DB** (`reseedPersona` → `DELETE FROM users` → `seedPersonaData` writes one row into id=1). There is **no per-request user identity** anywhere in the operational layer.

So Goal-B is not "thread a variable" — it is **replacing the identity model**: from *one mutable global user that gets wiped/reseeded* to *N persistent users selected per session, never wiped on selection*.

### What is ALREADY multi-user (do not rebuild — reuse)
- `members` directory table — holds all personas, any member resolvable.
- `cdp_profiles` table + `server/cdp-profile.js` — multi-row, identity-stitched profile store keyed by identity, accumulates `pss`+`web` touches, stitches, recomputes segments. **Independent of id=1.**
- `server/pss.js` — resolves any member, records bookings tagged `member_no`, stitches into `cdp_profiles`, fires offers.
- `server/cdp-ingest.js`, `server/cdp-events.js` — identity-parameterized ingest/stream (not id=1-bound).
- `server/cdp-audiences.js` — audience reads/publish by identity.

### What must change (the work)
- `server/server.js` — ~150 sites of `user_id=1`/`id=1`, plus helpers, global mutable state, persona/reset/datasource routes.
- `server/whatsapp.js` — ~40 id=1 sites + identity threading through its internal HTTP `apiCall`s.
- `server/db.js` — seed/reseed/`applyProfile`/`currentBooking` rewrite for multi-user.
- `server/cdp.js` — `_cdpProvenance` and hydrate become per-user (option b).
- `web/v2/*` React client (~500KB, 12 files) — login, per-request session handle, registration, per-user datasource toggle.

---

## 1. Architecture: the session→user seam

### 1.1 Identity resolution
Introduce a single resolver used by EVERY request:

```js
// server/session.js (NEW module)
const crypto = require("node:crypto");
const { db } = require("./db");

// In-memory session→user map. 15-user demo: no external store needed.
// { sessionId: { uid, source } }   source = 'sqlite' | 'adobe' (option b, per-session)
const sessions = new Map();

function newSessionId() { return "s_" + crypto.randomBytes(12).toString("hex"); }

// Bind a session to a user id (called at login / persona-pick / registration).
function bindSession(sessionId, uid, source = "sqlite") {
  sessions.set(sessionId, { uid, source });
}

function getSession(sessionId) {
  return sessionId ? sessions.get(sessionId) || null : null;
}

// THE resolver. Priority:
//   1. explicit session binding (web/chat)         — X-Session-Id header or body.sessionId
//   2. phone→user (WhatsApp)                        — passed in by the WA layer
//   3. fallback to 1 (PRE-MIGRATION SAFETY DEFAULT) — preserves today's behaviour
function resolveUid(req, opts = {}) {
  const sid = (req && (req.headers["x-session-id"] || (req.body && req.body.sessionId) || (req.query && req.query.sessionId))) || opts.sessionId;
  const s = getSession(sid);
  if (s && s.uid) return s.uid;
  if (opts.phone) { const u = userByPhone(opts.phone); if (u) return u.id; }
  return 1; // default — REMOVE/replace once every caller passes identity (see §5 cutover)
}

function userByPhone(raw) {
  const tail = String(raw || "").replace(/[^0-9]/g, "").slice(-9);
  if (!tail) return null;
  const cmp = "replace(replace(replace(phone,' ',''),'+',''),'-','')";
  return db.prepare(`SELECT * FROM users WHERE ${cmp} LIKE ?`).get("%" + tail) || null;
}

function sessionSource(req, opts = {}) {
  const sid = (req && (req.headers["x-session-id"] || (req.body && req.body.sessionId))) || opts.sessionId;
  const s = getSession(sid);
  return (s && s.source) || require("./db").getDataSource(); // global default if unbound
}

module.exports = { newSessionId, bindSession, getSession, resolveUid, sessionSource, userByPhone, _sessions: sessions };
```

**Why default to 1:** during migration, any not-yet-converted caller still behaves exactly as today. The harness must stay green after each step. The default is removed only at cutover (§5) once every entry point passes identity.

### 1.2 Express middleware
Resolve `req.uid` once per request, attach for all handlers:

```js
// in server.js, AFTER express.json, BEFORE routes
const session = require("./session");
app.use((req, _res, next) => { req.uid = session.resolveUid(req); req.profileSource = session.sessionSource(req); next(); });
```

### 1.3 Agent sessions
`getSession(id)` in server.js (agent scratch state) gains a `.uid`. The agent's `sessionId` IS the web session id, so `agentRunTool(name, input, session)` reads `session.uid`. Wire it: when `/api/ai/agent` resolves `req.uid`, set `session.uid = req.uid` before running tools.

---

## 2. The single-user-assumption inventory (regression checklist)

Every item below must be converted to use the request's `uid`. Grouped by file. **This list is the definition of done for the server side** — when all are `uid`-scoped and the concurrency test is green, the server is multi-user.

### 2.1 `server/server.js` — helpers (do FIRST; everything calls them)
| Helper | Today | Change |
|---|---|---|
| `liveIdentity()` | `users WHERE id=1` | `liveIdentity(uid)` |
| `userTier()` | `users WHERE id=1` | `userTier(uid)` |
| `prefSeat()` | `bookings WHERE user_id=1` | `prefSeat(uid)` |
| `saveJourney({...})` | `synced_searches WHERE user_id=1` | `saveJourney(uid, {...})` |
| `getJourney()` | `synced_searches WHERE user_id=1` | `getJourney(uid)` |
| `bookedToDest(dest)` | `bookings WHERE user_id=1` | `bookedToDest(uid, dest)` |
| `basketTotal(sel)` | reads ancillaries only (OK) | (no uid needed) |
| `buildOfferTiles(identity)` | `users WHERE id=1` | `buildOfferTiles(uid)` |
| `toCdpTrack(type,payload,at)` | `users WHERE id=1`, `userId:"user_1"` | `toCdpTrack(uid, ...)`, real member |

### 2.2 `server/db.js` — helpers
| Helper | Today | Change |
|---|---|---|
| `currentBooking()` | `bookings WHERE user_id=1` | `currentBooking(uid)` |
| `seedPersonaData(personaId)` | writes ONE user into id=1 | `seedUser(uid, personaId)` — see §3 |
| `applyProfile(profile)` | `UPDATE users WHERE id=1` + global `DELETE preferences/vouchers` | `applyProfile(uid, profile)` — per-user |
| `localProfile(personaId)` | unchanged (pure) | (no change) |

### 2.3 `server/server.js` — operational routes (each: replace literal `1` with `req.uid`)
`/api/routes/suggested`, `/api/search`, `/api/profile`, `/api/journey` (GET/POST/clear/resume), `/api/recommendation`, `/api/ancillaries`, `/api/seat-recommendation`, `/api/destinations`, `/api/basket` (GET/POST/clear), `/api/fare-lock`, `/api/hold`, `/api/pay`, `/api/bookings`, `/api/disrupt`, `/api/bookings/ancillary`(+remove), `/api/bookings/extras/checkout`, `/api/bookings/cancel`, `/api/rebook`, `/api/checkin`, `/api/bookings/checkin`, `/api/ai/plan`, `/api/ai/chat`, `/api/ai/agent`, `/api/stopover`, `/api/offers/today`, `/api/offers/tiles`, `/api/admin/personalization`, `/api/offers/send`.

### 2.4 `server/server.js` — agent tools (`agentRunTool`, use `session.uid`)
`search_flights`, `list_destinations`, `get_suggestions`, `select_flight`, `add_extras`, `remove_extras`, `list_seats`, `change_seat`, `checkout`, `get_wallet`, `get_recommendation`, `get_journey`, `get_booking`, `express_usual`, `check_in`, `cancel_booking`. Plus `deterministicAgent` reads `users WHERE id=1` (the greeting + home airport) → `uid`.

### 2.5 Global mutable state → per-user
| State | Today | Change |
|---|---|---|
| `followupTimers` | keyed `${origin}-${dest}` | key `${uid}:${origin}-${dest}` |
| `cancelAllSearchFollowups()` | clears ALL | `cancelAllSearchFollowups(uid)` — clear only this user's |
| `synced_searches` | one row, `DELETE WHERE user_id=1` | per-user rows |
| `app_state['persona']` | one global active persona | per-session (in `sessions` map) |
| `_cdpProvenance` | one global cached provenance | per-user map (option b) |
| `_airportIndex` | read-only cache | **leave as-is (safe)** |

### 2.6 `server/whatsapp.js`
- `_cdpIdent()`, `userTier()`, `personaForPhone`, `activePersonaId`, every `handleAction` branch reading `users WHERE id=1`, `priceDraft`, `startSeatStep`, `startExpressReview`, `sendMainMenu` → resolve user **by phone** (`from`) once at entry, thread that uid.
- **Internal HTTP calls** (`apiCall` → `http://localhost:PORT/api/...`): must carry the resolved user so the server acts as the right person. Add a session for the WA user (e.g. bind a stable `wa:<phoneTail>` session id to that uid at message entry) and send `X-Session-Id: wa:<phoneTail>` on every `apiCall`. This reuses the §1 seam instead of inventing a second path.

### 2.7 `server/cdp.js` (option b)
- `getProfileFromCdp(personaId)` already takes a persona — fine.
- `_cdpProvenance` (server.js) → per-user; `hydrateActiveSource(personaId)` → `hydrateActiveSource(uid, personaId)`.

---

## 3. Multi-user seed model (db.js rewrite)

### 3.1 New rule: never wipe on selection
Selecting/switching a user is a **session binding**, not a DB mutation. The ONLY destructive op is the global reset (§7).

### 3.2 Seeding
- `seed()` seeds **all 5 known users** once into `users` (ids 1–5) with their preferences/vouchers/history/bookings/searches, plus the `members` directory (already does all personas). Idempotent (gated on row count).
- Generalize `seedPersonaData(personaId)` → `seedUser(uid, personaId)`: same inserts but parameterized on `uid` instead of literal `1` (it currently hardcodes `VALUES (1,...)` and `user_id=1` throughout — every one becomes `uid`).
- Seat/booking date-shift logic (`personaShift`, `currentBooking`) becomes per-uid.

### 3.3 The 5 known users
| uid | persona id | member_no | login email |
|---|---|---|---|
| 1 | daniel | PT-990001 | anant.direct2links+daniel@gmail.com |
| 2 | sofia | PT-990002 | anant.direct2links+sofia@gmail.com |
| 3 | lars | DE-990003 | anant.direct2links+lars@gmail.com |
| 4 | **maria** (new, §6) | PT-990004 | anant.direct2links+maria@gmail.com |
| 5 | **james** (new, §6) | GB-990005 | anant.direct2links+james@gmail.com |

### 3.4 The 10 anonymous slots (uids 6–15)
Created on registration (§4), not at seed. Until registered, they don't exist as `users` rows. Track capacity: max 15 users total; reject registration past 15 (or recycle via reset).

---

## 4. Registration + login (anonymous lifecycle)

### 4.1 Routes (NEW)
```
POST /api/auth/login      { persona?|email?|member_no? }      → binds session to an existing user (the 5 known)
POST /api/auth/register   { first_name, email, phone?, home_airport? } → creates a new user (uid 6–15), binds session
POST /api/auth/logout     {}                                  → unbinds session
GET  /api/auth/me         (X-Session-Id)                      → who am I (uid, name, source)
```

- **login**: look up existing user by persona/email/member_no → `bindSession(sid, uid, source)`. Returns `{ sessionId, uid, user }`. (If no sessionId provided, mint one with `newSessionId()` and return it; client stores it.)
- **register**: allocate next free uid (6–15), insert a **blank** user row (no bookings/history — they accrue it), insert into `members` too (so PSS/WA/stitch resolve them), `bindSession`. Returns `{ sessionId, uid, user }`.
- **logout**: `sessions.delete(sid)`.

### 4.2 Blank profile bootstrap
A registered user starts with: a `users` row (name/email/phone/home_airport, tier `Member`, miles 0, no card/affinity), empty preferences (defaults), no vouchers, no bookings, no history. As they search/book (web) or the PSS stitches a booking in, their `cdp_profiles` row builds and segments emerge. This is the "anonymous builds history" story and it rides the EXISTING cdp_profiles/pss rails.

---

## 5. Migration order (each step = one commit, harness green after each)

> Rule: after every step run
> `node scripts/_qa_multiuser.mjs --base http://localhost:7801 --compare baseline.json`
> Server-file changes require a **process restart** (Node doesn't hot-reload).

1. **Add `server/session.js`** + the middleware (`req.uid`/`req.profileSource`), `resolveUid` defaulting to 1. No call sites use it yet. → **zero behavior change**, harness green. Commit.
2. **Parameterize db.js helpers** (`currentBooking(uid=1)`, `applyProfile(uid=1,...)`) with **default uid=1**. → zero change. Commit.
3. **Parameterize server.js helpers** (`liveIdentity(uid=1)`, `userTier(uid=1)`, `prefSeat(uid=1)`, `saveJourney(uid=1,...)`, `getJourney(uid=1)`, `bookedToDest(uid=1,...)`, `buildOfferTiles(uid=1)`, `toCdpTrack(uid=1,...)`) with default uid=1. → zero change. Commit.
4. **Migrate operational routes** (§2.3) to pass `req.uid` into the helpers and replace literal `1` in their SQL. Do in sub-groups (profile → search/journey → basket → pay → bookings → ancillaries/destinations → offers → admin), harness green after each sub-group. Commit per sub-group.
5. **Migrate agent tools** (§2.4): set `session.uid = req.uid` in `/api/ai/agent`; thread `session.uid` through every tool's SQL. Commit.
6. **Per-user mutable state** (§2.5): `followupTimers` keyed by uid; journey per-user; `_cdpProvenance` per-user map. Commit.
7. **Multi-user seed** (§3): seed 5 users; `seedUser(uid, personaId)`. Reset rewrite (§7). Commit. *(Harness identity fields will now depend on which session/user — extend harness, see §9.)*
8. **Auth/registration** (§4): login/register/logout/me; allocate uids 6–15. Commit.
9. **Per-session datasource** (option b, §1.3 + §2.7): `req.profileSource`; per-user hydrate/provenance; `/api/datasource` becomes per-session. Commit.
10. **whatsapp.js** (§2.6): resolve by phone, thread uid, pass `X-Session-Id` on internal apiCalls. Commit.
11. **Cutover**: remove the `resolveUid` default-to-1 (or make it return an explicit "anonymous/guest" rather than user 1) once every entry point binds identity. Commit.
12. **Client** (§8) and **concurrency gate** (§9).

---

## 6. The 2 new sample users (fill demo gaps)

Designed to add discriminating segments the existing 3 don't cover:

### Maria Costa — `PT-990004`, uid 4
- **Profile:** Bronze/entry tier, miles 3,200, home **LIS**, nationality Portuguese.
- **Affinity:** `food` ("Foodie") — card spend heavy in Dining & Markets. (New affinity → exercises affinity logic beyond football/golf/music; `packages.js` may need a `food` package or graceful fallback — verify.)
- **Why:** a **low-tier, low-miles, marketing-consented** user → proves Miles-Rich(>30k) EXCLUDES her, tier audiences separate her, and a lower-value journey path.
- **Voucher:** none (tests no-voucher checkout path).

### James Bennett — `GB-990005`, uid 5
- **Profile:** Gold, miles 61,000, home **LHR**, nationality British.
- **Affinity:** `business`/none — card spend in Hotels & Car Rental.
- **Why:** a **non-Portugal home airport (LHR)** + high miles → proves Frequent-OPO/LIS audiences exclude him, a UK-corridor journey, and Miles-Rich INCLUDES him. Optionally **marketing-NOT-consented** to demo a consent-gated journey (no offer email).

> Author both as full PERSONA objects in db.js mirroring the existing shape (user, prefs, voucher?, synced, ancillaries, destinations, history, bookings, searches). Keep emails as `+alias` on the same inbox. Publish logins in the demo runbook.

---

## 7. Global reset (rewrite `reseedPersona` → `resetAllUsers`)

```
POST /api/admin/reset   {}   → restore baseline: 5 seeded users (with history) + 10 open slots
```
- Wipe per-user operational tables for ALL users (bookings except pss-sticky, payments, searches, baskets, holds, fare_locks, travel_history, vouchers, preferences, synced_searches, emails, web events), **delete registered users 6–15**, clear their `cdp_profiles` (optionally keep the canonical 5's stitched profiles or clear all — demo choice), re-seed users 1–5.
- Keep `members` for the 5 (PSS stickiness), airports/routes/ancillaries/destinations shared.
- Clear all `sessions` bindings (everyone logged out → clean slate).
- This is the ONLY destructive op. It resets EVERYONE (it's the between-runs reset, not per-user).

---

## 8. Client (`web/v2/`) — what must change

> Not yet read in detail; inventory: `main.jsx`(5.9KB) `shell.jsx`(13KB) `auth.jsx`(7.3KB) `screens.jsx`(48KB) `results.jsx`(47KB) `checkout.jsx`(138KB) `mmb.jsx`(83KB) `ai.jsx`(12KB) `demo.jsx`(38KB) `ui.jsx`(13KB) `lib.js`(2KB) `trip.js`(7.3KB). Bundled by esbuild → `public/v2/app.js`.

Required:
1. **Session handle.** On login/register, store the returned `sessionId` (in-memory React state or a cookie). Send it on **every** API call as `X-Session-Id`. Centralize: find the fetch wrapper in `lib.js`/`shell.jsx` and add the header there once.
2. **Login screen** (`auth.jsx` already exists — it has the alias-map/persona chips from the earlier identity work). Extend: tapping a persona calls `POST /api/auth/login` and stores the session. Add a **Register** path → `POST /api/auth/register` for the 10 slots.
3. **Per-user datasource toggle** (option b): the SQLite⇄Adobe control (currently global in `demo.jsx`) becomes per-session; it calls the per-session `/api/datasource` and the header carries identity.
4. **No global "current persona"** assumption: any screen that assumed one user now reads `/api/auth/me` + its own session.

**Build/deploy after client edits:** `./node_modules/.bin/esbuild web/v2/main.jsx --bundle --jsx=automatic --minify --outfile=public/v2/app.js` then hard-refresh / cache-bust (the recurring stale-app.js lesson).

---

## 9. Concurrency proof (the Goal-B gate)

Extend `scripts/_qa_multiuser.mjs` `--concurrency` (already scaffolded) to use the REAL seam:
1. For N=15 sessions, each `POST /api/auth/login` (or register) as a chosen user → capture returned `sessionId`.
2. Concurrently (Promise.all, interleaved) each session: read `/api/profile`, do a `/api/search`, a `/api/journey` write, an agent `get_wallet`, and (for some) a `/api/pay` — all with its own `X-Session-Id`.
3. Assert, per session: `/api/profile` member_no == the user it logged in as; journey/bookings/wallet reflect ITS user only; **no** session sees another's data.
4. Canary: `toCdpTrack.userId` for each session's events == that session's member (never global `user_1`).
5. **Pass = 15 distinct, correctly-isolated users with zero cross-read.** This is the definition of done.

Also: a soak variant — 200 randomized interleaved requests across 15 sessions, assert invariant "response identity always matches request session."

---

## 10. Risk register / gotchas (learned from this codebase)

- **Transitive id=1 in helpers** — a route can look migrated but still call a helper that re-reads id=1. The inventory §2.1–§2.2 must ALL be done; grep after each step: `Select-String -Path server\*.js -Pattern "id=1|user_id=1|user_1"` should shrink to zero (except intentional defaults during migration).
- **whatsapp.js internal HTTP** — its `apiCall`s hit the server with no session; without the `X-Session-Id: wa:<tail>` fix they'd act as user 1. Easy to miss.
- **`applyProfile` global deletes** — `DELETE FROM preferences` / `DELETE FROM vouchers` with no WHERE wipes EVERYONE. Must become `WHERE user_id=?`.
- **Node has no hot-reload** — every server-file change needs a process restart before the harness re-runs, or you'll test stale code (a recurring lesson this project).
- **Stale `app.js`/browser cache** — after client edits, rebuild + hard-refresh or the fix looks broken.
- **Shared-sandbox Adobe** — schema saves flaky, ingestion propagation 1–5 min lag; not on the critical path for the server refactor but relevant when re-verifying CDP per-user.
- **`packages.js` affinities** — new `food` affinity (Maria) may have no package; ensure graceful fallback.
- **Self-test (`/api/admin/selftest`) hardcodes id=1** in several checks (e.g. "Customer profile loaded", "Bookings seeded") — update these to a representative user or they'll mislead once multi-user.

---

## 11. Definition of done

- [ ] `grep` for `id=1|user_id=1|user_1` in `server/*.js` returns only intentional/removed-at-cutover sites.
- [ ] 5 known users + up to 10 registrants coexist; selecting a user never wipes the DB.
- [ ] Per-session profile source (option b) works: two sessions, one SQLite one Adobe, simultaneously.
- [ ] PSS↔web stitch fires a journey for a registered (anonymous-origin) user; visible in Adobe.
- [ ] All users' data reaches Adobe RT-CDP.
- [ ] Global reset restores 5 seeded + 10 open, logs everyone out.
- [ ] `scripts/_qa_multiuser.mjs --compare baseline.json` green (single-user invariants preserved where still valid).
- [ ] `scripts/_qa_multiuser.mjs --concurrency` green: 15 isolated sessions, zero bleed, `toCdpTrack.userId` per-user.
- [ ] WhatsApp resolves the correct user by phone and its internal apiCalls carry identity.
- [ ] Client sends `X-Session-Id` on every request; login + register + per-user datasource toggle work.

---

## Appendix A — exact known IDs / config (for reference)
- imsOrg `65B229AE5ED637A00A495E96@AdobeOrg`; sandbox `coforge3`.
- profile schema `4a538027b8b70a4e2e7ae28849ba7e8c3962856add0917be`; profile dataset `6a2ed5da5851aaac8bc69d1c`.
- event schema `8f9c109a99b357190784d9a0b0306fc9c79c23e22b11b46d`; event dataset `6a30e64ba4428172f3d4e491`.
- streaming inlet flowId `ec49b603-ae53-42ee-9439-125051a9a37e`; merge policy `d29369ea-d63a-4ed4-afe6-28ebe33b8594`.
- identityNamespace `loyaltyId` (primary), lookupAttr `loyalty`.
- VM: `$env:PORT=7801; npm start`; public `http://xperion2.centralindia.cloudapp.azure.com:7801`.

## Appendix B — harness commands
```bash
# baseline (already captured): baseline.json
node scripts/_qa_multiuser.mjs --base http://localhost:7801 --snapshot baseline.json
# after each step:
node scripts/_qa_multiuser.mjs --base http://localhost:7801 --compare baseline.json
# concurrency gate (after seam lands):
node scripts/_qa_multiuser.mjs --base http://localhost:7801 --concurrency
```
