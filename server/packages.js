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

// Return the package for a given affinity + home airport (or null).
function packageFor(affinity, home) {
  const make = PACKAGES[affinity];
  return make ? make(home || "JFK") : null;
}

module.exports = { packageFor };
