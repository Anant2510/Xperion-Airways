#!/usr/bin/env node
/**
 * adobe-seed-personas.js
 * Ingests the 3 demo personas into Adobe RT-CDP via the HTTP Streaming inlet (DCS),
 * each with a UNIQUE loyaltyId + UNIQUE email so the identity graph keeps them as
 * three separate profiles (no shared-email collapse).
 *
 * Run on Node 18+ (you have v24, so global fetch is available):
 *     node scripts/adobe-seed-personas.js
 *
 * If your inlet is authenticated, export a token first:
 *     export AEP_TOKEN="<access token from your 0-Authentication request>"
 *
 * ── WHAT YOU CAN TRUST vs WHAT TO VERIFY ───────────────────────────────────────
 *  • HEADER (inlet URL, schemaRef, imsOrgId, datasetId, source) = copied verbatim
 *    from your working "Send messages to AEP" Postman request. Should be correct.
 *  • identityMap = standard XDM; loyaltyId(custom) + Email(standard). Controls stitching.
 *  • The ATTRS() block below writes persona attributes under your tenant namespace
 *    "_aeppsemea". The FIELD NAMES there are a best guess — open your schema (or copy a
 *    known-good payload via the Demo Console "tap to copy CDP payload") and rename the
 *    keys to match. Unknown/extra fields are usually rejected by schema validation.
 * ───────────────────────────────────────────────────────────────────────────────
 */

const INLET = "https://dcs.adobedc.net/collection/f6da11bd8dbf7fa0937ac8ba60c95e3acd146a1f5e171eeb1396b1df225d429a";
const SCHEMA_REF = "https://ns.adobe.com/aeppsemea/schemas/6e5848ecb6cc222d43d36521e90b01f3d45b698f8447e51a";
const CONTENT_TYPE = "application/vnd.adobe.xed-full+json;version=1.11";
const IMS_ORG = "65B229AE5ED637A00A495E96@AdobeOrg";
const DATASET_ID = "685e717d22894b2aef2e784e";
const SOURCE_NAME = "Exp Demo 1";
const TENANT = "_aeppsemea";                 // your tenant namespace key in xdmEntity
const TOKEN = process.env.AEP_TOKEN || "";   // optional; only if your inlet is authenticated

// New, unique identities (must match server/db.js after the edits).
const PERSONAS = [
  { loyaltyId: "PT-990001", email: "anant.direct2links+daniel@gmail.com",
    firstName: "Daniel", lastName: "Ferreira", tier: "Gold",     miles: 48230,
    homeAirport: "OPO", affinity: "football", phone: "+351 91 442 7781", nationality: "Portuguese" },
  { loyaltyId: "PT-990002", email: "anant.direct2links+sofia@gmail.com",
    firstName: "Sofia",  lastName: "Marques",  tier: "Silver",   miles: 21450,
    homeAirport: "LIS", affinity: "golf",     phone: "+351 96 220 1184", nationality: "Portuguese" },
  { loyaltyId: "DE-990003", email: "anant.direct2links+lars@gmail.com",
    firstName: "Lars",   lastName: "Andersen", tier: "Platinum", miles: 184920,
    homeAirport: "FRA", affinity: "music",    phone: "+49 151 2244 7788", nationality: "German" },
];

// >>> Align these key names to YOUR schema's tenant fields <<<
const ATTRS = (p) => ({
  loyaltyId:   p.loyaltyId,
  email:       p.email,
  firstName:   p.firstName,
  lastName:    p.lastName,
  tier:        p.tier,
  miles:       p.miles,
  homeAirport: p.homeAirport,
  affinity:    p.affinity,
  phone:       p.phone,
  nationality: p.nationality,
});

function payload(p) {
  return {
    header: {
      schemaRef: { id: SCHEMA_REF, contentType: CONTENT_TYPE },
      imsOrgId: IMS_ORG,
      datasetId: DATASET_ID,
      createdAt: Date.now(),
      source: { name: SOURCE_NAME },
    },
    body: {
      xdmMeta: { schemaRef: { id: SCHEMA_REF, contentType: CONTENT_TYPE } },
      xdmEntity: {
        // identityMap controls stitching: loyaltyId is the PRIMARY (first-party) ID,
        // Email is secondary. Unique values per persona => three separate profiles.
        identityMap: {
          loyaltyId: [{ id: p.loyaltyId, primary: true }],
          Email:     [{ id: p.email,     primary: false }],
        },
        [TENANT]: ATTRS(p),
      },
    },
  };
}

async function send(p) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) {
    headers["Authorization"] = `Bearer ${TOKEN}`;
    headers["x-gw-ims-org-id"] = IMS_ORG;
  }
  const res = await fetch(INLET, { method: "POST", headers, body: JSON.stringify(payload(p)) });
  const text = await res.text();
  console.log(`${p.firstName.padEnd(7)} ${p.loyaltyId.padEnd(10)} -> ${res.status} ${res.statusText}  ${text.slice(0, 200)}`);
  return res.ok;
}

(async () => {
  console.log(`Ingesting ${PERSONAS.length} personas to dataset ${DATASET_ID} ...`);
  let ok = 0;
  for (const p of PERSONAS) { if (await send(p)) ok++; }
  console.log(`\nDone: ${ok}/${PERSONAS.length} accepted by the inlet.`);
  console.log("Profile store + identity graph can take a few minutes to reflect. Then search a");
  console.log("new email (e.g. anant.direct2links+daniel@gmail.com) in AEP > Profiles — expect ONE clean profile each.");
})();
