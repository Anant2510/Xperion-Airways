/* Affinity-driven travel packages (event ticket + hotel + return flight).
   Each persona's co-branded card spend profile derives an `affinity`
   (football / golf / music), and we surface a matching bundle in a city
   they fly to. Prices are demo values; the bundle total = flight + hotel + event.
   EVERGREEN: event dates are computed forward from the real current date, so a
   package can never advertise an event that has already happened. */

// N days ahead of the real today, as YYYY-MM-DD.
function futureDate(daysAhead) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// Helper to assemble a package object with computed total.
function pkg({ id, affinity, badge, city, code, event, venue, date, eventPrice, hotel, hotelNights, hotelPrice, flightDesc, flightPrice, image, blurb, addon }) {
  const total = eventPrice + hotelPrice + flightPrice;
  return { id, affinity, badge, city, code, event, venue, date, eventPrice, hotel, hotelNights, hotelPrice, flightDesc, flightPrice, total, image, blurb, addon };
}

// Packages by affinity. `home` is filled per-request so the return flight is correct.
const PACKAGES = {
  football: (home) => pkg({
    id: "miami-derby",
    affinity: "football",
    badge: "Matchday in Miami",
    city: "Miami",
    code: "MIA",
    event: "Miami derby — league matchday",
    venue: "Gardens Stadium · Miami",
    date: futureDate(45),
    eventPrice: 120,
    hotel: "Bayside House · 4★",
    hotelNights: 3,
    hotelPrice: 310,
    flightDesc: `Return ${home} ⇄ MIA · Economy`,
    flightPrice: 96,
    image: "https://images.unsplash.com/photo-1577223625816-7546f13df25d?auto=format&fit=crop&w=1000&q=80",
    blurb: "You stream every match and your card sees the stadium spend — here's the real thing. Match ticket, 3 nights bayside, and your return flight, one tap.",
    addon: null,
  }),
  golf: (home) => pkg({
    id: "desert-classic",
    affinity: "golf",
    badge: "Championship Sunday",
    city: "Las Vegas",
    code: "LAS",
    event: "Desert Classic — Final Round",
    venue: "Canyon Ridge GC · Las Vegas",
    date: futureDate(60),
    eventPrice: 95,
    hotel: "Canyon Ridge Resort · 4★ (fairway view)",
    hotelNights: 2,
    hotelPrice: 320,
    flightDesc: `Return ${home} ⇄ LAS · Economy`,
    flightPrice: 138,
    image: "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=1000&q=80",
    blurb: "Your weekends and your card both point to the fairway. Tournament grounds pass, 2 nights on the course, and your return flight — clubs welcome.",
    addon: { code: "golfbag", label: "Golf-kit check-in bag (15kg)", normal: 45, price: 28, note: "We noticed you usually fly weekends — add your clubs for less when you book this trip." },
  }),
  music: (home) => pkg({
    id: "nyc-live",
    affinity: "music",
    badge: "Live in New York",
    city: "New York",
    code: "JFK",
    event: "Stadium live — summer tour night",
    venue: "Harbor Arena · New York",
    date: futureDate(30),
    eventPrice: 145,
    hotel: "Midtown Boutique · 5★",
    hotelNights: 2,
    hotelPrice: 430,
    flightDesc: `Return ${home} ⇄ JFK · Business`,
    flightPrice: 540,
    image: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1000&q=80",
    blurb: "Concerts top your card spend, and this one's in a city you already love. Floor ticket, 2 nights downtown, and your return flight in Business.",
    addon: null,
  }),
};

// Second venues so a package never flies a customer to their own city.
const ALT = {
  football: (home) => pkg({ id: "nyc-derby", affinity: "football", badge: "Matchday in New York", city: "New York", code: "JFK", event: "New York derby — league matchday", venue: "Harbor Stadium · New York", date: futureDate(38), eventPrice: 135, hotel: "Midtown Boutique · 4★", hotelNights: 2, hotelPrice: 380, flightDesc: `Return ${home} ⇄ JFK · Economy`, flightPrice: 118, image: "https://images.unsplash.com/photo-1577223625816-7546f13df25d?auto=format&fit=crop&w=1000&q=80", blurb: "You stream every match and your card sees the stadium spend — here's the real thing in New York. Match ticket, 2 nights midtown, and your return flight, one tap.", addon: null }),
  golf: (home) => pkg({ id: "orlando-classic", affinity: "golf", badge: "Tee time in Orlando", city: "Orlando", code: "MCO", event: "Orlando Classic — pro-am weekend", venue: "Lakeside Links · Orlando", date: futureDate(52), eventPrice: 210, hotel: "Fairway Lodge · 4★", hotelNights: 3, hotelPrice: 420, flightDesc: `Return ${home} ⇄ MCO · Economy`, flightPrice: 104, image: "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=1000&q=80", blurb: "Green fees, three nights on the course, and your flights — one tap.", addon: null }),
  music: (home) => pkg({ id: "miami-bayfront", affinity: "music", badge: "Live in Miami", city: "Miami", code: "MIA", event: "Bayfront live — summer tour night", venue: "Bayfront Amphitheater · Miami", date: futureDate(34), eventPrice: 125, hotel: "Bayside House · 4★", hotelNights: 2, hotelPrice: 300, flightDesc: `Return ${home} ⇄ MIA · Economy`, flightPrice: 96, image: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1000&q=80", blurb: "Concerts top your card spend — floor ticket, two nights by the bay, and your return flight.", addon: null }),
};

// The package for an affinity + home airport: the venue that is NOT the customer's own city.
// If every venue is local, it becomes a ticket + hotel package with no flight.
function packageFor(affinity, home) {
  home = home || "JFK";
  const makers = [PACKAGES[affinity], ALT[affinity]].filter(Boolean);
  if (!makers.length) return null;
  const away = makers.map((m) => m(home)).find((p) => p.code !== home);
  if (away) return away;
  const local = makers[0](home);
  return { ...local, flightDesc: "No flight needed — you're local", flightPrice: 0, total: (local.total || 0) - (local.flightPrice || 0), local: true, blurb: local.blurb.replace(/,? and your return flight[^.]*\./i, ".") };
}
// Every package in a given city (for "anything on there?" questions)
function packagesIn(code, home) {
  code = String(code || "").toUpperCase();
  return Object.keys(PACKAGES).flatMap((a) => [PACKAGES[a], ALT[a]].filter(Boolean).map((m) => m(home || "JFK"))).filter((p) => p.code === code);
}

module.exports = { packageFor, packagesIn };
