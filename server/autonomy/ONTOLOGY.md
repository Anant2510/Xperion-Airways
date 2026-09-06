# Xperion Airways · Disruption Autonomy — Ontology

The knowledge graph is the single source of truth. Agents communicate only by
reading and writing it; the bus merely announces graph changes. This document
is one section per entity, the edge catalogue, the action space, the
calibration note for the scorecard, and ADR-001.

## Entities

**Passenger** — one traveller. `name, loyalty_tier, contact_channels[]` (each
`{channel, consent}`), `quiet_hours {start,end}` (UTC, interruptive channels
only), `locale`, `vulnerability_flags[]` (reduced_mobility, elderly),
`flexible` (demand-shaping candidate), `ltv_band`. Identity resolution across
PSS/CRM/loyalty collapses to one node per person (in the reference build the
seed is already resolved; the production rule set lives with the identity
agent of the experience layer).

**PNR** — one booking party. `record_locator, party_size, fare_class,
segments[]` (second segment carries `connect_min` for misconnect exposure).
Members attach via `BELONGS_TO`; members of a party always receive identical
options.

**FlightSchedule / FlightInstance** — the recurring flight (XP201 DEL→MIA) and
one dated departure (`sched_dep, sched_arr, origin, dest, aircraft_type,
status`). Recovery flights are FlightInstances flagged `recovery:true` so the
predictor ignores them.

**Airport** — `iata, geo{lat,lon}, curfew`. `ALTERNATE_OF` edges carry
`ground_transfer_min`; seeded MIA↔FLL(45)/MCO(240)/ATL(600) and
DEL↔JAI(280)/AMD(560).

**WeatherEvent** — normalized alert: `source, type, severity, geometry
{lat,lon,radius_km}, valid{from,to}, raw`. The node id is a content hash, so a
redelivered alert upserts the same node (dedupe by construction).

**DisruptionPrediction** — per (event, flight instance): `probability,
confidence, top_drivers[] {factor, weight}, state, model_version`. States:
WATCH → ACT → OFFERS_OUT → RESOLVING → RESOLVED, or STOOD_DOWN via hysteresis.

**RecoveryOption** — `type` (REROUTE | DIVERT_PLUS_GROUND | REFUND | WAITLIST),
`components[]`, `total_cost, seat_hold_ref, expiry` (TTL from
`policy:hold_ttl`), `feasibility_score, party_size`.

**Offer** — `passenger_ref, pnr, prediction, options[] (ordered),
channel, framing_variant, state (SENT/ACCEPTED/DECLINED/EXPIRED), incentive,
sent_at, executed, refs, exec_ms`.

**Vendor** — `type (HOTEL/TAXI/PARTNER_AIRLINE), location, rate, name`.
Reservation contract is idempotent on caller keys; STUB in this build.

**Policy** — machine-readable rules: thresholds + hysteresis, weather waiver,
spend caps (EUR), outreach limits, hold TTL, kill switch, rollout gate. Agents
never hardcode a number that lives here.

**Action** — the action space as data: `name, preconditions[] (predicate names
evaluated against the live graph at execution time), tier, capRef, reversible,
compensating`. Tier 3 entries exist so the policy check can refuse them by
data.

**AuditEvent** — append-only: `actor, action, tier, inputs_hash, rationale,
graph_diff, prediction_id`. Every decision, refusal and compensation lands
here.

## Edges

`(WeatherEvent)-[:IMPACTS {distance_km, window}]->(Airport)` ·
`(FlightInstance)-[:ARRIVES_AT|DEPARTS_FROM]->(Airport)` ·
`(FlightInstance)-[:CARRIES]->(PNR)` · `(PNR)-[:BELONGS_TO]->(Passenger)` ·
`(Passenger)-[:TRAVELS_WITH]->(Passenger)` ·
`(DisruptionPrediction)-[:FORECASTS]->(FlightInstance)` ·
`(DisruptionPrediction)-[:AFFECTS {priority, pnr}]->(Passenger)` ·
`(RecoveryOption)-[:RESOLVES]->(DisruptionPrediction)` ·
`(Passenger)-[:QUALIFIES_FOR]->(RecoveryOption)` ·
`(RecoveryOption)-[:FULFILLED_BY]->(Vendor)` ·
`(Offer)-[:PRESENTS]->(RecoveryOption)` ·
`(DisruptionPrediction)-[:OUTREACH {count,last}]->(Passenger)` ·
`(DisruptionPrediction)-[:DECLINED]->(Passenger)` ·
`(Airport)-[:ALTERNATE_OF {ground_transfer_min}]->(Airport)`.

## Scorecard calibration (model_version scorecard-v1)

`p = clamp( base(type) + 0.05·(severity−3) + window_overlap(+0.05 / −0.15)
+ airport_base_rate + time_of_day(+0.03 evening / +0.01) )` with base:
convective_outlook 0.35, tornado_watch 0.58, tornado_warning 0.75, hurricane
0.70. Every term is written to `top_drivers`, so a controller reads WHY a
number is what it is. Thresholds from `policy:thresholds`: ≥0.40 WATCH, ≥0.60
ACT, and a 0.10 hysteresis band before STOOD_DOWN so one oscillating feed
never double-fires. Replace with a calibrated gradient-boosted model in
production; the contract (probability + drivers into the same node) is
unchanged.

## Quiet hours & transactional messages (policy note)

Quiet hours govern interruptive channels (push, SMS, WhatsApp). Email is
treated as asynchronous and allowed. Confirmations of an action the customer
just took are transactional and sent on the accepting channel.

## ADR-001 — property graph on the embedded store, not Neo4j/RDF

Context: the master prompt defaults to Neo4j + Cypher. The reference build
runs one lightweight service with an embedded relational store, no external
daemons, and must boot anywhere (stand, laptop, pilot VM).
Decision: implement the knowledge graph as two tables (`kg_nodes`,
`kg_edges`) with a small traversal API, keeping the ontology, the edge
catalogue and every agent contract identical to what Neo4j would hold.
Why property graph over RDF: the domain is a closed, operational schema with
per-edge attributes (hold TTLs, outreach counts, transfer minutes) —
property-graph territory. RDF/OWL adds open-world reasoning and vocabulary
alignment we do not need, at real modelling cost.
Consequences: traversals are adequate at demo scale (thousands of nodes);
swapping in Neo4j is a driver change behind graph.js, not an ontology change;
constraints (uniqueness, append-only audit) are enforced in SQL today and in
Cypher constraints tomorrow. Revisit at the first pilot when concurrent
writers and multi-hop analytics appear.

## Live-app linkage (bridge.js)

The app's real customers are not a separate model; they are the same entities
with a few extra properties, written by `bridge.link()` after each world reset:

- **Passenger** `pax:app:<uid>` — `app_uid`, `app_email`, `app_phone`,
  `preferred_channel` (whatsapp when a phone is on file, else push),
  `quiet_hours: null` (urgent travel alerts allowed at any hour, a profile
  setting), `source: "app-profile"`. Consent per channel is derived from the
  profile: WhatsApp and SMS need a phone, email needs an address, push is on.
- **PNR** `pnr:app:<uid>` — `record_locator` XPW<uid>A, `app_booking_id`
  pointing at the real `bookings` row, `source: "app-booking"`.
- Edges are the ordinary ones: FlightInstance CARRIES PNR, PNR BELONGS_TO
  Passenger. Impact, recovery, offer and execution never special-case them.
- `preferred_channel` is honoured by the Offer agent's channel choice ahead of
  the default push → sms → whatsapp → email order; consent and quiet hours
  still gate it.
- **Offer** gains `app_uid` and `app_delivery` (provider status per channel,
  e.g. "whatsapp: delivered via Twilio" or "logged (Twilio not configured)").

New AuditEvent actions: `LINK_APP_CUSTOMERS`, `DELIVER_OFFER`,
`APPLY_TO_BOOKING`. The accepted option is written back onto the real booking
as `meta.recovery` (type, label, items, legs, vendor refs, accepted_at) and the
booking status becomes `rebooked` (or `refund_pending` for a Tier-2 refund).
Customer-facing messages live in `ai_inbox` and are mirrored into
`chat_turns`, so the assistant remembers what it said proactively.

## Destination intelligence (feeds.js · research.js · briefs.js)

- **WeatherEvent** now also arrives from live feeds: NWS active alerts (US) and Open-Meteo
  outlooks, through the same `sensing.ingestAlert()` with the same dedupe and scorecard.
  New scored types: hurricane_watch, severe_thunderstorm_watch/warning, blizzard,
  winter_storm, ice_storm, flash_flood, flood, high_wind, dense_fog, extreme_heat, heavy_rain.
- **DestinationEvent** (declared): political, civil, strike, transport, health, major_event,
  advisory — the structured non-weather kinds for Phase 2 feeds (GDELT, advisories,
  Ticketmaster). Declared now so the scorecard can grow without a schema change.
- **DestinationBrief** `brief:<code>:<from>:<to>` — the analyst's output for a city and date
  window: `weather` (outlook, days, alerts, risk), `holidays`, `events[]` (kind, title, date,
  impact, note, source), `advisories[]`, `news[]`, `travel_impact`, `summary`, `confidence`,
  `sources[]`, `mode` (llm+facts | facts-only), `generated_at`, `expires_at`. Edge
  `BRIEF_FOR → Airport`. Cached until `expires_at`; built only for booked destinations or on
  request; analyst calls capped per hour.
- **Action SEND_DESTINATION_BRIEF** (Tier 0; preconditions passenger_consented,
  outside_quiet_hours). Information only: it never changes a booking and never raises a
  prediction. Governance line: only structured feeds move a prediction toward ACT; the analyst
  explains and informs, and the customer decides (keep · other dates · talk to a person).
- New AuditEvent actions: LIVE_WEATHER_INGEST, DESTINATION_BRIEF, BRIEF_SENT, DELIVER_BRIEF,
  CUSTOMER_CALLBACK. Political content is summarised neutrally and every item carries a source.
