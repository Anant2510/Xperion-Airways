/* autonomy/sensing.js — Phase 2: sensing + prediction.
   Connectors for NWS/SPC/METAR/FAA are STUB: implementations of the same
   contract (normalized alert objects pushed in; in production they stream/poll
   at ≤15 min cadence). Alerts upsert WeatherEvent nodes (deduped on a content
   key) and geo-matched IMPACTS edges. The prediction service is a transparent,
   documented scorecard — every factor it used is written to top_drivers so a
   controller can read WHY. Thresholds + hysteresis come from Policy nodes.
   Agents never poll feeds: they react to graph state via the bus. */
"use strict";
const G = require("./graph");
const O = require("./ontology");
const clock = require("./clock");

const R = 6371;
const havKm = (a, b) => {
  const dLa = (b.lat - a.lat) * Math.PI / 180, dLo = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

/* STUB: connector entry point. alert = { source, type, geometry:{lat,lon,radius_km}, valid:{from,to}, severity, raw } */
function ingestAlert(alert) {
  const key = G.hash({ s: alert.source, t: alert.type, f: alert.valid.from, g: alert.geometry });
  const weId = `we:${key}`;
  const existed = !!G.getNode(weId);                    // duplicate alerts dedupe to one node
  G.upsertNode(weId, "WeatherEvent", { ...alert, key });
  const buffer = 50;
  for (const ap of G.nodesByKind("Airport")) {
    const d = havKm(alert.geometry, ap.geo);
    if (d <= alert.geometry.radius_km + buffer) {
      G.upsertEdge(weId, "IMPACTS", ap.id, { distance_km: Math.round(d), window: alert.valid });
    }
  }
  O.audit({ actor: "sensing", action: "INGEST_ALERT", rationale: `${alert.source} ${alert.type} sev${alert.severity} (${existed ? "dedup" : "new"})` });
  return { weId, deduped: existed };
}

/* transparent scorecard — weights documented in ONTOLOGY.md §calibration */
const TYPE_BASE = { convective_outlook: 0.35, tornado_watch: 0.58, tornado_warning: 0.75, hurricane: 0.70,
  /* live feed types (feeds.js): NWS watches/warnings and Open-Meteo outlooks */
  hurricane_watch: 0.60, severe_thunderstorm_warning: 0.55, severe_thunderstorm_watch: 0.45, blizzard: 0.65, winter_storm: 0.50, ice_storm: 0.60,
  flash_flood: 0.35, flood: 0.25, high_wind: 0.30, dense_fog: 0.35, extreme_heat: 0.10, heavy_rain: 0.20 };
const AIRPORT_RATE = { MIA: 0.02, MCO: 0.015, FLL: 0.02, ATL: 0.01, DEL: 0.01 };
function scoreInstance(fi, we, ap) {
  const drivers = [];
  let p = TYPE_BASE[we.type] ?? 0.3; drivers.push({ factor: `event:${we.type}`, weight: p });
  const sev = 0.05 * ((we.severity ?? 3) - 3); p += sev; drivers.push({ factor: `severity:${we.severity}`, weight: +sev.toFixed(2) });
  const t = new Date(fi.dest === ap.iata ? fi.sched_arr : fi.sched_dep).getTime();
  const overlap = t >= new Date(we.valid.from).getTime() && t <= new Date(we.valid.to).getTime() ? 0.05 : -0.15;
  p += overlap; drivers.push({ factor: "window_overlap", weight: overlap });
  const rate = AIRPORT_RATE[ap.iata] ?? 0.01; p += rate; drivers.push({ factor: `base_rate:${ap.iata}`, weight: rate });
  const hourU = new Date(fi.sched_arr).getUTCHours();
  const tod = hourU >= 20 || hourU <= 2 ? 0.03 : 0.01; p += tod; drivers.push({ factor: "time_of_day", weight: tod });
  return { p: Math.max(0.01, Math.min(0.95, +p.toFixed(2))), drivers };
}

/* evaluate all instances against all active events; write DisruptionPrediction; drive state */
function evaluate() {
  const th = G.getNode("policy:thresholds");
  const results = [];
  for (const we of G.nodesByKind("WeatherEvent")) {
    for (const { node: ap } of G.out(we.id, "IMPACTS")) {
      const arrivals = G.into(ap.id, "ARRIVES_AT").concat(G.into(ap.id, "DEPARTS_FROM"));
      for (const { node: fi } of arrivals) {
        if (!fi || fi.recovery) continue;
        const { p, drivers } = scoreInstance(fi, we, ap);
        const predId = `pred:${we.key}:${fi.id.split(":").slice(1).join(":")}`;
        const prev = G.getNode(predId);
        let state = prev?.state || "NONE";
        const from = state;
        if (["RESOLVED", "STOOD_DOWN"].includes(state)) { /* terminal */ }
        else if (p >= th.act) state = ["OFFERS_OUT", "RESOLVING"].includes(state) ? state : "ACT";
        else if (p >= th.watch) state = ["ACT", "OFFERS_OUT", "RESOLVING"].includes(state) && p >= th.act - th.hysteresis ? state : "WATCH";
        else if (["ACT", "OFFERS_OUT", "RESOLVING", "WATCH"].includes(state) && p < th.act - th.hysteresis) state = "STOOD_DOWN";
        else if (state === "NONE") state = p >= th.watch ? "WATCH" : "NONE";
        if (state === "NONE") continue;
        G.upsertNode(predId, "DisruptionPrediction", {
          flight_instance_ref: fi.id, probability: p, confidence: 0.7, top_drivers: drivers,
          state, model_version: "scorecard-v1", updated_at: clock.nowIso(),
          ...(prev ? {} : { created_at: clock.nowIso() }),
        });
        G.upsertEdge(predId, "FORECASTS", fi.id);
        if (from !== state) {
          O.audit({ actor: "sensing", action: "PREDICTION_STATE", predictionId: predId, rationale: `${from} -> ${state} (p=${p})` });
          O.emit("prediction:state", { predictionId: predId, from, to: state, probability: p });
        }
        results.push({ predId, p, state });
      }
    }
  }
  return results;
}

module.exports = { ingestAlert, evaluate, scoreInstance };
