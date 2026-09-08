# ASSUMPTIONS — Phase 0 answered with demo defaults

The master prompt's Phase 0 asks seven discovery questions before code. The
user instructed the build to start, so each is answered here with an explicit,
overridable demo default. Everything marked STUB implements the documented
contract shape and never invents fields of a real system.

1. **PSS rebooking/reissue + sandbox** — the build's own reservation core plays
   the PSS. Recovery-flight seat inventory, holds and reissue are STUB
   (vendors.js) with idempotent calls and TTL holds.
   *Open question: which real PSS and is a sandbox available?*
2. **Source of truth for contact + consent** — Passenger nodes carry
   `contact_channels[] {channel, consent}` and `quiet_hours`, seeded
   synthetically. In production this maps to the experience layer's unified
   profile. *Open question: which system is authoritative, CRM or loyalty?*
3. **Weather-waiver ownership** — `policy:weather_waiver` (active when
   probability ≥ 0.60). *Open question: who declares waivers today and how?*
4. **Current manual IRROPS workflow** — modelled as the Tier-2 queue the agent
   feeds with prepared packages. *Open question: the real controller tooling
   we must not collide with.*
5. **Hotel/ground vendor contracts** — STUB vendors near MCO/MIA with rate
   cards; idempotent reserve/cancel; injectable failure for the compensation
   test. *Open question: contracted vendors + APIs per airport.*
6. **Spend caps + exception approval** — EUR demo caps: hotel 180, taxi 90,
   refund 400, incentive 60, per-event 60000. Exceptions route to Tier-2.
   *Open question: real caps and the approver role.*
7. **PII residency** — agents pass passenger refs; attributes resolve at the
   point of need from the graph. All data is synthetic. *Open question: DPDP /
   DOT residency constraints for the pilot regions.*

Other demo decisions: single in-process bus and state machine (no
Kafka/Temporal); clock injectable for replay; quiet hours 22:00–06:00 UTC and
email exempt as an asynchronous channel; recovery seats sized to cover the
manifest in the golden run and to zero in the exhaustion test; LLM drafting
uses the fallback templates with graph-fact injection since no API key is
configured — the live path is identical.

# RUNBOOK — operating the autonomy layer

**Ops page**: `/autonomy/` (buttons drive the replayable simulation; tiles are
live KPIs; every table refreshes from the graph).

**Kill switch** — freezes Tier 0/1 instantly, globally or per event.
`POST /api/autonomy/kill {"global":true}` or `{"eventId":"pred:…","on":true}`.
Verify: banner on the ops page turns ON; audit shows KILL_SWITCH; pipeline
runs log PIPELINE_SKIPPED. Tier-2 preparation and approval keep working while
frozen — that is by design.

**Tier-2 queue** — `GET /api/autonomy/tier2`; approve with
`POST /api/autonomy/tier2/:id/approve`. Every item carries the action, the
package payload and the agent's rationale.

**Stand-down** — automatic on hysteresis; verify holds_released and all-clear
counts on the prediction node, and RELEASE_HOLD / STOOD_DOWN in the audit.

**Restart between T-48 and a customer's tap** — holds live in the STUB PSS's memory, so a
process restart used to break every reroute acceptance with `no_hold`. `confirmSeats` now
rebuilds a missing hold from the RecoveryOption node (its `seat_hold_ref` and `expiry`),
and a hold released on purpose (stand-down, expiry) is never rebuilt. A saga that still
fails answers the customer in plain language (inbox kind `disruption_failed`, audit
`OFFER_FAILED_REPLY`) and leaves the offer open, so they can take another option.

**Who is on the flight** — Reset world links the 11 seeded personas (`KNOWN_USERS`). Accounts
created at runtime are not linked unless `AUTONOMY_LINK_ALL=1`. WhatsApp delivery skips any
number that `WA_PHONE_MAP` pins to a different persona, so the presenter's phone gets one copy.
Customer copy of a brief is passed through `research.customerSafe()`: graphic news becomes a
planning line; the ops brief keeps the analyst's wording.

**What the customer receives after saying yes** — the booking row changes (flight, date,
status `rebooked`, `meta.recovery` or `meta.rebooked_from`), My Trips shows the new flight with
the recovery band, the assistant inbox gets the confirmation card, WhatsApp gets the confirmation
(as the reply itself when the yes came on WhatsApp, as a message when it came from the app), and
an email with the new itinerary is always written to the outbox (delivered when SMTP is set).
The graph follows the booking (`moveTrip`), so a later prediction on the old flight no longer
carries them.

**Rollout gate (phase C by default)** — `policy:autonomy_gate.routes` lists the routes where the
agents may contact customers unaided (`DEL-MIA`). Every other route is still sensed, predicted and
prepared (seats held, hotel and taxi lined up); at ACT it lands in the Tier-2 queue as
`RELEASE_OFFERS` with the rationale, and approval runs the Offer agent. Phase D opens all routes:
the Gate button on the ops page, or `POST /api/autonomy/gate {"phase":"D"}`. Every upcoming real
booking is in the graph by default (`AUTONOMY_LIVE_TRIPS=0` to switch off), so the Predictions
table shows WATCH rows for the customer's other trips whenever an alert touches their airports.

**Manual override** — decline on behalf of a passenger:
`POST /api/autonomy/offer/:id/decline`; accept:
`POST /api/autonomy/offer/:id/accept {"optionId":"opt:…"}`. Both are audited
with actor and rationale.

**Replay** — `POST /api/autonomy/sim/golden` runs the full DEL→MIA timeline;
`_autonomy-test.mjs` is the 51-check acceptance suite and must be green before
any autonomy tier is enabled anywhere real.

**Rollout gates** — Phase A shadow (predict + plan, zero contact): run the sim
with the kill switch ON. Phase B Tier-2 only: leave the switch ON and work the
queue. Phase C (this build's default policy node): Tier 0–1 on DEL→MIA.
Phase D: full caps. Never skip a gate; the current gate is recorded in
`policy:autonomy_gate`.

## Live-app demo — the scenario as a real customer sees it

The autonomy layer is joined to the customer app by `bridge.js`. Every world
reset links the app's real customers into the knowledge graph as Passenger and
PNR nodes on XP201 Delhi → Miami, each backed by a real row in `bookings`, so
the trip appears in My Trips like any other booking. The Offer agent's message
then reaches them through the app's own channels; a tap on the card, a typed
"take the Orlando option", or a WhatsApp reply of "2" all run the same
execution saga. The in-process acceptance suite never links, so it stays at
214 synthetic passengers.

Presenter script (two browser tabs, one phone):

1. App tab: open `/v2`, sign in as Daniel. Note the DEL → MIA trip in the
   hero and in My Trips (PNR XPW01A).
2. Ops tab: open `/autonomy/`. Press **Reset world** (the table "Real
   customers on this flight" fills), then **T-72h**: WATCH at 43%, no message
   goes out. Point at the audit trail.
3. Press **T-48h**: ACT at 71%. In the app tab a red alert appears on every
   screen within five seconds; Xperion AI shows the proactive message with a
   card: risk, reasons, three one-tap options, the seat-hold expiry. The same
   text arrives on WhatsApp when Twilio is configured (otherwise it sits in
   the WhatsApp log with an honest "logged" status); the ops table shows the
   delivery result per customer.
4. Accept: tap option 2 in the card, or type "I'll take the Orlando option",
   or reply "2" on WhatsApp. The saga runs in milliseconds; the confirmation
   card lists hotel voucher, taxi reference, morning transfer, reissued
   ticket. My Trips now shows the booking as rebooked with the recovery band.
   The ops audit shows SAGA_COMPLETE and APPLY_TO_BOOKING.
5. Variants: reply "no thanks, leave it" (declined, no re-contact); press
   **Stand down** after T-72 (holds released, all-clear in the inbox); press
   the kill switch before T-48 (nothing autonomous fires, human queue stays
   live).

Endpoints used by the app: `GET /api/autonomy/customer/status` (banner),
`GET /api/autonomy/customer/inbox?since=` and `POST …/inbox/seen` (assistant),
`POST /api/autonomy/customer/accept {optionId, offerId}` and `…/decline`.
`POST /api/autonomy/customer/link` re-links without a world reset.

Verification: `BASE=http://127.0.0.1:<port> node _bridge-test.mjs` → 27/27.

## Destination intelligence

Three schedulers start with the server (all free sources, no keys):

- **Feeds** (`FEEDS_ENABLED`, every 30 min): NWS alerts + Open-Meteo outlooks for the arrival
  airport of every graph flight and every upcoming booking → `sensing.ingestAlert()` → the
  disruption pipeline. Ops page: **Poll live weather now**.
- **Research** (needs `ANTHROPIC_API_KEY`): Claude with web search builds a DestinationBrief per
  city and window — weather, political/civil events, strikes, major events, advisories, news —
  neutral, every item sourced; cached 12 h; capped at `RESEARCH_MAX_PER_HOUR`. Without a key
  the brief is forecast + holidays only and says so.
- **Briefs** (`BRIEFS_ENABLED`, every 30 min): every booked trip gets its brief 60–84 h before
  departure as a Tier-0 message (card in the app, WhatsApp, email) with three choices: keep the
  trip, see other dates, talk to a person. Decision stays with the customer. Ops page: **Brief
  Daniel's next trip now**; the golden T-72 step also briefs the linked customers.

Ask path: the assistant tool `get_destination_brief` answers "what's the weather / what's
happening / is it safe in <city>" from the same brief, live and offline, web and WhatsApp.

Verification: `node _brief-test.mjs` → 24/24 (mocked sources). Live: `GET /api/autonomy/briefs`,
`GET /api/autonomy/brief/DEL?force=1`, `POST /api/autonomy/feeds/poll`.

## Normal-operation cadence (what runs without anyone pressing a button)

- **Every 30 min — feeds.** NWS alerts and Open-Meteo outlooks for the arrival airport of every
  flight in the graph and every upcoming booking → `sensing.ingestAlert()` → scorecard →
  predictions: WATCH at p ≥ .40 (seats held, no contact), ACT at p ≥ .60 (impact → recovery →
  offer, through the policy gates), stand-down when the risk clears.
- **Which flights get scored.** The demo flight and the linked customers always. Real upcoming
  bookings only when `AUTONOMY_LIVE_TRIPS=1`: then `bridge.syncTrips()` mirrors every booking
  in the next 10 days into the graph as FlightInstance + PNR before each poll (and after each
  world reset). With it on, a real alert can produce real offers on real trips at any hour, so
  it is off by default and should be switched on deliberately.
- **Every 30 min — briefs.** Every booking 60–84 h before departure gets its destination brief
  once (Tier-0, policy-gated), regardless of the flag above.
- **On demand.** The assistant tool; the ops page (**Brief Daniel's next trip now** runs as a
  background job on the soonest trip only, and reports when done).
- **Always.** Kill switch freezes Tier 0–1; Tier 2 waits for a human; everything is audited.

## Reducing the chance of getting stuck (risk-aware alternatives)

When a brief or the weather shows risk at the destination (impact medium/high or weather risk
≥ .30), the alternatives agent scores every day around the trip and every served airport in the
same country within reach, and the brief carries concrete options: go a day earlier or later
(with the flight and price), fly into a nearby airport, or keep the plan with Flex. The customer
takes one by tapping, by number on WhatsApp, or by saying "earlier"/"later"/"flex". Taking one
runs SHIFT_TRIP_DATE / SWITCH_AIRPORT through the policy engine (reversible; original kept).
The assistant surfaces the same options when a customer asks about their destination.
Ops: `POST /api/autonomy/risk/assess {pnr}` and `GET /api/autonomy/risk/<pnr>`.

## Cost controls (what can spend money, and when)

Only the research analyst (Claude + web search, ≈ $0.02–0.05 a call) costs anything; the
weather feeds, geocoding and holidays are free. Defaults:

- `RESEARCH_MODE=on-demand` — the analyst runs when someone is using the site (a request in the
  last 30 min) or when explicitly asked: ops buttons, the assistant, the simulation. The T-72
  scheduler on an idle server sends facts-only briefs (forecast + holidays) and says so.
- `RESEARCH_DAILY_MAX=15` — hard cap per UTC day in every mode; `RESEARCH_MAX_PER_HOUR=20` burst.
- Briefs are cached 12 h per city and window; the golden T-72 briefs all linked customers from
  one call.
- The free feeds slow from every 30 min to every 3 h after an hour without use.

The ops page shows mode, whether the site counts as in use, calls today and the estimated spend.
