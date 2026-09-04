# Modern Retailing engine — Offer → Order → Settlement

The commercial core layered OVER the existing PNR model (strangler pattern). The PNR stays the
**fulfilment** record; the Order becomes the **commercial** record. Nothing in the legacy flow
was removed — every legacy channel now *also* produces an Order.

## New files
| File | What it is |
|---|---|
| `server/retail.js` | Offers, Orders, order items, settlement ledger, explainable pricing, catalogue eligibility rules, NDC-aligned routes |
| `server/propensity.js` | Per-ancillary logistic-regression models, trained at boot from real `bookings` rows |
| `public/retail/index.html` | Workshop demo page at **/retail/** — persona switch, offers, compare strip, order + ledger |
| `_retail-test.mjs` | 30-check end-to-end suite (see "Testing") |

## New tables (no existing table is ALTERed)
`offers`, `orders`, `order_items`, `settlements`.

## API (NDC-aligned in SEMANTICS, not schema-conformant — say it exactly that way)
| NDC verb | Route |
|---|---|
| AirShopping | `POST /api/retail/offers` `{origin,dest,date}` → customer-priced offers with TTL |
| OfferPrice | `GET /api/retail/offers/:id` → re-validates; expiry surfaces here |
| OrderCreate | `POST /api/retail/orders` `{offer_id, accept_bundle? \| items?[]}` + `Idempotency-Key` header |
| OrderRetrieve | `GET /api/retail/orders/:id` — ONE Order view (items + PNR ref + ledger) |
| OrderChange | `POST /api/retail/orders/:id/items/:itemId/cancel` — refund ONE ancillary, flight untouched |
| — | `GET /api/retail/orders/:id/settlement` · `GET /api/retail/catalog` · `GET /api/retail/model` · `GET /api/retail/compare` |

**Reprice at commit:** accepting an expired offer returns **409
`OFFER_EXPIRED_REPRICED_AT_COMMIT`** with a fresh offer for the same flight. A stale cached
price can never book.

**Idempotency:** same `Idempotency-Key` → the same order, `replayed: true`. A re-delivered
OrderCreate is a no-op (same guarantee style as the PSS webhook).

## Pricing policy (this wording matters in front of a panel)
- **Continuous, customer-independent:** demand (seats left), advance-purchase curve. Everyone
  pays these the same.
- **Customer-specific = discounts/value ONLY, never surcharges:** commuter fare, tier loyalty
  fares, welcome fare, Platinum flex-included, miles-payment nudge. The test suite asserts no
  personal adjustment is ever positive.
- Every euro of adjustment ships as `{code,label,amount}` — the demo page renders the chips.

## Propensity model honesty
- Trained ONLY on rows in SQLite (`/api/retail/model` reports the count; ~250 at demo scale).
- Leave-one-out history feature — the label never leaks into its own feature.
- Codes with < 8 rows are blended toward the prior and flagged `low_confidence`.
- Scores ship with `drivers[]` in plain language ("added on 8 of 8 past trips", "interest match").
- Retrain any time: `POST /api/retail/model/train` (also runs at boot).

## Integration hooks (the only edits to existing files)
1. `server/server.js` — two requires; `retail.mount(app, …)` + `propensity.train()` before
   `/api/flights`; `/api/pay` creates an Order and returns `order_id`; agent `checkout` creates
   an Order, sets `session.lastPnr`, returns `order_id` (flows onto the confirmation card).
2. `server/server.js` — `sessionBooking(uid, session)` helper; all 9 post-booking tools now use
   it. **Fixes the wrong-trip bug**: a booking made in this chat session always wins over the
   date-nearest seeded trip.
3. `server/pss.js` — after the booking+payment insert, the PSS booking also becomes an Order
   (`channel: 'pss'`) — ONE Order spans offline + online.
4. `server/packages.js` — event dates are now computed forward from the real today
   (`futureDate(n)`); the expired World Cup package is replaced by an evergreen Lisbon matchday.

Apply with the files in this drop, or surgically via `retail-changes.diff`.

## Env
- `RETAIL_OFFER_TTL_MS` (default 1,200,000 = 20 min)
- `RETAIL_BUNDLE_MIN_P` (default 0.15 — min propensity for a bundle component)

## Testing
```bash
RETAIL_OFFER_TTL_MS=4000 node server/server.js &
TEST_TTL_MS=4000 node _retail-test.mjs      # 30 checks, exits non-zero on failure
```
Covers: per-customer price variance · explainability · no-personal-surcharge policy ·
propensity training · offer TTL + 409 reprice-at-commit · OrderCreate idempotency · PNR as
fulfilment ref · settlement balance (Σrevenue == Σpayments) · per-item refund with ledger
reversal · chat wrong-trip fix · legacy web + chat + PSS channels producing Orders ·
nordvind regression · built-in selftest · evergreen packages.

## Demo script (workshop)
1. Open **/retail/**. Note the propensity footer (algorithm + real row count).
2. "Compare all personas" — one flight, per-customer totals, discount chips. *Tip: switch to
   each persona once first so their user rows exist and the strip fills out.*
3. As Maria (Bronze): offers show paid extras ranked by propensity with drivers; accept
   offer + bundle → Order appears: items, PNR as fulfilment ref, balanced ledger.
4. Click "cancel just this" on one ancillary → item refunded, flight untouched, ledger shows
   the reversal, order `partially_refunded`. That is ONE Order servicing without EMD
   reconciliation.
5. Wait out a short TTL (boot with `RETAIL_OFFER_TTL_MS=60000`) and accept → the 409
   reprice-at-commit dialog. That is the stale-offer race, closed by design.
6. In the chat: book a flight, then "check me in" — it now talks about THAT booking, and the
   confirmation card carries the `order_id`.

## Deliberately NOT claimed (keep the deck honest)
- NDC 21.3 schema conformance (semantics only, today)
- Willingness-to-pay / price-elasticity models (pricing is rules + continuous components;
  propensity ML covers ancillary ranking)
- Flight-item OrderChange beyond whole-booking cancel; interline; multi-currency settlement
- Per-tenant retail config (engine currently prices with Xperion defaults; the adapter seam is the
  obvious place to add it — same pattern as the 27-tool contract)
