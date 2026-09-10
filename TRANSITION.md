# Xperion Airways — Transition Document
**Prepared 7 Sep 2026, ~20:45 IST · for continuing the build in a new chat**

Read this top to bottom once; then use the section index. Everything the next chat needs — context, architecture, state of the machines, every switch, every ritual, every open issue — is here.

---

## 0. Index

1. Project, people, dates
2. Machines, URLs, repo, access
3. The deploy ritual (Mac ⇄ GitHub ⇄ VM) and process hygiene
4. Environment variables (VM `.env`, complete)
5. Architecture map — every module and what it does
6. What was built, in order (this session's changelog)
7. Test suites and their last results
8. Demo scripts (golden timeline · live · MCP · WhatsApp)
9. Current state of the VM and OPEN ISSUES (read this before anything else)
10. Security housekeeping (secrets that were exposed in chat)
11. Pending / next ideas
12. Conventions and user preferences
13. API quick reference

---

## 1. Project, people, dates

- **Event:** Coforge TechCon 2026 — "Modern Retailing in Airlines". Semi-final was 7 Sep (today); **final 16 Sep 2026**.
- **Airline:** *Xperion Airways*, fictional US carrier, IATA **XP**, hubs **MIA + JFK**, home MIA, USD, en-US. Rebranded from an earlier TAP Air Portugal demo ("TAP V2") — some older filenames still say `Tap-demo`/`tap-logo.png`; product-facing text is fully Xperion.
- **Accelerator story:** *VoyagerAI* (Coforge's airline accelerator, eight named agents). Critic/judge persona: Amit Kumar (Sr Principal Enterprise Architect / VP).
- **Personas (seeded customers):** uid 1 **Daniel Ferreira** (Gold, home MIA, football affinity), 2 Sofia Marques (Silver), 3 Lars Andersen (Platinum, FRA shuttle), 4 Maria Costa (Bronze), 5 James Bennett (Gold), 6 Luís Carvalho (Gold, JFK↔BOS shuttle), plus 5 more; all emails `anant.direct2links+<name>@gmail.com`. Persona → uid: `uidForPersona()` in server.js.
- **Owner:** Anant Singh (`anant.2.singh`, Coforge). Mac user; VM is Windows.

## 2. Machines, URLs, repo, access

| Thing | Value |
|---|---|
| Repo | `https://github.com/Anant2510/Xperion-Airways` (should be private) — branch `main` |
| Mac working dir | `~/Xperion-Airways` (zsh) |
| VM working dir | `C:\Users\xPerionExp\Documents\AI tools\xperion-airways` (PowerShell 5, Administrator) |
| VM public app | `http://20.40.50.197:7811/` — v1 app at `/v10#app`, v2 app at `/v2`, ops page `/autonomy/`, health `/api/health`, MCP `/mcp` + `/mcp/info` |
| VM process | pm2 app **`xperion-v10`** (fork mode), started fresh 8 Sep ~00:20 IST with `pm2 start server\server.js --name xperion-v10 --cwd "C:\Users\xPerionExp\Documents\AI tools\xperion-airways"` then `pm2 save`. Port **7811** |
| VM DB | `data\xperion-v10.db` (SQLite). Old copies: `data.old-vm/`, `data.old-vm2/` (untracked) |
| Other service on the VM | **`AABackend`** ("AA Backend API"): NSSM-wrapped Windows service, `node scripts\serve.js` on port **7810**, not part of this project, auto-restarts if killed. This is why Xperion runs on 7811. Leave it alone |
| Sandbox in this chat | `/home/claude/work/Tap-demo` (the build tree; drops are zipped from it as `mar-reference-build-v10.zip`) |
| Node | 22 on both. Deps: express 5, better-sqlite3/node:sqlite, baileys 7.0.0-rc14, qrcode-terminal, @modelcontextprotocol/sdk ^1.30, zod ^4 |
| WhatsApp burner (bot) | **+91 85959 60365** — **PAIRED** 8 Sep ~00:15 IST via pairing code; creds in `data\baileys-auth\` (never delete again). Second WhatsApp account (additional eSIM) on the owner's handset. Replaced +91 96258 33782, restricted by WhatsApp for bulk messaging — see §9 |
| Owner's personal WhatsApp | +91 98717 24927 — primary account on the same handset; the pinned demo recipient (`WA_PHONE_MAP=919871724927:daniel`) |
| Adobe AEP | sandbox **coforge3**, IMS org `65B229AE5ED637A00A495E96@AdobeOrg`, client id `4f40cf53cb4e4c209d15370b6ea7a209`, tenant ns `_aeppsemea`; profile dataset `6a2ed5da5851aaac8bc69d1c`, event dataset `6a30e64ba4428172f3d4e491`; profile schema `…/4a538027b8b70a4e2e7ae28849ba7e8c3962856add0917be`, event schema `…/8f9c109a99b357190784d9a0b0306fc9c79c23e22b11b46d` |
| AEP streaming inlet (provisioned by the server today) | inlet `https://dcs.adobedc.net/collection/92261cf62d541a05322f6ab24a68537070879b2d3fb47103a02da9d9aeaef2ba`, flow `3ddf2d76-deba-4119-bcb6-614fde439f60`, base conn `96752b00-bb16-44a8-b943-710cadd090ab` (stored in the `settings` table; env wins if `ADOBE_STREAMING_URL` set) |
| Gmail SMTP | `anant.direct2links@gmail.com` with an app password (see §10) |
| Claude Desktop (Mac) | connector **xperion-airways** configured in `~/Library/Application Support/Claude/claude_desktop_config.json` → `command: /usr/local/bin/node`, `args: [~/Xperion-Airways/mcp/xperion-mcp.mjs]`, env `XPERION_URL=http://20.40.50.197:7811`, `XPERION_TOKEN=<Daniel token>` |

## 3. The deploy ritual and process hygiene

Drops arrive as **`mar-reference-build-v10.zip`** (cumulative; contains a `Tap-demo/` folder). The user downloads it into `~/Xperion-Airways` (sometimes `~/Downloads`).

**Mac (every drop):**
```bash
lsof -ti:7811 | xargs kill 2>/dev/null
cd ~/Xperion-Airways
unzip -o mar-reference-build-v10.zip
rsync -a Tap-demo/ ./
rm -rf Tap-demo
rm mar-reference-build-v10.zip
git add -A && git commit -m "<message>" && git push
```
Add `npm install` when `package.json` changed (it did for baileys and the MCP SDK). `*.zip` is now in `.gitignore` (one archive was accidentally committed and removed). Tests run on the Mac with `BASE=http://127.0.0.1:7811 node _<name>-test.mjs` while `npm start` runs, or against the VM with `BASE=http://20.40.50.197:7811`.

**VM (every drop):**
```powershell
cd "$env:USERPROFILE\Documents\AI tools\xperion-airways"
git pull
pm2 restart xperion-v10 --update-env
Start-Sleep -Seconds 12; pm2 logs xperion-v10 --lines 20 --nostream
```
Add `npm install` after pull when deps changed. **Never reset the DB casually** (`Remove-Item data\xperion-v10.db*` wipes bookings, CDP queue, MCP tokens, streaming settings). Seed changes only apply to a fresh DB.

**Process hygiene (cost hours on 7 Sep; root causes found 8 Sep):**
- **Do not count node processes — read their command lines.** Healthy on this VM is THREE: `pm2\lib\Daemon.js` (pm2 daemon), `pm2\lib\ProcessContainerFork.js` (the xperion-v10 app), and `scripts\serve.js` (the unrelated `AABackend` NSSM service on 7810). Check:
  ```powershell
  Get-CimInstance Win32_Process -Filter "name='node.exe'" | Select-Object ProcessId, CommandLine | Format-List
  netstat -ano | findstr LISTENING | findstr :7811
  pm2 pid xperion-v10
  ```
  Anything showing a bare `server\server.js` is a stray foreground server and must be killed by PID (`Stop-Process -Id <pid> -Force`). The 7811 listener PID must equal `pm2 pid`. The earlier "exactly two" rule was wrong from the day it was written and caused the blanket kills below.
- A foreground `node server\server.js` left running in a window silently steals port 7811 (pm2's app then crash-loops, `restarts` climbs) **and** fights for the WhatsApp session (440 conflicts → eventually WhatsApp logs the device out). Exactly this happened on 7 Sep: a stray started ~22:10 IST survived the "cleanup" and was still alive at 00:05 IST on 8 Sep (found via the command-line check, killed).
- `Get-Process node | Stop-Process -Force` kills the pm2 daemon too (then `pm2 restart` says "not found" → `pm2 kill`, `pm2 start … --name xperion-v10 --cwd …`, `pm2 save`) and is pointless against `AABackend`, which NSSM restarts within a minute. Only use it as part of the full reset, and expect `serve.js` to come back.
- Stop the app with `pm2 stop`, never by closing a window. Start it only with `pm2 start`/`pm2 restart`, never with a bare `node server\server.js` while pm2 is up. The one exception is first-time WhatsApp pairing, which needs the foreground run so the code is visible, followed immediately by Ctrl-C and `pm2 restart --update-env`.

- **After any `pm2 restart` during a rehearsal:** the simulation's in-memory state (`sim.state`, the STUB vendor tables) is gone; the graph and every customer card survive in the DB. Seat holds are rebuilt from the graph on demand since 8 Sep, so an old card still works. To continue the timeline (T-0, stand-down) you still need Reset world → T-72 → T-48 on `/autonomy/`.

## 4. Environment variables (VM `.env`, complete)

Server/DB: `PORT=7811`, `DB_PATH` (default `data/xperion-v10.db`), `SERVER_DEFAULT_UID=1` (demo model: requests without a session act as Daniel), `PUBLIC_URL` (unset; set when https exists — MCP snippets use it).

AI: `ANTHROPIC_API_KEY=<set>`, `CLAUDE_MODEL=claude-sonnet-5`.

Adobe: `ADOBE_CDP_ENABLED=1`, `ADOBE_IMS_ORG`, `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET` (**exposed in chat earlier — rotate**), `ADOBE_SANDBOX=coforge3`, `ADOBE_SCOPES=openid,AdobeID,read_organizations,additional_info.projectedProductContext,session`, `ADOBE_TENANT_NS=_aeppsemea`, `ADOBE_LOYALTY_NS=Email`, `ADOBE_PROFILE_SCHEMA_ID`, `ADOBE_EVENT_SCHEMA_ID`, `ADOBE_PROFILE_DATASET_ID`, `ADOBE_EVENT_DATASET_ID`, `AEP_AUDIENCE_PREFIX=TAP –`, `CDP_AGENT_ENABLED=0`. Optional: `ADOBE_STREAMING_URL` + `ADOBE_EVENT_FLOW_ID` (env override for the provisioned inlet), `ADOBE_EVENT_SYNC_VALIDATION=1` (inline schema validation on the inlet), `CDP_EVENT_BATCH_MS` (15 min; only used when no inlet), `CDP_EVENT_BATCH=0`.

Email: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=anant.direct2links@gmail.com`, `SMTP_PASS=<16-char app password, no spaces>` (**exposed — rotate**), `EMAIL_FROM="Xperion Airways <anant.direct2links@gmail.com>"`, `DEMO_EMAIL_TO=anant.direct2links@gmail.com`.

WhatsApp (live on the VM since 8 Sep): `WA_MODE=baileys`, `WA_PAIRING_PHONE=918595960365` (pairing by 8-char code), `WA_PHONE_MAP=919871724927:daniel` (bot messages the owner's personal account as Daniel), `WA_SELF_CHAT=0` (off because a separate number is pinned; leave unset only for one-number self-chat testing with `WA_PHONE_MAP=918595960365:daniel`). Opt-in rule: `WA_ALLOWED_NUMBERS` (extra numbers the bot may message unprompted), `WA_ALLOW_ALL=1` (disables the rule — never on a number that matters). `WA_QR_LARGE=1` (full-size QR fallback), `WA_GUESTS=1` (unknown senders → guests; default on). Anything other than `WA_MODE=baileys` = Twilio webhook path (`TWILIO_*`, unused). Pairing credentials live in `data\baileys-auth\` (gitignored).

Destination intelligence / cost: `FEEDS_ENABLED=1` (default on), `FEEDS_INTERVAL_MS=1800000`, `FEEDS_IDLE_INTERVAL_MS=10800000`, `BRIEFS_ENABLED=1`, `BRIEFS_INTERVAL_MS`, `BRIEF_T_MIN_H=60`, `BRIEF_T_MAX_H=84`, `RESEARCH_ENABLED=1`, **`RESEARCH_MODE=on-demand`** (default; `always` lets the unattended scheduler use the analyst), `RESEARCH_ACTIVE_MIN=30`, **`RESEARCH_DAILY_MAX=15`**, `RESEARCH_MAX_PER_HOUR=20`, `RESEARCH_MAX_SEARCHES=7`, `RESEARCH_TTL_MS=43200000`, `RESEARCH_MODEL`, `RESEARCH_COST_PER_CALL=0.04`, **`AUTONOMY_LIVE_TRIPS=1`** (off by default: mirrors real bookings into the graph so live weather can score/act on them), `AUTONOMY_TRIP_HORIZON_DAYS=10`.

`.env.example` documents all of these.
- `AUTONOMY_LINK_ALL` (unset) — set to `1` to put every registered account on the disrupted flight at world reset; default links the 11 seeded personas only (8 Sep).

## 5. Architecture map

**Server (`server/`)** — Express 5, single process, SQLite.
- `server.js` — everything wires here: tenants (`airline.js`: `createAirlineAdapter`, 27-tool `REQUIRED_TOOLS`, `resolveTenant`), the assistant tool registry **`AGENT_TOOLS`** + `XperionAdapter` implementations + `agentRunTool(name,input,session)` + `toolsFor(cfg)`; the live agent loop (`claude.js`, `callClaudeAgent`, tools awaited) and the **offline `deterministicAgent`** (rules → tools; used when no key); `/api/ai/agent`, `/api/ai/tool` (WebMCP); persona/session; search (`search.js`: `generateFlights`, `getRoute`; `routes-data.js`: 1,572 airports / 6,522 legs); packages (`packages.js`: two venues per affinity, `packageFor`, `packagesIn`); countries (`countries.js`: name→ISO, `listServed` ranked by a MAJOR list); CDP (`cdp.js` profile read, `cdp-ingest.js` batch, `cdp-events.js` events queue/batch/stream, `cdp-streaming.js` inlet provisioning via Flow Service, `cdp-audiences.js`, `cdp-segment-agent.js`); email (`email.js` templates incl. `destination_brief`); WhatsApp (`whatsapp.js` conversation, `whatsapp-baileys.js` transport); `session.js` (`resolveUid` via `x-session-id`, `userByPhone`, `guestForPhone`, `pinnedPhoneFor`); `mcp.js` (MCP server + tokens + self-service snippets); schedulers started in the `app.listen` callback (feeds, briefs, CDP batcher, WhatsApp transport).
- `server/autonomy/` — the Enterprise Autonomy layer: `graph.js` (in-memory KG persisted in SQLite), `ontology.js` (KINDS incl. `DestinationEvent`, `DestinationBrief`, `TripRiskAssessment`; ACTIONS with tiers/preconditions incl. `SEND_DESTINATION_BRIEF` T0, `SHIFT_TRIP_DATE`/`SWITCH_AIRPORT` T1 reversible; PRED predicates; `audit`), `policy.js` (`execute`, kill switch `setKill({global:true|false})`, tier-2 queue), `sensing.js` (`ingestAlert` hash-dedupe, `evaluate`, TYPE_BASE incl. live NWS types), `agents.js` + `orchestrator.js` (impact → recovery → offer → execution saga), `sim.js` (golden scenario XP201 DEL→MIA, 214 synthetic pax; `reset/t72/t48/accept/t0`), `clock.js`, `vendors.js`, `seed.js`, `bridge.js` (links real app users as PNRs on XP201, delivers offers/briefs to app inbox + WhatsApp/email/push, `intercept` for plain-language replies, `syncTrips()` real bookings → FlightInstances, `status(uid)` for banners), `geo.js` (Open-Meteo geocoding cached in `geo_cache`), `feeds.js` (NWS + Open-Meteo → sensing; idle cadence), `research.js` (facts + Claude web-search analyst → `DestinationBrief`; on-demand mode, daily cap, `<brief>` tags + repair pass), `briefs.js` (T-72 scheduler, `runForBooking`, background job for ops), `alternatives.js` (risk window, SHIFT_DATE / ALTERNATE_AIRPORT / KEEP_WITH_FLEX, `take()`), `index.js` (router `/api/autonomy/*`), docs `ONTOLOGY.md`, `RUNBOOK.md`.
- `mcp/xperion-mcp.mjs` — stdio bridge for Claude Desktop (ESM; proxies to `/mcp`). Served at `/mcp/bridge.mjs`.

**Clients (`web/` → built to `public/` with esbuild; `npm run build`, `build:v2`, `build:all`)**
- v1 `web/app.jsx` → `public/app.js` (`/v10#app`): Home header has **Connect your AI** + Demo Console; ChatCards incl. `disruption*`, `destination_brief` (with risk-aware alternatives), flights card with window/dates; ProactiveBanner; `AiAccessPanel`.
- v2 `web/v2/*.jsx` → `public/v2/app.js` (`/v2`): `shell.jsx` (TopNav, user menu → Settings → **Connect your AI** → `AiAccessModal`), `ai.jsx` (cards), `main.jsx` (banner), `mmb.jsx`, `checkout.jsx`, `webmcp.js`.
- `public/autonomy/index.html` — ops page (simulation buttons, KPIs, predictions, Tier-2 queue, **Destination intelligence** panel with Poll/Brief buttons, **AI tool access (MCP)** token panel, real-customers table).

**Data notes:** bookings carry `meta_json` (origin/dest/dep/arr, `recovery`, `brief_sent`, `original`, `rebooked_from`, `flex`); `ai_inbox` (assistant proactive inbox), `wa_messages`, `mcp_tokens` (with `client` column), `cdp_event_queue`, `settings` (streaming inlet), `geo_cache`.

## 6. What was built this session (chronological)

1. **WhatsApp over Baileys** replacing Twilio: pluggable transport, LID resolution (`remoteJidAlt` → signal store), reply on originating JID, guests, `WA_PHONE_MAP` (both directions), self-chat test mode, 440 back-off, outbox flushed on reconnect, pairing by code (`WA_PAIRING_PHONE`), version logging, standard browser identity (`Browsers.ubuntu("Chrome")`), `WA_QR_LARGE`.
2. **Copy/rename fixes:** "Olá"→"Hi", "Xperion an option"→"Choose an option", "Tap a seat", "Thank you for flying Xperion", "Good morning", wordmark **Xperion · AIRWAYS**, `${home}→LIS` defaults → MIA↔JFK, guest greeting/menu, examples "flights to New York".
3. **Search intelligence (WhatsApp + web parity):** week scan (`days`), cheapest-first (`sort=price`), dated picks (`PICK_XP@date`, `select_flight(date)`), month phrases ("first week of October", "early/mid/late", "in October", "Oct 12"), countries as destinations (served-airport list ranked, pick by number/city/airport; honest "we don't fly to X"), no express/package hijacks, alias resolution shared (`whatsapp.detectDest`).
4. **Destination intelligence (Option C):** live NWS + Open-Meteo feeds into sensing; research analyst (Claude + web search, neutral, sourced, `<brief>` JSON, repair pass, honest empty findings); T-72 proactive briefs (Tier-0, policy-gated) to app/WhatsApp/email with keep/dates/talk; `get_destination_brief` tool (with `interest`, packages in that city, alternatives); weather guidance in prompts; ops panel; **cost controls** (on-demand analyst, daily cap, idle feed cadence).
5. **Risk-aware alternatives:** `alternatives.js` — risk window from events/weather/predictions; safer dates with flights/prices, alternate airport in-country with own weather + transfer estimate, keep-with-flex; one tap / reply number / "earlier" / "later" / "flex"; T1 reversible actions; on the brief card, WhatsApp text, assistant tool, `POST /api/autonomy/risk/assess`.
6. **Real trips into the graph** (`bridge.syncTrips`, flag `AUTONOMY_LIVE_TRIPS`), next-trip brief background job, brief by PNR, seed fixes (Lars XP201→XP211/212, Luís JFK→JFK → JFK↔BOS).
7. **RT-CDP:** profile reads live; persona batch ingest; **events**: queue + batch into event dataset when no inlet, then **server-provisioned streaming inlet** (Flow Service: base/source/target/flow) → real-time server-side ingestion — verified `synchronousValidation: pass`; Demo Console panels + buttons.
8. **MCP server** at `/mcp` (Streamable HTTP, 33 tools = 28 assistant tools + `get_my_profile`, `get_disruption_status`, `accept_disruption_option`, `get_trip_risk`, `take_trip_alternative`; 3 resources; 2 prompts), bearer tokens per customer, admin mint on ops page, stdio bridge; **Connect your AI** self-service (Claude/Gemini/Copilot toggles, key shown once, paste-ready configs, revoke on off) — homepage top right (v1) and v2 user menu.
9. Wordmark fix; Demo Console self-test lines; docs (DEPLOY.md, RUNBOOK.md, ONTOLOGY.md, .env.example).
10. **PNR targeting for booking tools (8 Sep, from a real Claude Desktop session):** asked to "cancel my upcoming flight to Miami on XP201", the assistant correctly refused because `cancel_booking` could only act on the *current* booking (XPDAN02), and over MCP there is no session-selected trip. Fix in `server.js`: `sessionBooking(uid, session, pnr)` — an explicit `pnr` always wins and **never falls back**; a PNR that is not the customer's, not upcoming, or unknown returns `state: "pnr_not_found"` with nothing changed. Optional `pnr` added to the input schema of `get_booking`, `check_in`, `split_booking`, `resolve_disruption`, `upgrade_cabin`, `get_disruption`, `rebook_flight`, `cancel_booking` (flows through to MCP automatically; descriptions tell the model to call `get_my_profile` to list trips). Confirm gates unchanged. `change_seat` still acts on the session/current booking (basket-vs-booking logic; left for later). 5 regression checks in `_mcp-test.mjs`.
11. **Clear chat in the assistant (8 Sep):** both layouts of the Xperion AI Assistant (the embedded home panel and the full `/ai` screen) now have a two-tap **Clear chat** control (first tap asks, times out after 6 s). It resets the thread to the greeting, rotates the client `sessionId` and calls the new `POST /api/ai/session/clear` so the server forgets the old session (lastSearch / selected / pending confirmation), drops any reply still in flight, and **keeps unanswered proactive cards** (an open disruption offer or brief) — those are the airline's inbox, not chat history. The old "+ New chat" on `/ai` only reset the client list and left server memory intact; it is replaced. `public/v2/app.js` rebuilt (`npm run build:v2`) and included in the drop; QA still 115/117; bundle boots clean in jsdom.
12. **Failed acceptance after a restart (8 Sep, from a real VM screenshot):** Daniel tapped an option on the proactive weather card and the assistant answered *"I couldn't complete that: please try again."* while the card flipped to **Handled ✓**. Root cause: the STUB PSS keeps seat holds in process memory (`server/autonomy/vendors.js`), so a `pm2 restart` between T-48 and the tap (or a T-0 / stand-down) made `confirmSeats` return `no_hold`, the reroute saga failed at REBOOK, compensated, and `acceptForUser` returned `{ok:false, failed, compensated}` with no `reply` — hence the generic text on every channel (app, `/api/ai/agent`, WhatsApp all fall back to the same string). Two fixes: (a) `confirmSeats` **rehydrates a missing hold from the graph** — the `RecoveryOption` node carries `seat_hold_ref` and `expiry`, so a hold that is missing in memory but still valid on the node is rebuilt; holds released on purpose (stand-down, expiry) are remembered and never rebuilt. (b) `bridge.acceptForUser` now answers a failed or refused saga in plain language ("the seats for that option could not be confirmed, so nothing on your booking has changed… you can still choose another option: …"), writes it to `ai_inbox` as `disruption_failed`, audits `OFFER_FAILED_REPLY`, and **leaves the offer open**. Client (`web/v2/ai.jsx`): the card only turns Handled when the server says the offer is settled (`ok`, or `no_pending_offer`); a dead network gets its own message. 7 regression checks in `_autonomy-test.mjs` (hold survives a lost hold table; released holds stay released; failure reply text; inbox kind; offer stays open; another option still executes). Bundle rebuilt.
13. **Two briefs on one phone, and graphic news in a customer message (8 Sep, from the personal WhatsApp):** the T-72 brief arrived twice on +91 98717 24927, one addressed "Anant", one "Daniel". Cause: `bridge.link()` put **every row of `users`** on XP201, including an account registered on the VM under the presenter's own name and phone, and `deliver()` sent to that account's phone as well as to Daniel's pinned one. Fixes: (a) `link()` now takes the **11 seeded personas only** (`KNOWN_USERS`); runtime signups and WhatsApp guests are left out unless **`AUTONOMY_LINK_ALL=1`**. (b) `deliver()` never sends WhatsApp to a number that `WA_PHONE_MAP` pins to a different persona; the delivery column reads `skipped (number is pinned to Daniel by WA_PHONE_MAP)`. (c) The same brief said "amid a fatal cargo-crash aftermath": `research.customerSafe()` now softens graphic news in customer copy (brief text, WhatsApp text and the app card's events) — a graphic note becomes a planning line ("allow extra time at the airport; operations are running below normal capacity"), a graphic title becomes a neutral one for its kind; the analyst's own brief on the ops page is untouched. 9 checks in `_brief-test.mjs`. **VM housekeeping (one-off, before the final):** new `DELETE /api/admin/users/:id` removes a runtime-registered account and its whole footprint (every table keyed by `user_id`, members row, CDP profile, `pax:app`/`pnr:app` graph nodes, live sessions); seeded personas 1–11 are refused. Find the id with `GET /api/admin/users` (admin session), then delete it, then Reset world.
14. **Acceptance confirmations on every channel, and the graph following a moved booking (8 Sep, from the VM screenshot "Done — you now fly into Fort Lauderdale… about 0h by road"):** replaying the VM sequence in the sandbox showed the DB *is* updated on a WhatsApp acceptance (flight_no, status `rebooked`, `meta.recovery`, My Trips band), but three things were missing. (a) **No email**: `deliver()` sent on one channel only, the offer's; now a confirmation goes on the customer's channel **and always email** (`recovery_confirmed`, which now carries the new legs, or the new `itinerary_changed` template for a brief alternative with flight, times, road transfer, the reason and the original kept on file). (b) **Duplicate WhatsApp**: an acceptance typed on WhatsApp got "Done, Daniel…" twice (the webhook reply plus `deliver()`); `acceptForUser`/`briefResponse`/`alternatives.take` now take `via` ("whatsapp" from the webhook, "app" from the card and the agent route) and the channel that carries the reply is skipped, recorded as `carried by the reply on the accepting channel`. (c) **Graph drift**: taking a T-72 alternative (switch airport / shift date) moved the booking in the DB but the PNR node still hung off XP201, so the T-48 offer went to a customer who was no longer on that flight. New `bridge.moveTrip()` re-points the PNR at a FlightInstance for the new flight and drops the old CARRIES edge. Also: "about 0h by road" → minutes from the `ALTERNATE_OF` edge (MIA↔FLL 45 min) or a 70 km/h estimate. Autonomy emails sent outside a request are tagged app `v2` so the Demo console lists them. Tests: bridge 30/30 (+3), briefs 58/58 (+5).
15. **Autonomy for every destination, and the demo URL serves v1 (8 Sep, "why Miami only?"):** two causes. (a) `AUTONOMY_LIVE_TRIPS` was off, so only the golden XP201 lived in the graph; other bookings were briefed at T-72 but never scored. (b) The recovery agent was hard-wired to the scenario (XP903/XP077, Orlando vendors), so switching live trips on would have offered Miami options for a London flight. Now: **generic recovery planner** in `agents.js` (`planReroute`: seeded recovery flights when they chain origin→hub→dest, else the airline's own inventory via `search.generateFlights`, hub with the least detour or next morning's direct; `planDivert`: nearest `ALTERNATE_OF` airport the storm does not touch, alternates derived within 350 km from `geo.SEED` (extended with ~90 alternates and display names) when the graph has none, hotel/taxi stubs created per airport inside the caps). Everything downstream is component-driven: `A.accept` (legs, divert code), `vendors.rehydrateHold`, `bridge.optionView`, `onAccepted` (divert city, `UPDATE flights SET dest=?`), `onOffer` (hazard named from the WeatherEvent, arrival vs departure), `intercept` (matches the cities in the option labels), `contextLine` (the customer's actual booking). **Live trips on by default** (`AUTONOMY_LIVE_TRIPS=0` to turn off): every upcoming real booking is a FlightInstance and is scored on every alert. **Rollout gate enforced**: `policy:autonomy_gate` carries `routes` (phase C: `["DEL-MIA"]`); `orchestrator.pipeline` still runs impact + recovery for every ACT, but outside the gate it queues a Tier-2 **RELEASE_OFFERS** package instead of contacting anyone; approving it (`POST /api/autonomy/tier2/:id/approve`) runs the Offer agent. `GET/POST /api/autonomy/gate {phase: "C"|"D", routes?}`; ops page has a **Gate** button beside the kill switch (Phase D = all routes). At T-48 the ops page now lists Daniel's other Miami trips as WATCH 0.51 (no window overlap) next to XP201 OFFERS_OUT: "considered, not acted on". Also fixed a latent crash in `sensing.ingestAlert` for any Airport node without coordinates (would have killed every live feed poll), and `syncTrips` falls back to seed coordinates when geocoding is unavailable. **v1 vs v2:** `/v10#app` (the demo URL) serves the **v1** app (`web/app.jsx` → `public/app.js`, `npm run build`); `/v10/v2` serves v2. The Clear-chat control and the "Handled only when settled" card fix are now in both, and typing "clear the chat" clears it in both. Tests: autonomy 70/70 (+11: London trip sensed, planned, gated, approved, accepted), briefs 59/59, bridge 30/30.
16. **T-72/T-48 pressed after a restart produced nothing for the app customers (8 Sep, VM screenshot: impacted 214, no brief, no offer):** with live trips on, the first feed poll after boot mirrors every real booking into the graph as `pnr:trip:*` nodes carrying `app_uid`; `isLinked()`/`linked()` counted those, so `ensureLinked()` believed the golden customers were linked and never linked them, and `sim.t72()` on a fresh boot reseeds the world after the check. Fix: `isLinked`/`linked` look at golden PNRs only (`pnr:app:<uid>`), the T-72 route links after the step, T-48 also calls `ensureLinked()`. Side benefit: T-72 briefs the 11 golden trips again (it had started briefing all 27 mirrored trips, which would have hit the research rate cap). Verified: T-72 straight after boot without Reset → 11 briefs, T-48 → 225 impacted, Daniel's inbox has brief + offer. Reset world is still the clean way to start a run.
17. **Sign in as any persona (10 Sep):** the v1 sign-in screen (`/v10`, no hash) existed but did nothing: the v1 client never sent a session id, so every request after "sign in as Sofia" was unbound and resolved to `SERVER_DEFAULT_UID` (Daniel). Now `web/app.jsx` keeps a per-tab session id in `sessionStorage` (`xp_sid`) and sends `x-session-id` on every call; sign-in posts `POST /api/auth/login {persona}` and stores the returned session; a **Traveller** picker prefills email (`<persona>@flyxperion.demo`) and password (`demo`); the header has **Switch traveller** (clears the session, returns to sign-in). Two tabs can be two travellers. The server default is unchanged, so WhatsApp pinning, the ops page and unbound MCP calls still mean Daniel. `/v10#app` skips the sign-in screen and uses whatever the tab is signed in as (Daniel when nothing). Bundle rebuilt (`npm run build`).

## 7. Test suites (run from repo root; most need a running server via `BASE`/`QA_BASE`)

| Suite | Command | Last result |
|---|---|---|
| Exhaustive QA | `QA_BASE=<url> node _qa.mjs` | 115/117 (2 pre-existing: sofia/lars voucher; re-verified 8 Sep on a fresh DB — run suites one at a time, running QA and retail together consumes Daniel's voucher and shows a false 3rd failure) |
| Bridge (autonomy → app) | `BASE=<url> node _bridge-test.mjs` | 30/30 (27 + one-confirmation, outbox email, My Trips band; 8 Sep) (fails by design if `AUTONOMY_LIVE_TRIPS=1` — multiple offers) |
| Briefs (in-process, mocked internet) | `node _brief-test.mjs` | 59/59 |
| Autonomy (in-process) | `node _autonomy-test.mjs` | 70/70 (59 + any-route London scenario; wipes and reseeds the graph, run it alone) |
| Baileys transport (mock socket) | `node _baileys-test.mjs` | 26/26 (4 opt-in checks added) |
| Destination intelligence (mocked feeds/analyst) | `node _brief-test.mjs` | 44/44 |
| MCP (real client + stdio bridge + self-service) | `BASE=<url> node _mcp-test.mjs` | 31/31 (5 PNR-targeting checks added 8 Sep) |
| Network validation | `node _network-validate.mjs` | 26/26 |
| Retail | `BASE=<url> node _retail-test.mjs` | 29 passed, 0 failed (the TTL section only runs with `TEST_TTL_MS` + `RETAIL_OFFER_TTL_MS`; earlier "30/30" counted it) |
| Self-test (in app) | Demo Console → Re-run | 17/18 (seat-pref advisory) |

## 8. Demo scripts

**Golden disruption timeline (replayable):** Tab A app as Daniel (Xperion AI open) + Tab B `/autonomy/` + phone. **Reset world** (214 pax + 11 real customers linked, PNR XPW01A) → **T-72h** (WATCH p≈0.43, no contact; Daniel gets the Miami destination brief) → **T-48h** (ACT p≈0.71, ~219 offers, red bar + card in app, numbered options on WhatsApp) → accept (tap option 2 / "I'll take the Orlando option" / reply `2`) → saga ms, My Trips recovery band, audit SAGA_COMPLETE → **T-0** (Tier-2 queue). Variants: kill switch before T-48; "no thanks". T-48 requires T-72 first (else "No active scenario").

**Live:** feeds poll every 30 min; briefs at T-72 for real trips; **Brief a trip by PNR…** (e.g. XPX43K Delhi) for a researched brief with alternatives; assistant/WhatsApp: "what's happening in Delhi next week?", "flights to Denmark first week of October", "cheapest flights to Delhi in the upcoming week".

**MCP:** ops page → mint token (or customer → Connect your AI) → Claude Desktop config → "What are my upcoming trips?" → "Is my Delhi trip at risk?". `/mcp/info` shows the surface.

**RT-CDP:** Demo Console → event stream; Monitoring → Streaming end-to-end; Profiles → Daniel → Events (Xperion `journey.step` events appear minutes after actions).

## 9. CURRENT STATE OF THE VM & OPEN ISSUES

- **App:** running under pm2 as `xperion-v10`. After this drop the VM should be on the PNR-targeting commit (8 Sep); before it: `b6d5f4b` docs on top of `1f35d1b` (opt-in guard + new burner). `git log -1 --oneline` on the VM is the source of truth, not this line. Health: AI live, CDP live tenant with **streaming on**, SMTP configured, MCP 33 tools. `/api/me/mcp` verified JSON.
- **WhatsApp: PAIRED as +91 85959 60365** (8 Sep ~00:15 IST, pairing code `Link with phone number instead`, one clean attempt after one timed-out attempt; a 515 reconnect right after pairing is normal). Health reports `baileys — connected as +918595960365`; pm2 log clean of 440s. Burner is a second WhatsApp account on an additional eSIM in the owner's handset. `.env`: `WA_MODE=baileys`, `WA_PAIRING_PHONE=918595960365`, `WA_PHONE_MAP=919871724927:daniel`, `WA_SELF_CHAT=0`. **Never delete `data\baileys-auth` again** and never run a bare `node server\server.js` while pm2 is up — either one costs the pairing.
  History: the old burner +91 96258 33782 was RESTRICTED by WhatsApp for "spam, automated or bulk messaging" on 7 Sep 22:12 IST. Root cause was the transport messaging the 10 other personas' fictional numbers at T-48, not the number itself. FIXED by the opt-in rule now deployed (only numbers that messaged the bot, pinned, allow-listed, or the bot itself; everyone else `skipped (no WhatsApp opt-in…)` and still gets app inbox + email). That fix sat un-unpacked on the Mac until 8 Sep ~00:00 IST; it is on `main` and on the VM now. The old number stays burnt.
  **Still to verify:** (1) warm-up — one message from the personal account to the burner should come back as the `Xperion AI · Daniel` numbered menu; this also teaches the transport the JID the personal account really uses. (2) Golden timeline through T-48: Daniel's offer lands in the personal chat, the other ten personas log `skipped`. Do both before relying on WhatsApp in the final.
- **Process picture RESOLVED (8 Sep):** the "transient pid 8764" was never pm2 — it was `scripts\serve.js`, the `AABackend` NSSM service on 7810, which NSSM restarts on every kill. A second stray, a hand-launched `node server\server.js` from 7 Sep ~22:10 IST, was also still running and was killed. pm2 was then killed and restarted from zero and `pm2 save`d. Current: daemon + `xperion-v10` app + `AABackend` = three node processes, which is correct here. Use the command-line check in §3, not a count.
- **`AUTONOMY_LIVE_TRIPS` is ON by default since 8 Sep** (set `=0` to turn off). Safe because the rollout gate (phase C, DEL-MIA) turns any other route at ACT into a Tier-2 package instead of a message. Flip the Gate button to Phase D on the ops page if you want to show an offer on another route live.
- **Claude.ai custom connectors need https** — VM is plain http. Options: Cloudflare Tunnel, or Azure DNS label + Caddy/Let's Encrypt. Set `PUBLIC_URL` afterwards.
- **Duplicate AEP objects possible:** the first "Enable real-time streaming" click may have left a second unused base connection named "Xperion Airways · server-side events" in AEP Sources; harmless.
- **Data oddities:** booking `XPG8Y1` lacks route metadata (shows only "Madrid"); seed changes (Lars/Luís) apply only on a fresh DB. Daniel has two trips on 9 Sep (Delhi + Mumbai) from testing.
- **Research budget:** on-demand, 15/day cap; ops page shows calls today and est. cost.
- **MCP token used from this chat** (`xp_09e2…c8b`) should be revoked and re-minted.

## 10. Security housekeeping (do these)

- Rotate the **Adobe client secret** (exposed in an early chat) — Developer Console → project → credentials → retrieve/rotate; update `.env`.
- Rotate the **Gmail app password** (shown in a screenshot) — myaccount.google.com/apppasswords → delete "Xperion VM" → create new → `.env`.
- Revoke the **Daniel MCP token** shown in chat (ops page table / `DELETE /api/admin/mcp/token/<token>`), mint fresh; update Claude Desktop config.
- `WhatsAppSetUp.txt` (contains phone numbers) lives outside the repo at `~/WhatsAppSetUp.txt`. Keep it out.
- Repo should be private.

## 11. Pending / next ideas (not started)

- https for the VM (tunnel or TLS) → enables Claude.ai connectors; then `PUBLIC_URL`.
- Phase 2 destination feeds: GDELT (civil/political), government advisories, Ticketmaster, Nager holidays already in; `DestinationEvent` kind declared for them; scorecard weights.
- PredictHQ (paid) if budget.
- Guest self-service MCP token ("connect as a new customer").
- Backfill `XPG8Y1` meta; tidy Daniel's duplicate test bookings.
- Shrink the WhatsApp keyword router further (numbers + menu words only; assistant handles sentences) if more hijacks appear.
- Real-time audiences in AEP built on the streamed events (tile "Real-time audiences" currently 0).
- Experience deck (`Modern-Retailing-for-Airlines-Experience.pptx`, 22 slides, British spelling, no vendor names, no em dashes, petrol/sage/plum palette) exists from before this session; update if the story changed (MCP, destination intelligence).

## 12. Conventions and user preferences

- **Mac shell is zsh:** never put `#` comments inside command blocks; use `.[^.]*` for dotfiles.
- **Windows PowerShell 5:** use `;` not `&&`; `Select-String` instead of grep; `Add-Content`, `notepad .env`.
- **Always end a change with an explicit deploy block** (Mac sequence + VM sequence) and say whether `npm install` / db reset / re-pair is needed.
- Text/terminal **attachments arrive empty**; screenshots and pasted text work.
- The user pastes commands into the wrong place sometimes (a shell command went into the JSON config once) — say "in Terminal.app" explicitly.
- Tone: concise, concrete, honest about what is and isn't real; cite test counts; no em dashes in deck content (chat is fine).
- Drops are cumulative zips; the user unpacks with the ritual in §3. Finder screenshots show folder timestamps — check `server/` file timestamps to see whether a drop was actually unpacked.
- British spelling and no vendor product names in the **deck** only; the app uses en-US.

## 13. API quick reference

- Health: `GET /api/health` (airline, network, ai, cdp, smtp, whatsapp fields)
- Assistant: `POST /api/ai/agent {messages, screen, sessionId}` → `{reply, cards, ai:"live"|"offline"}`; tools `POST /api/ai/tool` `{name, input, sessionId}`. Booking-scoped tools (`get_booking`, `check_in`, `split_booking`, `resolve_disruption`, `upgrade_cabin`, `get_disruption`, `rebook_flight`, `cancel_booking`) accept an optional `pnr`; unknown/foreign PNR → `state:"pnr_not_found"`, never a fallback. `POST /api/ai/session/clear {sessionId}` → `{ok, cleared}` forgets an agent session (own customer only)
- Persona/session: `POST /api/persona {persona, sessionId}` → send `x-session-id` afterwards (v1 app mostly relies on server default uid)
- Autonomy: `POST /api/autonomy/sim/{reset|t72|t48|accept|t0|golden}`, `GET /api/autonomy/status`, `/predictions`, `/audit`, kill switch, `GET /api/autonomy/briefs`, `GET /api/autonomy/brief/:code?from&to&force=1`, `POST /api/autonomy/briefs/next {uid|pnr, force}` + `GET /briefs/job/:id`, `POST /api/autonomy/briefs/run`, `GET /briefs/due`, `POST /api/autonomy/feeds/poll`, `POST /api/autonomy/trips/sync`, `GET /api/autonomy/risk/:pnr`, `POST /api/autonomy/risk/assess {pnr}`, customer: `GET /api/autonomy/customer/{status|inbox}`, `POST /customer/{accept|decline|link}`, `POST /customer/brief/:choice` (keep|alternatives|talk|alt:…)
- WhatsApp: `POST /api/whatsapp/webhook` (Twilio path; used by tests), self-test line
- CDP: `GET /api/admin/cdp/test`, `GET /api/admin/cdp/events`, `POST /api/admin/cdp/events/flush`, `POST /api/admin/cdp/event/test`, `GET /api/admin/cdp/streaming`, `POST /api/admin/cdp/streaming/provision`, `POST /api/admin/cdp/streaming/forget`, `POST /api/admin/cdp/ingest/personas`
- MCP: `GET /mcp/info`, `POST /mcp` (Bearer), `GET /mcp/bridge.mjs`, admin `GET /api/admin/mcp/tokens`, `POST /api/admin/mcp/token {persona}`, `DELETE /api/admin/mcp/token/:token`; self-service `GET /api/me/mcp`, `POST|DELETE /api/me/mcp/:client` (claude|gemini|copilot)
- Demo Console data: `GET /api/admin/db`, `GET /api/admin/selftest`

---
*End of transition document.*

- `POST /api/autonomy/customer/accept {optionId, offerId?}` → on success `{ok, reply, card, inboxId, refs}`; on a failed or refused saga `{ok:false, failed|refused, compensated, reply, inboxId}` where `reply` is the customer-facing explanation and the offer **stays pending**. Inbox kinds: `disruption_offer`, `disruption_confirmed`, `disruption_declined`, `disruption_failed` (new), `destination_brief`.
- `GET /api/admin/users` (admin) lists every account; `DELETE /api/admin/users/:id` (admin) removes a runtime-registered one (ids ≥ 12) with its footprint; personas 1–11 return 403.
- Acceptance/brief choices carry `via`: `acceptForUser(uid, optionId, offerId, {via})`, `briefResponse(uid, choice, via)`, `intercept(uid, text, via)`, `alternatives.take(uid, altId, {via})`. Delivery: `deliver({channel, also:["email"], skip:[via]})`; notification status `carried by the reply on the accepting channel` means the reply itself was the message. Email templates: `recovery_confirmed` (legs), `itinerary_changed` (brief alternative). `bridge.moveTrip(booking, {flight_no, date, origin, dest, dep, arr})` keeps the graph on the booking.
- `GET /api/autonomy/gate` · `POST /api/autonomy/gate {phase, routes?}` (rollout gate; `/status` also returns `gate` and `live_trips`). Tier-2 `RELEASE_OFFERS` items appear for ACT predictions outside the gate; approval sends the offers.
- The demo URL `/v10#app` is the **v1** bundle (`npm run build` → `public/app.js`); `/v10/v2` is v2 (`npm run build:v2`). Assistant changes must be made in both `web/app.jsx` and `web/v2/ai.jsx`; `npm run build:all` builds both.
