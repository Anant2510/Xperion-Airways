# Brand-neutral build: MAR (Modern Airline Retailing) reference · v10

Version v10: default demo tenant is **Xperion Airways** (code XP), tenant id
`xperion`. Deployable at a sub path via BASE_PATH (e.g. BASE_PATH=/v10).
Renamed from the earlier neutral carrier via the recipe below; suite re-verified
30/30, selftest 15/17, live brand check returns Xperion Airways.

## Previous rename (TAP → neutral), kept for the record

The solution is brand neutral. The default demo tenant is the fictional carrier
**Xperion Airways** (code XP); the second tenant remains **Nordvind Air**.

## What was renamed
| Was | Now |
|---|---|
| the original carrier brand | Xperion Airways / Xperion |
| the original loyalty programme | Xperion Miles |
| the original brand domains | flyxperion.example / xperion.example |
| tenant id `tap` | `xperion` (DEFAULT_TENANT) |
| TapAdapter / TAP_LEGACY_TOOLS | XperionAdapter / XPERION_LEGACY_TOOLS |
| flight + PNR prefix `TP` | `XP` (seeded fleet, PNR generator, voucher codes, agent parser regexes) |
| member_no prefix for new signups | `XP-9900x` |
| db file tap.db | mar.db (delete the db file to reseed under the new brand) |
| package name tap-daniel-demo | mar-reference-build |

Geography is unchanged: the route network stays Lisbon-hubbed so all seeded
bookings, packages and personas remain coherent. Persona identities (names,
emails, member numbers) are unchanged so CDP identity continuity is preserved.

## To rename the demo carrier again
1. Edit the config block passed to `createAirlineAdapter("xperion", ...)` in
   `server/server.js` (name, shortName, theme, brandLine) and `DEFAULT_TENANT`
   in `server/airline.js`.
2. Search-replace `Xperion Airways` / `Xperion` / `XP` with word boundaries, plus the
   regex literals `/XP\s?\d+/i` and `/\bVL\s?(\d{2,4})\b/` in `server/server.js`
   and `/XP[A-Z0-9]{4}/` in `_retail-test.mjs`.
3. `rm data/mar.db`, rebuild bundles (`npm run build:all && npm run build:v3`),
   boot, and run `_retail-test.mjs` (30 checks) and `/api/admin/selftest`.

## Verified after this rename
- 30/30 retail suite, selftest 15/17 (identical to pre-rename)
- Boot banner: "MAR reference build running - vela 27/27, nordvind 18/27"
- Zero remaining brand strings by grep across server, web, public, docs and
  rebuilt bundles: the original carrier name, loyalty programme, domains, adapter
  identifier,
  quoted 'tap', and TP-prefixed flight numbers all return zero.
