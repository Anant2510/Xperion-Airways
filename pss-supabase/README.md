# FlyTAP PSS integration (Phase 1)

A standalone **Passenger Service System** (booking / transaction / loyalty store) on
**Supabase Postgres** (free tier), connected to the FlyTAP backend so that any booking
made via the third-party PSS is ingested into **SQLite** (transaction record of truth)
and streamed to **Adobe RT-CDP** (identity stitching → segmentation → offers).

## The one rule this design protects
SQLite stays the system of record for *transactions*; Adobe RT-CDP owns *identity +
segments + offers*. A PSS is a third writer, so it must **not** write to both stores
itself (they would drift). Instead the PSS only **emits a signed event**, and a single
governed endpoint on the FlyTAP backend (`POST /api/pss/ingest`) is the only thing that
writes SQLite and forwards to CDP. One choke point → both stores stay consistent.

## Flow
```
PSS booking (Supabase INSERT)
  → Database Webhook → Edge Function (HMAC-sign)        [this folder]
  → POST /api/pss/ingest        (backend: server/pss.js)
      • verify HMAC signature
      • idempotency check (pssRef + eventType)          → replays are no-ops
      • resolve identity (loyaltyId → member_no, else email)
      • SQLite: upsert booking + payment (source='pss'), accrue miles   [one tx]
      • outbox: write events row (delivery='pending')                   [same tx]
      • RT-CDP: cdpEvents.streamEvent(type, {loyaltyId,email}, attrs)  → stitch + segment
      • offer rule fires personal_offer email + pss_offer_triggered event
  → Adobe stitches the PSS fragment onto the known web/loyalty profile → segment → offer
```

## Setup
1. **Create the schema** — run `schema.sql` in the Supabase SQL editor. It creates
   `pss_members`, `pss_bookings`, `pss_transactions` and seeds the three demo members
   (loyalty IDs match FlyTAP `users.member_no`, so bookings stitch onto the live persona).
2. **Deploy the Edge Function** in `edge-function/` (`supabase functions deploy pss-forward --no-verify-jwt`).
3. **Set secrets** (must match the backend):
   - `FLYTAP_INGEST_URL` = `https://<your-app>/api/pss/ingest`
   - `PSS_WEBHOOK_SECRET` = same value as the backend's `PSS_WEBHOOK_SECRET` env var
4. **Wire the Database Webhook**: Supabase → Database → Webhooks → new hook on
   `pss_bookings`, event = `INSERT`, type = Supabase Edge Function → `pss-forward`.
5. Insert a row into `pss_bookings` (see the commented example in `schema.sql`). It
   should appear in the FlyTAP Demo Console event stream and as a `source='pss'` booking.

## Backend env vars
| var | purpose | default |
|-----|---------|---------|
| `PSS_WEBHOOK_SECRET` | HMAC secret shared with Supabase | `tap-pss-demo-secret` |
| `PSS_FLUSH_MS` | outbox retry interval (ms) | `30000` |
| `SUPABASE_URL` | optional — if set, the Demo Console "Create PSS booking" button writes the row into the real Supabase `pss_bookings` table | — |
| `SUPABASE_SERVICE_KEY` | Supabase service-role (or anon) key for the above | — |

## Identity namespaces (Adobe)
Declare `loyaltyId` (primary CRM ID = `member_no`), `Email`, `ECID` (web), and optionally
`PNR` as a record-locator namespace. A PSS event carrying `loyaltyId`+`email` stitches onto
the existing web profile; an anonymous PSS booking stitches on `email` and merges when the
member is later known.

## Test without Supabase
The backend exposes a synthetic ingest so you can demo the whole loop without the PSS:
```
curl -X POST https://<your-app>/api/pss/test \
  -H 'Content-Type: application/json' \
  -d '{ "destination":"LIS", "amount":540, "ancillaries":[{"name":"Lounge access"}] }'
```
It builds a realistic PSS booking for the **active persona**, so it stitches onto whoever
is logged in. `GET /api/pss/bookings` lists ingested PSS bookings; `POST /api/pss/flush`
retries any CDP deliveries still queued.

## Standalone PSS app (Phase 2 — separate system)
The PSS is now its own web app in `../pss-app/` (a single self-contained `index.html`,
no build). The FlyTAP server serves it at **`/pss`**, or you can host it anywhere and point
it at the backend via the **API** field in its header (or `?api=https://backend`). It looks
deliberately different from the consumer site — a dark reservations-desk console — so in the
demo it reads as a separate system.

Demo arc:
1. Open **`/pss`**, pick the member (their loyalty ID + email are the stitch keys), set the
   trip + extras, and **Create reservation**. The pipeline view shows it flow
   PSS → Supabase → SQLite → Adobe RT-CDP, with the identity sent to CDP and any offer fired.
2. Open the **FlyTAP site** (`/`), log in with the **same email** and search/book.
3. In Adobe RT-CDP the two fragments stitch into one profile — same person across the offline
   PSS booking and the online session — and personalization fires off the unified 360° view.

The app calls the backend (`/api/pss/members`, `/api/pss/book`, `/api/pss/bookings`); CORS is
already enabled server-side. `/api/pss/book` writes to Supabase when the backend has
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, then ingests synchronously so the desk shows an instant
result (the Supabase webhook's later re-post is deduped).

## Unified profile, stitching & segment-driven offers (Phase 3 — done)
A local mirror of the Adobe RT-CDP profile store (`cdp_profiles`) accumulates every touch by
identity (loyaltyId primary, email secondary), across **offline (PSS)** and **online (web)**
channels. When the same identity is seen on both, the profile is **stitched** and gains the
`Stitched · Offline + Online` segment. Segments are recomputed on every touch and **offers are
driven by segment membership** (not a single transaction):
- PSS ingest (`server/pss.js`) records a `pss` touch and fires the segment-driven offer.
- Web search and web booking (`/api/search`, `/api/pay`) record `web` touches for the active member.
- Read it at `GET /api/cdp/profile` (active persona by default; `?loyaltyId=`/`?email=` for any),
  or `GET /api/cdp/profiles`. The Demo Console shows it as **Unified customer profile · 360°**
  (identity graph, channel mix, segments, and the triggered offer).

Demo arc: PSS booking (offline) → profile created, offer = lounge/affinity. Then log into the
site with the **same email** and search/book (online) → profile flips to **Stitched**, gains the
cross-channel segment, and the offer changes to the unified-profile offer.

### Supporting pieces (also Phase 3)
- **Members directory** (`members` table, seeded from all personas) so a PSS booking for ANY
  member — not just the live `id=1` record — resolves, accrues miles, and is segmentable.
- **Per-member segment engine** (`server/segments.js`): `evaluate(memberNo)` / `offerFor(memberNo)`
  compute audiences from the member's unified (online + offline) bookings. Exposed at
  `GET /api/segments/:memberNo`; PSS ingest uses it to pick the offer (with real Adobe audiences
  via `cdp.getProfileFromCdp` taking precedence when wired — see `pss.decideOffer`).
  The Demo Console shows it as **Segments & decisioning** (pick any member → profile metrics,
  qualifying segments with the reason each fired, and the decided offer).
- **Sticky PSS data**: `reseedPersona` (persona switch / login) now PRESERVES `source='pss'`
  bookings, their payments, and PSS events — so the offline booking survives the switch and the
  unified profile keeps reflecting it after the member logs in on the web.

## Still open (future)
- True multi-row operational `users` (the live transaction model still keeps one active customer
  at `id=1`; the *profile* store + members directory are already multi-row). The current design
  mirrors how Adobe separates profile from operational data, so the stitch story is accurate
  without that refactor.

## Adobe audience reads (wired)
`/api/cdp/profile`, `/api/segments/:memberNo` and `/api/pss/segments` read **real Adobe RT-CDP
audience membership** via `server/cdp-audiences.js` (`cdp.getProfileFromCdp().provenance.audiences`)
when the `cdp` module is present, and fall back to the local segment engine otherwise. The
response carries a `source` flag (`adobe` | `local`) — surfaced as a badge on the Demo Console
**Segments & decisioning** panel — and `cdp-profile.js` exposes `getProfileLive()` which merges
Adobe audiences over the locally-derived segments (Adobe takes precedence) and recomputes the
offer. PSS ingest also **publishes** the computed segment membership back to CDP as a
`segmentMembership` event. In this slice (`cdp` absent) everything degrades cleanly to `local`.

**Tolerant offer mapping.** Offers are matched to audiences by keyword patterns, not exact
strings, so real Adobe names map without code changes — `"TAP High Value Travellers (PROD)"` →
`high_value_lounge`, `"Cross-Channel Stitched - EMEA"` → `welcome_cross_channel`, etc. For any
audience the patterns miss, paste its exact name into `AUDIENCE_ALIASES` (in `cdp-profile.js`) or
`PSS_AUDIENCE_ALIASES` (in `pss.js`) → `offer_label`; aliases take precedence over the patterns.
