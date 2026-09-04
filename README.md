# Xperion Airways — "Daniel, the Digital Commuter" Full-Stack Demo

A genuine, working demo of the reimagined pre-travel journey: **React frontend + Express backend + SQLite customer database + real email delivery + Claude AI** — all personalization is fetched live from the database, and every action (basket, fare lock, hold, payment, disruption, rebooking, offers) writes back to it.

A built-in **Demo Console** shows the live database tables and the email outbox on screen, so the customer can see exactly where the data comes from and what gets sent.

---

## 1. Requirements

- **Node.js ≥ 22** (the demo uses Node's built-in SQLite — no native builds, no external DB to install). Check with `node --version`.
- That's it. SMTP credentials and an Anthropic API key are **optional** (see below).

## 2. Run it

```bash
cd tap-demo
npm install          # installs express, nodemailer, cors, dotenv (+ esbuild for rebuilds)
cp .env.example .env # then edit .env (optional — runs fine empty)
npm start            # → http://localhost:7801  (PORT comes from .env)
```

The port is whatever `PORT` is set to in `.env` (the example ships with **7801** to match the open port on your Azure VM). Change it freely — nothing else depends on it.

On first start it creates and seeds `data/tap.db` with Daniel's full customer record: profile, Gold tier, 48,230 miles, €35 voucher, saved Visa, seat/meal preferences, **15 past flights** (the "9 of his last 12 Mondays on XP1927" pattern is computed live from this table), a synced search from his MacBook, flights, ancillaries and destination recommendations.

To start fresh for each customer session: click **Reset demo** in the Demo Console (or delete `data/` and restart).

## 3. Configuration (.env)

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on **live Claude**: AI itinerary planner, disruption recovery messages, personalized offer emails, concierge chat. Without it, realistic cached responses are used — the demo never stalls. |
| `SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS` | Turns on **real email delivery** via any SMTP provider. |
| `DEMO_EMAIL_TO` | Overrides the recipient — **point this at your own inbox** so you can open Daniel's emails live on screen during the demo. |
| `EMAIL_FROM` | The From header on outgoing mail. |
| `PORT` | Default 3000. |

**Gmail SMTP example** (easiest for a demo): `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<App Password>` (Google Account → Security → 2-Step Verification → App passwords). Office 365: `smtp.office365.com:587`.

Whether or not SMTP is configured, **every email is also stored in the database** and viewable (with full HTML preview) in the Demo Console's Email center — so the email story works even offline.

## 4. Deploy on your Azure VM

```bash
# on the VM (Ubuntu example)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
# copy the project up (scp/rsync the zip), then:
unzip mar-reference-build.zip && cd tap-demo
npm install && cp .env.example .env && nano .env
npm start
```

Expose it publicly (your VM has port **7801** open):

1. Set `PORT=7801` in `.env` (already the default in `.env.example`).
2. Confirm **Azure Portal → your VM → Networking → Inbound port rules** allows TCP **7801** (and that any OS firewall does too: `sudo ufw allow 7801`).
3. Your URL is then `http://<vm-public-ip>:7801`. For a friendlier name, Azure gives a free DNS label: VM → Overview → Public IP → Configuration → **DNS name label** → `http://<label>.<region>.cloudapp.azure.com:7801`.
4. (Optional, nicer) put nginx in front on 80/443 with a Let's Encrypt cert, proxying to `localhost:7801`.

Keep it running after you log out:

```bash
sudo npm i -g pm2
PORT=7801 pm2 start server/server.js --name tap-demo
pm2 save && pm2 startup
```

If you edit the frontend (`web/app.jsx`), rebuild with `npm run build`.

## 5. Suggested customer demo flow (~8 minutes)

1. **Login** — one tap on Daniel's saved profile; point out it's loaded from the customer DB.
2. **Home** — recurring journey card ("9 of his last 12 Mondays — computed live from travel_history"), the synced search from his MacBook, the AI itinerary planner ("Plan my Lisbon client week").
3. **Flights** — XP1927 recommended from his pattern, lowest fare flagged, free Gold **fare lock** (watch the toast: row written to DB).
4. **Basket** — one persistent basket: flight + seat 4C + meal + transfer; toggle an item and mention it's saved server-side instantly.
5. **Checkout** — every passenger field auto-filled *from the users table*; trigger the **48h Time-to-Think hold** → a real branded email goes out.
6. **Payment** — split voucher + miles slider + saved Visa in one transaction → instant confirmation + **booking email**; miles balance visibly drops.
7. **Manage** — auto check-in ON, live boarding pass; hit **Simulate flight delay** → ops event hits the DB, Claude writes an honest recovery message, the **proactive disruption email** is sent, Daniel rebooks in one tap → **rebooking email**.
8. **Demo Console** — the reveal: live tables (bookings, payments, emails, events all just appeared), the email center with HTML previews, and the line: *"this customer store is CDP-ready — in production these objects sync 1:1 with the CDP profile."* Back on Home, hit **"Email me this week's offer"** for an AI-personalized commercial email built from his actual history.

## 6. Architecture

```
public/         static frontend (index.html + bundled app.js)
web/app.jsx     React source (rebuild: npm run build)
server/
  server.js     Express API + static hosting
  db.js         SQLite schema + Daniel seed + route network → data/tap.db
  routes-data.js  100-route network (50 European) + 92 airports
  search.js     flight-search engine — generates realistic flights
                for any route on demand; pins Daniel's OPO→LIS shuttle
  email.js      Nodemailer + branded HTML templates + DB outbox
  claude.js     server-side Claude calls (profile context built
                live from the DB) + cached fallbacks
data/tap.db     the visible customer database (open it in any
                SQLite tool, e.g. DB Browser for SQLite)
```

API highlights: `/api/profile`, `/api/search` (any route), `/api/airports` (autocomplete), `/api/routes` (network), `/api/flights`, `/api/basket`, `/api/fare-lock`, `/api/hold`, `/api/pay`, `/api/disrupt`, `/api/rebook`, `/api/ai/plan`, `/api/ai/chat`, `/api/offers/send`, `/api/admin/db`, `/api/admin/emails`, `/api/admin/reset`, `/api/health`.

## 7. Flight search & the personalization loop

The app searches a network of **100 routes across 92 airports — 50 within Europe, with heavy Portugal coverage** (Lisbon, Porto, Faro, Funchal, the Azores, plus Portugal↔Europe and long-haul to Brazil, North America, and Africa). Rather than seeding tens of thousands of flight rows, `search.js` generates realistic, *deterministic* flights for any route on demand (the same route+date always returns the same flights). Daniel's OPO→LIS commute is pinned to his real flight numbers so his travel history lines up exactly.

Every customer action is behavioural data that flows into the database and back into what the app recommends:

- **Searches** are logged to the `searches` table. The most-searched destinations surface in the profile and shape recommendations.
- **Bookings** append to `travel_history`. Per-destination booking counts drive the "Picked for you" cards ("Booked 3× — a favourite") and the recommended flight on each route is chosen to match the customer's usual departure time.

So in the demo you can search and book *any* of the 100 routes end-to-end (search → select → basket → checkout → payment → confirmation + email), watch each step write to the database live in the Demo Console, and see the personalization shift as a result. This is the CDP story made tangible: the store maps 1:1 to customer-profile, behaviour, and consent objects for later CDP sync.


## 8. WhatsApp integration (real, free, demo-only — via Twilio)

The demo connects to **real WhatsApp** using **Twilio's WhatsApp Sandbox** — free, no business verification, and far more reliable than Meta's developer test number for cross-border demos. You message the bot from your own phone; replies hit your VM's webhook and run the same backend the portal uses (bookings, rebooking, ancillaries, cancellations — all in the same database, all feeding personalization).

What works on WhatsApp: a **numbered main menu** (reply 1–5) → **book the usual flight** with one-tap pay (reply 1) or 48h hold (reply 2) → **add extras** (charged to the booking) → **check in** → **flight status** → **cancel with instant refund** (miles + voucher really restored). And the showpiece: triggering **Simulate flight delay** in the portal pushes a proactive WhatsApp message with two rebooking choices — reply 1 or 2 and the booking changes, the email goes out, the DB updates, live on screen.

> **Why numbered menus, not tap-buttons?** Twilio's sandbox sends free-form **text** reliably to any number that's joined it. True tappable WhatsApp buttons/lists require pre-approved message *templates*, which the sandbox doesn't support. Numbered replies give the same guided flow with zero template friction — ideal for a demo. (In production with an approved WhatsApp sender, the same logic can be upgraded to interactive buttons without changing the backend.)

### Setup (~10 minutes, free)

1. **Twilio account**: sign up free at twilio.com. No credit card needed for the sandbox.
2. **Open the WhatsApp Sandbox**: Console → **Messaging → Try it out → Send a WhatsApp message**. You'll see a sandbox number (**+1 415 523 8886**) and a **join code** like `join <two-words>`.
3. **Join from your phone**: in WhatsApp, send `join <your-two-word-code>` to **+1 415 523 8886**. Twilio replies confirming you're connected. (Anyone demoing on their own phone joins the same way — repeat per device.)
4. **Copy credentials** into `.env`: from the Console dashboard copy **Account SID** → `TWILIO_ACCOUNT_SID` and **Auth Token** → `TWILIO_AUTH_TOKEN`. Leave `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` as-is (the sandbox sender).
5. **Public HTTPS webhook**: on the VM, expose port 7801 with a tunnel:
   ```bash
   ngrok http 7801      # sign up free at ngrok.com for an authtoken
   ```
   Copy the `https://xxxx.ngrok-free.dev` URL it prints.
6. **Point the sandbox at your webhook**: back in **Sandbox settings** (Messaging → Try it out → Send a WhatsApp message → *Sandbox settings*), set **"When a message comes in"** to `https://YOUR-TUNNEL-URL/api/whatsapp/webhook`, method **POST**. Save.
7. **Restart the app** (`npm start`) and check `GET /api/health` — it should report `whatsapp: configured`.

### Demo flow

Send **any message** ("Hi") from your phone to the sandbox number — the numbered menu appears. Reply with a number to drive the whole journey; every action writes to the same SQLite DB and shows live in the Demo Console. For the disruption push to reach you before you've messaged the bot, set `WHATSAPP_DEFAULT_TO` to your number (international format, no `+`) in `.env`.

Without credentials the demo still works: every WhatsApp message is logged to the `wa_messages` table and visible in the Demo Console, so you can rehearse the conversation logic offline.

**Honest demo framing**: Twilio's sandbox is real WhatsApp delivery to any phone that's joined it, free, with no recipient cap to worry about for a demo. Sandbox sessions expire after ~3 days of inactivity (just re-send the join code) and the standard 24-hour customer-service window applies (the user messages first). Going commercial means a registered WhatsApp sender on Twilio; the backend logic doesn't change.
