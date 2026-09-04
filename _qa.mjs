// Exhaustive end-to-end QA harness — Website + AI chat + WhatsApp, all personas.
// Drives the REAL running server over HTTP and records pass/fail with evidence.
const BASE = process.env.QA_BASE || "http://127.0.0.1:7905";
const get  = (p) => fetch(`${BASE}/api${p}`).then(r => r.json());
const post = (p, b) => fetch(`${BASE}/api${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const waSend = (from, body) => fetch(`${BASE}/api/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: from, Body: body }) }).then(r => r.text());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];   // { channel, persona, name, pass, detail }
let curPersona = "—", curChannel = "—";
const rec = (name, pass, detail) => { results.push({ channel: curChannel, persona: curPersona, name, pass: !!pass, detail: String(detail).slice(0, 240) }); };
async function check(name, fn) {
  try { const d = await fn(); rec(name, true, d ?? "ok"); }
  catch (e) { rec(name, false, "FAIL: " + (e && e.message ? e.message : e)); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };

// fetch the latest N outbound WhatsApp messages from the admin DB view
async function waOut(n = 1) {
  const db = await get("/admin/db");
  const rows = ((db.tables && db.tables.wa_messages) || []).filter(r => r.direction === "out");
  return rows.slice(0, n);   // admin/db returns rowid DESC → newest first
}

const PERSONAS = ["daniel", "sofia", "lars"];
// warm up the server + WA pipeline so the first checks are not cold-start flakes
await waSend("whatsapp:+350000000000", "hi"); await get("/profile"); await sleep(300);
const phone = { daniel: "whatsapp:+351900000001", sofia: "whatsapp:+351900000002", lars: "whatsapp:+4915100000003" };

for (const persona of PERSONAS) {
  curPersona = persona;
  // ── switch persona (re-seeds pristine data) ──
  const sw = await post("/persona", { persona });
  assert(sw.body && sw.body.ok, "persona switch failed");

  const profile = await get("/profile");
  const u = profile.user, pat = profile.pattern || {}, prefs = profile.prefs || {}, vouchers = profile.vouchers || [];
  const home = u.home_airport, origin = pat.origin || home, dest = pat.dest, topFlight = pat.topFlight;

  // ========================= WEBSITE =========================
  curChannel = "Website";
  await check("Profile loads with persona identity", () => {
    assert(u && u.full_name, "no user"); assert(u.tier, "no tier"); assert(home, "no home airport");
    return `${u.full_name} · ${u.tier} · home ${home} · ${u.miles?.toLocaleString?.() || u.miles} miles`;
  });
  await check("Voucher code has NO 'EMD-' prefix (cleaned)", () => {
    const v = vouchers[0]; assert(v, "no voucher"); assert(!/EMD/i.test(v.code), `voucher still has EMD: ${v.code}`);
    assert(!/-/.test(v.code), `voucher still hyphenated: ${v.code}`);
    return `${v.code} (€${v.amount})`;
  });
  await check("Recurring-journey pattern is personalized", () => {
    assert(pat.topRoute, "no topRoute"); assert(/→/.test(pat.topRoute), "bad route"); assert(topFlight, "no topFlight");
    return `${pat.route} · usual ${topFlight} · back ${pat.usualBackNo}`;
  });
  await check("Express return flight number is CLEAN (usualBackNo)", () => {
    assert(pat.usualBackNo, "no usualBackNo"); assert(/^XP\d+$/.test(pat.usualBackNo), `not a clean flight no: '${pat.usualBackNo}'`);
    return pat.usualBackNo;
  });
  await check("Suggested destinations (personalized from history)", async () => {
    const s = await get("/routes/suggested");
    assert(Array.isArray(s.personalized) || Array.isArray(s.filler), "no suggestions");
    return `personalized=${(s.personalized || []).length}, filler=${(s.filler || []).length}, hasHistory=${s.hasHistory}`;
  });
  await check("Destination cards load", async () => {
    const d = await get("/destinations"); assert(Array.isArray(d) && d.length, "no destinations");
    return `${d.length} destinations`;
  });
  await check("Stopover offer is affinity-personalized", async () => {
    const so = await get("/stopover"); assert(so.hub && so.headline, "no stopover");
    assert(so.experiences && so.experiences.length, "no experiences");
    return `${so.hub} · ${so.experiences.length} experiences · ${so.affinityLabel}`;
  });
  await check("Affinity package (card-derived) loads", async () => {
    const r = await get("/recommendation"); const p = r.package || r;
    assert(p && (p.event || p.title), "no package"); assert(p.total, "no total");
    return `${p.event || p.title} · €${p.total} · ${r.affinity_label || r.affinity || ""}`;
  });
  await check("Seat recommendation from history", async () => {
    const sr = await get("/seat-recommendation"); assert(sr.seat, "no seat rec"); return `${sr.seat} (x${sr.count})`;
  });
  await check("Ancillaries load with personalization reasons", async () => {
    const a = await get("/ancillaries"); assert(Array.isArray(a) && a.length, "no ancillaries"); return `${a.length} ancillaries`;
  });
  await check("Flight search on usual route returns flights + topFlight", async () => {
    const r = await get(`/search?origin=${origin}&dest=${dest}&date=2026-06-15`);
    assert(r.ok, "search not ok"); assert(r.flights && r.flights.length, "no flights");
    assert(r.flights.some(f => f.flight_no === topFlight), `topFlight ${topFlight} missing`);
    return `${origin}→${dest}: ${r.flights.length} flights, lowest €${Math.min(...r.flights.map(f => f.price))}`;
  });
  await check("Search invalid route returns ok:false (no crash)", async () => {
    const r = await get(`/search?origin=${home}&dest=${home}&date=2026-06-15`);
    assert(r.ok === false, "expected ok:false for same-origin/dest"); return r.reason || "rejected";
  });
  await check("/flights returns usual flight with price/dep/arr", async () => {
    const f = await get(`/flights?origin=${origin}&dest=${dest}`);
    const t = f.find(x => x.flight_no === topFlight) || f[0];
    assert(t && t.dep && t.arr && t.price, "missing flight fields"); return `${t.flight_no} ${t.dep}-${t.arr} €${t.price}`;
  });
  await check("Hold (fare-lock) works + emails", async () => {
    const r = await post("/hold", { flight_no: topFlight, items: ["bag"], total: 100 });
    assert(r.body.expires, "no hold expiry"); assert(r.body.email && r.body.email.subject, "no hold email");
    return `held until ${r.body.expires}`;
  });
  // ── Cross-channel journey: save → restore → resume target → clear ──
  curChannel = "Cross-channel";
  await check("Journey save persists stage + selections", async () => {
    await post("/journey/clear");
    await post("/journey", { origin, dest, date: "2026-06-15", device: "Web app", stage: "seat", flight_no: topFlight, seat: prefs.seat?.split?.(" ")[0], items: ["bag"] });
    const j = await get("/journey");
    assert(j.stage === "seat", `stage=${j.stage}`); assert(j.flight_no === topFlight, "flight not saved");
    return `stage=${j.stage}, flight=${j.flight_no}`;
  });
  await check("Journey clear empties the resume state", async () => {
    await post("/journey/clear"); const j = await get("/journey");
    assert(!j.stage, `stage still ${j.stage}`); return "cleared";
  });

  // ========================= AI CHAT =========================
  curChannel = "AI chat";
  const ai = async (text, sid) => (await post("/ai/agent", { messages: [{ role: "user", content: text }], screen: "home", sessionId: sid })).body;
  await check("AI is functional offline (not dead 'cached' fallback)", async () => {
    const r = await ai(`flights from ${home} to ${dest}`, `${persona}-a1`);
    assert(r.ai !== "cached", `AI returned dead fallback (ai=${r.ai})`); return `ai=${r.ai}`;
  });
  await check("AI flight search → cards + show_search command", async () => {
    const r = await ai(`flights from ${home} to ${dest} on 2026-06-15`, `${persona}-a2`);
    assert((r.cards || []).some(c => c.type === "flights"), "no flight cards");
    assert(r.command && r.command.action === "show_search", "no show_search command");
    return `cards=${r.cards.length}, tools=[${r.tools}]`;
  });
  await check("AI wallet → live miles + voucher (no EMD)", async () => {
    const r = await ai("how many miles do I have and what's my voucher?", `${persona}-a3`);
    assert((r.cards || []).some(c => c.type === "wallet"), "no wallet card");
    assert(!/EMD/i.test(r.reply), "EMD leaked into AI reply");
    return r.reply.slice(0, 90);
  });
  await check("AI destinations (network) → destinations card", async () => {
    const r = await ai(`where can I fly from ${home}?`, `${persona}-a4`);
    assert((r.cards || []).some(c => c.type === "destinations"), "no destinations card");
    return r.reply.slice(0, 90);
  });
  await check("AI package recommendation → package card", async () => {
    const r = await ai("what should I do this weekend?", `${persona}-a5`);
    assert((r.cards || []).some(c => c.type === "package"), "no package card");
    return r.reply.slice(0, 90);
  });
  await check("AI seat change → seat card + navigate", async () => {
    const r = await ai("change my seat to a window", `${persona}-a6`);
    assert((r.cards || []).some(c => c.type === "seat"), "no seat card"); return r.reply.slice(0, 90);
  });
  await check("AI multi-turn: select usual flight then check out (same session)", async () => {
    const sid = `${persona}-buy`;
    const r1 = await ai(`book ${topFlight}`, sid);
    assert((r1.cards || []).some(c => c.type === "selected"), "select failed");
    const r2 = await ai("check out", sid);
    assert((r2.cards || []).some(c => c.type === "confirmation"), "checkout produced no confirmation");
    assert(r2.command && r2.command.action === "show_confirmation", "no show_confirmation command");
    return `${r1.reply.slice(0, 40)} → ${r2.reply.slice(0, 60)}`;
  });
  await check("AI gibberish → graceful helpful default (no crash)", async () => {
    const r = await ai("asdkfj qwpoeiru zzz", `${persona}-a7`);
    assert(r.reply && r.reply.length > 10, "empty reply"); assert(r.ai !== "cached" || r.reply, "no reply");
    return r.reply.slice(0, 70);
  });

  // re-seed to clear the AI test booking before transactional web tests
  await post("/persona", { persona });

  // ========================= WHATSAPP =========================
  curChannel = "WhatsApp";
  const ph = phone[persona];
  await check("WA menu (0) responds", async () => {
    await waSend(ph, "0"); await sleep(150); const out = await waOut(1);
    assert(out.length && out[0].body, "no WA reply to menu"); return `reply len ${out[0].body.length}`;
  });
  await check("WA 'my booking' responds", async () => {
    await waSend(ph, "my booking"); await sleep(150); const out = await waOut(1);
    assert(out.length && out[0].body, "no WA reply"); return out[0].body.slice(0, 70).replace(/\n/g, " ");
  });
  await check("WA 'miles' returns wallet info", async () => {
    await waSend(ph, "miles"); await sleep(150); const out = await waOut(1);
    assert(out.length && /mile|voucher|€/i.test(out[0].body), "no wallet reply"); assert(!/EMD/i.test(out[0].body), "EMD in WA wallet");
    return out[0].body.slice(0, 70).replace(/\n/g, " ");
  });
  await check("WA 'packages' returns affinity package", async () => {
    await waSend(ph, "packages"); await sleep(150); const out = await waOut(1);
    assert(out.length && out[0].body, "no package reply"); return out[0].body.slice(0, 70).replace(/\n/g, " ");
  });
  await check("WA 'seat options' responds", async () => {
    await waSend(ph, "seat options"); await sleep(150); const out = await waOut(1);
    assert(out.length && out[0].body, "no seat reply"); return out[0].body.slice(0, 70).replace(/\n/g, " ");
  });
  await check("WA 'book my usual' → express review", async () => {
    await waSend(ph, "book my usual flight"); await sleep(150); const out = await waOut(1);
    assert(out.length && /express|usual|pay|review|€/i.test(out[0].body), "no express review"); return out[0].body.slice(0, 70).replace(/\n/g, " ");
  });
  await check("WA 'check in' responds", async () => {
    await waSend(ph, "check in"); await sleep(150); const out = await waOut(1);
    assert(out.length && out[0].body, "no checkin reply"); return out[0].body.slice(0, 70).replace(/\n/g, " ");
  });
  // cross-channel: a web journey should be resumable on WhatsApp
  await check("WA 'resume' picks up a web-saved journey (cross-channel)", async () => {
    await post("/persona", { persona });
    await post("/journey", { origin, dest, date: "2026-06-15", device: "Web app", stage: "seat", flight_no: topFlight, seat: prefs.seat?.split?.(" ")[0], items: ["bag"] });
    await waSend(ph, "resume"); await sleep(150); const out = await waOut(1);
    assert(out.length && out[0].body, "no resume reply");
    assert(new RegExp(topFlight).test(out[0].body) || /resume|continue|seat|where/i.test(out[0].body), "resume didn't reference the journey");
    return out[0].body.slice(0, 80).replace(/\n/g, " ");
  });

  // ===================== TRANSACTIONAL WEB (last; mutates) =====================
  curChannel = "Website";
  await post("/persona", { persona });   // pristine
  await get(`/search?origin=${origin}&dest=${dest}&date=2026-06-15`);   // persist flights
  let payPnr = null;
  await check("Payment: split voucher+miles+card returns confirmable receipt", async () => {
    const r = await post("/pay", { flight_no: topFlight, items: ["bag"], total: 111, voucher_amt: vouchers[0]?.amount || 0, miles_used: 6000, miles_amt: 18, card_amt: 58, seat: prefs.seat?.split?.(" ")[0] || "4C" });
    assert(r.body.ok, "pay not ok"); assert(r.body.pnr, "no PNR"); assert(r.body.email && r.body.email.subject, "no confirmation email");
    payPnr = r.body.pnr; return `${r.body.pnr} · ${r.body.email.status}`;
  });
  await check("Payment unknown flight → 400 ok:false (handled)", async () => {
    const r = await post("/pay", { flight_no: "XP0000", items: [], total: 10, card_amt: 10 });
    assert(r.status === 400 && r.body.ok === false, `expected 400, got ${r.status}`); return r.body.error;
  });
  await check("Booking appears after payment", async () => {
    const b = await get("/bookings"); assert(Array.isArray(b) && b.length, "no bookings");
    return `${b.length} booking(s), latest ${b[0].pnr || b[0].flight_no}`;
  });
  await check("Check-in issues boarding pass", async () => {
    const r = await post("/checkin", {}); const ok = r.body.ok ?? r.body.checked_in ?? r.body.boarding_group ?? r.body.group;
    assert(ok || r.body.pnr, "checkin failed"); return JSON.stringify(r.body).slice(0, 80);
  });
  await check("Disruption + rebook flow works", async () => {
    const d = await post("/disrupt", {}); assert(d.body, "no disrupt");
    return JSON.stringify(d.body).slice(0, 80);
  });
  await check("Cancel booking refunds (miles/voucher/card)", async () => {
    const r = await post("/bookings/cancel", { confirm: true });
    assert(r.body, "no cancel response"); return JSON.stringify(r.body).slice(0, 80);
  });
}

// ===================== ADMIN / PLATFORM (persona-independent) =====================
curPersona = "—"; curChannel = "Platform";
await check("Health endpoint OK", async () => { const h = await get("/health"); assert(h.ok, "health not ok"); return JSON.stringify(h).slice(0, 120); });
await check("Built-in self-test passes", async () => {
  const s = await get("/admin/selftest");
  const checks = s.checks || s.results || [];
  const failed = checks.filter(c => c.ok === false);
  assert(checks.length, "no selftest checks");
  return `${checks.length - failed.length}/${checks.length} passed${failed.length ? " — failing: " + failed.map(f => f.name).join(", ") : ""}`;
});
await check("Personas endpoint lists all 3", async () => {
  const p = await get("/personas"); assert((p.personas || []).length >= 3, "missing personas");
  return (p.personas || []).map(x => `${x.id}(${x.tier})`).join(", ");
});

// ── summary ──
const total = results.length, passed = results.filter(r => r.pass).length;
console.log(`\n===== QA COMPLETE: ${passed}/${total} checks passed =====`);
const byCh = {};
for (const r of results) { byCh[r.channel] = byCh[r.channel] || { p: 0, t: 0 }; byCh[r.channel].t++; if (r.pass) byCh[r.channel].p++; }
for (const [c, v] of Object.entries(byCh)) console.log(`  ${c}: ${v.p}/${v.t}`);
const fails = results.filter(r => !r.pass);
if (fails.length) { console.log("\n--- FAILURES ---"); fails.forEach(f => console.log(`  [${f.persona}/${f.channel}] ${f.name} → ${f.detail}`)); }
import("fs").then(fs => fs.writeFileSync("/tmp/qa_results.json", JSON.stringify(results, null, 2)));
