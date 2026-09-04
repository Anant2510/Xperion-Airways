"use strict";
/* ── Adobe Real-Time CDP — profile INGESTION (write path) ──────────────────────
   Pushes the demo personas INTO the Xperion Traveller Profile dataset so that, when
   the app reads back by identity, CDP returns a profile as rich as the local
   SQLite one — keeping every personalization use case relevant in CDP mode.

   Identity strategy: the demo shares one email (DEMO_EMAIL_TO) across personas, so
   each persona is written under BOTH the Email namespace AND the unique loyalty-id
   namespace. Look the profile up by loyalty id (ADOBE_IDENTITY_NS=<loyalty symbol>,
   ADOBE_LOOKUP_ATTR=loyalty) so Daniel/Sofia/Lars resolve to distinct profiles.

   Uses the AEP Batch Ingestion API. Custom (tenant) field paths are best-effort —
   run GET /api/admin/cdp/schema to confirm them against your actual schema, then
   adjust personaToXDM below (or share the paths and we lock them exactly).        */

const cdp = require("./cdp");
const { PERSONAS, DEFAULT_PERSONA } = require("./db");

const NAT2CC = { Portuguese: "PT", German: "DE", Spanish: "ES", French: "FR", British: "GB", Italian: "IT", Dutch: "NL" };
function toISODate(d) { const t = Date.parse(d); return isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10); }
const lastName = (u) => (u.full_name || "").replace(u.first_name || "", "").trim();

// Persona → XDM Individual Profile record, mapped to the Xperion Traveller Profile schema
// (confirmed via GET /api/admin/cdp/schema). Custom traits live under _aeppsemea.*.
function personaToXDM(P, c) {
  const u = P.user;
  const pr = P.prefs || {};
  const vc = P.voucher || {};
  let cats = []; try { cats = JSON.parse(u.card_categories || "[]"); } catch {}
  const top = cats[0] || {};
  // Runtime segment membership from the SAME local engine the app uses (cdp.audiences). Written
  // onto the profile so RT-CDP can mirror local intelligence via passthrough audiences. Gated by
  // ADOBE_LOCAL_SEGMENTS_FIELD so nothing unknown is sent before the schema field is added.
  const segField = c.localSegmentsField || "";
  let localSegments = null;
  if (segField) { try { localSegments = (cdp.audiences(u) || []).map(a => a.name).filter(Boolean); } catch { localSegments = null; } }
  // Identity graph: when a loyalty namespace is configured, use loyaltyId as the SOLE
  // identity so personas stay distinct. (The demo shares one email via DEMO_EMAIL_TO, so
  // adding it as an identity would stitch all personas into one merged profile.) The email
  // is still written as a plain attribute (personalEmail.address) — attributes don't stitch.
  const identityMap = c.loyaltyNs
    ? { [c.loyaltyNs]: [{ id: u.member_no, primary: true }] }
    : { Email: [{ id: u.email, primary: true }] };
  return {
    identityMap,
    person: { name: { firstName: u.first_name, lastName: lastName(u), fullName: u.full_name } },
    personalEmail: { address: u.email },
    mobilePhone: { number: u.phone },
    homeAddress: { country: NAT2CC[u.nationality] || u.nationality },
    _aeppsemea: {
      loyalty: {
        memberId: u.member_no, tier: u.tier, tierLevel: u.tier,
        milesBalance: u.miles, homeAirport: u.home_airport,
      },
      traveller: {
        affinity: u.affinity, affinityLabel: u.affinity_label, archetype: u.affinity_label,
        nationality: u.nationality,
        seatPreference: pr.seat, baggagePreference: pr.bag, mealPreference: pr.meal,
        autoCheckin: !!pr.auto_checkin,
      },
      card: {
        // Card identity is masked in the demo UI, but these are the real trait fields used
        // for affinity/decisioning. Brand/last4/expiry kept here for completeness.
        brand: u.card_brand, last4: u.card_last4, expiry: u.card_exp, product: u.card_product,
        spendCategories: cats.map(x => ({ category: x.name, sharePct: x.share })),
        topSpendCategory: top.name, topSpendSharePct: top.share,
      },
      wallet: vc.code ? {
        voucherCode: vc.code, voucherAmount: vc.amount, voucherCurrency: "EUR",
        voucherReason: vc.reason, voucherExpiry: toISODate(vc.expiry),
      } : undefined,
      consents: { marketing: { collect: { val: "y" } }, personalize: { content: { val: "y" } } },
      ...(segField && localSegments ? { [segField]: localSegments } : {}),
    },
  };
}

function headers(c, token, extra) {
  return Object.assign({ Authorization: `Bearer ${token}`, "x-api-key": c.clientId, "x-gw-ims-org-id": c.imsOrg, "x-sandbox-name": c.sandbox }, extra || {});
}
async function txt(r) { try { return (await r.text()).slice(0, 300); } catch { return ""; } }

// Batch-ingest all personas into the profile dataset. dryRun → return the payload only.
async function ingest(personaIds, opts = {}) {
  const c = cdp.rawConfig();
  const ids = (personaIds && personaIds.length ? personaIds : Object.keys(PERSONAS));
  const records = ids.map(id => personaToXDM(PERSONAS[id] || PERSONAS[DEFAULT_PERSONA], c));
  if (opts.dryRun) return { dryRun: true, datasetId: c.profileDatasetId || "(ADOBE_PROFILE_DATASET_ID not set)", tenantNs: c.tenantNs, loyaltyNs: c.loyaltyNs || "(ADOBE_LOYALTY_NS not set — only Email identity will be written)", count: records.length, records };
  if (!c.configured) throw new Error("Adobe credentials not configured (set ADOBE_CDP_ENABLED + IMS org + client id/secret).");
  if (!c.profileDatasetId) throw new Error("ADOBE_PROFILE_DATASET_ID not set.");
  const token = await cdp.imsToken(c);
  const base = c.ingestApi;
  // 1) create batch
  let r = await fetch(`${base}/batches`, { method: "POST", headers: headers(c, token, { "Content-Type": "application/json" }), body: JSON.stringify({ datasetId: c.profileDatasetId, inputFormat: { format: "json" } }) });
  if (!r.ok) throw new Error(`create batch HTTP ${r.status} — ${await txt(r)}`);
  const bj = await r.json(); const batchId = bj.id || (bj && Object.keys(bj)[0]);
  if (!batchId) throw new Error("create batch: no batch id returned");
  // 2) upload records (JSON array)
  r = await fetch(`${base}/batches/${batchId}/datasets/${c.profileDatasetId}/files/profiles.json`, { method: "PUT", headers: headers(c, token, { "Content-Type": "application/octet-stream" }), body: JSON.stringify(records) });
  if (!r.ok) throw new Error(`upload HTTP ${r.status} — ${await txt(r)}`);
  // 3) signal completion
  r = await fetch(`${base}/batches/${batchId}?action=COMPLETE`, { method: "POST", headers: headers(c, token) });
  if (!r.ok) throw new Error(`complete HTTP ${r.status} — ${await txt(r)}`);
  return { ok: true, batchId, datasetId: c.profileDatasetId, count: records.length, note: "Batch submitted. AEP processes asynchronously — profiles appear in a few minutes." };
}

// Introspect the profile schema → flat list of field paths (to confirm the mapping).
function flatten(props, prefix, out) {
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && v.properties) flatten(v.properties, path, out);
    else if (v && v.items && v.items.properties) flatten(v.items.properties, path + "[]", out);
    else out.push(`${path}${v && v.type ? " : " + v.type : ""}`);
  }
  return out;
}
async function schemaPaths() {
  const c = cdp.rawConfig();
  if (!c.configured) throw new Error("Adobe credentials not configured.");
  if (!c.profileSchemaId) throw new Error("ADOBE_PROFILE_SCHEMA_ID not set.");
  const token = await cdp.imsToken(c);
  const url = `${c.schemaRegistryApi}/tenant/schemas/${encodeURIComponent(c.profileSchemaId)}`;
  const r = await fetch(url, { headers: headers(c, token, { Accept: "application/vnd.adobe.xed-full+json; version=1" }) });
  if (!r.ok) throw new Error(`schema HTTP ${r.status} — ${await txt(r)}`);
  const j = await r.json();
  return { title: j.title, tenantNs: c.tenantNs, paths: flatten(j.properties, "", []).sort() };
}

// List identity namespaces (to find the loyalty-id SYMBOL for ADOBE_LOYALTY_NS / ADOBE_IDENTITY_NS).
async function namespaces() {
  const c = cdp.rawConfig();
  if (!c.configured) throw new Error("Adobe credentials not configured.");
  const token = await cdp.imsToken(c);
  const r = await fetch(`${c.idNamespaceApi}/identities`, { headers: headers(c, token) });
  if (!r.ok) throw new Error(`namespaces HTTP ${r.status} — ${await txt(r)}`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j.children || j.namespaces || []);
  return { namespaces: list.map(n => ({ name: n.name, symbol: n.code || n.id, description: n.description })) };
}

module.exports = { ingest, schemaPaths, namespaces, personaToXDM };
