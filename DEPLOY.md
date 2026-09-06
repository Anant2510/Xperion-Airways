# DEPLOY — Xperion Airways · MAR reference build v10

A standalone deployment: its own git repository, its own folder, its own port,
its own database file. It shares nothing at runtime with any earlier build.

---

## 0 · Isolation checklist

| Concern | How it is isolated | Set by |
|---|---|---|
| Code | fresh git repo, fresh folder | you |
| Port | `PORT` in `.env` | `.env` |
| Database | `DB_PATH` in `.env` — its own `.db` file | `.env` |
| Process | its own node process / service name | you |
| Sub-path (optional) | `BASE_PATH` | `.env` |

The database is a single file. Two instances are safely separate as long as
`DB_PATH` differs. **Never point two running instances at one file** — SQLite
is single-writer and the second process will hit lock errors under load.

---

## 1 · Mac: new folder, new repository

```bash
# 1. unpack the drop somewhere NEW — not beside the older working copy
mkdir -p ~/projects/xperion-autonomy
cd ~/projects/xperion-autonomy
unzip ~/Downloads/mar-reference-build-v10.zip
mv Tap-demo/* Tap-demo/.[!.]* .        # flatten; the inner folder name is historical
rmdir Tap-demo

# 2. requires Node 22.5+ (the build uses the built-in node:sqlite module)
node -v                                 # must be >= v22.5.0
# nvm users:  nvm install 22 && nvm use 22

# 3. install, configure, build
npm install
cp .env.example .env                    # then edit PORT and DB_PATH
npm run build:all && npm run build:v3

# 4. run
npm start
```

Open `http://localhost:7810/` for the airline app and
`http://localhost:7810/autonomy/` for the autonomy ops console.

```bash
# 5. fresh git repository
git init
git add -A
git commit -m "Xperion Airways MAR reference build v10 — retailing + experience + disruption autonomy"
git branch -M main
git remote add origin git@github.com:<org>/<new-repo>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `data/` and `.env`. Confirm
before the first push that `git status` shows no `.env` and no `.db` file.

---

## 2 · Windows VM: new port

```powershell
cd C:\apps
# unpack the same zip into C:\apps\xperion-autonomy  (NOT the existing app folder)

cd C:\apps\xperion-autonomy
node -v                                  # >= v22.5.0
npm install
copy .env.example .env
notepad .env                             # PORT=7810, DB_PATH=./data/xperion-v10.db
npm run build:all
npm run build:v3
npm start
```

Open the port once:

```powershell
New-NetFirewallRule -DisplayName "Xperion v10" -Direction Inbound `
  -LocalPort 7810 -Protocol TCP -Action Allow
```

If the VM is on Azure or similar, also add an inbound rule for 7810 in the
network security group. Confirm nothing else holds the port:

```powershell
netstat -ano | findstr :7810
```

### Run it as a service (survives logoff and reboot)

```powershell
npm i -g pm2 pm2-windows-startup
pm2-startup install
cd C:\apps\xperion-autonomy
pm2 start server/server.js --name xperion-v10
pm2 save
pm2 logs xperion-v10
```

pm2 inherits the `.env` because the app loads it itself via dotenv.

---

## 3 · Verify the deployment

```bash
curl http://<host>:7810/api/health
# {"ok":true,"version":"v10","db":".../xperion-v10.db", ...}

curl http://<host>:7810/api/autonomy/status          # KPIs + graph stats
curl -X POST http://<host>:7810/api/autonomy/sim/golden   # full DEL->MIA timeline
```

Boot banner should read:

```
✈  MAR reference build v10 running
   DB:      ...\data\xperion-v10.db
   Autonomy: ontology + knowledge graph mounted at /api/autonomy (ops page /autonomy/)
   Airlines: 2 tenant(s) registered — xperion 27/27, nordvind 18/27 (partial)
```

Test suites (run against a started server):

```bash
node _retail-test.mjs        # 30 checks — retailing core (HTTP; needs the server running)
node _autonomy-test.mjs      # 51 checks — disruption autonomy (in-process)
```

Both read `.env`, so they use the same `PORT` and `DB_PATH` as the server. The
retail suite drives the server over HTTP, so start it first; the autonomy
suite runs in-process and needs no server. To point the retail suite somewhere
else: `BASE=http://127.0.0.1:7810 node _retail-test.mjs`.

Two of the retail checks exercise offer expiry, which is slow at production
TTL. To run those, start the server with a short TTL and tell the suite:

```bash
RETAIL_OFFER_TTL_MS=4000 npm start          # in one terminal
TEST_TTL_MS=4000 node _retail-test.mjs      # in another
```

---

## 4 · First-run behaviour

`data/` is gitignored, so on a new machine the database does not exist and the
app **seeds itself on first boot**: personas, route network, demo bookings,
and the autonomy graph on first simulation. To reset any environment to a
clean state, stop the process, delete the `.db` file, and start again.

---

## 5 · Sub-path hosting (optional)

To serve behind an existing site at `https://host/xperion-v10/`:

```
BASE_PATH=/xperion-v10
```

The server strips the prefix internally and serves static assets at both the
prefix and root, so no other change is needed. Point your reverse proxy at
`http://127.0.0.1:7810`.

---

## 6 · Enabling autonomy safely

The build ships at rollout gate Phase C (`policy:autonomy_gate` in the graph).
For a first deployment, start in shadow mode:

```bash
curl -X POST http://<host>:7810/api/autonomy/kill \
  -H "content-type: application/json" -d '{"global":true}'
```

Tier 0/1 actions freeze; prediction, ranking and package preparation continue,
and the Tier-2 queue still works. Lift it when you are ready:

```bash
curl -X POST http://<host>:7810/api/autonomy/kill \
  -H "content-type: application/json" -d '{"global":false}'
```

See `server/autonomy/RUNBOOK.md` for the operator procedures and
`server/autonomy/ASSUMPTIONS.md` for the open Phase-0 questions.

## Live disruption demo (autonomy ↔ app bridge)

After deploying, open `/autonomy/` and press **Reset world** once: the app's
real customers are linked into the knowledge graph with live bookings on XP201.
Then sign in to `/v2` as Daniel and follow the presenter script in
`server/autonomy/RUNBOOK.md` ("Live-app demo"). Verify with:

    BASE=http://127.0.0.1:<port> node _bridge-test.mjs      → 27/27

No database reset is needed: the bridge creates its `ai_inbox` table on first
load and writes bookings through the normal tables. Real WhatsApp delivery needs
the `TWILIO_*` keys; without them the message is logged with an honest status.

## Carrier base and network (what the code asserts)

Xperion Airways is declared in code as a US carrier: `country: "US"`, home
Miami, hubs Miami + New York JFK, USD, en-US (tenant config in
`server/server.js`; platform defaults in `server/airline.js`). The route
network in `server/routes-data.js` is generated from the OurAirports
public-domain dataset: 1,572 airports in 233 countries and territories (190
sovereign states), 503 US airports, 1,069 international cities, every city
connected non-stop to both hubs, plus a 16-city US point-to-point mesh.
`GET /api/health` reports these facts. Re-prove any environment with:

    node _network-validate.mjs                                  (static)
    BASE=http://127.0.0.1:<port> node _network-validate.mjs     (static + live)

## Adobe Real-Time CDP — connect the live tenant

The build talks to the same AEP tenant TAP V2 did; every AEP-facing identifier
(IMS org, sandbox, identity namespace symbol, tenant namespace, schema/dataset
ids, streaming inlet, audience id→name map) comes from the environment, so the
TAP V2 `.env` values carry over unchanged. Copy this block from the old `.env`:

    PROFILE_SOURCE=adobe
    ADOBE_CDP_ENABLED=1
    ADOBE_IMS_ORG=            ADOBE_CLIENT_ID=            ADOBE_CLIENT_SECRET=
    ADOBE_SANDBOX=            ADOBE_SCOPES=               ADOBE_IMS_URL=
    ADOBE_IDENTITY_NS=        ADOBE_LOOKUP_ATTR=          ADOBE_LOYALTY_NS=
    ADOBE_TENANT_NS=          ADOBE_PROFILE_SCHEMA_ID=    ADOBE_PROFILE_DATASET_ID=
    ADOBE_EVENT_SCHEMA_ID=    ADOBE_EVENT_DATASET_ID=     ADOBE_EVENT_FLOW_ID=
    ADOBE_STREAMING_URL=      ADOBE_AUDIENCE_NAMES=       ADOBE_LOCAL_SEGMENTS_FIELD=
    AEP_AUDIENCE_PREFIX=TAP –     (keeps the audiences the tenant already has)
    CDP_AGENT_ENABLED=0           (1 only if the self-extending audience sync is wanted)

Then `pm2 restart xperion-v10 --update-env` (Windows) or restart `npm start`
(Mac) and verify, in order:

1. `GET /api/health` → `"cdp": "configured — live tenant (…)"`
2. `GET /api/admin/cdp/test` → `"Connected — a live profile was returned"`;
   otherwise the message names the exact reason (token, namespace, scopes).
3. `POST /api/admin/cdp/event/test` → streams one test event to the inlet.
4. `POST /api/admin/cdp/ingest` → re-pushes the personas into the profile
   dataset so the tenant's profiles carry the Xperion (US) attributes. Persona
   loyalty ids and emails are unchanged, so the same profiles are updated.
