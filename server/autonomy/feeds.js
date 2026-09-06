"use strict";
/* feeds.js — live weather into the sensing pipeline. Two free, keyless sources:

     NWS  (api.weather.gov)   official US alerts: tornado / severe thunderstorm / hurricane /
                              winter storm / flood watches and warnings, by point.
     Open-Meteo                global 7-day forecast; when the arrival day shows thunderstorms,
                              damaging wind, heavy rain or snow we raise an "outlook" alert.

   Every alert goes through sensing.ingestAlert() exactly like the simulated ones (same dedupe,
   same scorecard), so the disruption pipeline does not know or care whether an event came from
   the sim or from the sky. Structured feeds are the only thing that can move a prediction into
   ACT; the research briefs (research.js) are informational.

   Polling covers the arrival airports of every FlightInstance in the graph plus the destinations
   of every upcoming real booking. FEEDS_ENABLED=0 turns the poller off; FEEDS_INTERVAL_MS sets
   the cadence (default 30 min). */

const { db } = require("../db");
const G = require("./graph");
const O = require("./ontology");
const sensing = require("./sensing");
const { geocode } = require("./geo");
const { AIRPORTS } = require("../routes-data");

let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }
const UA = { "User-Agent": "XperionAirways-MAR/1.0 (ops@flyxperion.example)", Accept: "application/geo+json, application/json" };

/* ── NWS event → sensing type ─────────────────────────────────────────── */
const NWS_MAP = [
  [/tornado warning/i, "tornado_warning", 5], [/tornado watch/i, "tornado_watch", 4],
  [/hurricane warning/i, "hurricane", 5], [/hurricane watch|tropical storm warning/i, "hurricane_watch", 4],
  [/severe thunderstorm warning/i, "severe_thunderstorm_warning", 4], [/severe thunderstorm watch/i, "severe_thunderstorm_watch", 3],
  [/blizzard/i, "blizzard", 4], [/winter storm/i, "winter_storm", 3], [/ice storm/i, "ice_storm", 4],
  [/flash flood/i, "flash_flood", 3], [/flood/i, "flood", 2], [/high wind/i, "high_wind", 2], [/dense fog/i, "dense_fog", 2],
  [/extreme heat|excessive heat/i, "extreme_heat", 1],
];
function classifyNWS(ev) { for (const [re, type, sev] of NWS_MAP) if (re.test(ev)) return { type, severity: sev }; return null; }

async function nwsAlerts(code) {
  const ap = AIRPORTS[code]; if (!ap || ap.country !== "US") return [];
  const g = await geocode(code); if (!g) return [];
  try {
    const r = await fetchImpl(`https://api.weather.gov/alerts/active?point=${g.lat.toFixed(3)},${g.lon.toFixed(3)}`, { headers: UA });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.features || []).map((f) => f.properties || {}).map((p) => {
      const c = classifyNWS(p.event || ""); if (!c) return null;
      return { source: "NWS", type: c.type, severity: c.severity, headline: p.headline || p.event, event: p.event,
        valid: { from: p.onset || p.effective || p.sent, to: p.ends || p.expires }, geometry: { lat: g.lat, lon: g.lon, radius_km: 50 },
        airport: code, url: p.id || null };
    }).filter(Boolean);
  } catch { return []; }
}

/* ── Open-Meteo daily → outlook alerts ────────────────────────────────── */
const WMO = (c) => (c >= 95 ? "thunderstorm" : c >= 85 ? "snow_showers" : c >= 71 ? "snow" : c >= 65 ? "heavy_rain" : c >= 61 ? "rain" : c >= 51 ? "drizzle" : c >= 45 ? "fog" : "fair");
async function openMeteoDaily(code, days = 7) {
  const g = await geocode(code); if (!g) return null;
  try {
    const r = await fetchImpl(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windgusts_10m_max,snowfall_sum&timezone=UTC&forecast_days=${days}`);
    if (!r.ok) return null;
    const j = await r.json(); const d = j.daily || {};
    return (d.time || []).map((t, i) => ({ date: t, code: d.weathercode?.[i], label: WMO(d.weathercode?.[i] ?? 0), tmax: d.temperature_2m_max?.[i], tmin: d.temperature_2m_min?.[i], rain_mm: d.precipitation_sum?.[i], gust_kmh: d.windgusts_10m_max?.[i], snow_cm: d.snowfall_sum?.[i] }));
  } catch { return null; }
}
function outlookAlerts(code, daily, g) {
  const out = [];
  for (const day of daily || []) {
    let type = null, severity = 0;
    if ((day.code ?? 0) >= 95) { type = "convective_outlook"; severity = day.code >= 96 ? 3 : 2; }
    else if ((day.gust_kmh ?? 0) >= 90) { type = "high_wind"; severity = 3; }
    else if ((day.snow_cm ?? 0) >= 10) { type = "winter_storm"; severity = 3; }
    else if ((day.rain_mm ?? 0) >= 50) { type = "heavy_rain"; severity = 2; }
    else if ((day.code ?? 0) === 45 || (day.code ?? 0) === 48) { type = "dense_fog"; severity = 1; }
    if (!type) continue;
    out.push({ source: "OpenMeteo", type, severity, headline: `${day.label} forecast (${type.replace(/_/g, " ")})`, event: day.label,
      valid: { from: `${day.date}T00:00:00Z`, to: `${day.date}T23:59:59Z` }, geometry: { lat: g.lat, lon: g.lon, radius_km: 50 }, airport: code, day });
  }
  return out;
}

/* ── which airports to watch ──────────────────────────────────────────── */
function watchedAirports() {
  const set = new Set();
  for (const fi of G.nodesByKind("FlightInstance")) if (fi.dest) set.add(fi.dest);
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const b of db.prepare("SELECT flight_no, flight_date, meta_json FROM bookings WHERE status IN ('confirmed','rebooked') AND flight_date >= ?").all(today)) {
      let dest = null; try { dest = JSON.parse(b.meta_json || "{}").dest; } catch {}
      if (!dest) { const f = db.prepare("SELECT dest FROM flights WHERE flight_no=? AND flight_date=?").get(b.flight_no, b.flight_date) || db.prepare("SELECT dest FROM flights WHERE flight_no=?").get(b.flight_no); dest = f?.dest; }
      if (dest) set.add(dest);
    }
  } catch {}
  return [...set];
}

/* ── one poll ─────────────────────────────────────────────────────────── */
const lastPoll = { at: null, airports: 0, alerts: 0, ingested: 0, deduped: 0, evaluated: null, errors: 0 };
async function poll({ airports } = {}) {
  const codes = airports || watchedAirports();
  let alerts = 0, ingested = 0, deduped = 0, errors = 0;
  for (const code of codes) {
    try {
      const g = await geocode(code); if (!g) continue;
      const found = [...(await nwsAlerts(code)), ...outlookAlerts(code, await openMeteoDaily(code), g)];
      for (const a of found) {
        alerts++;
        const { deduped: dup } = sensing.ingestAlert({ ...a, geometry: a.geometry });
        if (dup) deduped++; else ingested++;
      }
    } catch { errors++; }
  }
  let evaluated = null;
  if (ingested) { try { evaluated = sensing.evaluate(); } catch (e) { errors++; } }
  Object.assign(lastPoll, { at: new Date().toISOString(), airports: codes.length, alerts, ingested, deduped, evaluated: evaluated ? (evaluated.predictions?.length ?? evaluated.length ?? null) : null, errors });
  if (ingested) O.audit({ actor: "feeds", action: "LIVE_WEATHER_INGEST", rationale: `${ingested} new alert(s) from NWS/Open-Meteo across ${codes.length} airport(s); ${deduped} duplicates dropped` });
  return { ...lastPoll };
}

let timer = null;
function start({ intervalMs = Number(process.env.FEEDS_INTERVAL_MS) || 30 * 60 * 1000, log = console.log } = {}) {
  if (process.env.FEEDS_ENABLED === "0") { log("   Feeds:   live weather OFF (FEEDS_ENABLED=0)"); return null; }
  log(`   Feeds:   live weather ON — NWS alerts + Open-Meteo outlooks every ${Math.round(intervalMs / 60000)} min for booked destinations`);
  const run = () => poll().catch(() => {});
  setTimeout(run, 15000);
  timer = setInterval(run, intervalMs); if (timer.unref) timer.unref();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function status() { return { enabled: process.env.FEEDS_ENABLED !== "0", lastPoll: { ...lastPoll }, watching: watchedAirports() }; }

module.exports = { poll, start, stop, status, nwsAlerts, openMeteoDaily, outlookAlerts, classifyNWS, watchedAirports, setFetch };
