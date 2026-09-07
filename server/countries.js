"use strict";
/* countries.js — resolve a country name to the airport a traveller most likely means.
   Names (with common variants) → ISO code; ISO → primary gateway. Anything not listed falls
   back to the first served airport in that country. */
const { AIRPORTS } = require("./routes-data");

const NAMES = {
  "united states": "US", usa: "US", america: "US", "u.s.": "US", "united kingdom": "GB", uk: "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB",
  ireland: "IE", france: "FR", germany: "DE", spain: "ES", portugal: "PT", italy: "IT", netherlands: "NL", holland: "NL", belgium: "BE", switzerland: "CH", austria: "AT",
  denmark: "DK", sweden: "SE", norway: "NO", finland: "FI", iceland: "IS", poland: "PL", "czech republic": "CZ", czechia: "CZ", hungary: "HU", greece: "GR", turkey: "TR", türkiye: "TR",
  croatia: "HR", romania: "RO", bulgaria: "BG", serbia: "RS", ukraine: "UA", russia: "RU", estonia: "EE", latvia: "LV", lithuania: "LT", malta: "MT", cyprus: "CY", luxembourg: "LU",
  "united arab emirates": "AE", uae: "AE", emirates: "AE", qatar: "QA", "saudi arabia": "SA", saudi: "SA", oman: "OM", bahrain: "BH", kuwait: "KW", jordan: "JO", israel: "IL", lebanon: "LB",
  egypt: "EG", morocco: "MA", tunisia: "TN", algeria: "DZ", "south africa": "ZA", kenya: "KE", ethiopia: "ET", nigeria: "NG", ghana: "GH", tanzania: "TZ", uganda: "UG", rwanda: "RW", senegal: "SN", mauritius: "MU", seychelles: "SC",
  india: "IN", pakistan: "PK", bangladesh: "BD", "sri lanka": "LK", nepal: "NP", maldives: "MV", thailand: "TH", vietnam: "VN", singapore: "SG", malaysia: "MY", indonesia: "ID", philippines: "PH", cambodia: "KH",
  china: "CN", "hong kong": "HK", taiwan: "TW", japan: "JP", "south korea": "KR", korea: "KR", australia: "AU", "new zealand": "NZ", fiji: "FJ",
  canada: "CA", mexico: "MX", brazil: "BR", brasil: "BR", argentina: "AR", chile: "CL", peru: "PE", colombia: "CO", ecuador: "EC", uruguay: "UY", bolivia: "BO", paraguay: "PY", venezuela: "VE",
  panama: "PA", "costa rica": "CR", guatemala: "GT", honduras: "HN", "el salvador": "SV", nicaragua: "NI", belize: "BZ", cuba: "CU", jamaica: "JM", "dominican republic": "DO", bahamas: "BS", barbados: "BB", "trinidad": "TT", "puerto rico": "PR", aruba: "AW", curacao: "CW", "cayman islands": "KY", bermuda: "BM",
};
const PRIMARY = {
  US: "JFK", GB: "LHR", IE: "DUB", FR: "CDG", DE: "FRA", ES: "MAD", PT: "LIS", IT: "FCO", NL: "AMS", BE: "BRU", CH: "ZRH", AT: "VIE", DK: "CPH", SE: "ARN", NO: "OSL", FI: "HEL", IS: "KEF",
  PL: "WAW", CZ: "PRG", HU: "BUD", GR: "ATH", TR: "IST", HR: "ZAG", RO: "OTP", BG: "SOF", RS: "BEG", UA: "KBP", RU: "SVO", EE: "TLL", LV: "RIX", LT: "VNO", MT: "MLA", CY: "LCA", LU: "LUX",
  AE: "DXB", QA: "DOH", SA: "RUH", OM: "MCT", BH: "BAH", KW: "KWI", JO: "AMM", IL: "TLV", LB: "BEY", EG: "CAI", MA: "CMN", TN: "TUN", DZ: "ALG", ZA: "JNB", KE: "NBO", ET: "ADD", NG: "LOS", GH: "ACC", TZ: "DAR", UG: "EBB", RW: "KGL", SN: "DSS", MU: "MRU", SC: "SEZ",
  IN: "DEL", PK: "KHI", BD: "DAC", LK: "CMB", NP: "KTM", MV: "MLE", TH: "BKK", VN: "SGN", SG: "SIN", MY: "KUL", ID: "CGK", PH: "MNL", KH: "PNH", CN: "PEK", HK: "HKG", TW: "TPE", JP: "HND", KR: "ICN", AU: "SYD", NZ: "AKL", FJ: "NAN",
  CA: "YYZ", MX: "MEX", BR: "GRU", AR: "EZE", CL: "SCL", PE: "LIM", CO: "BOG", EC: "UIO", UY: "MVD", BO: "VVI", PY: "ASU", VE: "CCS", PA: "PTY", CR: "SJO", GT: "GUA", HN: "SAP", SV: "SAL", NI: "MGA", BZ: "BZE", CU: "HAV", JM: "KIN", DO: "SDQ", BS: "NAS", BB: "BGI", TT: "POS", PR: "SJU", AW: "AUA", CW: "CUR", KY: "GCM", BM: "BDA",
};

function countryCode(text) {
  const t = String(text || "").toLowerCase();
  let best = null;
  for (const [name, iso] of Object.entries(NAMES)) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t) && (!best || name.length > best.name.length)) best = { name, iso };
  }
  return best ? best.iso : null;
}
function gatewayFor(iso) {
  if (!iso) return null;
  const p = PRIMARY[iso];
  if (p && AIRPORTS[p]) return p;
  const any = Object.keys(AIRPORTS).filter((c) => AIRPORTS[c].country === iso).sort();
  return any[0] || null;
}
function airportsIn(iso) { return Object.keys(AIRPORTS).filter((c) => AIRPORTS[c].country === iso); }
/* the world's major airports, in rough order of traffic: used to rank a country's list so the
   customer sees the big gateways first */
const MAJOR = "ATL DXB DFW LHR HND DEN IST ORD DEL LAX CAN CDG JFK LAS AMS MIA MAD PEK SFO FRA SEA CLT MCO EWR PVG SIN ICN BKK HKG SZX BOM CGK KUL MEX SYD GRU FCO MUC BCN LGW DOH JED RUH CTU YYZ TPE MNL SGN HAN BLR MAA HYD CCU COK GOI PNQ AMD JAI LKO IXC TRV ATQ NAG NRT KIX ITM FUK CTS OKA NGO KKJ CPH ARN OSL HEL BLL AAL AAR ODE DUB MAN EDI BHX GLA STN LTN LIS OPO FAO VIE ZRH GVA BRU ATH SKG WAW KRK PRG BUD OTP SOF BEG KBP SVO LED TLV CAI CMN RAK JNB CPT DUR NBO ADD LOS ACC DAR EBB KGL DSS MRU AUH SHJ MCT BAH KWI AMM BEY KHI LHE ISB DAC CMB KTM MLE PNH RGN DPS SUB HKT CNX CEB HAK XIY CKG KMG WUH NKG HGH XMN CSX TSN URC PER MEL BNE ADL AKL CHC WLG NAN YVR YUL YYC YEG YOW CUN GDL MTY TIJ SJD PVR MID GIG BSB CNF SSA REC FOR POA CWB EZE AEP COR SCL LIM BOG MDE CLO UIO GYE PTY SJO GUA SAL HAV MBJ KIN SDQ PUJ NAS SJU BGI POS AUA CUR GCM BDA".split(" ");
const RANK = new Map(MAJOR.map((c, i) => [c, i]));
/* served airports for a country, ranked: gateway, then major-airport rank, then by city name */
function listServed(iso, limit = 8) {
  const p = PRIMARY[iso];
  const rank = (c) => (c === p ? -1 : RANK.has(c) ? RANK.get(c) : 10000);
  const all = airportsIn(iso).map((code) => ({ code, city: AIRPORTS[code].city })).sort((a, b) => rank(a.code) - rank(b.code) || a.city.localeCompare(b.city));
  return { list: all.slice(0, limit), more: Math.max(0, all.length - limit), total: all.length };
}
function nameOf(iso) { const e = Object.entries(NAMES).find(([, v]) => v === iso); return e ? e[0].replace(/\b\w/g, (m) => m.toUpperCase()) : iso; }

module.exports = { countryCode, gatewayFor, airportsIn, listServed, nameOf, NAMES, PRIMARY };
