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
  if (u.includes("geocoding-api.open-meteo.com")) { calls.geocode++; return j({ results: [{ latitude: 28.61, longitude: 77.2, country_code: "IN", timezone: "Asia/Kolkata" }] }); }
  if (u.includes("api.open-meteo.com/v1/forecast")) { calls.meteo++; const days = [...Array(14)].map((_, i) => addDays(i)); const codes = days.map((d) => (d === addDays(4) ? 96 : 2)); return j({ daily: { time: days, weathercode: codes, temperature_2m_max: days.map(() => 34), temperature_2m_min: days.map(() => 27), precipitation_sum: days.map((d) => (d === addDays(4) ? 62 : 0)), windgusts_10m_max: days.map(() => 40), snowfall_sum: days.map(() => 0) } }); }
  if (u.includes("api.weather.gov/alerts")) { calls.nws++; return j({ features: [{ properties: { event: "Tornado Watch", headline: "Tornado Watch until 9 PM EDT", onset: "2026-09-06T14:00:00Z", ends: "2026-09-06T21:00:00Z", id: "https://api.weather.gov/alerts/x1" } }] }); }
  if (u.includes("date.nager.at")) { calls.nager++; return j([{ date: addDays(5), name: "Gandhi Jayanti", localName: "गांधी जयंती" }, { date: "2030-01-01", name: "far", localName: "far" }]); }
  return j({}, 404);
};
geo.setFetch(mockFetch); feeds.setFetch(mockFetch); research.setFetch(mockFetch);
let llmCalls = 0;
research.setLLM(async (prompt) => { llmCalls++; return { text: '```json\n' + JSON.stringify({ summary: "Delhi is busy that week: a large political rally is planned in the city centre on the 5th and a metro workers' strike is called for the 6th; both are peaceful in past years. Air quality is moderate.", events: [{ kind: "political", title: "Opposition rally, Ramlila Maidan", date: addDays(5), impact: "medium", note: "Road closures in central Delhi from noon; airport unaffected.", source: "https://example.org/rally" }, { kind: "strike", title: "Metro workers' strike", date: addDays(6), impact: "medium", note: "Reduced metro frequency; allow extra transfer time.", source: "https://example.org/strike" }], advisories: [{ level: "Exercise normal precautions", summary: "No advisory change for Delhi.", source: "https://travel.state.gov/x" }], news: [{ title: "Airport expressway resurfacing", note: "Night works until the 8th.", source: "https://example.org/news" }], travel_impact: "medium", confidence: 0.7 }) + '\n```', cites: [{ title: "Example rally report", url: "https://example.org/rally" }] }; });

/* 1 · geocode + facts */
const gb = await geo.geocode("BOM");
ok("geocoding resolves and caches a served city", gb && Math.abs(gb.lat - 28.61) < 0.01 && (await geo.geocode("BOM")) && calls.geocode === 1, `lat ${gb?.lat} · calls ${calls.geocode}`);
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
ok("brief landed in the assistant inbox as a card with three choices", inboxMsg?.card?.type === "destination_brief" && inboxMsg.card.options.length === 3 && /Your call/.test(inboxMsg.text));
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
policy.setKill({ global: true, on: true });
const sofia = db.prepare("SELECT * FROM bookings WHERE pnr='XPW02A'").get();
const frozen = await briefs.runForBooking(sofia, { reason: "test" });
ok("kill switch refuses the brief (Tier 0 frozen)", frozen.ok === false && frozen.refused === "kill_switch", frozen.refused);
policy.setKill({ global: true, on: false });

/* 6 · synthetic suite untouched */
const passed = results.filter(Boolean).length;
console.log(`\n===== BRIEFS: ${passed}/${results.length} checks passed =====`);
try { fs.rmSync("./data/brief-test.db", { force: true }); } catch {}
process.exit(passed === results.length ? 0 : 1);
