"use strict";
/* ── AEM headless CONTENT client (server-side) ──────────────────────────────────
   Fetches structured content (Content Fragments) from AEM via GraphQL persisted
   queries, so pages render AEM-managed content instead of hardcoded values.

   Design:
   - AEM owns CONTENT (city, copy, price, image). The app overlays PERSONALIZATION
     (behaviour/CDP) AFTER fetch — so /api/destinations = AEM content + per-user reason.
   - Proxying through Express (vs browser→AEM direct) keeps AEM credentials server-side,
     lets us merge content with CDP/SQLite in one response, and avoids CORS. (Browser-
     direct via persisted queries + CORS is the alternative — see aem/README.md.)
   - Falls back to local data when AEM isn't configured, so the demo always runs.        */

function aemConfig() {
  const enabled = /^(1|true|yes)$/i.test(process.env.AEM_ENABLED || "");
  return {
    enabled,
    base: (process.env.AEM_GRAPHQL_URL || "").replace(/\/$/, ""),
    project: process.env.AEM_PROJECT || "xperion",
    qDestinations: process.env.AEM_Q_DESTINATIONS || "destinations-all",
    qOffers: process.env.AEM_Q_OFFERS || "offers-all",
    token: process.env.AEM_AUTH_TOKEN || "",
    configured: enabled && !!process.env.AEM_GRAPHQL_URL,
  };
}

async function execPersisted(name) {
  const c = aemConfig();
  const url = `${c.base}/graphql/execute.json/${c.project}/${name}?ts=${Date.now()}`;
  const headers = { Accept: "application/json" };
  if (c.token) headers.Authorization = `Bearer ${c.token}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`AEM GraphQL HTTP ${r.status} for ${name}`);
  return r.json();
}

function imgUrl(c, img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  return img._publishUrl || img._dynamicUrl || (img._path ? c.base + img._path : null);
}

// Base destination CONTENT from AEM; null when AEM is off (caller falls back to SQLite).
async function getDestinations() {
  const c = aemConfig();
  if (!c.configured) return null;
  const j = await execPersisted(c.qDestinations);
  const items = (j && j.data && j.data.destinationList && j.data.destinationList.items) || [];
  return items.map(d => ({
    city: d.city, code: d.code, tag: d.tag,
    price: d.basePrice, miles_price: d.milesPrice != null ? d.milesPrice : null,
    emoji: d.emoji, image: imgUrl(c, d.image), blurb: d.blurb, region: d.region, affinity: d.affinity,
  }));
}

// Affinity offers/packages CONTENT from AEM; null when off (caller falls back to packages.js).
async function getOffers() {
  const c = aemConfig();
  if (!c.configured) return null;
  const j = await execPersisted(c.qOffers);
  const items = (j && j.data && j.data.offerList && j.data.offerList.items) || [];
  return items.map(o => ({
    id: o.id, affinity: o.affinity, badge: o.badge, city: o.city, code: o.code,
    event: o.event, venue: o.venue, date: o.date, eventPrice: o.eventPrice,
    hotel: o.hotel, hotelNights: o.hotelNights, hotelPrice: o.hotelPrice,
    flightDesc: o.flightDesc, flightPrice: o.flightPrice, image: imgUrl(c, o.image), blurb: o.blurb,
  }));
}

function status() {
  const c = aemConfig();
  return { enabled: c.enabled, configured: c.configured, base: c.base || "(not set)", project: c.project, queries: { destinations: c.qDestinations, offers: c.qOffers } };
}

module.exports = { getDestinations, getOffers, status, aemConfig };
