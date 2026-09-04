# Airline Adapter Contract

Any airline plugs its chat into the shared A2UI engine by implementing this contract and
registering it with `registerAirline()` in `server/airline.js`. Mobile apps then call
`POST /api/ai/agent` with header `x-airline-tenant: <id>` and receive `{ reply, cards, command }` —
the same 15 interactive A2UI card types, rendered by the shared client renderer.

Each tool is `(input, ctx) => result` with `ctx = { uid, session }`. Result shapes must match
what `buildUI()` cards — the reference implementations are XperionAdapter in `server/server.js`,
which now holds the complete contract (all 27 tools, migrated verbatim from the legacy chain).

Status: **27/27 migrated — the legacy inline chain is gone.**

## Search & discovery

- [x] `search_flights` — Search Xperion flights for a SPECIFIC route (origin + destination) and date. Only call this when you kno
- [x] `list_destinations` — List the real cities Xperion flies to FROM a given origin airport. Use this whenever the customer asks w
- [x] `get_suggestions` — Get the customer's personalized suggested destinations, computed from their real flown/booked/search
- [x] `search_multi_city` — Search a multi-city itinerary of 2-5 legs, each with its own route and date. Use for 'Porto to Lisbo
- [x] `get_flight_info` — Look up details and seat availability for a SPECIFIC flight number the customer mentions (e.g. 'does

## Book & pay

- [x] `select_flight` — Select a specific flight by its flight number (from a prior search) and put it in the basket. Use wh
- [x] `add_extras` — Add ancillary extras to the current basket/booking by their codes (e.g. wifi, meal, lounge, xbag, tr
- [x] `remove_extras` — Remove ancillary extras from the current basket by their codes (e.g. meal, wifi, bag). Use whenever 
- [x] `checkout` — Pay for the currently selected flight using the customer's saved profile (voucher + miles + card). C
- [x] `express_usual` — Open the 2-step Express Checkout for the customer's USUAL flight — their recurring route with seat, 
- [x] `park_trip` — Save the currently selected flight + extras into My Trip Basket so the customer can come back to it 
- [x] `hold_fare` — Lock/hold the price of a flight for a period (24h, 48h or 7d) so the customer can decide later. Use 
- [x] `get_hold` — Check the customer's active fare hold: which flight, the locked price and when it expires.",

## Post-booking

- [x] `get_booking` — Get the customer's current/latest active booking with status. Use for 'my booking', 'am I checked in
- [x] `list_seats` — List available seats and cabin classes (Business, Premium Economy, Economy) for the currently select
- [x] `change_seat` — Change the customer's seat on the currently selected flight or their current booking — you CAN do th
- [x] `upgrade_cabin` — Upgrade the cabin on an existing booking (Premium Economy or Executive/Business). Use for 'upgrade m
- [x] `check_in` — Check the customer in for their current active booking. Issues the boarding pass. Use when they say 
- [x] `cancel_booking` — Cancel the customer's current active booking with an instant refund (miles restored, voucher reactiv
- [x] `get_refund_status` — Status of a refund after a cancellation: amount, method and where it is in the timeline.",
- [x] `split_booking` — Split a multi-passenger booking into separate PNRs — move one or more travellers onto their own reco

## Disruption

- [x] `get_disruption` — Check whether the customer's flight is disrupted (delayed/cancelled) and list the recovery options a
- [x] `rebook_flight` — Rebook the customer onto an alternative flight after a disruption, keeping their extras. Use after g
- [x] `resolve_disruption` — Resolve a disruption per traveller — each passenger can independently take a refund, a travel vouche

## Profile & discovery

- [x] `get_wallet` — Get the customer's LIVE Xperion Miles balance and voucher status from the database. Use whenever they ask
- [x] `get_recommendation` — Get the customer's personalized experiential PACKAGE — derived from their co-branded Xperion credit-card
- [x] `get_journey` — Get the customer's UNFINISHED booking journey shared across web, this chat, and WhatsApp. Use when t

## Onboarding a new airline

1. `createAirlineAdapter("<id>", { ...tools })` implementing the tools against your systems.
2. `registerAirline(adapter)` — the return value is your remaining-work checklist.
3. Point your app at `POST /api/ai/agent` with `x-airline-tenant: <id>`.
4. A contract tool your adapter doesn't implement returns a clear per-tenant reply
   (`"<tool> isn't available for <id> yet."`) — the chat degrades gracefully, never dies.
5. Unknown/typo'd tenant ids fall back to `xperion` entirely.

---

# Phase 2 — Multi-tenancy

## Registering a tenant

```js
const adapter = createAirlineAdapter("otherair", { /* tools */ }, {
  name: "Other Airways",          // shown to the agent; names the carrier in every reply
  homeAirport: "LHR",
  currency: "GBP",
  locale: "en-GB",
  brandLine: "Loyalty tiers: Blue, Silver, Gold.",   // optional, injected into agent context
  cdp: false,                      // true only with a live customer-data-platform feed
  model: null,                     // optional per-tenant Claude model; null = server default
});
adapter.profile = ({ uid }) => yourCustomerLookup(uid);   // optional, non-contract hook
registerAirline(adapter);
```

## Request routing

`POST /api/ai/agent` with header `x-airline-tenant: otherair`.

- **Known tenant** → served by that adapter.
- **Unknown / typo'd tenant** → served as the default airline (`xperion`) so the chat never dies,
  and logged as `ai_tenant_unknown` with the requested id, so a misconfigured client app is
  visible rather than silent.
- **No header** → default airline.

## Session isolation

Agent sessions are keyed `"<tenant>::<sessionId>"`. Before Phase 2 they were keyed by
`sessionId` alone, so two airlines whose apps both sent the common default (`"web-default"`)
would have shared one session — including `lastSearch`, `selected` and `uid`. Sessions are now
per-tenant. **Deploy note:** because the key format changed, any in-flight chat session resets
once on the deploy that introduces this.

## Unimplemented tools

A tool in the contract that a tenant's adapter does not implement returns
`{ ok: false, message: "<tool> isn't available for <tenant> yet." }`. The agent reports that
plainly to the customer; the rest of the chat keeps working. Xperion implements all 27, so Xperion
can never reach this path.

## Known Phase 2 limitation — the live system prompt is still Xperion-branded

`server/claude.js` builds the live agent's system prompt from `danielContext()`, which reads
the Xperion customer record directly (`SELECT * FROM users WHERE id=1`) and opens with
*"You are the AI inside Xperion Airways' digital channel"*. Everything else is now
tenant-aware, but that prompt is not — so a second tenant's **live** replies would still
carry Xperion framing.

Partial mitigation already in place: the situational note prepended to each request names the
resolved tenant (`"…is on the 'home' screen of Other Airways."`) plus its `brandLine`, which
steers the model. The offline agent and all 27 tools are fully tenant-correct.

**The remaining change** (small, and deliberately not applied here — `server/claude.js` is not
in the working tree this was built from, so it has not been edited or verified):

```js
// claude.js — accept an optional per-tenant context instead of always using danielContext()
async function callClaudeAgent(messages, tools, runTool,
                               { maxTokens = 1200, maxTurns = 5, context } = {}) {
  const sys = (context || danielContext()) + ` ...existing agent instructions... `;
```

```js
// server.js — pass the tenant's own context when it provides one
callClaudeAgent(withContext, AGENT_TOOLS, runTool,
                { context: tenant.adapter?.systemContext?.({ uid: req.uid }) });
```

Each adapter then supplies `systemContext()` describing its own airline and customer, and the
live agent speaks as the right carrier. Until then, treat live multi-tenant replies as
Xperion-framed and rely on the situational note.

---

# Phase 3 — Second airline onboarded (reference implementation)

`server/airlines/nordvind.js` is a working second tenant, **Nordvind Air**, included as both
proof and template. It imports nothing from `server/server.js` — its whole "reservation
system" is an in-memory store in that one file. That is the property that shows the seam
really detaches the chat from Xperion.

## What it demonstrates

- **18 of 27 contract tools implemented**, against its own data (own routes, own fare logic,
  own cabins "Nordic Economy / Plus / Business", own loyalty currency).
- **The remaining 9 are intentionally absent**, so the partial-tenant path is exercised: they
  return `"<tool> isn't available for nordvind yet."` and the rest of the chat keeps working.
  A real day-one integration looks exactly like this.
- **All 15 A2UI card types render for it**, produced by the same shared `buildUI` — verified by
  running a full flow (search → select → extras → pay → manage → seat → upgrade → check-in →
  cancel → refund) and asserting the emitted card types.
- **Per-customer isolation** inside the tenant, and per-tenant session isolation from Phase 2.

## Enabling / disabling

Registered automatically at boot. It is inert unless a request sends
`x-airline-tenant: nordvind`. Set `AIRLINE_DEMO=0` to leave it out of a production deployment.

```bash
curl -X POST http://<host>:7801/api/ai/agent \
  -H "content-type: application/json" \
  -H "x-airline-tenant: nordvind" \
  -d '{"messages":[{"role":"user","content":"flights from Oslo to Copenhagen"}],"sessionId":"demo-1"}'
```

## Using it as a template

Copy the file, keep the tool names and return shapes, and replace the in-memory helpers
(`schedule`, `acct`, `basket`, …) with calls to your own reservation, loyalty and payment APIs.
Return shapes are the contract — they are what `buildUI` turns into cards.

## Known limitations found while building it

- **Card currency is EUR-only.** The client renderer formats money with a fixed `€`; the
  per-tenant `currency` config is not yet honoured in the UI. A non-EUR airline would display
  the right number with the wrong symbol. Fix belongs with the Phase 4 client SDK.
- **The live system prompt is still Xperion-branded** (see the Phase 2 limitation above). Nordvind's
  offline replies and all its tools are correct; its *live* replies inherit Xperion framing until
  `claude.js` accepts a per-tenant context.

---

# Core de-brand pass

Goal: nothing in the **shared engine** should name Xperion. Xperion-specific *features* (Portugal
Stopover, its CDP wiring) legitimately stay with Xperion as a tenant — the target is the code every
tenant inherits.

| Coupling | Before | After |
|---|---|---|
| Tool descriptions sent to the LLM | 3 literal "Xperion" | templated `{{airline}}`, filled per tenant |
| Offline agent home airport | hardcoded `"OPO"` | `tenant.config.homeAirport` |
| Default tenant | `"xperion"` in code | `DEFAULT_AIRLINE` env |
| Unknown tenant | silently served as Xperion | `AIRLINE_STRICT=1` → HTTP 400 |
| Client brand strings | hardcoded | server-supplied `brand` per reply, Xperion as fallback |

**`shortName`** keeps Xperion's prompt wording byte-identical: templating on the full config name
would have produced "Search *Xperion Airways* flights". Xperion declares `shortName: "Xperion"`, so all
27 descriptions render exactly as before — verified 27/27 against the pre-de-brand file.

Every response now carries `brand: { id, name, assistant, source, currency }` for the resolved
tenant. The renderer uses it when present and falls back to Xperion's strings, so Xperion is unchanged
and a partner sees its own name without a client rebuild. `source` is null for a tenant without
a CDP, and the "personalized from …" line is then omitted rather than showing a stale provider.

## A Xperion-free deployment

```bash
DEFAULT_AIRLINE=nordvind AIRLINE_STRICT=1 AIRLINE_DEMO=0 node server/server.js
```

## What still names Xperion (and why)

- **`server/claude.js` system prompt** — *"You are the AI inside Xperion Airways' digital
  channel"*, and it reads `users WHERE id=1`. Not in the working tree this was built from, so it
  has never been edited or verified here. The two-snippet fix is in the Phase 2 section.
- **Renderer colour tokens** (`tap-green*`, `lime-tint`, `tap-red`) — theming belongs with the
  Phase 4 client SDK, alongside the per-tenant currency symbol.
- **`FALLBACKS`** in `claude.js` — cached demo copy with Xperion flight numbers; only reachable when
  the live call fails *and* the offline agent throws.

---

# Phase 4 — Client SDK

`sdk/airline-chat.jsx` + `sdk/README.md`. A partner renders `<AirlineChat endpoint tenant
getToken />` and gets the whole A2UI surface.

**Theming moved to CSS variables.** The renderer no longer uses `tap-*` Tailwind classes —
verified zero residual Xperion/lime classes in `web/v2/ai.jsx`. It uses `.air-*` utilities reading
`--air-accent`, `--air-accent-deep`, `--air-accent-dark`, `--air-highlight`, `--air-tint`,
`--air-danger`, defaulted in `tokens.css` to Xperion's exact hexes so Xperion is pixel-identical. Each
tenant's palette travels in `brand.theme` and is applied at runtime, so **re-theming needs no
client release**.

**Currency** renders from `brand.currency`; the EUR path delegates to the host formatter so
Xperion output is byte-identical.

**Transport is pluggable** — `AIConcierge` accepts a `transport`, so the widget can point at
any host with any auth scheme. The in-app default still uses the host's api client.

## Remaining after Phase 4

- `Pill` status tones come from the host design system (3 sites), not theme variables.
- Theme variables are applied to the document root, not scoped to the widget element.
- `server/claude.js` system prompt still Xperion-branded (Phase 2 section has the fix).
- SDK ships as source; no bundling/publishing pipeline.
