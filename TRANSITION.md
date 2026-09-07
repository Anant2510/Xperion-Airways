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
| VM process | pm2 app **`xperion-v10`**, `pm2 start server\server.js --name xperion-v10 --cwd "<dir>"`, `pm2 save` |
| VM DB | `data\xperion-v10.db` (SQLite). Old copies: `data.old-vm/`, `data.old-vm2/` (untracked) |
| Sandbox in this chat | `/home/claude/work/Tap-demo` (the build tree; drops are zipped from it as `mar-reference-build-v10.zip`) |
| Node | 22 on both. Deps: express 5, better-sqlite3/node:sqlite, baileys 7.0.0-rc14, qrcode-terminal, @modelcontextprotocol/sdk ^1.30, zod ^4 |
| WhatsApp burner (bot) | **+91 85959 60365** (Baileys pairs as this). Replaced +91 96258 33782, which WhatsApp restricted for bulk messaging — see §9 |
| Owner's personal WhatsApp | +91 98717 24927 (primary account on the handset; the burner runs beside it as a second WhatsApp account on an additional eSIM). This is the pinned demo recipient — `WA_PHONE_MAP=919871724927:daniel` |
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

**Process hygiene (this bit tonight for hours):**
- Healthy = exactly **two** node processes (pm2 daemon + app). Check: `Get-Process node | Select Id, StartTime`; listener: `netstat -ano | findstr LISTENING | findstr :7811` must equal `pm2 pid xperion-v10`.
- A foreground `node server\server.js` left running in a window silently steals port 7811 (pm2's app then crash-loops, `restarts` climbs) **and** fights for the WhatsApp session (440 conflicts → eventually WhatsApp logs the device out).
- `Get-Process node | Stop-Process -Force` also kills the pm2 daemon; afterwards `pm2 restart` says "not found" → use `pm2 kill` then `pm2 start … --name xperion-v10 --cwd …` and `pm2 save`.
- Stop the app with `pm2 stop`, never by closing a window.

## 4. Environment variables (VM `.env`, complete)

Server/DB: `PORT=7811`, `DB_PATH` (default `data/xperion-v10.db`), `SERVER_DEFAULT_UID=1` (demo model: requests without a session act as Daniel), `PUBLIC_URL` (unset; set when https exists — MCP snippets use it).

AI: `ANTHROPIC_API_KEY=<set>`, `CLAUDE_MODEL=claude-sonnet-5`.

Adobe: `ADOBE_CDP_ENABLED=1`, `ADOBE_IMS_ORG`, `ADOBE_CLIENT_ID`, `ADOBE_CLIENT_SECRET` (**exposed in chat earlier — rotate**), `ADOBE_SANDBOX=coforge3`, `ADOBE_SCOPES=openid,AdobeID,read_organizations,additional_info.projectedProductContext,session`, `ADOBE_TENANT_NS=_aeppsemea`, `ADOBE_LOYALTY_NS=Email`, `ADOBE_PROFILE_SCHEMA_ID`, `ADOBE_EVENT_SCHEMA_ID`, `ADOBE_PROFILE_DATASET_ID`, `ADOBE_EVENT_DATASET_ID`, `AEP_AUDIENCE_PREFIX=TAP –`, `CDP_AGENT_ENABLED=0`. Optional: `ADOBE_STREAMING_URL` + `ADOBE_EVENT_FLOW_ID` (env override for the provisioned inlet), `ADOBE_EVENT_SYNC_VALIDATION=1` (inline schema validation on the inlet), `CDP_EVENT_BATCH_MS` (15 min; only used when no inlet), `CDP_EVENT_BATCH=0`.

Email: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=anant.direct2links@gmail.com`, `SMTP_PASS=<16-char app password, no spaces>` (**exposed — rotate**), `EMAIL_FROM="Xperion Airways <anant.direct2links@gmail.com>"`, `DEMO_EMAIL_TO=anant.direct2links@gmail.com`.

WhatsApp: `WA_MODE=baileys` (**currently `off` on the VM** — see §9) | `off`/anything else = Twilio webhook path (`TWILIO_*` vars, unused). `WA_PHONE_MAP=918595960365:daniel` (currently pins the **burner itself** to Daniel → the bot messages its own "Message yourself" chat; earlier it was `919871724927:daniel`). `WA_PAIRING_PHONE=918595960365` (pair with an 8-char code instead of QR), `WA_QR_LARGE=1` (full-size QR), `WA_GUESTS=1` (unknown senders → guests; default on with Baileys), `WA_SELF_CHAT=0` disables self-chat test mode. Pairing credentials live in `data\baileys-auth\` (gitignored).

Destination intelligence / cost: `FEEDS_ENABLED=1` (default on), `FEEDS_INTERVAL_MS=1800000`, `FEEDS_IDLE_INTERVAL_MS=10800000`, `BRIEFS_ENABLED=1`, `BRIEFS_INTERVAL_MS`, `BRIEF_T_MIN_H=60`, `BRIEF_T_MAX_H=84`, `RESEARCH_ENABLED=1`, **`RESEARCH_MODE=on-demand`** (default; `always` lets the unattended scheduler use the analyst), `RESEARCH_ACTIVE_MIN=30`, **`RESEARCH_DAILY_MAX=15`**, `RESEARCH_MAX_PER_HOUR=20`, `RESEARCH_MAX_SEARCHES=7`, `RESEARCH_TTL_MS=43200000`, `RESEARCH_MODEL`, `RESEARCH_COST_PER_CALL=0.04`, **`AUTONOMY_LIVE_TRIPS=1`** (off by default: mirrors real bookings into the graph so live weather can score/act on them), `AUTONOMY_TRIP_HORIZON_DAYS=10`.

`.env.example` documents all of these.

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

## 7. Test suites (run from repo root; most need a running server via `BASE`/`QA_BASE`)

| Suite | Command | Last result |
|---|---|---|
| Exhaustive QA | `QA_BASE=<url> node _qa.mjs` | 115/117 (2 pre-existing: sofia/lars voucher) |
| Bridge (autonomy → app) | `BASE=<url> node _bridge-test.mjs` | 27/27 (fails by design if `AUTONOMY_LIVE_TRIPS=1` — multiple offers) |
| Autonomy (in-process) | `node _autonomy-test.mjs` | 51/51 |
| Baileys transport (mock socket) | `node _baileys-test.mjs` | 26/26 (4 opt-in checks added) |
| Destination intelligence (mocked feeds/analyst) | `node _brief-test.mjs` | 44/44 |
| MCP (real client + stdio bridge + self-service) | `BASE=<url> node _mcp-test.mjs` | 26/26 |
| Network validation | `node _network-validate.mjs` | 26/26 |
| Retail | `node _retail-test.mjs` | 30/30 |
| Self-test (in app) | Demo Console → Re-run | 17/18 (seat-pref advisory) |

## 8. Demo scripts

**Golden disruption timeline (replayable):** Tab A app as Daniel (Xperion AI open) + Tab B `/autonomy/` + phone. **Reset world** (214 pax + 11 real customers linked, PNR XPW01A) → **T-72h** (WATCH p≈0.43, no contact; Daniel gets the Miami destination brief) → **T-48h** (ACT p≈0.71, ~219 offers, red bar + card in app, numbered options on WhatsApp) → accept (tap option 2 / "I'll take the Orlando option" / reply `2`) → saga ms, My Trips recovery band, audit SAGA_COMPLETE → **T-0** (Tier-2 queue). Variants: kill switch before T-48; "no thanks". T-48 requires T-72 first (else "No active scenario").

**Live:** feeds poll every 30 min; briefs at T-72 for real trips; **Brief a trip by PNR…** (e.g. XPX43K Delhi) for a researched brief with alternatives; assistant/WhatsApp: "what's happening in Delhi next week?", "flights to Denmark first week of October", "cheapest flights to Delhi in the upcoming week".

**MCP:** ops page → mint token (or customer → Connect your AI) → Claude Desktop config → "What are my upcoming trips?" → "Is my Delhi trip at risk?". `/mcp/info` shows the surface.

**RT-CDP:** Demo Console → event stream; Monitoring → Streaming end-to-end; Profiles → Daniel → Events (Xperion `journey.step` events appear minutes after actions).

## 9. CURRENT STATE OF THE VM & OPEN ISSUES

- **App:** running under pm2 as `xperion-v10`, commit `5f83073` (all drops through "Connect your AI" + latest WhatsApp transport). Health: AI live, CDP live tenant with **streaming on**, SMTP configured, MCP 33 tools. `/api/me/mcp` verified JSON.
- **WhatsApp: NOT paired. Burner replaced with +91 85959 60365**, running as a second WhatsApp account (additional eSIM) on the owner's existing handset, beside the personal account +91 98717 24927. The old burner +91 96258 33782 was RESTRICTED by WhatsApp for "spam, automated or bulk messaging"; it stays burnt and is not worth reusing. Root cause was **not** the number: at T-48 the transport messaged the 10 other personas' fictional phone numbers, i.e. unsolicited sends to strangers. FIXED in the transport before this drop: opt-in rule — the bot only messages numbers that have messaged it, are pinned (`WA_PHONE_MAP`), are allow-listed (`WA_ALLOWED_NUMBERS`), or are itself; everyone else gets `skipped (no WhatsApp opt-in…)` and still receives app inbox + email. **The new eSIM must only ever be paired on a build that contains this guard**, or it gets restricted the same way on the first golden-timeline run. Never set `WA_ALLOW_ALL=1` on a number that matters. `.env` still has `WA_MODE=off` (parked); the earlier link-throttling applied to the old number and does not carry across, so the first attempt can be made as soon as the eSIM is registered on WhatsApp.
  **Demo rig:** two accounts, one handset. Baileys links to the burner; the bot messages the **personal** number, so Daniel's offers arrive as an ordinary incoming chat and replies go back as ordinary outgoing ones — far better on a projector than the old self-chat setup. Pin `WA_PHONE_MAP=919871724927:daniel` and set `WA_SELF_CHAT=0` (otherwise anything typed in the burner's own "Message yourself" chat spawns a stray guest user). The self-chat fallback (`WA_PHONE_MAP=918595960365:daniel`, `WA_SELF_CHAT` unset) still works if the second account is unavailable. Set one mapping or the other, never both.
  **Plan — ONE clean attempt:** register the eSIM number on WhatsApp on the handset (OTP must land on that eSIM) → `pm2 stop xperion-v10` → in `.env` set `WA_MODE=baileys`, `WA_PAIRING_PHONE=918595960365`, `WA_PHONE_MAP=919871724927:daniel`, `WA_SELF_CHAT=0` → `Remove-Item -Recurse -Force data\baileys-auth` (mandatory: the stored creds are bound to the old number) → `node server\server.js` in ONE window → enter the printed code on the **burner account** within 30 s (Linked Devices → Link a Device → Link with phone number instead) → on `✓ WhatsApp connected via Baileys as +918595960365` Ctrl-C → `pm2 restart xperion-v10 --update-env` → confirm exactly two node processes. Then never touch `baileys-auth` again.
  **Warm the thread before the first demo:** from the personal account, send one message to the burner. The bot's first outbound is then a reply inside an existing two-way conversation rather than a cold send from a days-old number, which is the pattern WhatsApp's anti-spam scores hardest.
- **Process count** was cleaned to pm2 daemon + app (a third transient pid `8764` appeared after `pm2 save`; verify it's gone).
- **`AUTONOMY_LIVE_TRIPS` is OFF** (deliberate; turn on after demos — live alerts then send real offers on real trips, and the golden timeline produces one offer per impacted booking).
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
- Assistant: `POST /api/ai/agent {messages, screen, sessionId}` → `{reply, cards, ai:"live"|"offline"}`; tools `POST /api/ai/tool`
- Persona/session: `POST /api/persona {persona, sessionId}` → send `x-session-id` afterwards (v1 app mostly relies on server default uid)
- Autonomy: `POST /api/autonomy/sim/{reset|t72|t48|accept|t0|golden}`, `GET /api/autonomy/status`, `/predictions`, `/audit`, kill switch, `GET /api/autonomy/briefs`, `GET /api/autonomy/brief/:code?from&to&force=1`, `POST /api/autonomy/briefs/next {uid|pnr, force}` + `GET /briefs/job/:id`, `POST /api/autonomy/briefs/run`, `GET /briefs/due`, `POST /api/autonomy/feeds/poll`, `POST /api/autonomy/trips/sync`, `GET /api/autonomy/risk/:pnr`, `POST /api/autonomy/risk/assess {pnr}`, customer: `GET /api/autonomy/customer/{status|inbox}`, `POST /customer/{accept|decline|link}`, `POST /customer/brief/:choice` (keep|alternatives|talk|alt:…)
- WhatsApp: `POST /api/whatsapp/webhook` (Twilio path; used by tests), self-test line
- CDP: `GET /api/admin/cdp/test`, `GET /api/admin/cdp/events`, `POST /api/admin/cdp/events/flush`, `POST /api/admin/cdp/event/test`, `GET /api/admin/cdp/streaming`, `POST /api/admin/cdp/streaming/provision`, `POST /api/admin/cdp/streaming/forget`, `POST /api/admin/cdp/ingest/personas`
- MCP: `GET /mcp/info`, `POST /mcp` (Bearer), `GET /mcp/bridge.mjs`, admin `GET /api/admin/mcp/tokens`, `POST /api/admin/mcp/token {persona}`, `DELETE /api/admin/mcp/token/:token`; self-service `GET /api/me/mcp`, `POST|DELETE /api/me/mcp/:client` (claude|gemini|copilot)
- Demo Console data: `GET /api/admin/db`, `GET /api/admin/selftest`

---
*End of transition document.*
