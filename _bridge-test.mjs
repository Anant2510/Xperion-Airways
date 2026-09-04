// Bridge acceptance: the disruption scenario as the customer experiences it in the live app.
// Drives the running server over HTTP. Usage: BASE=http://127.0.0.1:7810 node _bridge-test.mjs
const BASE = process.env.BASE || "http://127.0.0.1:7810";
const H = { "content-type": "application/json" };
const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b || {}) }).then((r) => r.json());
const wa = (from, body) => fetch(BASE + "/api/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: from, Body: body }) }).then((r) => r.text());
const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

/* 0 · start as Daniel */
await post("/api/persona", { persona: "daniel" });
const profile = await get("/api/profile");
const uid = profile.user.id;
const phone = profile.user.phone;

/* 1 · world reset links real customers */
const reset = await post("/api/autonomy/sim/reset");
ok("world reset links real customers", reset.ok && reset.linked?.length >= 5, `${reset.linked?.length} linked, synthetic ${reset.passengers}`);
const me = reset.linked?.find((l) => l.uid === uid);
ok("Daniel is a Passenger/PNR in the graph", !!me, me && `pnr ${me.pnr}`);

/* 2 · the trip is a real booking in My Trips */
let bookings = await get("/api/bookings");
let trip = bookings.find((b) => b.pnr === me?.pnr);
ok("booking row exists with DEL→MIA XP201 resolved", trip && trip.flight?.origin === "DEL" && trip.flight?.dest === "MIA" && trip.flight_no === "XP201", trip && `${trip.flight_no} ${trip.flight_date} ${trip.flight?.dep}→${trip.flight?.arr} · ${trip.days_to_go} days to go`);

/* 3 · T-72 watch: no customer contact */
const t72 = await post("/api/autonomy/sim/t72");
let inbox = await get("/api/autonomy/customer/inbox");
ok("T-72 WATCH: probability < .60 and no message to the customer", t72.ok && t72.p < 0.6 && inbox.messages.filter((m) => m.kind.startsWith("disruption")).length === 0, `p=${t72.p}`);
let st = await get("/api/autonomy/customer/status");
ok("status: linked + monitoring, nothing pending", st.linked && !st.pending && st.prediction?.state === "WATCH", `state ${st.prediction?.state}`);

/* 4 · T-48 act: proactive offer lands in the app */
const t48 = await post("/api/autonomy/sim/t48");
inbox = await get("/api/autonomy/customer/inbox");
const offerMsg = inbox.messages.find((m) => m.kind === "disruption_offer");
ok("T-48 ACT: proactive offer in Daniel's assistant inbox", t48.ok && !!offerMsg, offerMsg && offerMsg.text.slice(0, 110) + "…");
ok("card carries options with one-tap ids", offerMsg?.card?.options?.length >= 2 && offerMsg.card.options.every((o) => o.id && o.label), offerMsg && offerMsg.card.options.map((o) => o.type).join(" | "));
ok("card carries probability + hold TTL", offerMsg?.card?.probability >= 60 && !!offerMsg?.card?.holdUntil, offerMsg && `${offerMsg.card.probability}% · held until ${offerMsg.card.holdUntil}`);
st = await get("/api/autonomy/customer/status");
ok("status: pending offer + unseen banner count", !!st.pending && st.unseen >= 1, `unseen ${st.unseen}, channel ${st.pending?.channel}`);
ok("preferred channel honoured (whatsapp when a phone is on file)", st.pending?.channel === "whatsapp", `channel ${st.pending?.channel}`);
await new Promise((r) => setTimeout(r, 400));   // delivery is asynchronous
const notes = await get("/api/notifications");
const offNote = (notes.notifications || []).find((n) => n.event === "disruption_offer");
ok("notification recorded with an honest provider status", !!offNote, offNote && `${offNote.channel}: ${offNote.status}`);
const audit = await get("/api/autonomy/audit?limit=200");
ok("audit trail shows DELIVER_OFFER for the app customer", audit.events.some((e) => e.action === "DELIVER_OFFER"), "");
const ops = await get("/api/autonomy/status");
ok("ops status lists linked real customers with offer state", ops.linked?.some((l) => l.uid === uid && l.state === "SENT"), ops.linked && ops.linked.filter((l) => l.state === "SENT").length + " with offers");

/* 5 · the assistant answers about the flight from the graph (offline agent) */
const chat1 = await post("/api/ai/agent", { messages: [{ role: "user", content: "what's happening with my Miami flight?" }], screen: "home", sessionId: "bridge-test" });
ok("assistant explains the disruption + options from the graph", /tornado|weather|option/i.test(chat1.reply || ""), (chat1.reply || "").slice(0, 100) + "…");

/* 6 · accept in plain language in the assistant → saga → booking updated */
const chat2 = await post("/api/ai/agent", { messages: [{ role: "user", content: "I'll take the Orlando option with the hotel" }], screen: "home", sessionId: "bridge-test" });
ok("plain-language accept runs the execution saga", chat2.ai === "autonomy" && /Done/.test(chat2.reply || ""), (chat2.reply || "").slice(0, 120) + "…");
ok("confirmation card returned in chat", chat2.cards?.[0]?.type === "disruption_confirmed" && chat2.cards[0].items?.length >= 3, chat2.cards?.[0] && chat2.cards[0].items.join(" · "));
bookings = await get("/api/bookings");
trip = bookings.find((b) => b.pnr === me?.pnr);
ok("real booking rebooked with the recovery bundle", trip?.status === "rebooked" && trip?.meta?.recovery?.type === "DIVERT_PLUS_GROUND", trip && `${trip.status} · ${trip.meta.recovery.label}`);
ok("home hero / My Trips will show the diversion (dest MCO)", trip?.flight?.dest === "MCO", trip && `${trip.flight.origin}→${trip.flight.dest}`);
st = await get("/api/autonomy/customer/status");
ok("nothing pending after acceptance; offer marked executed", !st.pending && st.booking?.recovery, "");
inbox = await get("/api/autonomy/customer/inbox");
ok("confirmation mirrored into the assistant inbox", inbox.messages.some((m) => m.kind === "disruption_confirmed"), "");
const chat3 = await post("/api/ai/agent", { messages: [{ role: "user", content: "what's the status of my flight now?" }], screen: "home", sessionId: "bridge-test" });
ok("assistant now reports the recovery as done", /handled|rebooked|Orlando/i.test(chat3.reply || ""), (chat3.reply || "").slice(0, 100) + "…");
const audit2 = await get("/api/autonomy/audit?limit=300");
ok("audit: SAGA_COMPLETE + APPLY_TO_BOOKING for the app customer", audit2.events.some((e) => e.action === "SAGA_COMPLETE") && audit2.events.some((e) => e.action === "APPLY_TO_BOOKING"), "");

/* 7 · WhatsApp path: a fresh world, Daniel replies "1" on WhatsApp */
await post("/api/autonomy/sim/reset"); await post("/api/autonomy/sim/t72"); await post("/api/autonomy/sim/t48");
await wa(phone, "1"); await new Promise((r) => setTimeout(r, 800));   // webhook acks fast, replies asynchronously
const adminDb = await get("/api/admin/db");
const waOut = ((adminDb.tables && adminDb.tables.wa_messages) || []).filter((r) => r.direction === "out")[0] || {};
ok("WhatsApp reply '1' accepts the first option via the same saga", /Done/.test(waOut.body || waOut.text || ""), String(waOut.body || waOut.text || "").slice(0, 110) + "…");
bookings = await get("/api/bookings"); trip = bookings.find((b) => b.pnr === me?.pnr);
ok("booking updated from the WhatsApp acceptance", ["rebooked", "refund_pending"].includes(trip?.status), trip && `${trip.status} · ${trip.meta?.recovery?.label}`);

/* 8 · decline path + all-clear on stand-down */
await post("/api/autonomy/sim/reset"); await post("/api/autonomy/sim/t72"); await post("/api/autonomy/sim/t48");
const dec = await post("/api/ai/agent", { messages: [{ role: "user", content: "no thanks, leave it as it is" }], screen: "home", sessionId: "bridge-test" });
ok("decline in plain language is honoured", dec.ai === "autonomy" && /leave your booking/i.test(dec.reply || ""), (dec.reply || "").slice(0, 80) + "…");
st = await get("/api/autonomy/customer/status");
ok("declined offer no longer pending; booking untouched", !st.pending && st.booking?.status === "confirmed", st.booking?.status);

/* 9 · synthetic suite untouched: in-process world stays at 214 */
const inproc = await get("/api/autonomy/graph");
const paxN = (inproc.stats?.nodes || []).find((k) => k.kind === "Passenger")?.n || 0;
ok("graph holds 214 synthetic + 11 real passengers", paxN === 225, `Passenger nodes ${paxN}`);

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== BRIDGE: ${passed}/${results.length} checks passed =====`);
if (passed < results.length) { console.log("Failures:"); results.filter((r) => !r.pass).forEach((r) => console.log("  ✖ " + r.name)); process.exit(1); }
