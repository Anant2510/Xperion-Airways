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
  /* alternates around the served cities, so the recovery planner can pick a divert airport offline */
  LGW: [51.148, -0.190], STN: [51.885, 0.235], LTN: [51.875, -0.368], LCY: [51.505, 0.055], BHX: [52.454, -1.748], MAN: [53.365, -2.273], BRS: [51.383, -2.719], EMA: [52.831, -1.328], SOU: [50.950, -1.357], EDI: [55.950, -3.373], GLA: [55.872, -4.433], NCL: [55.037, -1.692],
  EWR: [40.692, -74.169], LGA: [40.777, -73.874], PHL: [39.872, -75.241], BWI: [39.175, -76.668], IAD: [38.953, -77.456], DCA: [38.852, -77.037], BDL: [41.939, -72.683], PVD: [41.724, -71.428], MHT: [42.933, -71.436],
  ORY: [48.723, 2.379], BVA: [49.454, 2.113], LIL: [50.563, 3.089], AMS: [52.310, 4.768], RTM: [51.957, 4.437], EIN: [51.450, 5.375], BRU: [50.901, 4.484], CRL: [50.459, 4.453],
  MAD: [40.472, -3.561], VLL: [41.706, -4.852], BCN: [41.297, 2.078], VCE: [45.505, 12.352], TSF: [45.648, 12.194], VRN: [45.396, 10.888], BLQ: [44.535, 11.288], FCO: [41.800, 12.239], CIA: [41.799, 12.595], NAP: [40.886, 14.291], MXP: [45.630, 8.723], LIN: [45.445, 9.277], BGY: [45.673, 9.704],
  HHN: [49.948, 7.264], CGN: [50.866, 7.143], DUS: [51.289, 6.767], STR: [48.690, 9.222], MUC: [48.354, 11.786], NUE: [49.499, 11.078], HAM: [53.630, 9.988], BER: [52.362, 13.501],
  BOM: [19.089, 72.868], PNQ: [18.582, 73.920], HYD: [17.240, 78.429], BLR: [13.199, 77.706], MAA: [12.990, 80.169], LKO: [26.760, 80.889], CCU: [22.655, 88.447],
  VCP: [-23.007, -47.134], CGH: [-23.626, -46.656], GIG: [-22.809, -43.250], SDU: [-22.910, -43.163], MID: [20.937, -89.658],
  TPA: [27.976, -82.533], PBI: [26.683, -80.096], SFB: [28.778, -81.237], RSW: [26.536, -81.755], JAX: [30.494, -81.688],
  MDW: [41.786, -87.752], DAL: [32.847, -96.852], HOU: [29.645, -95.279], BUR: [34.201, -118.359], LGB: [33.818, -118.152], SNA: [33.676, -117.868], ONT: [34.056, -117.601], OAK: [37.721, -122.221], SJC: [37.363, -121.929], PDX: [45.589, -122.595], COS: [38.806, -104.700], TUS: [32.116, -110.941],
  DWC: [24.897, 55.161], SHJ: [25.329, 55.517], AUH: [24.433, 54.651], KUL: [2.746, 101.710],
};

/* display names for the alternates above that the route network may not list */
const NAMES = { LGW: "London Gatwick", STN: "London Stansted", LTN: "London Luton", LCY: "London City", BHX: "Birmingham", MAN: "Manchester", BRS: "Bristol", EMA: "East Midlands", SOU: "Southampton", EDI: "Edinburgh", GLA: "Glasgow", NCL: "Newcastle",
  EWR: "Newark", LGA: "New York LaGuardia", PHL: "Philadelphia", BWI: "Baltimore", IAD: "Washington Dulles", DCA: "Washington", BDL: "Hartford", PVD: "Providence", MHT: "Manchester NH",
  ORY: "Paris Orly", BVA: "Beauvais", LIL: "Lille", AMS: "Amsterdam", RTM: "Rotterdam", EIN: "Eindhoven", BRU: "Brussels", CRL: "Charleroi", MAD: "Madrid", VLL: "Valladolid", BCN: "Barcelona", VCE: "Venice", TSF: "Treviso", VRN: "Verona", BLQ: "Bologna", FCO: "Rome", CIA: "Rome Ciampino", NAP: "Naples", MXP: "Milan Malpensa", LIN: "Milan Linate", BGY: "Bergamo",
  HHN: "Frankfurt Hahn", CGN: "Cologne", DUS: "Düsseldorf", STR: "Stuttgart", MUC: "Munich", NUE: "Nuremberg", HAM: "Hamburg", BER: "Berlin", BOM: "Mumbai", PNQ: "Pune", HYD: "Hyderabad", BLR: "Bengaluru", MAA: "Chennai", LKO: "Lucknow", CCU: "Kolkata",
  VCP: "Campinas", CGH: "São Paulo Congonhas", GIG: "Rio de Janeiro", SDU: "Rio Santos Dumont", MID: "Mérida", TPA: "Tampa", PBI: "West Palm Beach", SFB: "Orlando Sanford", RSW: "Fort Myers", JAX: "Jacksonville", MDW: "Chicago Midway", DAL: "Dallas Love Field", HOU: "Houston Hobby", BUR: "Burbank", LGB: "Long Beach", SNA: "Orange County", ONT: "Ontario CA", OAK: "Oakland", SJC: "San Jose", PDX: "Portland", COS: "Colorado Springs", TUS: "Tucson", DWC: "Dubai World Central", SHJ: "Sharjah", AUH: "Abu Dhabi", KUL: "Kuala Lumpur",
  MIA: "Miami", JFK: "New York", DEL: "Delhi", MCO: "Orlando", FLL: "Fort Lauderdale", ATL: "Atlanta", JAI: "Jaipur", AMD: "Ahmedabad", LHR: "London", LAX: "Los Angeles", ORD: "Chicago", DFW: "Dallas", SFO: "San Francisco", BOS: "Boston", LAS: "Las Vegas", SEA: "Seattle", DEN: "Denver", IAH: "Houston", PHX: "Phoenix", CUN: "Cancún", GRU: "São Paulo", FRA: "Frankfurt", CDG: "Paris", DXB: "Dubai", SIN: "Singapore" };

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

module.exports = { geocode, setFetch, SEED, NAMES };
