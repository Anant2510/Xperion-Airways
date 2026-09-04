"use strict";
/* ── Adobe Real-Time CDP profile provider ─────────────────────────────────
   Supplies the unified customer profile + traits used by ALL personalization.
   Two modes, chosen automatically:
     • LIVE       — when Adobe IMS credentials are present in the environment,
                    we mint an IMS S2S token and read the Real-Time Customer
                    Profile (Profile API) for the persona's identity, then map
                    the XDM individual profile into the app's profile shape.
     • SIMULATED  — when no credentials are set (e.g. the demo VM), we build the
                    same unified profile from the local persona, wrapped in an
                    XDM individual-profile envelope with a stitched identity
                    graph, real-time audience memberships and consent — i.e. the
                    exact artifacts a live RT-CDP would return — so the demo is
                    fully functional and credential-ready without a tenant.
   Either way the returned `profile` hydrates users/preferences/vouchers, so the
   web portal, web AI chat and WhatsApp all personalize from CDP identically. */

const { PERSONAS, DEFAULT_PERSONA } = require("./db");

/* ── configuration (env-driven; all optional) ── */
function rawConfig() {
  const c = {
    enabled: /^(1|true|yes)$/i.test(process.env.ADOBE_CDP_ENABLED || ""),
    imsOrg: process.env.ADOBE_IMS_ORG || "",
    clientId: process.env.ADOBE_CLIENT_ID || "",
    clientSecret: process.env.ADOBE_CLIENT_SECRET || "",
    sandbox: process.env.ADOBE_SANDBOX || "prod",
    profileApi: process.env.ADOBE_PROFILE_API || "https://platform.adobe.io/data/core/ups",
    imsTokenUrl: process.env.ADOBE_IMS_URL || "https://ims-na1.adobelogin.com/ims/token/v3",
    scopes: process.env.ADOBE_SCOPES || "openid,AdobeID,read_organizations,additional_info.projectedProductContext,session",
    // READ path: the unified profile is always the union view _xdm.context.profile —
    // NOT a tenant schema id. (Tenant schema/dataset ids below are for INGESTION only.)
    profileView: process.env.ADOBE_PROFILE_VIEW || "_xdm.context.profile",
    // Identity to look a profile up by. Use the namespace SYMBOL from AEP
    // (Admin > Identities), e.g. "Email" or your loyalty-id symbol — not the display name.
    identityNamespace: process.env.ADOBE_IDENTITY_NS || "Email",
    // Which profile attribute supplies the lookup value: "email" or "loyalty" (member_no).
    lookupAttr: (process.env.ADOBE_LOOKUP_ATTR || "").toLowerCase(),
    lookupValueOverride: process.env.ADOBE_LOOKUP_VALUE || "",
    // INGESTION config — used only when streaming events INTO CDP, not on the read path.
    profileSchemaId: process.env.ADOBE_PROFILE_SCHEMA_ID || "",
    eventSchemaId: process.env.ADOBE_EVENT_SCHEMA_ID || "",
    profileDatasetId: process.env.ADOBE_PROFILE_DATASET_ID || "",
    eventDatasetId: process.env.ADOBE_EVENT_DATASET_ID || "",
    // Event STREAMING (DCS inlet) — real-time events into the event dataset:
    streamingUrl: process.env.ADOBE_STREAMING_URL || "",
    eventFlowId: process.env.ADOBE_EVENT_FLOW_ID || "",
    eventSyncValidation: /^(1|true|yes)$/i.test(process.env.ADOBE_EVENT_SYNC_VALIDATION || "1"),
    // Ingestion-direction config (writing profiles INTO CDP):
    loyaltyNs: process.env.ADOBE_LOYALTY_NS || "",
    // Tenant field (under _aeppsemea) that carries the runtime-computed segment membership so
    // RT-CDP mirrors the local engine. Empty = don't write it (safe before the schema field
    // exists). Set ADOBE_LOCAL_SEGMENTS_FIELD=localSegments once the field is added to the schema.
    localSegmentsField: (process.env.ADOBE_LOCAL_SEGMENTS_FIELD || "").trim(),
    ingestApi: process.env.ADOBE_INGEST_API || "https://platform.adobe.io/data/foundation/import",
    schemaRegistryApi: process.env.ADOBE_SCHEMA_API || "https://platform.adobe.io/data/foundation/schemaregistry",
    idNamespaceApi: process.env.ADOBE_IDNS_API || "https://platform.adobe.io/data/core/idnamespace",
  };
  // tenant namespace for custom XDM fields (e.g. "_aeppsemea"), derived from the schema URL
  c.tenantNs = process.env.ADOBE_TENANT_NS || (() => { const m = String(c.profileSchemaId).match(/ns\.adobe\.com\/([^/]+)\//); return m ? "_" + m[1] : "_tenant"; })();
  if (!c.lookupAttr) c.lookupAttr = /loyalty|crm|member/i.test(c.identityNamespace) ? "loyalty" : "email";
  c.configured = !!(c.enabled && c.clientId && c.clientSecret && c.imsOrg);
  return c;
}
// Public view of the config — never leaks the client secret.
function cdpConfig() {
  const c = rawConfig();
  return {
    configured: c.configured, enabled: c.enabled, sandbox: c.sandbox,
    imsOrg: c.imsOrg || "(not set)", profileApi: c.profileApi,
    identityNamespace: c.identityNamespace, lookupAttr: c.lookupAttr, profileView: c.profileView,
    streaming: { configured: !!c.streamingUrl, syncValidation: c.eventSyncValidation, eventDatasetId: c.eventDatasetId || "(not set)" },
    ingestion: {
      profileSchemaId: c.profileSchemaId || "(not set)", eventSchemaId: c.eventSchemaId || "(not set)",
      profileDatasetId: c.profileDatasetId || "(not set)", eventDatasetId: c.eventDatasetId || "(not set)",
    },
  };
}

/* ── small deterministic helpers so the identity graph is stable per persona ── */
function h32(s) { let h = 2166136261 >>> 0; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function ecidFor(seed) { let out = ""; let x = h32(seed) || 1; while (out.length < 38) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out += String(x).padStart(10, "0"); } return out.slice(0, 38); }
const lastName = (u) => (u.full_name || "").replace(u.first_name || "", "").trim();

function identityMap(u) {
  return {
    primary: rawConfig().identityNamespace,
    ECID: ecidFor((u.email || "") + (u.member_no || "")),
    Email: u.email,
    loyaltyId: u.member_no,
    CRMID: "CRM-" + String(u.member_no || "").replace(/\D/g, ""),
    phone: u.phone,
  };
}

// Real-time audience memberships derived from the persona's traits + behaviour.
// These are the segments that "trigger" each personalization in CDP mode.
function audiences(u) {
  const a = [];
  if (u.tier) a.push({ id: "loyalty_" + String(u.tier).toLowerCase(), name: `${u.tier} Tier Member`, status: "realized", source: "Loyalty profile (CRM)" });
  a.push({ id: "freq_commuter_" + (u.home_airport || "").toLowerCase(), name: `Frequent ${u.home_airport} Commuter`, status: "realized", source: "travel_history · Edge events" });
  let cats = []; try { cats = JSON.parse(u.card_categories || "[]"); } catch {}
  const top = cats[0];
  if (u.affinity_label) a.push({ id: "affinity_" + u.affinity, name: `${u.affinity_label} Affinity – High`, status: "realized", source: top ? `Card spend: ${top.share}% ${top.name}` : "Card-spend traits" });
  a.push({ id: "lapsing_low", name: "Lapsing Risk – Low", status: "realized", source: "Recency/frequency model" });
  if ((u.miles || 0) > 30000) a.push({ id: "miles_rich", name: "Miles-Rich (> 30k)", status: "realized", source: "Loyalty balance" });
  a.push({ id: "consented_mktg", name: "Marketing-Consented", status: "realized", source: "Consent & governance" });
  return a;
}

function consent() {
  return { collect: { val: "y" }, marketing: { any: { val: "y" } }, personalize: { content: { val: "y" } }, share: { val: "y" }, governanceLabels: ["C1", "C2"] };
}

// Build an XDM Individual Profile envelope from the persona (the record shape
// RT-CDP stores and returns from the Profile API).
function toXDM(u, prefs) {
  let cats = []; try { cats = JSON.parse(u.card_categories || "[]"); } catch {}
  const idm = identityMap(u);
  return {
    _id: "urn:tap:profile:" + (u.member_no || ""),
    identityMap: {
      Email: [{ id: u.email, primary: idm.primary === "email" }],
      ECID: [{ id: idm.ECID, primary: idm.primary === "ECID" }],
      loyaltyId: [{ id: u.member_no }],
      CRMID: [{ id: idm.CRMID }],
    },
    person: { name: { firstName: u.first_name, lastName: lastName(u) }, birthDate: u.dob, gender: (u.gender || "").toLowerCase(), nationality: u.nationality },
    personalEmail: { address: u.email },
    mobilePhone: { number: u.phone },
    loyalty: { program: "Xperion Miles", id: u.member_no, tier: u.tier, points: u.miles, homeAirport: u.home_airport },
    _tapairportugal: {
      preferences: prefs ? { seat: prefs.seat, bag: prefs.bag, meal: prefs.meal, autoCheckin: !!prefs.auto_checkin } : undefined,
      cardSpendTraits: cats,
      affinity: u.affinity, affinityLabel: u.affinity_label,
      document: { type: "passport", number: u.doc_id, expiry: u.passport_exp },
    },
    consents: consent(),
    segmentMembership: { ups: Object.fromEntries(audiences(u).map(s => [s.id, { status: s.status, lastQualificationTime: new Date().toISOString() }])) },
  };
}

/* ── LIVE Adobe API path (best-effort; guarded so SIMULATED always works) ── */
async function imsToken(c) {
  if (typeof fetch !== "function") throw new Error("fetch unavailable (need Node ≥ 18)");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret, scope: c.scopes.replace(/,/g, " ") });
  const r = await fetch(c.imsTokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("IMS token HTTP " + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error("IMS token: no access_token");
  return j.access_token;
}
function lookupIdentity(persona, c) {
  if (c.lookupValueOverride) return c.lookupValueOverride;
  return c.lookupAttr === "loyalty" ? (persona.user.member_no || persona.user.email) : (persona.user.email || persona.user.member_no);
}
async function fetchLiveXDM(persona, c) {
  const token = await imsToken(c);
  const id = lookupIdentity(persona, c);
  const url = `${c.profileApi}/access/entities?schema.name=${encodeURIComponent(c.profileView)}&entityId=${encodeURIComponent(id)}&entityIdNS=${encodeURIComponent(c.identityNamespace)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-api-key": c.clientId, "x-gw-ims-org-id": c.imsOrg, "x-sandbox-name": c.sandbox, Accept: "application/json" } });
  if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`Profile API HTTP ${r.status}${body ? " — " + body.slice(0, 200) : ""}`); }
  const j = await r.json();
  const ent = (j && j.entities && Object.values(j.entities)[0]) || j;
  return (ent && ent.entity) ? ent.entity : ent;
}

// Audience id→name resolution for the read-back. The env map is the static source; the
// segment agent registers ids it created/learned at runtime so labels resolve with no manual
// upkeep. Runtime entries are merged over the env map.
let _runtimeAudienceNames = {};
function registerAudienceNames(m) { if (m && typeof m === "object") Object.assign(_runtimeAudienceNames, m); }
function audienceNames() {
  let env = {}; try { env = JSON.parse(process.env.ADOBE_AUDIENCE_NAMES || "{}"); } catch {}
  return { ...env, ..._runtimeAudienceNames };
}

// Extract the profile's REAL Adobe audience membership from a fetched Profile API entity.
// Adobe returns segmentMembership.ups = { <audienceId>: { status, lastQualificationTime } }.
// We surface only ACTIVE memberships (realized/existing) and resolve audienceId → name via
// audienceNames() (env map + agent-learned). Nothing is invented here: every entry came from
// Adobe. Unknown ids are shown by id (membership is never hidden). [] when no membership.
function adobeAudiencesFromEntity(entity) {
  const ups = entity && entity.segmentMembership && entity.segmentMembership.ups;
  if (!ups || typeof ups !== "object") return [];
  const names = audienceNames();
  return Object.entries(ups)
    .filter(([, m]) => m && /^(realized|existing)$/i.test(String(m.status || "")))
    .map(([id, m]) => ({ id, name: names[id] || id, status: String(m.status || "").toLowerCase(),
      lastQualified: m.lastQualificationTime || null, source: "adobe" }));
}

/* ── main entry: unified profile for a persona, sourced from CDP ── */
async function getProfileFromCdp(personaId) {
  const P = PERSONAS[personaId] || PERSONAS[DEFAULT_PERSONA];
  const c = rawConfig();
  let mode = "simulated", liveError = null, liveXdm = null;
  if (c.configured) {
    try { liveXdm = await fetchLiveXDM(P, c); mode = "live"; }
    catch (e) { liveError = String((e && e.message) || e); mode = "simulated"; }
  }
  // The unified profile that hydrates the live record. In simulated mode the
  // persona IS the authoritative profile (identical personalization, sourced
  // "via CDP"). In live mode we still hydrate from the persona for transactional
  // consistency, but surface the real XDM returned by the Profile API as proof.
  const user = { ...P.user }, prefs = { ...P.prefs }, voucher = { ...P.voucher };
  const xdm = liveXdm || toXDM(user, prefs);
  // REAL Adobe audience membership, read from the live profile entity — [] when simulated or
  // when Adobe returns no membership. The local segment engine is kept separately (localAudiences)
  // so callers can fall back to it WITHOUT mislabelling local output as an Adobe RT-CDP audience.
  const realAudiences = (mode === "live" && liveXdm) ? adobeAudiencesFromEntity(liveXdm) : [];
  return {
    profile: { user, prefs, voucher },
    provenance: {
      source: "Adobe Real-Time CDP",
      mode, liveError,
      sandbox: c.sandbox, datasetId: c.datasetId, imsOrg: c.imsOrg || "(not set)", profileApi: c.profileApi,
      profileView: c.profileView, identityNamespace: c.identityNamespace, lookupAttr: c.lookupAttr,
      ingestedAt: new Date().toISOString(),
      identityMap: identityMap(user),
      unifiedFrom: ["CRM — loyalty & identity", "Web SDK (Edge) — on-site behaviour", "Card-spend feed — affinity traits", "WhatsApp Business — messaging events"],
      audiences: realAudiences,                         // genuine Adobe membership only
      localAudiences: audiences(user),                  // local-engine derived (clearly not Adobe)
      audienceSource: realAudiences.length ? "adobe" : (mode === "live" ? "adobe-empty" : "simulated"),
      consent: consent(),
      xdm,
    },
  };
}

module.exports = { cdpConfig, getProfileFromCdp, toXDM, audiences, identityMap, consent, imsToken, rawConfig, registerAudienceNames };
