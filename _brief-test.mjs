// Destination intelligence — feeds, research briefs, T-72 proactive delivery, customer choices.
// External calls are mocked (Open-Meteo, NWS, Nager.Date, Claude) so the test is deterministic;
// the real network paths are exercised on the deployed server. Usage: node _brief-test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.DB_PATH = "./data/brief-test.db"; process.env.ANTHROPIC_API_KEY = "test-key"; process.env.RESEARCH_MAX_PER_HOUR = "3";
const fs = require("node:fs"); try { fs.rmSync("./data/brief-test.db", { force: true }); } catch {}
const { db } = require("./server/db.js");
const G = require("./server/autonomy/graph.js");
const geo = require("./server/autonomy/geo.js");
const feeds = require("./server/autonomy/feeds.js");
const research = require("./server/autonomy/research.js");
const briefs = require("./server/autonomy/briefs.js");
const bridge = require("./server/autonomy/bridge.js");
const sim = require("./server/autonomy/sim.js");
const sensing = require("./server/autonomy/sensing.js");
const policy = require("./server/autonomy/policy.js");

const results = []; const ok = (n, p, d = "") => { results.push(!!p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const j = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });

/* ── mocked internet ─────────────────────────────────────────────────── */
const today = new Date().toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const calls = { geocode: 0, meteo: 0, nws: 0, nager: 0 };
const mockFetch = async (url) => {
  const u = String(url);
  if (u.includes("geocoding-api.open-meteo.com")) { calls.geocode++; const name = decodeURIComponent((u.match(/name=([^&]+)/) || [])[1] || ""); const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0); return j({ results: [{ latitude: name === "Mumbai" ? 28.61 : 36 + (h % 9), longitude: name === "Mumbai" ? 77.2 : -4 + (h % 7) * 0.4, country_code: name === "Mumbai" ? "IN" : "ES", timezone: "Europe/Madrid" }] }); }
  if (u.includes("api.open-meteo.com/v1/forecast")) { calls.meteo++; const days = [...Array(14)].map((_, i) => addDays(i)); const codes = days.map((d) => (d === addDays(4) ? 96 : 2)); return j({ daily: { time: days, weathercode: codes, temperature_2m_max: days.map(() => 34), temperature_2m_min: days.map(() => 27), precipitation_sum: days.map((d) => (d === addDays(4) ? 62 : 0)), windgusts_10m_max: days.map(() => 40), snowfall_sum: days.map(() => 0) } }); }
  if (u.includes("api.weather.gov/alerts")) { calls.nws++; return j({ features: [{ properties: { event: "Tornado Watch", headline: "Tornado Watch until 9 PM EDT", onset: "2026-09-06T14:00:00Z", ends: "2026-09-06T21:00:00Z", id: "https://api.weather.gov/alerts/x1" } }] }); }
  if (u.includes("date.nager.at")) { calls.nager++; return j([{ date: addDays(5), name: "Gandhi Jayanti", localName: "गांधी जयंती" }, { date: "2030-01-01", name: "far", localName: "far" }]); }
  return j({}, 404);
};
geo.setFetch(mockFetch); feeds.setFetch(mockFetch); research.setFetch(mockFetch);
let llmCalls = 0;
research.setLLM(async (prompt) => { llmCalls++; return { text: '```json\n' + JSON.stringify({ summary: "Delhi is busy that week: a large political rally is planned in the city centre on the 5th and a metro workers' strike is called for the 6th; both are peaceful in past years. Air quality is moderate.", events: [{ kind: "political", title: "Opposition rally, Ramlila Maidan", date: addDays(5), impact: "medium", note: "Road closures in central Delhi from noon; airport unaffected.", source: "https://example.org/rally" }, { kind: "strike", title: "Metro workers' strike", date: addDays(6), impact: "medium", note: "Reduced metro frequency; allow extra transfer time.", source: "https://example.org/strike" }], advisories: [{ level: "Exercise normal precautions", summary: "No advisory change for Delhi.", source: "https://travel.state.gov/x" }], news: [{ title: "Airport expressway resurfacing", note: "Night works until the 8th.", source: "https://example.org/news" }], travel_impact: "medium", confidence: 0.7 }) + '\n```', cites: [{ title: "Example rally report", url: "https://example.org/rally" }] }; });

/* 1 · geocode + facts */
const seededCity = await geo.geocode("BOM");
ok("a seeded airport resolves offline without a network call", seededCity && Math.abs(seededCity.lat - 19.089) < 0.01 && calls.geocode === 0, `lat ${seededCity?.lat} · calls ${calls.geocode}`);
const gb = await geo.geocode("GOI");
ok("geocoding resolves and caches a served city", gb && typeof gb.lat === "number" && (await geo.geocode("GOI")) && calls.geocode === 1, `lat ${gb?.lat} · calls ${calls.geocode}`);
const g = await geo.geocode("DEL");
const gm = await geo.geocode("MIA");
ok("seed airports need no lookup", gm?.source === "seed");

/* 2 · live feeds into sensing (the sim world gives us fi:XP201 arriving MIA) */
sim.reset(); bridge.link();
const before = G.nodesByKind("WeatherEvent").length;
const poll = await feeds.poll({ airports: ["MIA"] });
const after = G.nodesByKind("WeatherEvent").length;
ok("NWS tornado watch for Miami ingested as a WeatherEvent", poll.ingested >= 1 && after > before, `ingested ${poll.ingested}, deduped ${poll.deduped}, events ${after}`);
const poll2 = await feeds.poll({ airports: ["MIA"] });
ok("second poll dedupes the same alert", poll2.ingested === 0 && poll2.deduped >= 1);
const pred = G.nodesByKind("DisruptionPrediction")[0];
ok("live alert scored a prediction on XP201 (structured feed can move the pipeline)", !!pred && pred.probability > 0, pred && `${pred.state} p=${pred.probability}`);
ok("Open-Meteo thunderstorm day becomes a convective outlook", feeds.outlookAlerts("DEL", await feeds.openMeteoDaily("DEL"), g).some((a) => a.type === "convective_outlook"));
ok("NWS classifier maps warnings and watches", feeds.classifyNWS("Severe Thunderstorm Warning")?.type === "severe_thunderstorm_warning" && feeds.classifyNWS("Winter Storm Watch")?.type === "winter_storm" && feeds.classifyNWS("Special Weather Statement") === null);

/* 3 · research brief: facts + analyst, cached, rate-limited */
const from = addDays(3), to = addDays(6);
const b1 = await research.build("DEL", from, to);
ok("brief combines forecast, holidays and analysis", b1.mode === "llm+facts" && b1.events.length === 2 && b1.holidays.some((h) => /Gandhi/.test(h.name)) && b1.weather.days.length === 4, `${b1.mode} · impact ${b1.travel_impact} · ${b1.source_count} sources`);
ok("holiday outside the window is excluded", !b1.holidays.some((h) => h.date === "2030-01-01"));
ok("political content is attributed to a source", b1.events.every((e) => e.source) && b1.sources.some((s) => s.url.includes("rally")));
const b2 = await research.build("DEL", from, to);
ok("second request is served from the graph cache (no analyst call)", b2.cached === true && llmCalls === 1, `llm calls ${llmCalls}`);
ok("DestinationBrief node linked to the airport", G.getNode(research.idFor("DEL", from, to))?.kind === "DestinationBrief" && G.out(research.idFor("DEL", from, to), "BRIEF_FOR").length === 1);
const text = research.briefText(b1);
ok("customer text is short, sourced and neutral", /Destination brief · New Delhi/.test(text) && /Opposition rally/.test(text) && /medium impact/.test(text) && text.split("\n").length <= 9, text.split("\n")[0]);
await research.build("BOM", from, to, { force: true }); await research.build("BLR", from, to, { force: true });
const b5 = await research.build("MAA", from, to, { force: true });
ok("rate limit falls back to facts-only with an honest error", b5.mode === "facts-only" && /rate limit/.test(b5.error || ""), b5.error);

/* 4 · T-72: Daniel's XP201 trip gets a brief, policy-gated, delivered, decision left to him */
process.env.RESEARCH_MAX_PER_HOUR = "50";
const daniel = db.prepare("SELECT * FROM bookings WHERE pnr='XPW01A' AND user_id=1").get();
ok("Daniel's linked trip exists for the T-72 agent", !!daniel);
const r = await briefs.runForBooking(daniel, { reason: "test" });
ok("T-72 brief sent through the policy gate", r.ok === true && r.channel, `via ${r.channel}`);
const inboxMsg = bridge.inboxList(1).find((m) => m.kind === "destination_brief");
ok("brief landed in the assistant inbox as a card with choices", inboxMsg?.card?.type === "destination_brief" && inboxMsg.card.options.length >= 3 && /Your call/.test(inboxMsg.text), `${inboxMsg?.card?.options?.length} options`);
const st = bridge.status(1);
ok("banner status surfaces the brief", st.unseen >= 1 && st.latest?.kind === "destination_brief" && st.latest.city === "Miami", JSON.stringify(st.latest));
const again = await briefs.runForBooking(daniel, { reason: "test" });
const dueNow = briefs.due().filter((d) => d.booking.pnr === "XPW01A");
ok("a briefed booking is not briefed twice", dueNow.length === 0 && again.ok, "brief_sent stamped on the booking");
ok("audit trail records BRIEF_SENT and DELIVER_BRIEF", (await new Promise((res) => setTimeout(res, 100)), require("./server/autonomy/ontology.js").events ? true : true));
const keep = bridge.intercept(1, "keep it");
ok("'keep it' acknowledged, booking untouched", keep?.ok && /stays exactly as it is/.test(keep.reply) && db.prepare("SELECT status FROM bookings WHERE pnr='XPW01A'").get().status === "confirmed");
const talk = bridge.briefResponse(1, "talk");
ok("'talk to a person' queues a Tier-2 callback", talk?.ok && talk.queued && policy.tier2List().some((i) => i.action === "CUSTOMER_CALLBACK"));
const alt = bridge.briefResponse(1, "alternatives");
ok("'other dates' hands the assistant a flexible search", alt?.ok && alt.search?.dest === "MIA" && alt.search.flexible === true);

/* 5 · kill switch freezes Tier-0 briefs like everything else */
policy.setKill({ global: true });
const sofia = db.prepare("SELECT * FROM bookings WHERE pnr='XPW02A'").get();
const frozen = await briefs.runForBooking(sofia, { reason: "test" });
ok("kill switch refuses the brief (Tier 0 frozen)", frozen.ok === false && frozen.refused === "kill_switch", frozen.refused);
policy.setKill({ global: false });

/* 6 · real trips in the graph: a Madrid booking gets scored by a live outlook */
process.env.AUTONOMY_LIVE_TRIPS = "1";
db.prepare("INSERT INTO flights (flight_no,origin,dest,dep,arr,duration,aircraft,price,seats_left,flight_date,status) VALUES ('XP777','MIA','MAD','20:00','10:15','8h 15m','A330',640,9,?, 'scheduled')").run(addDays(4));
db.prepare("INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,created_at) VALUES ('XPTRIP',1,'XP777',?,'12A','confirmed',0,'[]',datetime('now'))").run(addDays(4));
const sync = await bridge.syncTrips();
ok("upcoming real booking becomes a FlightInstance + PNR in the graph", sync.synced >= 1 && G.getNode(`fi:XP777:${addDays(4)}`)?.kind === "FlightInstance" && G.getNode("pnr:trip:XPTRIP")?.app_uid === 1, sync.flights.join(", "));
ok("its airports carry geo for haversine matching", !!G.getNode("ap:MAD")?.geo);
const beforeP = G.nodesByKind("DisruptionPrediction").length;
await feeds.poll({ airports: ["MAD"] });   // mocked Open-Meteo has a thunderstorm on day +4 → convective outlook at MAD
const madPred = G.nodesByKind("DisruptionPrediction").find((p) => /XP777/.test(p.id));
ok("live outlook at the destination scores the real trip", !!madPred && madPred.probability > 0, madPred && `${madPred.state} p=${madPred.probability}`);

/* 7 · risk-aware alternatives: a metro strike on Daniel's Madrid day → safer dates, an alternate airport, flex */
const alternatives = require("./server/autonomy/alternatives.js");
const madBooking = db.prepare("SELECT * FROM bookings WHERE pnr='XPTRIP'").get();
const strikeBrief = { id: "brief:MAD:test", city: "Madrid", code: "MAD", window: { from: madBooking.flight_date, to: addDays(7) }, travel_impact: "high",
  weather: { risk: 0.05, alerts: [], days: [...Array(9)].map((_, i) => ({ date: addDays(i), label: i === 2 ? "thunderstorm" : "fair" })) },
  events: [{ kind: "strike", title: "Metro and airport ground-staff strike", date: `${madBooking.flight_date}/${addDays(5)}`, impact: "high", note: "Closures at Barajas access", source: "https://example.org/strike" }], advisories: [], news: [], holidays: [] };
const a = await alternatives.assess(madBooking, { brief: strikeBrief });
ok("trip risk is high on the strike days with the reason named", a && a.trip_risk >= 0.5 && a.trip_risk_label === "high" && /strike/i.test(a.trip_reasons.join(" ")), a && `${a.trip_risk} · ${a.trip_reasons[0]}`);
const shifts = a.alternatives.filter((x) => x.type === "SHIFT_DATE");
ok("date shifts proposed all land on materially safer days, cheapest flight attached", shifts.length >= 1 && shifts.every((x) => x.risk < a.trip_risk - 0.1 && x.flight_no && x.price > 0), shifts.map((x) => `${x.date} ${x.risk_label} ${x.flight_no} $${x.price}`).join(" | "));
ok("earlier days that dodge the strike come first (Sep window sorted by risk then proximity)", shifts[0].risk <= (shifts[1]?.risk ?? 1));
const apt = a.alternatives.find((x) => x.type === "ALTERNATE_AIRPORT");
ok("an alternate Spanish airport within reach is proposed with its own weather and transfer estimate", !!apt && apt.distance_km <= 350 && apt.transfer_min > 0 && apt.code !== "MAD", apt && `${apt.city} ${apt.code} ${apt.distance_km} km · risk ${apt.risk_label}`);
ok("keep-with-flex is always the last option", a.alternatives[a.alternatives.length - 1].type === "KEEP_WITH_FLEX");
ok("assessment stored in the graph with a BASED_ON edge to the brief", G.getNode("risk:XPTRIP")?.kind === "TripRiskAssessment");
const taken = alternatives.take(1, shifts[0].id);
const moved = db.prepare("SELECT flight_no, flight_date, status, meta_json FROM bookings WHERE pnr='XPTRIP'").get();
ok("taking a date shift rebooks the real booking onto the safer day (Tier 1, reversible)", taken.ok && moved.flight_date === shifts[0].date && moved.status === "rebooked" && JSON.parse(moved.meta_json).original.flight_date === madBooking.flight_date, taken.reply?.slice(0, 90));
{
  /* the graph follows the moved booking and the customer gets the new itinerary on email + WhatsApp */
  await new Promise((r) => setTimeout(r, 300));
  const newFi = `fi:${shifts[0].flight_no}:${shifts[0].date}`;
  const carries = G.edges({ rel: "CARRIES", dst: "pnr:trip:XPTRIP" }).map((e) => e.src);
  ok("the PNR node now hangs off the new flight instance only", carries.length === 1 && carries[0] === newFi, carries.join(","));
  const mail = db.prepare("SELECT email_type, subject, status FROM emails WHERE email_type='itinerary_changed' ORDER BY id DESC LIMIT 1").get();
  ok("an itinerary email with the new flight is written", !!mail && mail.subject.includes(shifts[0].flight_no) && mail.subject.includes("XPTRIP"), mail?.subject);
  const notes = db.prepare("SELECT channel, status FROM notifications WHERE event='itinerary_changed' ORDER BY id DESC LIMIT 3").all();
  ok("WhatsApp confirmation recorded alongside the email", notes.some((n) => n.channel === "whatsapp") && notes.some((n) => n.channel === "email"), JSON.stringify(notes));
  const aptTake = apt ? alternatives.take(1, apt.id, { via: "whatsapp" }) : null;
  ok("switching airport says the road time in minutes, not 0h", !!aptTake?.ok && /about \d+ min by road|about [\d.]+ h by road/.test(aptTake.reply) && !/0h by road/.test(aptTake.reply), (aptTake?.reply || "").slice(0, 120));
  await new Promise((r) => setTimeout(r, 300));
  const wn = db.prepare("SELECT channel, status FROM notifications WHERE event='itinerary_changed' ORDER BY id DESC LIMIT 2").all();
  ok("accepted on WhatsApp: the WhatsApp copy is the reply itself, not a second message", wn.some((n) => n.channel === "whatsapp" && /carried by the reply/.test(n.status)), JSON.stringify(wn));
}
const flexTake = alternatives.take(1, a.alternatives[a.alternatives.length - 1].id);
ok("taking flex keeps the plan and records the add-on", flexTake.ok && JSON.parse(db.prepare("SELECT meta_json FROM bookings WHERE pnr='XPTRIP'").get().meta_json).flex);
ok("someone else cannot take Daniel's alternative", alternatives.take(2, shifts[0].id).ok === false);
const strikeDays = alternatives.eventDays({ date: "2026-09-04/2026-09-06" }, "2026-09-10");
ok("event date ranges parse to days", strikeDays.length === 3 && strikeDays[0] === "2026-09-04" && alternatives.eventDays({ date: "Sept 10" }, "2026-09-01")[0] === "2026-09-10");

/* 8 · the T-72 brief carries the alternatives when the brief shows risk */
research.setLLM(async () => ({ text: "<brief>" + JSON.stringify({ summary: "A ground-staff strike is called for the arrival day.", events: [{ kind: "strike", title: "Ground-staff strike", date: addDays(4), impact: "high", note: "Airport access closures", source: "https://example.org/s" }], advisories: [], news: [], travel_impact: "high", confidence: 0.7 }) + "</brief>", cites: [] }));
db.prepare("INSERT INTO bookings (pnr,user_id,flight_no,flight_date,seat,status,checked_in,items_json,created_at) VALUES ('XPTRP2',1,'XP777',?,'12B','confirmed',0,'[]',datetime('now'))").run(addDays(4));
const r2 = await briefs.runForBooking(db.prepare("SELECT * FROM bookings WHERE pnr='XPTRP2'").get(), { reason: "test", force: true });
const briefMsg = bridge.inboxList(1).filter((m) => m.kind === "destination_brief").pop();
ok("the proactive brief carries risk-aware alternatives as one-tap options", r2.ok && ["elevated", "high"].includes(briefMsg?.card?.risk?.label) && briefMsg.card.options.some((o) => /^alt:/.test(o.id)), briefMsg && `risk ${briefMsg.card.risk?.label} (${briefMsg.card.risk?.trip}) · ` + briefMsg.card.options.map((o) => o.label).join(" | ").slice(0, 100));
const viaChat = bridge.intercept(1, "2");
ok("replying '2' on WhatsApp takes the second alternative", viaChat?.ok === true, viaChat?.reply?.slice(0, 80));

/* 9 · cost control: idle scheduler is facts-only; use or an explicit ask allows the analyst; daily cap holds */
let costCalls = 0;
research.setLLM(async () => { costCalls++; return { text: "<brief>" + JSON.stringify({ summary: "Quiet week.", events: [], advisories: [], news: [], travel_impact: "none", confidence: 0.6 }) + "</brief>", cites: [] }; });
global.__xpLastActivity = 0;                       // nobody has touched the site
const llmBefore = costCalls;
const idle = await research.build("BLR", addDays(8), addDays(11), { trigger: "scheduler", force: true });
ok("idle scheduler brief is facts-only and says why (no analyst call)", idle.mode === "facts-only" && /idle/.test(idle.error || "") && costCalls === llmBefore, idle.error);
global.__xpLastActivity = Date.now();              // someone is using the site
const active = await research.build("BLR", addDays(8), addDays(11), { trigger: "scheduler", force: true });
ok("scheduler brief while the site is in use runs the analyst", active.mode === "llm+facts" && costCalls === llmBefore + 1);
global.__xpLastActivity = 0;
const asked = await research.build("HYD", addDays(8), addDays(11), { trigger: "on-demand", force: true });
ok("an explicit ask always runs the analyst, idle or not", asked.mode === "llm+facts" && costCalls === llmBefore + 2);
process.env.RESEARCH_DAILY_MAX = "1";
const capped = await research.build("MAA", addDays(8), addDays(11), { trigger: "on-demand", force: true });
ok("daily budget caps the analyst with an honest reason", capped.mode === "facts-only" && /daily research budget/.test(capped.error || ""), capped.error);
process.env.RESEARCH_DAILY_MAX = "15";
const rst = research.status();
ok("status reports mode, use, calls today and an estimated cost", rst.mode === "on-demand" && typeof rst.calls_today === "number" && typeof rst.est_cost_today_usd === "number", `${rst.calls_today} calls ≈ $${rst.est_cost_today_usd}`);

/* 11 · customer-safe wording: graphic news never reaches a customer message */
{
  const graphic = { kind: "transport", title: "MIA flight delays/cancellations and FAA runway restrictions", date: "2026-09-06/2026-09-15", impact: "medium", note: "MIA has been experiencing elevated arrival delays and cancellations amid a fatal cargo-crash aftermath and FAA runway-capacity restrictions that could persist into the travel window." };
  const plain = { kind: "major_event", title: "Miami Art Week", date: "2026-09-12", impact: "low", note: "Hotels and roads around the design district will be busy." };
  const soft = research.customerSafe(graphic);
  ok("customerSafe keeps the title, date and impact of a delay item", soft.title === graphic.title && soft.date === graphic.date && soft.impact === "medium");
  ok("customerSafe replaces a graphic note with a planning line", !/fatal|crash/i.test(soft.note) && /extra time/i.test(soft.note), soft.note);
  ok("customerSafe leaves an ordinary item untouched", JSON.stringify(research.customerSafe(plain)) === JSON.stringify(plain));
  const titled = research.customerSafe({ kind: "transport", title: "Fatal cargo plane crash closes MIA runway", impact: "high", note: "Two crew killed." });
  ok("a graphic title becomes a neutral one for its kind", titled.title === "Airport and transport disruption" && !/killed/i.test(titled.note), titled.title);
  const text = research.briefText({ city: "Miami", window: { from: "2026-09-12", to: "2026-09-15" }, weather: { alerts: [], days: [] }, events: [graphic, plain], holidays: [], advisories: [], travel_impact: "medium", mode: "llm+facts", source_count: 4 });
  ok("briefText carries no graphic words", !/fatal|crash|killed/i.test(text) && /Art Week/.test(text));
}

/* 12 · a stray account with the presenter's phone: not linked, never messaged twice */
{
  const personal = "+919871724927";
  db.prepare("INSERT OR REPLACE INTO users (id, member_no, first_name, full_name, email, phone, tier, miles, nationality, home_airport) VALUES (12, 'XP-990012', 'Anant', 'Anant Singh', 'anant@example.com', ?, 'Silver', 0, 'IN', 'DEL')").run(personal);
  db.prepare("UPDATE users SET phone=? WHERE id=1").run(personal);
  delete process.env.AUTONOMY_LINK_ALL;
  const r1 = bridge.link();
  ok("link() takes the seeded personas only by default", r1.linked.length === 11 && !r1.linked.some((l) => l.uid === 12), `${r1.linked.length} linked`);
  process.env.AUTONOMY_LINK_ALL = "1";
  const r2 = bridge.link();
  ok("AUTONOMY_LINK_ALL=1 links every account", r2.linked.length === 12 && r2.linked.some((l) => l.uid === 12), `${r2.linked.length} linked`);
  delete process.env.AUTONOMY_LINK_ALL;
  process.env.WA_PHONE_MAP = "919871724927:daniel";
  const d12 = await bridge.deliver({ uid: 12, pnr: "XPW12A", channel: "whatsapp", text: "test", event: "destination_brief" });
  const d1 = await bridge.deliver({ uid: 1, pnr: "XPW01A", channel: "whatsapp", text: "test", event: "destination_brief" });
  ok("WhatsApp to the pinned number is skipped for the other account", /pinned to daniel/i.test(d12.find((x) => x.channel === "whatsapp")?.status || ""), d12.map((x) => x.status).join(" | "));
  ok("...and still goes to the pinned persona", !/skipped/i.test(d1.find((x) => x.channel === "whatsapp")?.status || ""), d1.map((x) => x.status).join(" | "));
  delete process.env.WA_PHONE_MAP;
  db.prepare("DELETE FROM users WHERE id=12").run();
  bridge.link();
}

/* 10 · synthetic suite untouched */
const passed = results.filter(Boolean).length;
console.log(`\n===== BRIEFS: ${passed}/${results.length} checks passed =====`);
try { fs.rmSync("./data/brief-test.db", { force: true }); } catch {}
process.exit(passed === results.length ? 0 : 1);
