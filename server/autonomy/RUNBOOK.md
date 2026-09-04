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
