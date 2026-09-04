# Migrating the TAP demo to headless AEM — content layer

This folder turns the demo's hardcoded content (starting with the destination
catalogue) into AEM-managed content delivered headlessly via GraphQL. The booking
funnel, search, AI chat, payments and CDP integration stay exactly as they are —
**AEM owns content; the app keeps owning behaviour, transactions and personalization.**

## How it works in this build
- `server/aem.js` fetches Content Fragments from AEM via GraphQL persisted queries.
- `/api/destinations` now serves AEM content when AEM is configured, and overlays the
  per-traveller "reason" (from CDP/behaviour). If AEM is off or unreachable, it falls
  back to the local SQLite content — so the demo always runs.
- `/api/aem/status` reports whether AEM content is wired.
- Each destination in the response carries `contentSource: "aem" | "local"` so you can
  prove on screen which source rendered it.

We proxy AEM through Express (not browser→AEM direct) so AEM credentials stay
server-side, content can be merged with CDP personalization in one response, and there's
no CORS to configure. Browser-direct (persisted queries + CORS + the AEM Headless JS SDK)
is the alternative if you'd rather the React app call AEM itself.

## One-time AEM setup
1. **Environment** — an AEM as a Cloud Service sandbox (or local AEM SDK). Note your
   author/publish host, e.g. `https://publish-pXXXX-eYYYY.adobeaemcloud.com`.
2. **Content Fragment Models** — create `Destination` and `Offer` (and later `Hero`,
   `Page`) under config `/conf/tap`, using the field specs in `models/`.
3. **GraphQL endpoint** — enable a GraphQL endpoint for the `/conf/tap` configuration
   (Tools → General → GraphQL).
4. **Author content** — create Content Fragments from `content/destinations.sample.json`
   (one CF per destination) under `/content/dam/tap/destinations`, and upload the images
   to the DAM. Publish them.
5. **Persisted queries** — register `destinations-all` and `offers-all` from
   `graphql/queries.md`.
6. **Access** — publish tier is usually open. For the author tier, generate a token
   (local: dev token from the AEM SDK; cloud: a Service Credentials → exchanged access
   token, or the Developer Console local dev token) and put it in `AEM_AUTH_TOKEN`.

## App configuration (.env)
```
AEM_ENABLED=1
AEM_GRAPHQL_URL=https://publish-pXXXX-eYYYY.adobeaemcloud.com
AEM_PROJECT=tap
AEM_Q_DESTINATIONS=destinations-all
AEM_Q_OFFERS=offers-all
# AEM_AUTH_TOKEN=...        # only if hitting an authenticated (author) endpoint
```
Restart, then:
- `GET /api/aem/status` → `configured:true`
- `GET /api/destinations` → items now show `contentSource:"aem"`; the home page renders
  AEM content with the personalization overlay unchanged.

Leave `AEM_ENABLED` unset and everything runs on local content as before.

## Suggested rollout (don't boil the ocean)
1. Destinations (this build) — proves the headless pattern end-to-end.
2. Affinity offers/packages — `getOffers()` is already stubbed; point `packages.js`'s
   source at it the same way, model the Offer CFs, register `offers-all`.
3. Hero / marketing copy / Help & FAQ — straightforward Content Fragments.
4. (Optional) Universal Editor — instrument the React pages so authors edit in-context.
5. (Optional) Next.js + SSR if these become public, SEO-facing pages.

## What stays out of AEM
Search/results, seat/extras/payment, AI chat, check-in, the demo console, and all
personalization logic. Those are application behaviour and data, not content.
