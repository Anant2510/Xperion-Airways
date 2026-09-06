"use strict";
/* geo.js — coordinates for any served airport/city. The graph seed carries geo for the demo
   airports; everything else is geocoded once through Open-Meteo's free geocoding API and cached
   in SQLite, so the 1,572-city network never needs a coordinates file. */
const { db } = require("../db");
const { AIRPORTS } = require("../routes-data");

db.exec(`CREATE TABLE IF NOT EXISTS geo_cache (code TEXT PRIMARY KEY, lat REAL, lon REAL, tz TEXT, source TEXT, fetched_at TEXT);`);

const SEED = {
  MIA: [25.795, -80.287], JFK: [40.641, -73.778], DEL: [28.556, 77.100], MCO: [28.429, -81.309], FLL: [26.072, -80.153],
  ATL: [33.640, -84.427], JAI: [26.824, 75.812], AMD: [23.077, 72.635], LHR: [51.470, -0.454], LAX: [33.942, -118.408],
  ORD: [41.974, -87.907], DFW: [32.897, -97.038], SFO: [37.621, -122.379], BOS: [42.365, -71.009], LAS: [36.084, -115.153],
  SEA: [47.449, -122.309], DEN: [39.856, -104.673], IAH: [29.984, -95.341], PHX: [33.437, -112.008], CUN: [21.036, -86.877],
  GRU: [-23.435, -46.473], FRA: [50.033, 8.570], CDG: [49.010, 2.548], DXB: [25.253, 55.365], SIN: [1.364, 103.991],
};

let fetchImpl = (...a) => fetch(...a);   // injectable for tests
function setFetch(f) { fetchImpl = f; }

async function geocode(code) {
  code = String(code || "").toUpperCase();
  if (SEED[code]) return { lat: SEED[code][0], lon: SEED[code][1], source: "seed" };
  const row = db.prepare("SELECT lat, lon, tz, source FROM geo_cache WHERE code=?").get(code);
  if (row) return row;
  const ap = AIRPORTS[code]; if (!ap) return null;
  try {
    const q = encodeURIComponent(ap.city);
    const r = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=5&language=en&format=json`);
    const j = await r.json();
    const hit = (j.results || []).find((x) => (x.country_code || "").toUpperCase() === ap.country) || (j.results || [])[0];
    if (!hit) return null;
    const out = { lat: hit.latitude, lon: hit.longitude, tz: hit.timezone || null, source: "open-meteo-geocoding" };
    db.prepare("INSERT OR REPLACE INTO geo_cache (code,lat,lon,tz,source,fetched_at) VALUES (?,?,?,?,?,?)").run(code, out.lat, out.lon, out.tz, out.source, new Date().toISOString());
    return out;
  } catch { return null; }
}

module.exports = { geocode, setFetch, SEED };
