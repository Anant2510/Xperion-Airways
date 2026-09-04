/* autonomy/seed.js — Phase 1 synthetic dataset.
   Airports carry geo, curfews and ALTERNATE_OF edges (MIA↔FLL/MCO/ATL,
   DEL↔JAI/AMD). One FlightSchedule XP-201 DEL→MIA plus a dated FlightInstance,
   partner recovery flights, vendors near MIA/MCO, and ~214 passengers across
   120 PNRs spanning tiers, parties, vulnerabilities, consent, quiet hours and
   locales. Deterministic PRNG so every sim run is identical. */
"use strict";
const G = require("./graph");
const V = require("./vendors");
const clock = require("./clock");

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const AIRPORTS = [
  ["DEL", { name: "Delhi Indira Gandhi", geo: { lat: 28.556, lon: 77.100 }, curfew: null }],
  ["MIA", { name: "Miami International", geo: { lat: 25.795, lon: -80.287 }, curfew: null }],
  ["FLL", { name: "Fort Lauderdale", geo: { lat: 26.074, lon: -80.150 }, curfew: null }],
  ["MCO", { name: "Orlando International", geo: { lat: 28.431, lon: -81.308 }, curfew: null }],
  ["ATL", { name: "Atlanta Hartsfield", geo: { lat: 33.640, lon: -84.427 }, curfew: null }],
  ["JFK", { name: "New York JFK", geo: { lat: 40.641, lon: -73.778 }, curfew: null }],
  ["JAI", { name: "Jaipur", geo: { lat: 26.824, lon: 75.812 }, curfew: null }],
  ["AMD", { name: "Ahmedabad", geo: { lat: 23.077, lon: 72.634 }, curfew: null }],
];
const ALTERNATES = [
  ["MIA", "FLL", 45], ["MIA", "MCO", 240], ["MIA", "ATL", 600],
  ["DEL", "JAI", 280], ["DEL", "AMD", 560],
];

function seedWorld({ depIso }) {
  const dep = new Date(depIso);
  const arr = new Date(dep.getTime() + 17.5 * 3600e3);           // long-haul block
  for (const [iata, p] of AIRPORTS) G.upsertNode(`ap:${iata}`, "Airport", { iata, ...p });
  for (const [a, b, min] of ALTERNATES) {
    G.upsertEdge(`ap:${a}`, "ALTERNATE_OF", `ap:${b}`, { ground_transfer_min: min });
    G.upsertEdge(`ap:${b}`, "ALTERNATE_OF", `ap:${a}`, { ground_transfer_min: min });
  }
  G.upsertNode("fs:XP201", "FlightSchedule", { flight_no: "XP201", origin: "DEL", dest: "MIA" });
  const fiId = `fi:XP201:${depIso.slice(0, 10)}`;
  G.upsertNode(fiId, "FlightInstance", {
    flight_no: "XP201", date: depIso.slice(0, 10), sched_dep: dep.toISOString(), sched_arr: arr.toISOString(),
    origin: "DEL", dest: "MIA", aircraft_type: "A339", status: "scheduled",
  });
  G.upsertEdge(fiId, "DEPARTS_FROM", "ap:DEL"); G.upsertEdge(fiId, "ARRIVES_AT", "ap:MIA");

  /* recovery inventory (STUB seats live in vendors) */
  const nextMorning = new Date(arr); nextMorning.setUTCHours(13, 0, 0, 0); nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
  const eveBefore = new Date(dep.getTime() - 6 * 3600e3);
  G.upsertNode("fi:XP903", "FlightInstance", { flight_no: "XP903", origin: "DEL", dest: "JFK", sched_dep: eveBefore.toISOString(), recovery: true });
  G.upsertNode("fi:XP077", "FlightInstance", { flight_no: "XP077", origin: "JFK", dest: "MIA", sched_dep: nextMorning.toISOString(), recovery: true });
  V.seedSeats({ XP903: 260, XP077: 260 });

  const vendors = [
    ["ven:hotel:mco1", { type: "HOTEL", location: "MCO", rate: 120, name: "Orlando Gateway Inn" }],
    ["ven:hotel:mia1", { type: "HOTEL", location: "MIA", rate: 150, name: "Miami Bay Rest" }],
    ["ven:taxi:mco1",  { type: "TAXI",  location: "MCO", rate: 60,  name: "Sunshine Transfers" }],
    ["ven:partner:jfk",{ type: "PARTNER_AIRLINE", location: "JFK", name: "Interline via JFK" }],
  ];
  for (const [id, p] of vendors) G.upsertNode(id, "Vendor", p);
  return { fiId, dep, arr };
}

const FIRST = ["Aarav","Diya","Kabir","Isha","Rohan","Meera","Vihaan","Anaya","Arjun","Sara","Dev","Nia","Ravi","Tara","Om","Zoya","Neel","Rhea","Yash","Ira"];
const LAST  = ["Sharma","Mehta","Iyer","Khan","Kapoor","Rao","Das","Bose","Nair","Gill","Patel","Singh","Verma","Joshi","Kaur","Menon"];

function seedPassengers(fiId) {
  const r = rng(42);
  const sizes = [...Array(60).fill(1), ...Array(40).fill(2), ...Array(14).fill(3), ...Array(8).fill(4)]; // 214 pax / 122 PNRs? 60+80+42+32=214, PNRs=122
  let pax = 0, pnrN = 0;
  for (const size of sizes) {
    pnrN++;
    const pnrId = `pnr:XPA${String(pnrN).padStart(3, "0")}`;
    const onward = r() < 0.3;   // misconnect exposure MIA→ATL
    G.upsertNode(pnrId, "PNR", {
      record_locator: pnrId.split(":")[1], party_size: size, fare_class: r() < 0.15 ? "J" : "Y",
      segments: onward ? [{ f: "XP201" }, { f: "XP642", from: "MIA", to: "ATL", connect_min: 95 }] : [{ f: "XP201" }],
    });
    G.upsertEdge(fiId, "CARRIES", pnrId);
    const members = [];
    for (let i = 0; i < size; i++) {
      pax++;
      const tR = r(); const tier = tR < 0.08 ? "Platinum" : tR < 0.25 ? "Gold" : tR < 0.5 ? "Silver" : "Base";
      const vuln = r() < 0.07 ? (r() < 0.5 ? "reduced_mobility" : "elderly") : null;
      const locale = r() < 0.35 ? "hi-IN" : "en-GB";
      const channels = [
        { channel: "push",  consent: r() < 0.8 },
        { channel: "sms",   consent: r() < 0.6 },
        { channel: "whatsapp", consent: r() < 0.4 },
        { channel: "email", consent: r() < 0.95 },
      ];
      const pid = `pax:${String(pax).padStart(3, "0")}`;
      G.upsertNode(pid, "Passenger", {
        name: `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`,
        loyalty_tier: tier, vulnerability_flags: vuln ? [vuln] : [],
        contact_channels: channels, quiet_hours: { start: 22, end: 6 }, locale,
        flexible: r() < 0.25, ltv_band: tier === "Platinum" ? "top" : tier === "Gold" ? "high" : "std",
      });
      G.upsertEdge(pnrId, "BELONGS_TO", pid);
      members.push(pid);
    }
    for (const a of members) for (const b of members) if (a !== b) G.upsertEdge(a, "TRAVELS_WITH", b);
  }
  return { passengers: pax, pnrs: pnrN };
}

module.exports = { seedWorld, seedPassengers };
