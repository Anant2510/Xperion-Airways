/* ──────────────────────────────────────────────────────────────
   Xperion Demo — route network
   100 routes worldwide: 50 European (Portugal-heavy), 50 long-haul
   / intercontinental. Used by the flight-search engine; flights are
   generated deterministically per route so search always returns
   realistic options without seeding tens of thousands of rows.
   ────────────────────────────────────────────────────────────── */

// Airports referenced by the route network (code → city, country, region)
const AIRPORTS = {
  // Portugal
  LIS: { city: "Lisbon",    country: "Portugal", region: "Europe" },
  OPO: { city: "Porto",     country: "Portugal", region: "Europe" },
  FAO: { city: "Faro",      country: "Portugal", region: "Europe" },
  FNC: { city: "Funchal",   country: "Portugal", region: "Europe" },
  PDL: { city: "Ponta Delgada", country: "Portugal", region: "Europe" },
  TER: { city: "Terceira",  country: "Portugal", region: "Europe" },
  // Spain
  MAD: { city: "Madrid",    country: "Spain", region: "Europe" },
  BCN: { city: "Barcelona", country: "Spain", region: "Europe" },
  AGP: { city: "Málaga",    country: "Spain", region: "Europe" },
  XPC: { city: "Valencia",  country: "Spain", region: "Europe" },
  SVQ: { city: "Seville",   country: "Spain", region: "Europe" },
  BIO: { city: "Bilbao",    country: "Spain", region: "Europe" },
  PMI: { city: "Palma",     country: "Spain", region: "Europe" },
  // France
  CDG: { city: "Paris",     country: "France", region: "Europe" },
  ORY: { city: "Paris Orly",country: "France", region: "Europe" },
  LYS: { city: "Lyon",      country: "France", region: "Europe" },
  NCE: { city: "Nice",      country: "France", region: "Europe" },
  MRS: { city: "Marseille", country: "France", region: "Europe" },
  TLS: { city: "Toulouse",  country: "France", region: "Europe" },
  // UK & Ireland
  LHR: { city: "London",        country: "United Kingdom", region: "Europe" },
  LGW: { city: "London Gatwick",country: "United Kingdom", region: "Europe" },
  MAN: { city: "Manchester",    country: "United Kingdom", region: "Europe" },
  DUB: { city: "Dublin",        country: "Ireland", region: "Europe" },
  EDI: { city: "Edinburgh",     country: "United Kingdom", region: "Europe" },
  // Germany
  FRA: { city: "Frankfurt", country: "Germany", region: "Europe" },
  MUC: { city: "Munich",    country: "Germany", region: "Europe" },
  BER: { city: "Berlin",    country: "Germany", region: "Europe" },
  DUS: { city: "Düsseldorf",country: "Germany", region: "Europe" },
  HAM: { city: "Hamburg",   country: "Germany", region: "Europe" },
  // Italy
  FCO: { city: "Rome",      country: "Italy", region: "Europe" },
  MXP: { city: "Milan",     country: "Italy", region: "Europe" },
  VCE: { city: "Venice",    country: "Italy", region: "Europe" },
  NAP: { city: "Naples",    country: "Italy", region: "Europe" },
  // Benelux & Switzerland & Austria
  AMS: { city: "Amsterdam", country: "Netherlands", region: "Europe" },
  BRU: { city: "Brussels",  country: "Belgium", region: "Europe" },
  LUX: { city: "Luxembourg",country: "Luxembourg", region: "Europe" },
  ZRH: { city: "Zurich",    country: "Switzerland", region: "Europe" },
  GVA: { city: "Geneva",    country: "Switzerland", region: "Europe" },
  VIE: { city: "Vienna",    country: "Austria", region: "Europe" },
  // Nordics
  CPH: { city: "Copenhagen",country: "Denmark", region: "Europe" },
  ARN: { city: "Stockholm", country: "Sweden", region: "Europe" },
  OSL: { city: "Oslo",      country: "Norway", region: "Europe" },
  HEL: { city: "Helsinki",  country: "Finland", region: "Europe" },
  // Eastern / Southern Europe
  WAW: { city: "Warsaw",    country: "Poland", region: "Europe" },
  PRG: { city: "Prague",    country: "Czechia", region: "Europe" },
  BUD: { city: "Budapest",  country: "Hungary", region: "Europe" },
  ATH: { city: "Athens",    country: "Greece", region: "Europe" },
  IST: { city: "Istanbul",  country: "Turkey", region: "Europe" },
  OTP: { city: "Bucharest", country: "Romania", region: "Europe" },
  // North America
  JFK: { city: "New York",     country: "USA", region: "North America" },
  EWR: { city: "Newark",       country: "USA", region: "North America" },
  BOS: { city: "Boston",       country: "USA", region: "North America" },
  IAD: { city: "Washington",   country: "USA", region: "North America" },
  MIA: { city: "Miami",        country: "USA", region: "North America" },
  ORD: { city: "Chicago",      country: "USA", region: "North America" },
  LAX: { city: "Los Angeles",  country: "USA", region: "North America" },
  SFO: { city: "San Francisco",country: "USA", region: "North America" },
  YUL: { city: "Montreal",     country: "Canada", region: "North America" },
  YYZ: { city: "Toronto",      country: "Canada", region: "North America" },
  // South America
  GRU: { city: "São Paulo",      country: "Brazil", region: "South America" },
  GIG: { city: "Rio de Janeiro", country: "Brazil", region: "South America" },
  BSB: { city: "Brasília",       country: "Brazil", region: "South America" },
  CNF: { city: "Belo Horizonte", country: "Brazil", region: "South America" },
  REC: { city: "Recife",         country: "Brazil", region: "South America" },
  FOR: { city: "Fortaleza",      country: "Brazil", region: "South America" },
  SSA: { city: "Salvador",       country: "Brazil", region: "South America" },
  POA: { city: "Porto Alegre",   country: "Brazil", region: "South America" },
  EZE: { city: "Buenos Aires",   country: "Argentina", region: "South America" },
  SCL: { city: "Santiago",       country: "Chile", region: "South America" },
  BOG: { city: "Bogotá",         country: "Colombia", region: "South America" },
  LIM: { city: "Lima",           country: "Peru", region: "South America" },
  // Africa
  CMN: { city: "Casablanca", country: "Morocco", region: "Africa" },
  RAK: { city: "Marrakesh",  country: "Morocco", region: "Africa" },
  ALG: { city: "Algiers",    country: "Algeria", region: "Africa" },
  TUN: { city: "Tunis",      country: "Tunisia", region: "Africa" },
  DKR: { city: "Dakar",      country: "Senegal", region: "Africa" },
  RAI: { city: "Praia",      country: "Cape Verde", region: "Africa" },
  SID: { city: "Sal",        country: "Cape Verde", region: "Africa" },
  LAD: { city: "Luanda",     country: "Angola", region: "Africa" },
  MPM: { city: "Maputo",     country: "Mozambique", region: "Africa" },
  ACC: { city: "Accra",      country: "Ghana", region: "Africa" },
  CAI: { city: "Cairo",      country: "Egypt", region: "Africa" },
  JNB: { city: "Johannesburg", country: "South Africa", region: "Africa" },
  // Middle East & Asia
  TLV: { city: "Tel Aviv",  country: "Israel", region: "Middle East" },
  DXB: { city: "Dubai",     country: "UAE", region: "Middle East" },
  DOH: { city: "Doha",      country: "Qatar", region: "Middle East" },
  BKK: { city: "Bangkok",   country: "Thailand", region: "Asia" },
  HKG: { city: "Hong Kong", country: "Hong Kong", region: "Asia" },
  NRT: { city: "Tokyo",     country: "Japan", region: "Asia" },
  SIN: { city: "Singapore", country: "Singapore", region: "Asia" },
  DEL: { city: "Delhi",     country: "India", region: "Asia" },
  BOM: { city: "Mumbai",    country: "India", region: "Asia" },
};

// 100 routes: [origin, dest, durationMinutes, baseFareEUR, intl?]
// First 50 = European (Portugal-heavy domestic + PT↔Europe + key intra-Europe).
const BASE_ROUTES = [
  // ── Portugal domestic & islands (10) ──
  ["LIS","OPO",55,64],["OPO","LIS",55,64],
  ["LIS","FAO",50,59],["OPO","FAO",80,72],
  ["LIS","FNC",100,89],["OPO","FNC",110,94],
  ["LIS","PDL",140,119],["OPO","PDL",150,124],
  ["LIS","TER",135,114],["PDL","FNC",95,99],
  // ── Portugal ↔ rest of Europe (24) ──
  ["LIS","MAD",80,74],["OPO","MAD",85,79],
  ["LIS","BCN",105,84],["OPO","BCN",105,88],
  ["LIS","CDG",160,121],["OPO","CDG",150,129],
  ["LIS","ORY",160,118],["LIS","LYS",145,112],
  ["LIS","LHR",165,134],["OPO","LHR",160,139],
  ["LIS","LGW",165,109],["LIS","MAN",185,128],
  ["LIS","DUB",160,118],["OPO","DUB",150,121],
  ["LIS","FRA",175,144],["OPO","FRA",165,149],
  ["LIS","MUC",185,151],["LIS","BER",195,139],
  ["LIS","AMS",185,141],["OPO","AMS",160,146],
  ["LIS","BRU",170,132],["LIS","ZRH",160,154],
  ["LIS","FCO",175,149],["LIS","MXP",160,144],
  // ── Key intra-Europe (16) ──
  ["MAD","BCN",75,69],["MAD","CDG",125,99],["MAD","LHR",140,124],
  ["BCN","FCO",105,89],["CDG","LHR",80,94],["CDG","FRA",80,99],
  ["FRA","MUC",55,79],["AMS","LHR",75,89],["AMS","CDG",75,84],
  ["FCO","MXP",70,64],["LHR","DUB",85,74],["ZRH","VIE",80,99],
  ["CPH","ARN",75,69],["VIE","BER",90,84],["WAW","FRA",110,94],
  ["ATH","FCO",130,109],
  // ── Long-haul / intercontinental from Portugal (24) ──
  ["LIS","JFK",480,449],["LIS","EWR",480,439],["LIS","BOS",450,429],
  ["LIS","IAD",495,459],["LIS","MIA",540,489],["OPO","JFK",495,469],
  ["LIS","YUL",430,419],["LIS","YYZ",460,439],
  ["LIS","GRU",615,529],["LIS","GIG",630,539],["LIS","BSB",660,559],
  ["LIS","CNF",645,549],["LIS","REC",450,469],["LIS","FOR",435,459],
  ["OPO","GRU",625,539],["LIS","SSA",480,489],
  ["LIS","CMN",105,99],["LIS","RAK",130,119],["LIS","DKR",240,219],
  ["LIS","RAI",225,209],["LIS","SID",215,199],["LIS","LAD",480,449],
  ["LIS","MPM",660,599],["LIS","TLV",300,259],
  // ── Long-haul rest-of-world (26) ──
  ["MAD","GRU",630,549],["MAD","EZE",795,629],["MAD","SCL",870,699],
  ["MAD","BOG",660,579],["MAD","LIM",750,619],["BCN","JFK",495,459],
  ["CDG","JFK",465,479],["CDG","NRT",720,699],["LHR","JFK",450,499],
  ["LHR","DXB",420,449],["LHR","SIN",810,759],["LHR","HKG",750,719],
  ["FRA","SIN",750,729],["FRA","JNB",660,599],["AMS","JFK",480,469],
  ["FRA","JFK",510,539],["FRA","GRU",730,649],["FRA","MIA",565,569],
  ["JFK","FRA",495,539],["GRU","FRA",720,649],["MIA","FRA",550,569],
  ["IST","DXB",270,259],["DXB","DEL",195,219],["DXB","BOM",180,209],
  ["DOH","BKK",390,389],["JFK","LAX",360,329],["JFK","SFO",375,339],
  ["GRU","EZE",165,179],["JNB","CAI",480,459],["CAI","DXB",180,189],
  ["BKK","SIN",135,149],["NRT","HKG",230,259],
];

// The source list above is mostly one-directional (PT hubs → Europe), so a round-trip's
// inbound leg (e.g. MAD → OPO) had no route and returned 0 flights. Derive a fully
// bidirectional network here: every city pair becomes flyable both ways with symmetric
// duration/fare. Originals are kept authoritative; a reverse is added only when missing.
// db.js re-syncs ROUTES into the routes table on every boot, so these inbound legs get
// ingested into the live DB on deploy without a reset.
const ROUTES = (() => {
  const out = [], seen = new Set();
  const push = (o, d, dur, fare, intl) => {
    const k = `${o}-${d}`;
    if (o === d || seen.has(k)) return;
    seen.add(k);
    out.push(intl == null ? [o, d, dur, fare] : [o, d, dur, fare, intl]);
  };
  for (const [o, d, dur, fare, intl] of BASE_ROUTES) push(o, d, dur, fare, intl);   // originals win
  for (const [o, d, dur, fare, intl] of BASE_ROUTES) push(d, o, dur, fare, intl);   // add missing reverse legs
  return out;
})();

module.exports = { AIRPORTS, ROUTES };
