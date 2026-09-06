/* ──────────────────────────────────────────────────────────────
   Xperion Demo — WhatsApp integration via TWILIO Sandbox
   • With TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM
     set, messages really send via Twilio's API (free sandbox, to
     any number that has joined your sandbox with the join code).
   • Without credentials, every outbound message is still logged to
     the wa_messages table (visible in the Demo Console), so the
     conversation logic is fully testable offline.
   • The Twilio sandbox reliably sends TEXT. True tappable buttons
     need approved templates (not available in sandbox), so the menu
     is a numbered text menu: the user replies 1/2/3… It always works.
   • Replies arrive on the webhook (POST x-www-form-urlencoded from
     Twilio) and trigger the SAME backend endpoints the portal uses —
     bookings, rebooking, ancillaries, cancellations all hit the same
     database and feed the same personalization.
   ────────────────────────────────────────────────────────────── */
const { db, now, searchToday, currentBooking, getDataSource } = require("./db");
const { AIRPORTS } = require("./routes-data");
const { phraseFromFacts } = require("./claude");
const session = require("./session");   // step-1 seam: phone→uid + wa:<tail> session binding (no cycle)

// CDP forwarder for WhatsApp-channel events (written here, outside server.js's log()).
let _cdpEvents = null; try { _cdpEvents = require("./cdp-events"); } catch { _cdpEvents = null; }
function _cdpIdent(uid = session.SERVER_DEFAULT_UID) { try { const u = db.prepare("SELECT member_no, email FROM users WHERE id=?").get(uid) || {}; return { loyaltyId: u.member_no, email: u.email }; } catch { return {}; } }
function cdpForward(type, attrs, rowId, uid = session.SERVER_DEFAULT_UID) {
  (async () => {
    let ok = false;
    try {
      if (_cdpEvents && typeof _cdpEvents.streamEvent === "function") ok = (await _cdpEvents.streamEvent(type, _cdpIdent(uid), attrs || {})) !== false;
      else if (_cdpEvents && typeof _cdpEvents.emit === "function") { _cdpEvents.emit(type, _cdpIdent(uid), attrs || {}); ok = true; }
    } catch { ok = false; }
    try { if (rowId) db.prepare("UPDATE events SET delivery=? WHERE id=?").run(ok ? "sent" : "pending", rowId); } catch { }
  })();
}

const cityName = (c) => (AIRPORTS[c] && AIRPORTS[c].city) || c;
const SID = () => process.env.TWILIO_ACCOUNT_SID;
const AUTH = () => process.env.TWILIO_AUTH_TOKEN;
const FROM = () => process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886"; // default sandbox number
const TWILIO = () => !!(SID() && AUTH());
/* Pluggable transport (whatsapp-baileys.js injects its send at boot). When set, every outbound
   goes through it and interactive templates are disabled so menus render as numbered text. */
let TRANSPORT = null;
function setTransport(t) { TRANSPORT = t && typeof t.send === "function" ? t : null; }
const MODE = () => (TRANSPORT ? "baileys" : TWILIO() ? "twilio" : "off");
const CONFIGURED = () => !!TRANSPORT || TWILIO();
const PORT = () => process.env.PORT || 3000;

// Normalise any number to Twilio's "whatsapp:+E164" form
const waAddr = (n) => {
  if (!n) return n;
  let s = String(n).trim();
  if (s.startsWith("whatsapp:")) return s;
  if (!s.startsWith("+")) s = "+" + s.replace(/[^\d]/g, "");
  return "whatsapp:" + s;
};
const bareNumber = (n) => String(n || "").replace(/^whatsapp:/, "");

// Trailing-9-digits of a number — tolerates "whatsapp:+1 …" prefixes/spacing. Used to
// resolve phone→uid (session.userByPhone) and to key the wa:<tail> session binding.
// (The old personaForPhone/activePersonaId helpers are gone: identity is now resolved by
//  phone→uid at handleIncoming entry and threaded via the wa:<tail> session binding.)
const phoneTail = (s) => String(s || "").replace(/[^0-9]/g, "").slice(-9);

const logWA = (direction, wa_id, type, body, payload, status) =>
  db.prepare(`INSERT INTO wa_messages (direction,wa_id,msg_type,body,payload_json,status,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(direction, bareNumber(wa_id) || "", type, body || "", JSON.stringify(payload || {}), status, now());

/* ── Outbound send (Twilio REST API) ─────────────────────────── */
async function sendText(to, text) {
  let status = "logged (no WhatsApp provider configured)";
  if (TRANSPORT) {
    try { status = await TRANSPORT.send(bareNumber(to), text); } catch (e) { status = "send failed: " + String(e?.message || e).slice(0, 120); }
  } else if (TWILIO()) {
    try {
      const params = new URLSearchParams();
      params.append("From", FROM());
      params.append("To", waAddr(to));
      params.append("Body", text);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(`${SID()}:${AUTH()}`).toString("base64"),
        },
        body: params.toString(),
      });
      const data = await res.json();
      status = res.ok ? "delivered via Twilio" : "send failed: " + JSON.stringify(data.message || data).slice(0, 140);
    } catch (e) { status = "send failed: " + e.message.slice(0, 120); }
  }
  logWA("out", to, "text", text, { body: text }, status);
  return status;
}

/* ── Interactive sends — WhatsApp quick-reply BUTTONS (max 3) and LIST menus.
   Twilio delivers these via the Content API. The sandbox can't create content
   templates on the fly, so when WA_INTERACTIVE isn't enabled (or a send fails)
   we fall back to the numbered text menu — which always works. Either way we
   register the tappable labels in the menu context so a tapped reply (which
   arrives as the button's text/id) maps to the right action. ─────────────── */
const INTERACTIVE = () => !TRANSPORT && TWILIO() && process.env.WA_INTERACTIVE === "1";

// buttons: [{ id, title }] (title ≤ 20 chars, max 3). Falls back to "1/2/3" text.
async function sendButtons(to, text, buttons, menuMap) {
  if (menuMap) setMenu(to, menuMap);
  // Register button titles AND ids as accepted replies (taps send the title).
  const ctx = menuContext[bareNumber(to)] || {};
  buttons.forEach((b, i) => { ctx[String(i + 1)] = b.id; ctx[b.title.toLowerCase()] = b.id; ctx[b.id] = b.id; });
  menuContext[bareNumber(to)] = ctx;

  if (INTERACTIVE()) {
    try {
      const params = new URLSearchParams();
      params.append("From", FROM());
      params.append("To", waAddr(to));
      params.append("ContentSid", process.env.WA_BUTTONS_CONTENT_SID || "");
      params.append("ContentVariables", JSON.stringify({ body: text, ...Object.fromEntries(buttons.map((b, i) => [String(i + 1), b.title])) }));
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${SID()}:${AUTH()}`).toString("base64") },
        body: params.toString(),
      });
      const data = await res.json();
      if (res.ok) { logWA("out", to, "interactive", text, { buttons }, "delivered via Twilio (buttons)"); return "delivered"; }
    } catch {}
    // fall through to text on any failure
  }
  // Text fallback: body + numbered options
  const lines = buttons.map((b, i) => `${i + 1}️⃣  ${b.title}`).join("\n");
  return sendText(to, `${text}\n\n${lines}`);
}

// rows: [{ id, title, description? }] (max 10). Falls back to numbered text list.
async function sendList(to, header, body, buttonLabel, rows, menuMap) {
  if (menuMap) setMenu(to, menuMap);
  const ctx = menuContext[bareNumber(to)] || {};
  rows.forEach((r, i) => { ctx[String(i + 1)] = r.id; ctx[(r.title || "").toLowerCase()] = r.id; ctx[r.id] = r.id; });
  menuContext[bareNumber(to)] = ctx;

  if (INTERACTIVE()) {
    try {
      const params = new URLSearchParams();
      params.append("From", FROM());
      params.append("To", waAddr(to));
      params.append("ContentSid", process.env.WA_LIST_CONTENT_SID || "");
      params.append("ContentVariables", JSON.stringify({ header, body, button: buttonLabel, ...Object.fromEntries(rows.map((r, i) => [String(i + 1), r.title])) }));
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${SID()}:${AUTH()}`).toString("base64") },
        body: params.toString(),
      });
      const data = await res.json();
      if (res.ok) { logWA("out", to, "interactive", body, { header, rows }, "delivered via Twilio (list)"); return "delivered"; }
    } catch {}
  }
  const lines = rows.map((r, i) => `${i + 1}️⃣  ${r.title}${r.description ? ` — ${r.description}` : ""}`).join("\n");
  return sendText(to, `${header ? "*" + header + "*\n" : ""}${body ? body + "\n\n" : ""}${lines}\n\n0 for menu`);
}

/* ── Internal API helper — reuses the portal's own endpoints ───
   Carries the sender's bound session (X-Session-Id: wa:<tail>) so the server acts as
   the RIGHT user (step-1 seam). Pass `to` (the WhatsApp number) at every call site. */
const apiCall = (method, p, body, to) =>
  fetch(`http://localhost:${PORT()}/api${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(to ? { "X-Session-Id": "wa:" + phoneTail(to) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json());

// Resolve the per-message uid from the sender's bound session (set at handleIncoming entry).
// NEVER cache uid in a module-level var — derive per message from the phone (Risk D).
const waUid = (to) => (session.getSession("wa:" + phoneTail(to)) || {}).uid || session.SERVER_DEFAULT_UID;
const latestBooking = (to) => currentBooking(waUid(to));   // this user's "soonest upcoming" trip
const flightByNo = (no) => db.prepare("SELECT * FROM flights WHERE flight_no=?").get(no);
// Live loyalty tier + boarding group for the acting user (never hardcode "Gold").
const userTier = (to) => (db.prepare("SELECT tier FROM users WHERE id=?").get(waUid(to)) || {}).tier || "Gold";
const boardingGroup = (tier) => `${(tier || "Gold") === "Silver" ? "B" : "A"} (${tier || "Gold"})`;

// ── Cross-channel journey: persist the WhatsApp step + selections to the shared
//    journey so web / AI / WhatsApp can all resume at the exact stage. ────────
async function saveJourneyWA(stage, d, to) {
  const f = d?.flight_no ? flightByNo(d.flight_no) : null;
  if (!f) return;
  try {
    await apiCall("POST", "/journey", {
      origin: f.origin, dest: f.dest, date: f.flight_date, device: "WhatsApp", stage,
      flight_no: d.flight_no, seat: d.seat || undefined,
      items: (d.items || []).filter(c => c !== "seat"), cabin: d.cabin || "Economy",
    }, to);
  } catch {}
}
const readJourney = (to) => apiCall("GET", "/journey", null, to).catch(() => null);

/* ── Per-sender menu context: maps the number the user just typed
      (1,2,3…) back to an action id, based on the last menu we sent.
      Kept in memory; fine for a demo. ───────────────────────────── */
const menuContext = {};   // { "<bareNumber>": { "1": "BOOK_USUAL", ... } }
function setMenu(to, map) { menuContext[bareNumber(to)] = map; }
function resolveChoice(to, text) {
  const map = menuContext[bareNumber(to)] || {};
  const key = (text || "").trim();
  return map[key] || map[key.toLowerCase()] || null;
}

// Per-sender booking draft, carries flight + seat + extras through the WhatsApp flow
const draft = {};   // { "<bareNumber>": { flight_no, seat, items:[] } }
const getDraft = (to) => (draft[bareNumber(to)] = draft[bareNumber(to)] || { flight_no: null, seat: "22C", items: ["seat","bag","meal"] });
const clearDraft = (to) => { delete draft[bareNumber(to)]; };

// Per-sender conversation history so the AI agent has context across turns
// (mirrors how the web chat sends its full message list). Without this, each
// WhatsApp message is answered blind — e.g. "does XP1481 have availability?"
// can't be resolved because the agent never saw XP1481 being listed.
const convo = {};   // { "<bareNumber>": [ {role, content}, ... ] }
const getConvo = (to) => (convo[bareNumber(to)] = convo[bareNumber(to)] || []);
const pushConvo = (to, role, content) => {
  const c = getConvo(to);
  c.push({ role, content });
  if (c.length > 16) c.splice(0, c.length - 16);   // keep last ~8 exchanges
};
const clearConvo = (to) => { delete convo[bareNumber(to)]; };

// Per-sender active route/date context so date-only follow-ups ("how about
// the day after tomorrow", "what about tomorrow") re-run the SAME route.
const ctx = {};   // { "<bareNumber>": { origin, dest, date } }
const getCtx = (to) => ctx[bareNumber(to)] || null;
const setCtx = (to, c) => { ctx[bareNumber(to)] = { ...(ctx[bareNumber(to)] || {}), ...c }; };

// Resolve a natural-language flight pick against the last shown list → flight_no | null.
// Handles ordinals ("the second one", "3rd"), "option N" / "#N", an explicit "TPxxxx",
// a departure time ("the 9:05", "7am"), and attributes ("cheapest", "earliest", "latest").
// So the customer never has to reply with a bare menu number to choose a flight.
function resolvePick(t, flights) {
  if (!flights || !flights.length) return null;
  const n = flights.length;
  const WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, last: n };
  let idx = null, m;
  if ((m = t.match(/\b(?:option|number|flight|no\.?)\s*(\d{1,2})\b/)) || (m = t.match(/#\s*(\d{1,2})\b/))) idx = +m[1];
  else { for (const w in WORDS) { if (new RegExp(`\\b${w}\\b`).test(t)) { idx = WORDS[w]; break; } } }
  if (idx == null) { const mm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/); if (mm && /\b(one|option|flight|go (with|for)|take|pick|choose|select|book|that)\b/.test(t)) idx = +mm[1]; }
  if (idx && idx >= 1 && idx <= n) return flights[idx - 1].flight_no;
  const tp = (t.toUpperCase().match(/\bTP\s?(\d{2,4})\b/) || [])[1];
  if (tp) { const f = flights.find(x => String(x.flight_no).replace(/\D/g, "") === tp); if (f) return f.flight_no; }
  const tm = t.match(/\b(\d{1,2})[:.h](\d{2})\b/) || t.match(/\b(\d{1,2})\s?(am|pm)\b/);
  if (tm) {
    let hh = +tm[1]; const mer = (tm[2] || "").toLowerCase();
    if (mer === "pm" && hh < 12) hh += 12; if (mer === "am" && hh === 12) hh = 0;
    const f = flights.find(x => String(x.dep || "").startsWith(String(hh).padStart(2, "0")));
    if (f) return f.flight_no;
  }
  const has = (...ws) => ws.some(w => t.includes(w));
  if (has("cheapest", "lowest", "least expensive", "cheap one", "best price")) return flights.slice().sort((a, b) => a.price - b.price)[0].flight_no;
  if (has("earliest", "first flight", "morning", "early one")) return flights.slice().sort((a, b) => String(a.dep).localeCompare(String(b.dep)))[0].flight_no;
  if (has("latest", "last flight", "evening", "night", "later one")) return flights.slice().sort((a, b) => String(b.dep).localeCompare(String(a.dep)))[0].flight_no;
  return null;
}

/* ── Conversation logic ──────────────────────────────────────── */
async function sendMainMenu(to) {
  const uid = waUid(to);
  const u = db.prepare("SELECT first_name, miles, tier, affinity_label FROM users WHERE id=?").get(uid);
  const pat = db.prepare("SELECT flight_no FROM bookings WHERE user_id=? AND status='confirmed' ORDER BY id DESC LIMIT 1").get(uid);
  // If there's an unfinished cross-channel journey, surface a Resume row at the top.
  const j = await readJourney(to);
  // Usual route + recommended next date, so the express option shows what & when.
  const prof = await apiCall("GET", "/profile", null, to).catch(() => null);
  const P = prof?.pattern || {};
  const usualDesc = (P.origin && P.dest)
    ? `${cityName(P.origin)}→${cityName(P.dest)}${P.recommendedLabel ? ` · ${P.recommendedLabel}` : ""} · one tap`
    : "Your regular route, one tap";
  const STAGE_WORD = { results: "choosing a flight", seat: "seat selection", extras: "extras", review: "review & pay" };
  const rows = [];
  const map = { "0": "MENU" };
  // Core options FIRST, at stable numbers (1-8) regardless of journey state.
  rows.push(
    { id: "BOOK_USUAL", title: "⚡ Express · my usual flight", description: usualDesc },
    { id: "MADE_FOR_YOU", title: "Made for you", description: u.affinity_label ? `${u.affinity_label} package` : "A package picked for you" },
    { id: "OFFER", title: "💎 Offer of the week", description: "Your personalized deal" },
    { id: "MY_BOOKING", title: "My booking", description: "View your current trip" },
    { id: "EXTRAS", title: "Add extras", description: "Bags, seats, meals, wifi" },
    { id: "STATUS", title: "Flight status", description: "Is my flight on time?" },
    { id: "CHECKIN", title: "Check in", description: "Get your boarding pass" },
    { id: "CANCEL", title: "Cancel booking", description: "Instant refund" },
  );
  // Resume appended LAST (only when a journey exists) so it never shifts the core numbers.
  if (j && j.stage && j.dest) {
    rows.push({ id: "RESUME", title: "↩️ Resume your search", description: `${cityName(j.origin)}→${cityName(j.dest)} · ${STAGE_WORD[j.stage] || "in progress"}` });
  }
  rows.forEach((r, i) => { map[String(i + 1)] = r.id; });
  const resumeNo = (j && j.stage && j.dest) ? rows.length : null;
  const greeting = (resumeNo
    ? `Olá ${u.first_name} 👋 You have a trip in progress (${cityName(j.origin)}→${cityName(j.dest)}). Reply ${resumeNo} (or "resume") to continue, or pick another option.`
    : `Olá ${u.first_name} 👋 Linked to your Xperion Miles account (${u.tier}, ${u.miles.toLocaleString()} miles). Xperion an option below, or just type where you want to go (e.g. "flights to Madrid").`)
    + (getDataSource() === "adobe" ? `\n\n🔗 Profile via Adobe Real-Time CDP.` : "");
  await sendList(to, `Xperion AI · ${u.first_name}`, greeting, "Main menu", rows.slice(0, 10), map);
}

/* ── Booking-flow step helpers (flight → seat → extras → checkout → pay) ── */

// Price a draft: flight + paid extras, with the persona's voucher + miles applied
function priceDraft(d, f, to) {
  const anc = db.prepare("SELECT code,price FROM ancillaries").all();
  const extras = (d.items || []).reduce((s, c) => s + (anc.find(a => a.code === c)?.price || 0), 0);
  const gross = +(((f?.price) || 72) + extras).toFixed(2);
  const v = db.prepare("SELECT amount FROM vouchers WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(waUid(to));
  const voucher = Math.min(v?.amount || 0, gross);
  const miles_used = 6000, miles_amt = 18;
  const card = Math.max(0, +(gross - voucher - miles_amt).toFixed(2));
  return { gross, extras, voucher, miles_used, miles_amt, card };
}

// SEAT step — recommend the seat the persona uses most (from history)
async function startSeatStep(to, f) {
  const rec = await apiCall("GET", "/seat-recommendation", null, to);
  const recSeat = rec?.seat || (db.prepare("SELECT seat FROM bookings WHERE user_id=? AND seat IS NOT NULL GROUP BY seat ORDER BY COUNT(*) DESC").get(waUid(to)) || {}).seat || "12A";
  // offer the recommended seat first, then a few sensible alternatives (de-duped)
  const alts = [recSeat, "22A", "22C", "20F", "24D"].filter((s, i, arr) => arr.indexOf(s) === i);
  const map = { "0": "MENU" }; const lines = [];
  alts.slice(0, 4).forEach((s, i) => { const n = String(i + 1); map[n] = `SEAT_${s}`; lines.push(`${n}️⃣  Seat ${s}${s === recSeat ? "  ⭐ your usual" : ""}`); });
  setMenu(to, map);
  await saveJourneyWA("seat", getDraft(to), to);
  await sendText(to,
`✈️ ${f.flight_no} ${cityName(f.origin)} → ${cityName(f.dest)} · ${f.flight_date} · ${f.dep}–${f.arr}

Choose your seat — ${rec?.reason || `seat ${recSeat} is your usual`}:

${lines.join("\n")}

0 for menu`);
}

// EXTRAS step — history-personalized ancillaries, toggle then done
async function startExtrasStep(to, note) {
  const d = getDraft(to);
  const anc = await apiCall("GET", "/ancillaries", null, to);   // includes bought/reason/recommended
  const paid = anc.filter(a => a.price > 0);
  const map = {}; const lines = [];
  paid.forEach((a, i) => {
    const n = String(i + 1);
    map[n] = `XTOG_${a.code}`;
    const on = d.items.includes(a.code);
    const tag = a.recommended ? `  ⭐ ${a.reason}` : (a.reason ? `  · ${a.reason}` : "");
    lines.push(`${n}️⃣  ${on ? "✅" : "➕"} ${a.name} — $${a.price}${tag}`);
  });
  map["9"] = "XDONE";
  setMenu(to, map);
  await saveJourneyWA("extras", d, to);
  const head = note ? `${note}\n\n` : "";
  await sendText(to,
`${head}🧳 Add extras (reply a number to toggle):

${lines.join("\n")}

9️⃣  Done — review & pay`);
}

// CHECKOUT review — full summary before payment
async function startCheckoutReview(to) {
  const d = getDraft(to);
  const f = flightByNo(d.flight_no);
  if (!f) { await sendText(to, "Your selection expired — reply \"menu\" to start again."); clearDraft(to); return sendMainMenu(to); }
  const priced = priceDraft(d, f, to);
  const anc = db.prepare("SELECT code,name,price FROM ancillaries").all();
  const extraNames = d.items.filter(c => !["seat","bag","meal"].includes(c)).map(c => anc.find(a => a.code === c)?.name || c);
  const card = db.prepare("SELECT card_brand, card_last4 FROM users WHERE id=?").get(waUid(to)) || {};
  await saveJourneyWA("review", d, to);
  await sendButtons(to,
`🧾 *Review your booking*
${f.flight_no} ${cityName(f.origin)} → ${cityName(f.dest)} · ${f.flight_date} · ${f.dep}–${f.arr}
Seat ${d.seat} · cabin bag${extraNames.length ? " + " + extraNames.join(", ") : ""}

Total $${priced.gross.toFixed(2)}
 • Voucher −$${priced.voucher}
 • ${priced.miles_used.toLocaleString()} miles −$${priced.miles_amt}
 • Saved card $${priced.card.toFixed(2)}`,
    [{ id: "DO_PAY", title: "Pay now" }, { id: "DO_HOLD", title: "Hold 48h free" }, { id: "MENU", title: "Back to menu" }],
    { "1": "DO_PAY", "2": "DO_HOLD", "3": "MENU", "0": "MENU" });
}

// Express checkout for the usual flight — everything pre-filled, one tap to pay.
// Mirrors the web Express Checkout and shares the "review" journey stage so the
// trip resumes across channels (web ⇄ WhatsApp) at exactly this point.
async function startExpressReview(to, f) {
  const d = getDraft(to);
  const priced = priceDraft(d, f, to);
  const u = db.prepare("SELECT full_name, tier, member_no, card_brand, card_last4 FROM users WHERE id=?").get(waUid(to)) || {};
  const tier = (u.tier || "Gold").toUpperCase();
  const miles = Math.round(priced.gross * 11);
  // Standalone express flow — does NOT write the shared journey, so it never
  // collides with "Resume your search" (which tracks the normal step-by-step flow).
  await sendButtons(to,
`⚡ *Express checkout — your usual flight*
${f.flight_no} ${cityName(f.origin)} → ${cityName(f.dest)}
🗓️ ${f.flight_date} (recommended) · ${f.dep}–${f.arr}

👤 ${u.full_name} · ${tier} · ${u.member_no}
💺 Seat ${d.seat || "auto"} · 🧳 cabin bag + checked 23kg
🎟️ Lounge + priority boarding FREE · ${tier}
💳 Saved card · •••• ••••

*Total $${priced.gross.toFixed(2)}* · earn ${miles.toLocaleString()} miles
 • Voucher −$${priced.voucher} · ${priced.miles_used.toLocaleString()} mi −$${priced.miles_amt} · card $${priced.card.toFixed(2)}

Everything's pre-filled — just confirm.`,
    [{ id: "EXPRESS_PAY", title: "Pay & confirm" }, { id: "MENU", title: "Back to menu" }],
    { "1": "EXPRESS_PAY", "0": "MENU" });
}

async function handleAction(to, id) {
  /* Resume the shared cross-channel journey at the exact step the customer left. */
  if (id === "RESUME") {
    const j = await readJourney(to);
    if (!j || !j.stage) { await sendText(to, "Nothing in progress to resume — let's start a new search."); return sendMainMenu(to); }
    const f = j.flight_no ? flightByNo(j.flight_no) : null;
    // Rebuild the WhatsApp draft from the saved journey.
    const d = getDraft(to);
    d.flight_no = j.flight_no || null;
    d.seat = j.seat || d.seat;
    d.items = ["seat", ...(j.items || [])];
    if (j.stage === "results" || !f) {
      // Only a route was chosen → re-run the route search so they can pick a flight.
      const home = j.origin || "MIA";
      return searchRoute(to, home, j.dest, j.date || searchToday(), "resume");
    }
    await sendText(to, `↩️ Picking up where you left off — ${cityName(f.origin)} → ${cityName(f.dest)}, ${({seat:"choosing your seat",extras:"adding extras",review:"reviewing & payment"})[j.stage] || "your booking"}.`);
    if (j.stage === "seat") return startSeatStep(to, f);
    if (j.stage === "extras") return startExtrasStep(to);
    if (j.stage === "review") return startCheckoutReview(to);
    return startSeatStep(to, f);
  }
  if (id === "START_FRESH") {
    await apiCall("POST", "/journey/clear", null, to);
    clearDraft(to);
    await sendText(to, "Starting fresh. Where would you like to fly? (e.g. \"flights to Madrid\")");
    return;
  }
  if (id === "BOOK_USUAL") {
    const prof = await apiCall("GET", "/profile", null, to);
    const pat = prof?.pattern || {};
    const origin = pat.origin || prof?.user?.home_airport || "MIA";
    const dest = pat.dest || "JFK";
    const dateQ = pat.recommendedDate ? `&date=${pat.recommendedDate}` : "";
    const flights = await apiCall("GET", `/flights?dest=${dest}&origin=${origin}${dateQ}`, null, to);
    const f = flights.find(x => x.flight_no === pat.topFlight) || flights[0];
    if (!f) { await sendText(to, "Couldn't load your usual flight — try the menu."); return sendMainMenu(to); }
    const seat = (prof?.prefs?.seat || "").split(" ")[0] || "";
    const d = getDraft(to); d.flight_no = f.flight_no; d.seat = seat; d.items = ["seat","bag","meal"];
    return startExpressReview(to, f);
  }

  /* Pick a flight returned by a search → go to SEAT selection */
  if (id.startsWith("PICK_")) {
    const fno = id.slice(5);
    const f = flightByNo(fno);
    if (!f) { await sendText(to, "That flight's no longer available — reply \"menu\" to start over."); return; }
    const prefSeat = (db.prepare("SELECT seat FROM bookings WHERE user_id=? AND seat IS NOT NULL GROUP BY seat ORDER BY COUNT(*) DESC").get(waUid(to)) || {}).seat || "";
    const d = getDraft(to); d.flight_no = f.flight_no; d.seat = prefSeat; d.items = ["seat","bag","meal"];
    return startSeatStep(to, f);
  }

  /* SEAT step: choose a seat with a history-based recommendation */
  if (id.startsWith("SEAT_")) {
    const seat = id.slice(5);
    const d = getDraft(to); d.seat = seat;
    return startExtrasStep(to);
  }

  /* EXTRAS step: toggle history-recommended ancillaries, then checkout */
  if (id.startsWith("XTOG_")) {
    const code = id.slice(5);
    const d = getDraft(to);
    if (d.items.includes(code)) d.items = d.items.filter(c => c !== code);
    else d.items.push(code);
    return startExtrasStep(to, `${d.items.includes(code) ? "Added" : "Removed"} ${code}.`);
  }
  if (id === "XDONE") return startCheckoutReview(to);
  if (id === "OFFER") return showOffer(to);
  if (id.startsWith("OFFERBOOK_")) { const p = id.split("_"); return searchRoute(to, p[1], p[2], searchToday(), "offer"); }

  /* CHECKOUT → PAY / HOLD using the full draft */
  if (id === "DO_PAY" || id === "EXPRESS_PAY") {
    const d = getDraft(to);
    const f = flightByNo(d.flight_no);
    if (!f) { await sendText(to, "Your selection expired — reply \"menu\" to start again."); clearDraft(to); return sendMainMenu(to); }
    const priced = priceDraft(d, f, to);
    const r = await apiCall("POST", "/pay", { flight_no: d.flight_no, items: d.items, seat: d.seat, total: priced.gross, voucher_amt: priced.voucher, miles_used: priced.miles_used, miles_amt: priced.miles_amt, card_amt: priced.card }, to);
    const cardRow = db.prepare("SELECT card_brand, card_last4 FROM users WHERE id=?").get(waUid(to)) || {};
    const cardStr = "your saved card";
    const facts = { action: "checkout", state: "booked", pnr: r.pnr, flight_no: f.flight_no, route: `${cityName(f.origin)}→${cityName(f.dest)}`, date: f.flight_date, seat: d.seat, card: cardStr, extras: d.items.filter(c=>!["seat","bag","meal"].includes(c)), split: { voucher: priced.voucher, miles: priced.miles_used, miles_eur: priced.miles_amt, card: priced.card } };
    await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp",
      fallback: `✅ Booked! ${r.pnr} — ${f.flight_no} ${cityName(f.origin)}→${cityName(f.dest)}, ${f.flight_date}, seat ${d.seat}.\nPayment: voucher −$${priced.voucher} · ${priced.miles_used.toLocaleString()} miles −$${priced.miles_amt} · ${cardStr} $${priced.card.toFixed(2)}.\nConfirmation emailed. Auto check-in is ON.` }));
    clearDraft(to);
    await sendMainMenu(to);
    return;
  }
  if (id === "DO_HOLD") {
    const d = getDraft(to);
    const f = flightByNo(d.flight_no);
    const priced = priceDraft(d, f, to);
    const r = await apiCall("POST", "/hold", { flight_no: d.flight_no, items: d.items, seat: d.seat, total: priced.gross }, to);
    setMenu(to, { "1": "DO_PAY", "0": "MENU" });
    await sendText(to, `⏳ Held until ${r.expires} — price, seat ${d.seat} and extras frozen, free as a ${userTier(to)} benefit. Hold confirmation emailed.\n\nReply 1 to complete payment · 0 for menu`);
    return;
  }

  if (id === "MY_BOOKING") {
    const b = latestBooking(to);
    if (!b) {
      const facts = { action: "my_booking", state: "no_booking", message: "You have no upcoming booking right now." };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: facts.message + " Reply 1 to book your usual flight." }));
      return sendMainMenu(to);
    }
    const f = flightByNo(b.flight_no) || {};
    setMenu(to, { "1": "CHECKIN", "2": "EXTRAS", "0": "MENU" });
    await sendText(to,
`📄 ${b.pnr} — ${b.flight_no} ${cityName(f.origin)} → ${cityName(f.dest)}
${b.flight_date} · ${f.dep}–${f.arr} · Seat ${b.seat}
Status: ${f.status === "delayed" ? `⚠️ delayed, new departure ${f.new_dep}` : "on time"} · ${b.checked_in ? "Checked in ✓" : "Auto check-in 24h before"}

Reply:  1 to Check in now   ·   2 to Add extras   ·   0 for menu`);
    return;
  }
  if (id === "CHECKIN") {
    const b = latestBooking(to);
    // Verify real DB state first — never claim success blindly.
    if (!b) {
      const facts = { action: "check_in", state: "no_booking", message: "You don't have any upcoming flight to check in for right now." };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: facts.message + " Reply 1 to book your usual flight." }));
      return;
    }
    const f = flightByNo(b.flight_no) || {};
    const route = `${cityName(f.origin)}→${cityName(f.dest)}`;
    if (b.checked_in) {
      const facts = { action: "check_in", state: "already_checked_in", pnr: b.pnr, flight_no: b.flight_no, route, date: b.flight_date, seat: b.seat, group: boardingGroup(userTier(to)) };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp",
        fallback: `You're already checked in for ${b.pnr} (${b.flight_no} ${route}, ${b.flight_date}), seat ${b.seat}, boarding group ${userTier(to) === "Silver" ? "B" : "A"}. Nothing more to do — your boarding pass is in the app.` }));
      return;
    }
    if (f.status === "cancelled") {
      const facts = { action: "check_in", state: "flight_cancelled", pnr: b.pnr, flight_no: b.flight_no, route };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: `${b.flight_no} (${route}) is cancelled, so check-in isn't available. Reply 1 and I'll help you rebook.` }));
      return;
    }
    // Action actually happens here
    db.prepare("UPDATE bookings SET checked_in=1 WHERE id=?").run(b.id);
    { const _waEv = db.prepare("INSERT INTO events (type,payload_json,created_at) VALUES ('wa_checkin',?,?)").run(JSON.stringify({ pnr: b.pnr }), now());
      cdpForward("wa_checkin", { pnr: b.pnr, channel: "WhatsApp" }, Number(_waEv.lastInsertRowid), waUid(to)); }
    const facts = { action: "check_in", state: "checked_in_now", pnr: b.pnr, flight_no: b.flight_no, route, date: b.flight_date, dep: f.dep, seat: b.seat, group: boardingGroup(userTier(to)) };
    await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp",
      fallback: `🎫 Checked in for ${b.pnr} — ${b.flight_no} ${route}, ${b.flight_date}${f.dep ? " · departs " + f.dep : ""}. Boarding group ${boardingGroup(userTier(to))}, seat ${b.seat}. Boarding pass issued; it updates live if anything changes.` }));
    return;
  }

  if (id === "EXTRAS") {
    const anc = db.prepare("SELECT * FROM ancillaries WHERE price > 0").all();
    const map = { "0": "MENU" }; const lines = [];
    anc.forEach((a, i) => { const n = String(i + 1); map[n] = `ANC_${a.code}`; lines.push(`${n}️⃣  ${a.name} — $${a.price}`); });
    setMenu(to, map);
    const card = "your saved card";
    await sendText(to, `Add to your trip — charged to your saved ${card}, instantly on your booking:\n\n${lines.join("\n")}\n\n0 for menu`);
    return;
  }
  if (id.startsWith("ANC_")) {
    const code = id.slice(4);
    const r = await apiCall("POST", "/bookings/ancillary", { code }, to);
    if (r.ok) {
      const cardRow = db.prepare("SELECT card_brand, card_last4 FROM users WHERE id=?").get(waUid(to)) || {};
      const card = "your saved card";
      const facts = { action: "add_extra", state: "added", item: r.name, price: r.price, pnr: r.pnr, card };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: `✅ Added ${r.name} ($${r.price}) to ${r.pnr} — charged to ${card}. Updated itinerary emailed.` }));
    } else {
      const facts = { action: "add_extra", state: "no_booking", message: "There's no active booking to add extras to yet." };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: facts.message + " Reply 1 to book your usual flight." }));
    }
    return;
  }

  if (id === "MADE_FOR_YOU") {
    const rec = await apiCall("GET", "/recommendation", null, to);
    if (!rec?.package) { await sendText(to, "No package available right now — try the main menu."); return sendMainMenu(to); }
    const p = rec.package;
    const emoji = rec.affinity === "football" ? "⚽" : rec.affinity === "golf" ? "⛳" : "🎵";
    const cat = (rec.categories && rec.categories[0]) ? `${rec.categories[0].share}% ${rec.categories[0].name}` : null;
    let body =
`${emoji} *Made for you — ${rec.affinity_label}*
_${cat ? "From your card: " + cat : "From your card spend"}_

*${p.event}*
📍 ${p.venue}
🗓️ ${new Date(p.date).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}

🎟️ Event ticket — $${p.eventPrice}
🏨 ${p.hotel} · ${p.hotelNights}n — $${p.hotelPrice}
✈️ ${p.flightDesc} — $${p.flightPrice}`;
    if (p.addon) body += `\n🧳 ${p.addon.label} — $${p.addon.price} (was $${p.addon.normal})`;
    body += `\n\n*Bundle total: $${p.total}*`;
    await sendButtons(to, body,
      [{ id: "PKG_BOOK", title: "Book package" }, { id: `SEARCHTO_${p.code}`, title: "Just the flight" }, { id: "MENU", title: "Back to menu" }],
      { "1": "PKG_BOOK", "2": `SEARCHTO_${p.code}`, "3": "MENU", "0": "MENU" });
    return;
  }
  if (id === "PKG_BOOK") {
    const rec = await apiCall("GET", "/recommendation", null, to);
    const p = rec?.package;
    if (p) await sendText(to, `🎉 Nice one! Your *${p.event}* package ($${p.total}) is held — event ticket, ${p.hotelNights} nights at ${p.hotel}, and your return flight. Our team will email the confirmation to complete payment.${p.addon ? ` Your ${p.addon.label} is included at $${p.addon.price}.` : ""}`);
    return sendMainMenu(to);
  }
  if (id.startsWith("SEARCHTO_")) {
    const code = id.slice(9);
    const home = db.prepare("SELECT home_airport FROM users WHERE id=?").get(waUid(to))?.home_airport || "MIA";
    return searchRoute(to, home, code, searchToday(), "package flight");   // was `from` (undefined in this scope) — pre-existing bug
  }

  if (id === "SEATMAP_INFO") {
    const u = db.prepare("SELECT tier FROM users WHERE id=?").get(waUid(to));
    const b = db.prepare("SELECT seat FROM bookings WHERE user_id=? AND status='confirmed' ORDER BY flight_date LIMIT 1").get(waUid(to));
    const cur = b?.seat || "22C";
    const tier = u?.tier || "Gold";
    const biz = tier === "Platinum" ? "included" : "$90";
    const prem = (tier === "Platinum" || tier === "Gold") ? "included" : "$18";
    await sendText(to,
`🪑 Seating on your flight — you're in ${cur}.

✈️ Business (rows 1–3) — ${biz} for ${tier}
⭐ Premium Economy (rows 4–7) — ${prem} for ${tier}
💺 Economy (rows 8–30) — free · front rows 8–10 $8

Just tell me a seat (e.g. "change my seat to 12A") or a preference ("window in business") and I'll move you right here.

0 for menu`);
    setMenu(to, { "0": "MENU" });
    return;
  }

  if (id === "WALLET") {
    const u = db.prepare("SELECT miles, card_brand, card_last4 FROM users WHERE id=?").get(waUid(to));
    const v = db.prepare("SELECT code, amount, status, expiry FROM vouchers WHERE user_id=? ORDER BY id DESC LIMIT 1").get(waUid(to));
    const milesVal = (u.miles * 0.003).toFixed(2);
    const facts = { action: "wallet", miles: u.miles, miles_value_eur: +milesVal, voucher: v ? { code: v.code, amount: v.amount, available: v.status === "active", expiry: v.expiry } : null, card: "Saved card" };
    const vLine = v && v.status === "active" ? `🎟️ Voucher ${v.code}: $${v.amount} (expires ${v.expiry})` : "🎟️ No active voucher";
    await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp",
      fallback: `💳 Your wallet\n✈️ Xperion Miles: ${u.miles.toLocaleString()} miles (≈ $${milesVal})\n${vLine}\n💳 Saved card · •••• ••••\n\nYou can pay any trip with a mix of voucher, miles and card. Reply 1 to book your usual flight.` }));
    setMenu(to, { "1": "BOOK_USUAL", "0": "MENU" });
    return;
  }

  if (id === "STATUS") {
    const b = latestBooking(to);
    const f = b ? flightByNo(b.flight_no) : null;
    if (!f) {
      const facts = { action: "flight_status", state: "no_booking", message: "You have no upcoming flight on file." };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: facts.message + " Reply 1 to book one!" }));
      return;
    }
    const route = `${cityName(f.origin)} → ${cityName(f.dest)}`;
    const facts = f.status === "delayed"
      ? { action: "flight_status", state: "delayed", flight_no: f.flight_no, route, new_dep: f.new_dep, new_arr: f.new_arr, pnr: b.pnr }
      : { action: "flight_status", state: "on_time", flight_no: f.flight_no, route, dep: f.dep, date: b.flight_date, pnr: b.pnr };
    const fb = f.status === "delayed"
      ? `⚠️ ${f.flight_no} (${route}) is delayed — new departure ${f.new_dep}, landing ${f.new_arr}. Reply here and I can rebook you.`
      : `🟢 ${f.flight_no} ${route} on ${b.flight_date} is on time. Departure ${f.dep}, gate closes 20 min before. I'll message you if anything changes.`;
    await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: fb }));
    return;
  }

  if (id === "CANCEL") {
    const b = latestBooking(to);
    if (!b) {
      const facts = { action: "cancel", state: "no_booking", message: "You have no active booking to cancel." };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: facts.message }));
      return;
    }
    const f = flightByNo(b.flight_no) || {};
    setMenu(to, { "1": `CONFIRM_CANCEL_${b.id}`, "0": "MENU" });
    await sendText(to,
`You're about to cancel ${b.pnr} (${b.flight_no} ${cityName(f.origin)}→${cityName(f.dest)}, ${b.flight_date}).
Refund goes back instantly to the original split — voucher, miles and card.

Reply:  1 to confirm cancel   ·   0 to keep my booking`);
    return;
  }
  if (id.startsWith("CONFIRM_CANCEL_")) {
    const r = await apiCall("POST", "/bookings/cancel", {}, to);
    if (r.ok) {
      const facts = { action: "cancel", state: "cancelled", pnr: r.pnr, refund: r.refund || { note: "original payment split" } };
      const cardRow = db.prepare("SELECT card_brand, card_last4 FROM users WHERE id=?").get(waUid(to)) || {};
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: `✅ ${r.pnr} cancelled. Refund issued instantly: miles restored, voucher reactivated, card amount returned to your saved card. Confirmation emailed — no forms, no queue.` }));
    } else {
      const facts = { action: "cancel", state: "no_booking", message: "No active booking was found to cancel." };
      await sendText(to, await phraseFromFacts(facts, { channel: "whatsapp", fallback: facts.message }));
    }
    await sendMainMenu(to);
    return;
  }

  /* Disruption rebooking (pushed proactively by the portal's disrupt action) */
  if (id.startsWith("REBOOK_")) {
    const optId = id.slice(7);
    const label = optId === "KEEP" ? "Keep my original flight" : `Move to ${optId}`;
    await apiCall("POST", "/rebook", { option: { id: optId === "KEEP" ? (latestBooking(to)?.flight_no || "XP1927") : optId, label } }, to);
    const keptSeat = (latestBooking(to)?.seat) || (db.prepare("SELECT seat FROM preferences WHERE user_id=?").get(waUid(to)) || {}).seat?.split(" ")[0] || "your seat";
    await sendText(to, `✅ Done — ${label.toLowerCase()}. New boarding pass issued, seat ${keptSeat} kept, confirmation emailed. Nothing else to do.`);
    return;
  }

  if (id === "MENU") return sendMainMenu(to);

  await sendText(to, "Here's the menu:");
  await sendMainMenu(to);
}

/* ── Inbound webhook processing ──────────────────────────────────
   Twilio posts application/x-www-form-urlencoded with fields like
   From="whatsapp:+91...", Body="1". server.js parses the form and
   passes { from, text } here. ─────────────────────────────────── */
// Map a natural-language phrase to a real ancillary code (for "add/remove <extra>").
function matchAncillary(t) {
  let code = null;
  if (/\b(transfers?|airport transfer|taxi|cab|shuttle|ride)\b/.test(t)) code = "transfer";
  else if (/\blounges?\b/.test(t)) code = "lounge";
  else if (/\b(wi-?\s?fi|internet|wireless)\b/.test(t)) code = "wifi";
  else if (/\b(bags?|baggage|luggage|suitcases?)\b/.test(t)) code = "bag";
  else if (/\b(meals?|food|dining|lunch|dinner|catering)\b/.test(t)) code = "meal";
  if (!code) return null;
  return db.prepare("SELECT 1 FROM ancillaries WHERE code=? LIMIT 1").get(code) ? code : null;
}

// Offer of the week — the SAME personalized offer the home screen shows.
async function showOffer(to) {
  const o = await apiCall("GET", "/offers/today", null, to).catch(() => null);
  if (!o) { await sendText(to, "No offer available right now — reply \"menu\"."); return sendMainMenu(to); }
  setMenu(to, { "1": `OFFERBOOK_${o.origin}_${o.dest}`, "0": "MENU" });
  await sendText(to,
`💎 *${o.badge}* — for you
*${o.destCity} from $${o.price}*  (was $${o.was}, −${o.discountPct}%)
${o.originCity} → ${o.destCity}
✨ ${o.perk}
${o.reason}

Reply 1 to book this offer · 0 for menu`);
}



async function handleIncoming({ from, text, pushName }) {
  if (!from) return;
  const bare = bareNumber(from);

  // Resolve identity ONCE by phone and bind a stable wa:<tail> session, so every internal
  // apiCall (via X-Session-Id) and every direct DB read acts as THIS user. Per-sender state
  // (draft/convo/menu/ctx) is already keyed by phone, so senders never collide. Unknown
  // sender → uid 1 (regression-safe default; cutover step 11 swaps default-to-1 for guest).
  const knownUser = session.userByPhone(from);
  const guestMode = !!TRANSPORT || process.env.WA_GUESTS === "1";
  const uid = (knownUser || {}).id || (guestMode ? session.guestForPhone(from, pushName).id : session.SERVER_DEFAULT_UID);
  session.bindSession("wa:" + phoneTail(from), uid, getDataSource());

  logWA("in", from, "text", text, { from, text }, "received");
  { const _waEv = db.prepare("INSERT INTO events (type,payload_json,created_at) VALUES ('wa_inbound',?,?)").run(JSON.stringify({ from: bare, text }), now());
    cdpForward("wa_inbound", { from: bare, text, channel: "WhatsApp" }, Number(_waEv.lastInsertRowid), uid); }
  db.prepare("UPDATE users SET wa_id=? WHERE id=?").run(bare, uid);   // remember partner for proactive push

  /* Enterprise Autonomy: an open disruption offer is answered here first — "2", "take the
     Orlando option", "refund" or "leave it" run the same execution saga as the in-app card. */
  try {
    const hit = require("./autonomy/bridge").intercept(uid, text);
    if (hit) {
      const line = hit.reply || (hit.ok ? "Done." : `I couldn't complete that: ${hit.error || "please try again"}.`);
      return sendText(from, line);
    }
  } catch (e) { console.error("[wa] autonomy intercept:", e.message); }

  const t = (text || "").trim().toLowerCase();

  // 1) If the reply is a number that maps to the menu we last sent → run it
  const choice = resolveChoice(from, text);
  if (choice) return handleAction(from, choice);

  // 1b) Plain-language "add/remove <extra>" during the booking flow (active draft):
  //     "remove transfer", "add wifi", "drop the lounge", "no bags". The numbered
  //     toggles still work — this just understands natural language at the extras step.
  {
    const d = getDraft(from);
    const ancCode = matchAncillary(t);
    const removeIntent = /\b(remove|drop|delete|take ?off|without|cancel|don'?t want|no longer)\b/.test(t) || /^no\s/.test(t);
    const addIntent = /\b(add|include|put|want|with|keep)\b/.test(t);
    if (d && d.flight_no && ancCode && (removeIntent || addIntent)) {
      const has = d.items.includes(ancCode);
      const nm = (db.prepare("SELECT name FROM ancillaries WHERE code=?").get(ancCode) || {}).name || ancCode;
      let note;
      if (removeIntent) { if (has) { d.items = d.items.filter(c => c !== ancCode); note = `Removed ${nm}.`; } else note = `${nm} wasn't added.`; }
      else { if (!has) { d.items.push(ancCode); note = `Added ${nm}.`; } else note = `${nm} is already in your trip.`; }
      return startExtrasStep(from, note);
    }
  }

  // 2) Fast deterministic paths (instant, no LLM needed)
  if (/^(hi|hello|hey|menu|start|olá|ola)\b/.test(t) || t === "") return sendMainMenu(from);
  // "book ... to <city>" names a destination → search that route, don't book the usual.
  // Only a bare "book" / "book my usual" / "usual" (no destination) books the recurring flight.
  if (/^(book|book my usual|usual)\b/.test(t)) {
    const toM = t.match(/\bto\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)/);
    const destFromText = toM ? detectDest(toM[1].trim()) : null;
    if (destFromText) {
      const home = (db.prepare("SELECT home_airport FROM users WHERE id=?").get(uid) || {}).home_airport || "MIA";
      const parsed = parseDate(t);
      if (destFromText === home) {
        // "to <home>" — can't fly home→home; just acknowledge and show the menu.
        await sendText(from, `${cityName(home)} is your home airport — tell me where you'd like to fly to from ${home}.`);
        return sendMainMenu(from);
      }
      return searchRoute(from, home, destFromText, parsed || searchToday(), text);
    }
    return handleAction(from, "BOOK_USUAL");
  }
  if (/^cancel\b/.test(t)) return handleAction(from, "CANCEL");
  if (/^(resume|continue|carry on|pick up|where was i|where were we|finish (my )?booking)\b/.test(t) || /\bcontinue where (i|we) left\b/.test(t)) return handleAction(from, "RESUME");
  if (/^(start (over|fresh|again)|new search|forget (it|that)|scrap (it|that))\b/.test(t)) return handleAction(from, "START_FRESH");
  if (/^check.?in\b/.test(t)) return handleAction(from, "CHECKIN");
  if (/^(status|delay)\b/.test(t)) return handleAction(from, "STATUS");
  if (/\b(my booking|my flight|my trip|booking details|view booking|show booking)\b/.test(t) || /^booking\b/.test(t)) return handleAction(from, "MY_BOOKING");
  if (/\b(offer|offers|deal|deals|special|promo|discount)\b/.test(t) && !/book|cancel|status|check.?in/.test(t)) return showOffer(from);
  if (/\b(packages?|made for me|made for you|recommend|suggestions?|what should i do|things to do|anything fun|what'?s on|whats on|events?|concerts?|matches?|tournaments?|golf|football|music)\b/.test(t) && !/book|cancel|status|check.?in/.test(t)) return handleAction(from, "MADE_FOR_YOU");
  if (/\b(seat options|seating options|available seats|seat map|what seats|which seats)\b/.test(t)) return handleAction(from, "SEATMAP_INFO");
  if (/\b(change|move|switch|upgrade).{0,20}\bseat\b|\bseat\b.{0,20}\b(change|window|aisle|business|premium)\b|\bwindow seat\b|\baisle seat\b/.test(t)) return runAgent(from, text);
  if (/\b(extras|add.?ons?|ancillar|upgrade my)\b/.test(t)) return handleAction(from, "EXTRAS");
  if (/\b(miles|voucher|balance|points|wallet)\b/.test(t) && !/book|pay|use|redeem|fly|flight/.test(t)) return handleAction(from, "WALLET");

  // 2-ctx) Natural-language progression of the in-flow journey — NO numbers needed.
  //   Reads the CURRENT step's menu so free text maps to the right action: pick a flight
  //   from the last list, keep/continue at the seat step, finish extras, or pay / hold.
  //   The numbered options still work; this just lets the customer talk normally.
  {
    const menu = menuContext[bare] || {};
    const vals = Object.values(menu);
    const seatOpts = Object.keys(menu).filter(k => /^\d+$/.test(k) && String(menu[k]).startsWith("SEAT_")).sort((a, b) => +a - +b).map(k => menu[k]);

    // (a) pick a flight from the last shown list ("the second one", "cheapest", "XP1927", "the 9:05")
    if (vals.some(v => String(v).startsWith("PICK_"))) {
      const c = getCtx(from);
      const pick = c && c.flights && resolvePick(t, c.flights);
      if (pick) return handleAction(from, `PICK_${pick}`);
    }
    // (b) SEAT step — keep/continue with the recommended seat, or a typed seat code
    if (seatOpts.length) {
      const code = (t.match(/\b(\d{1,2}[a-f])\b/) || [])[1];
      if (code) { const match = seatOpts.find(s => s.toLowerCase() === `seat_${code}`); if (match) return handleAction(from, match); }
      if (/\b(keep|usual|same|continue|carry on|that'?s fine|sounds good|leave it|default|proceed|next|go ahead)\b/.test(t) || /^(yes|yep|yeah|ok|okay|sure)[\s.!]*$/.test(t)) return handleAction(from, seatOpts[0]);
    }
    // (c) EXTRAS step — finish to review ("done", "nothing else", "continue", "pay")
    if (vals.includes("XDONE") && (/\b(done|continue|next|review|checkout|check out|proceed|nothing( else)?|that'?s all|that is all|skip|pay|finish|good to go|all set|move on)\b/.test(t) || /^(no|nope)[\s.!]*$/.test(t))) return handleAction(from, "XDONE");
    // (d) REVIEW / express — pay, hold, or confirm in words
    if (vals.includes("DO_HOLD") && /\b(hold|fare ?lock|lock (it|the fare)|48 ?h|keep it for)\b/.test(t)) return handleAction(from, "DO_HOLD");
    if (vals.includes("DO_PAY") && (/\b(pay|confirm|book it|complete|purchase|proceed|go ahead|do it|checkout|check out|settle)\b/.test(t) || /^(yes|yep|yeah|sure|ok|okay|confirm|pay)[\s.!]*$/.test(t))) return handleAction(from, "DO_PAY");
    if (vals.includes("EXPRESS_PAY") && (/\b(pay|confirm|book it|complete|purchase|proceed|go ahead|do it|settle)\b/.test(t) || /^(yes|yep|yeah|sure|ok|okay|confirm|pay)[\s.!]*$/.test(t))) return handleAction(from, "EXPRESS_PAY");
  }

  // 2a) Date-only follow-up on an active route — e.g. "how about day after
  //     tomorrow", "what about tomorrow", "and on Friday?". These re-run the
  //     SAME route for a new date. Checked BEFORE the question gate because
  //     they often start with "how/what about".
  {
    const parsedDate = parseDate(t);
    const c = getCtx(from);
    const looksLikeDateFollowup = parsedDate && (/\b(how about|what about|and|same|that route|those|again|instead|change.*date|different date)\b/.test(t) || t.split(/\s+/).length <= 6);
    // Make sure it's NOT a fresh route request (no new city named other than the active one)
    const namesNewCity = /\bto\s+[a-zà-ÿ]/.test(t) && detectDest((t.match(/\bto\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)/)||[])[1] || "");
    if (c && c.dest && looksLikeDateFollowup && !namesNewCity) {
      return searchRoute(from, c.origin, c.dest, parsedDate, text);
    }
  }

  // 2b) Fast deterministic search for an explicit route the user typed, e.g.
  //     "flights to Madrid", "fly to Paris", "options to London from New York",
  //     "New York to Amsterdam". We parse BOTH a destination ("to X") and an
  //     optional origin ("from Y"), so "to London from New York" → JFK→LHR, not
  //     a mangled home-airport guess. Questions go to the AI agent instead.
  const isQuestion = /\?|^(do|does|can|is|are|why|what|which|where|how)\b/.test(t);
  if (!isQuestion) {
    // Capture the city right after "to" (a single city token, not the rest of the sentence)
    const toMatch = t.match(/\bto\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)\b/);
    // Capture the city right after "from"
    const fromMatch = t.match(/\bfrom\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)\b/);
    // Also handle "X to Y" without the word "from" (e.g. "New York to Amsterdam")
    const pairMatch = t.match(/\b([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)\s+to\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)\b/);

    let originCode = null, destCode = null;
    if (fromMatch) originCode = detectDest(fromMatch[1].trim());
    if (toMatch) destCode = detectDest(toMatch[1].trim());
    // "X to Y" pattern fills in origin from the word before "to" when not already set
    if (pairMatch && !originCode) originCode = detectDest(pairMatch[1].trim());
    if (pairMatch && !destCode) destCode = detectDest(pairMatch[2].trim());

    const parsedDate = parseDate(t);

    // Only fire the deterministic search when we have a real destination.
    if (destCode && destCode !== originCode) {
      const home = db.prepare("SELECT home_airport FROM users WHERE id=?").get(uid)?.home_airport || "MIA";
      return searchRoute(from, originCode || home, destCode, parsedDate || searchToday(), text);
    }
  }

  // 3) EVERYTHING ELSE → the LLM agent (same brain as the web chat).
  //    Free-form requests, "options from <city>", factual questions, recommendations,
  //    multi-step booking — all handled intelligently with tools (search/list/book).
  return runAgent(from, text);
}

/* Route a free-form message through the AI agent endpoint and relay the reply
   to WhatsApp. If the agent searched flights, render them as a numbered pick
   list so the user can act with a reply. Falls back to the menu on error. */
async function runAgent(to, text) {
  try {
    // Send the running conversation so the agent has context across turns.
    pushConvo(to, "user", text);
    const messages = getConvo(to);
    const r = await apiCall("POST", "/ai/agent", { messages, screen: "whatsapp", sessionId: bareNumber(to) }, to);   // header drives req.uid; body.sessionId stays the agent scratch key
    if (!r || (!r.reply && !(r.cards && r.cards.length))) return sendMainMenu(to);

    // If the agent produced a flight list, present it as a numbered pick menu
    const flightsCard = (r.cards || []).find(c => c.type === "flights");
    if (flightsCard && flightsCard.flights?.length) {
      const flights = flightsCard.flights.slice(0, 5);
      const map = { "0": "MENU" }; const lines = [];
      flights.forEach((f, i) => { const n = String(i + 1); map[n] = `PICK_${f.flight_no}`; lines.push(`${n}️⃣  ${f.flight_no} · ${f.dep}–${f.arr} · $${f.price}${f.recommended ? " ⭐" : ""}`); });
      setMenu(to, map);
      setCtx(to, { origin: flightsCard.origin, dest: flightsCard.dest, date: flightsCard.date, flights: flights.map(f => ({ flight_no: f.flight_no, dep: f.dep, arr: f.arr, price: f.price })) });
      const head = r.reply ? r.reply + "\n\n" : "";
      const body = `${head}✈️ ${cityName(flightsCard.origin)} → ${cityName(flightsCard.dest)} · ${flightsCard.date}\nReply with a number:\n\n${lines.join("\n")}\n\n0 for menu`;
      // Record an assistant turn that names the flights, so a follow-up like
      // "does XP1481 have availability?" can be resolved from context.
      pushConvo(to, "assistant", `${r.reply ? r.reply + " " : ""}Showed ${cityName(flightsCard.origin)}→${cityName(flightsCard.dest)} on ${flightsCard.date}: ` + flights.map(f => `${f.flight_no} ${f.dep}-${f.arr} $${f.price}`).join("; "));
      await sendText(to, body);
      return;
    }

    // If the agent confirmed a booking/checkout, relay it and return to menu
    const conf = (r.cards || []).find(c => c.type === "confirmation");
    if (conf) { pushConvo(to, "assistant", r.reply || `Booked ${conf.pnr}`); await sendText(to, r.reply || `✅ Booked! Confirmation ${conf.pnr}.`); return sendMainMenu(to); }

    // Otherwise just relay the agent's text answer (recommendations, Q&A, etc.)
    pushConvo(to, "assistant", r.reply || "");
    await sendText(to, r.reply);
    // keep the conversation actionable
    setMenu(to, { "1": "BOOK_USUAL", "2": "MY_BOOKING", "3": "EXTRAS", "4": "STATUS", "5": "CHECKIN", "6": "CANCEL" });
  } catch (e) {
    await sendText(to, "Let me show you what I can do:");
    return sendMainMenu(to);
  }
}

/* Resolve a destination from free text → IATA code, using the airports table.
   Uses word-boundary matching so "london" never accidentally matches inside
   another token, and checks the curated alias map first for reliability. */
function detectDest(t) {
  t = (t || "").toLowerCase().trim();
  // direct IATA code mention
  const codeMatch = t.toUpperCase().match(/\b(JFK|MIA|MAD|CDG|CUN|MCO|LON|LHR|FCO|FRA|BRU|AMS|GVA|ZRH|MUC|MXP|ORY|JFK|GRU|MIA|LAS|EWR)\b/);
  if (codeMatch && AIRPORTS[codeMatch[1]]) return codeMatch[1];
  // curated aliases first (incl. multi-word + persona cities) — most reliable
  const alias = { lisbon: "LIS", porto: "OPO", oporto: "OPO", madrid: "MAD", paris: "CDG", funchal: "FNC", cancun: "CUN", cancún: "CUN", orlando: "MCO", barcelona: "BCN", "las vegas": "LAS", vegas: "LAS", "san juan": "SJU", nassau: "NAS", atlanta: "ATL", chicago: "ORD", "los angeles": "LAX", "la": "LAX", boston: "BOS", dallas: "DFW", houston: "IAH", denver: "DEN", seattle: "SEA", "san francisco": "SFO", delhi: "DEL", "new delhi": "DEL", mumbai: "BOM", london: "LHR", rome: "FCO", frankfurt: "FRA", brussels: "BRU", amsterdam: "AMS", geneva: "GVA", zurich: "ZRH", munich: "MUC", milan: "MXP", "new york": "JFK", "newyork": "JFK", nyc: "JFK", "sao paulo": "GRU", "são paulo": "GRU", saopaulo: "GRU", miami: "MIA", faro: "FAO", dublin: "DUB", "ponta delgada": "PDL" };
  for (const [name, code] of Object.entries(alias)) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t) && AIRPORTS[code]) return code;
  }
  // city-name scan with WORD BOUNDARIES (so "london" can't match inside other text)
  for (const [code, a] of Object.entries(AIRPORTS)) {
    if (!a.city) continue;
    const city = a.city.toLowerCase();
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return code;
  }
  return null;
}

/* Parse a date phrase → YYYY-MM-DD. "Today" is the demo anchor (2026-06-15) but
   rolls forward to the real current date (see searchToday) so relative dates and
   undated searches are never in the past. Handles today/tonight,
   tomorrow and day after tomorrow (incl. chat shorthand like "tomm" / "tmrw"), weekday
   names, this/next weekend, "in N days", next week, natural calendar dates ("20th june",
   "june 20", "20/06", "the 20th") with optional year, and an explicit YYYY-MM-DD. Returns
   null if no date phrase is present. Shared with the web AI agent (server.js) so both
   channels resolve dates identically. */
function parseDate(t) {
  const TODAY = new Date(searchToday() + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const add = (n) => { const d = new Date(TODAY); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  // the many ways people write "tomorrow" in a chat box (no bare "tom" — that's a name)
  const TM = "(?:tomorrow|tomorow|tommorow|tommorrow|tomoz|tomm|tmrw|tmw|2moro|2morrow)";
  const explicit = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit) return explicit[1];
  if (new RegExp(`\\bday after ${TM}\\b`).test(t)) return add(2);
  if (new RegExp(`\\b${TM}\\b`).test(t)) return add(1);
  if (/\btoday\b|\btonight\b/.test(t)) return add(0);
  if (/\b(this |next )?weekend\b/.test(t)) { // next Saturday
    let d = new Date(TODAY); const days = (6 - d.getUTCDay() + 7) % 7 || 7; d.setUTCDate(d.getUTCDate() + days); return iso(d);
  }
  const wd = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const [name, idx] of Object.entries(wd)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      let d = new Date(TODAY); const days = (idx - d.getUTCDay() + 7) % 7 || 7; d.setUTCDate(d.getUTCDate() + days); return iso(d);
    }
  }
  if (/\bin (\d+) days?\b/.test(t)) { const m = t.match(/\bin (\d+) days?\b/); return add(parseInt(m[1])); }
  if (/\bnext week\b/.test(t)) return add(7);

  // ── Natural calendar dates ───────────────────────────────────────────────
  // "20 june", "20th june", "20th of june", "june 20", "june 20th", "20/06",
  // "16/06/2026", and a bare "the 20th". Year is optional; when omitted we take
  // the NEXT occurrence (so "20 june" with today 15 Jun → this 20 Jun, but a date
  // already past → same date next year). Numeric form is day/month (European).
  const MON = { jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4,
    may:5, jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9,
    oct:10, october:10, nov:11, november:11, dec:12, december:12 };
  const monRe = Object.keys(MON).join("|");
  const fromYMD = (mm, dd, yr) => {
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
    let y = yr ? parseInt(yr.length === 2 ? "20" + yr : yr, 10) : TODAY.getUTCFullYear();
    let d = new Date(Date.UTC(y, mm - 1, dd));
    if (!yr && d < TODAY) d = new Date(Date.UTC(y + 1, mm - 1, dd)); // next occurrence
    return iso(d);
  };
  let dm;
  // day-then-month: "20 june", "20th june", "20th of june", optional trailing year
  if ((dm = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monRe})\\b(?:[, ]+(\\d{4}))?`)))) {
    const r = fromYMD(MON[dm[2]], parseInt(dm[1], 10), dm[3]); if (r) return r;
  }
  // month-then-day: "june 20", "june 20th", optional trailing year
  if ((dm = t.match(new RegExp(`\\b(${monRe})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:[, ]+(\\d{4}))?`)))) {
    const r = fromYMD(MON[dm[1]], parseInt(dm[2], 10), dm[3]); if (r) return r;
  }
  // numeric day/month(/year), slash only to avoid clashing with "2-3 days" etc.
  if ((dm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const r = fromYMD(parseInt(dm[2], 10), parseInt(dm[1], 10), dm[3]); if (r) return r;
  }
  // bare day-of-month: "the 20th", "on the 3rd", "20th" (needs the ordinal suffix)
  if ((dm = t.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/))) {
    const dd = parseInt(dm[1], 10);
    if (dd >= 1 && dd <= 31) {
      const m = TODAY.getUTCMonth(), y = TODAY.getUTCFullYear();
      let d = new Date(Date.UTC(y, m, dd));
      if (d < TODAY) d = new Date(Date.UTC(y, m + 1, dd)); // already past → next month
      return iso(d);
    }
  }
  return null;
}

/* Free-route search → numbered flight list (mirrors the web AI chat). */
async function searchRoute(to, origin, dest, date = searchToday(), userText) {
  const r = await apiCall("GET", `/search?origin=${origin}&dest=${dest}&date=${date}`, null, to);
  if (userText) pushConvo(to, "user", userText);
  if (!r.ok || !r.flights?.length) {
    const msg = `Hmm, I couldn't find a ${cityName(origin)} → ${cityName(dest)} flight in our network. Try another city, or reply "menu".`;
    pushConvo(to, "assistant", msg);
    await sendText(to, msg);
    return;
  }
  const flights = r.flights.slice(0, 5);
  const map = { "0": "MENU" }; const lines = [];
  flights.forEach((f, i) => {
    const n = String(i + 1);
    map[n] = `PICK_${f.flight_no}`;
    lines.push(`${n}️⃣  ${f.flight_no} · ${f.dep}–${f.arr} · $${f.price}${f.recommended ? " ⭐" : ""}`);
  });
  setMenu(to, map);
  // Remember the active route + date AND the shown flights, so a follow-up can pick by
  // position/attribute ("the second one", "cheapest") or a date-only follow-up re-runs the route.
  setCtx(to, { origin, dest, date, flights: flights.map(f => ({ flight_no: f.flight_no, dep: f.dep, arr: f.arr, price: f.price })) });
  // Record it in the conversation so the AI agent has context on any follow-up.
  pushConvo(to, "assistant", `Showed ${cityName(origin)}→${cityName(dest)} on ${date}: ` + flights.map(f => `${f.flight_no} ${f.dep}-${f.arr} $${f.price}`).join("; "));
  await sendText(to,
`✈️ ${cityName(origin)} → ${cityName(dest)} · ${date}
Found ${flights.length} flights — reply with a number to pick:

${lines.join("\n")}

0 for menu`);
}

/* ── Proactive push: portal disruption → WhatsApp text ───────── */
async function pushDisruption(f, recovery, uid = session.SERVER_DEFAULT_UID) {
  const to = process.env.WHATSAPP_DEFAULT_TO || db.prepare("SELECT wa_id FROM users WHERE id=?").get(uid)?.wa_id;
  if (!to) { logWA("out", "", "skipped", "Disruption push skipped — no WhatsApp recipient known yet", {}, "no recipient"); return "no recipient"; }
  // Bind this user's wa:<tail> session so a follow-up REBOOK apiCall acts as THEM (not uid 1).
  session.bindSession("wa:" + phoneTail(to), uid, getDataSource());
  const opts = (recovery.options || []).slice(0, 2);
  const keep = opts[0]?.label || "Keep my flight";
  const move = opts[1]?.label || "Move me to the next flight";
  const moveId = opts[1]?.id || "XP1931";
  setMenu(to, { "1": "REBOOK_KEEP", "2": `REBOOK_${moveId}` });
  return sendText(to,
`⚠️ ${recovery.headline}

${recovery.message}

🛡 ${recovery.compensation}

Reply:  1 to ${keep}   ·   2 to ${move}`);
}

module.exports = { handleIncoming, pushDisruption, sendMainMenu, sendText, sendButtons, CONFIGURED, MODE, setTransport, parseDate };
