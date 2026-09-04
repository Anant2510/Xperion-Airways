// Network & base validation — proves, from code and data, what Xperion Airways is and where it flies.
// Static part reads server/routes-data.js and the tenant registry; live part (optional) hits a running
// server. Usage: node _network-validate.mjs            (static only)
//        BASE=http://127.0.0.1:7810 node _network-validate.mjs   (static + live API checks)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AIRPORTS, ROUTES } = require("./server/routes-data.js");
const BASE = process.env.BASE || null;
const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const pct = (hit, all) => `${hit}/${all} (${Math.round((100 * hit) / all)}%)`;

/* ── 1 · base: a US carrier ─────────────────────────────────────────────── */
console.log("\n── Carrier base (server/server.js tenant config · server/airline.js defaults) ──");
const src = require("node:fs").readFileSync("server/server.js", "utf8");
const cfgBlock = src.slice(src.indexOf('name: "Xperion Airways"'), src.indexOf('name: "Xperion Airways"') + 600);
const has = (re) => re.test(cfgBlock);
ok("tenant country is US", has(/country:\s*"US"/));
ok("home airport is Miami (MIA)", has(/homeAirport:\s*"MIA"/));
ok("hubs are Miami + New York JFK", has(/hubs:\s*\["MIA",\s*"JFK"\]/));
ok("currency USD, locale en-US", has(/currency:\s*"USD"/) && has(/locale:\s*"en-US"/));
const defaults = require("node:fs").readFileSync("server/airline.js", "utf8");
ok("platform defaults are US too (no EUR fallback)", /currency:\s*"USD"/.test(defaults) && !/currency:\s*"EUR"/.test(defaults));

/* ── 2 · network reach from the generated route file ───────────────────── */
console.log("\n── Network (server/routes-data.js, generated from the OurAirports public-domain dataset) ──");
const codes = Object.keys(AIRPORTS);
const cc = (c) => AIRPORTS[c].country;
const us = codes.filter((c) => cc(c) === "US");
const intl = codes.filter((c) => cc(c) !== "US");
const countries = new Set(codes.map(cc));
/* dependent territories carry their own ISO code in the dataset; count sovereign states separately */
const TERRITORIES = new Set("PR GU VI AS MP UM HK MO GL FO AW CW SX BQ GF GP MQ RE YT PM BL MF WF PF NC GI JE GG IM FK BM KY TC VG AI MS SH IO PN GS CK NU TK NF CX CC HM AX SJ BV EH TF AQ".split(" "));
const sovereign = [...countries].filter((c) => !TERRITORIES.has(c));
ok("airports served ≥ 1,500", codes.length >= 1500, `${codes.length} airports`);
ok("international cities served ≥ 1,000", intl.length >= 1000, `${intl.length} non-US airports`);
ok("countries and territories served ≥ 150", countries.size >= 150, `${countries.size} ISO codes`);
ok("sovereign countries served ≥ 150", sovereign.length >= 150, `${sovereign.length} sovereign states (territories excluded)`);
ok("US domestic airports served ≥ 450", us.length >= 450, `${us.length} US airports`);
const byRegion = {}; for (const c of codes) byRegion[AIRPORTS[c].region] = (byRegion[AIRPORTS[c].region] || 0) + 1;
console.log("      by region: " + Object.entries(byRegion).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(" · "));
const topCountries = {}; for (const c of intl) topCountries[cc(c)] = (topCountries[cc(c)] || 0) + 1;
console.log("      most-served countries: " + Object.entries(topCountries).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, n]) => `${r} ${n}`).join(" · "));

/* ── 3 · named coverage: the world's major international cities ────────── */
const MAJOR_INTL = {
  Europe: "LHR CDG AMS FRA MAD BCN FCO MXP MUC ZRH VIE BRU CPH ARN OSL HEL DUB LIS ATH IST WAW PRG BUD BER MAN EDI GVA OPO",
  MiddleEastAfrica: "DXB DOH AUH RUH JED TLV CAI JNB CPT NBO ADD LOS ACC CMN ALG TUN AMM BAH MCT KWI DAR EBB",
  Asia: "DEL BOM BLR MAA HYD CCU KHI LHE DAC CMB KTM BKK SIN KUL CGK MNL SGN HAN HKG PEK PVG CAN SZX CTU TPE ICN NRT HND KIX",
  Oceania: "SYD MEL BNE PER AKL",
  Americas: "GRU GIG EZE SCL LIM BOG MEX CUN PTY SJO UIO YYZ YVR YUL YYC HAV NAS MBJ",
};
console.log("\n── Named coverage ──");
let hit = 0, all = 0, missing = [];
for (const [region, list] of Object.entries(MAJOR_INTL)) {
  const arr = list.split(" "); const h = arr.filter((c) => AIRPORTS[c]); hit += h.length; all += arr.length;
  missing.push(...arr.filter((c) => !AIRPORTS[c]).map((c) => `${region}:${c}`));
}
ok("major international gateways covered", hit === all, pct(hit, all) + (missing.length ? " · missing " + missing.join(" ") : ""));
const TOP_US = "ATL LAX DFW DEN ORD JFK MCO LAS CLT MIA SEA EWR SFO PHX IAH BOS FLL MSP LGA DTW PHL SLC DCA SAN BWI TPA AUS IAD BNA MDW HNL DAL PDX STL RDU HOU SMF MSY SJC OAK SNA MCI RSW SAT CLE IND PIT CMH CVG PBI JAX BUF MKE ABQ OMA ONT BUR BDL ANC RIC SDF OKC TUL MEM BOI ORF RNO ELP CHS TUS GEG LIT GRR DSM ROC SAV BHM PVD ALB SYR MSN TYS DAY GSO MYR LGB PSP FAT ICT XNA HSV PNS VPS SRQ JAN CAK LEX GSP ILM HPN ISP".split(" ");
const usHit = TOP_US.filter((c) => AIRPORTS[c]);
ok("top-100 US airports covered", usHit.length === TOP_US.length, pct(usHit.length, TOP_US.length) + (usHit.length < TOP_US.length ? " · missing " + TOP_US.filter((c) => !AIRPORTS[c]).join(" ") : ""));

/* ── 4 · connectivity: hub-and-spoke from Miami and New York ───────────── */
console.log("\n── Connectivity ──");
const legs = new Set(ROUTES.map((r) => (r.origin || r[0]) + "-" + (r.dest || r[1])));
const HUBS = ["MIA", "JFK"];
const unreachable = codes.filter((c) => !HUBS.includes(c) && !HUBS.every((h) => legs.has(h + "-" + c) && legs.has(c + "-" + h)));
ok("every served city has non-stop legs to and from BOTH hubs", unreachable.length === 0, unreachable.length ? `unreachable: ${unreachable.slice(0, 8).join(" ")}…` : `${legs.size} directional legs`);
const FOCUS = ["ORD", "LAX", "DFW", "SFO", "SEA", "ATL", "DEN", "BOS", "IAH", "PHX", "LAS", "MCO", "SLC", "CLT", "MSP", "DTW"];
let meshOk = true; for (const a of FOCUS) for (const b of FOCUS) if (a !== b && !legs.has(a + "-" + b)) meshOk = false;
ok("16-city US focus mesh is fully connected point-to-point", meshOk, FOCUS.join(" "));

/* ── 5 · live checks against a running server (optional) ───────────────── */
if (BASE) {
  console.log(`\n── Live (${BASE}) ──`);
  const get = (p) => fetch(BASE + p).then((r) => r.json());
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then((r) => r.json());
  const h = await get("/api/health");
  ok("health reports a US carrier with MIA/JFK hubs in USD", h.airline?.country === "US" && h.airline?.hubs?.join() === "MIA,JFK" && h.airline?.currency === "USD", JSON.stringify(h.airline));
  ok("health reports the network facts", h.network?.airports >= 1500 && h.network?.countries >= 150 && h.network?.every_city_reachable_from_both_hubs === true, `${h.network?.airports} airports · ${h.network?.countries} countries · ${h.network?.us_airports} US`);
  const personas = await get("/api/personas");
  const list = personas.personas || personas || [];
  const homes = [];
  for (const p of list) {
    const sw = await post("/api/persona", { persona: p.id });   // persona switches are session-scoped
    const pr = await fetch(BASE + "/api/profile", { headers: { "X-Session-Id": sw.sessionId || "" } }).then((r) => r.json());
    homes.push(`${pr.user.first_name}:${pr.user.home_airport}/${pr.user.nationality || "?"}`);
  }
  const usBased = homes.filter((x) => /:(MIA|JFK|MCO|LAS|ORD|LAX|DFW|ATL|SFO|SEA|BOS|DEN|IAH|PHX|SLC|CLT|MSP|DTW|FLL|SJU)\//.test(x)).length;
  ok("customer base is majority US-homed (rest are Brazil/Europe inbound customers)", usBased > list.length / 2, `${usBased}/${list.length} US · ` + homes.join(" · "));
  await post("/api/persona", { persona: "daniel" });
  const pairs = [["MIA", "DEL"], ["JFK", "LHR"], ["MIA", "SYD"], ["JFK", "GRU"], ["LAX", "ORD"], ["DEN", "BOS"], ["MIA", "HKG"], ["JFK", "NBO"]];
  for (const [o, d] of pairs) {
    const r = await get(`/api/search?origin=${o}&dest=${d}`);
    const f = (r.flights || [])[0];
    ok(`search ${o}→${d} returns Xperion flights priced in USD`, (r.flights || []).length > 0 && /^XP\d+$/.test(f?.flight_no || "") && typeof f?.price === "number", f ? `${r.flights.length} flights · ${f.flight_no} ${f.dep}→${f.arr} · $${f.price}` : JSON.stringify(r).slice(0, 80));
  }
  const nonHub = await get("/api/search?origin=PDX&dest=AUS");
  ok("point-to-point search works for a non-hub, non-mesh US pair (PDX→AUS)", (nonHub.flights || []).length > 0, `${(nonHub.flights || []).length} flights`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== NETWORK: ${passed}/${results.length} checks passed =====`);
if (passed < results.length) process.exit(1);
