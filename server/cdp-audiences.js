/* ──────────────────────────────────────────────────────────────────────────
   FlyTAP — Adobe RT-CDP audience bridge (shared)
   ----------------------------------------------------------------------------
   One place that talks to Adobe for SEGMENT MEMBERSHIP, so cdp-profile.js, the
   /api/segments + /api/cdp/profile routes, and pss.js all read the same way
   without duplicating the persona→profile mapping (and without circular requires).

   • audiencesFor(identity) → string[]  — the profile's Adobe audiences (membership),
       or [] when the cdp module isn't wired (this slice) so callers fall back to
       the local segment engine.
   • publish(identity, segments)         — streams computed segment membership BACK
       to Adobe as an event (the real cdp-events interface). No-op if unavailable.
   ────────────────────────────────────────────────────────────────────────── */
"use strict";

const dbmod = require("./db");
const PERSONAS = dbmod.PERSONAS || {};
let cdp = {};
try { cdp = require("./cdp"); } catch { /* absent in this slice → local fallback */ }
let cdpEvents = {};
try { cdpEvents = require("./cdp-events"); } catch { /* absent in this slice */ }

// Map an identity (loyaltyId / email) → persona id so cdp.getProfileFromCdp can be called.
function personaIdFor(identity) {
  const mno = identity && identity.loyaltyId;
  const em = String((identity && identity.email) || "").toLowerCase();
  for (const p of Object.values(PERSONAS)) {
    const u = p.user || {};
    if ((mno && u.member_no === mno) || (em && String(u.email || "").toLowerCase() === em)) return p.id;
  }
  return null;
}

const cdpWired = () => typeof cdp.getProfileFromCdp === "function";

// Real Adobe audience membership for an identity. [] when CDP unavailable.
async function audiencesFor(identity) {
  try {
    const pid = personaIdFor(identity);
    if (pid && cdpWired()) {
      const r = await cdp.getProfileFromCdp(pid);
      const a = r && r.provenance && r.provenance.audiences;
      if (Array.isArray(a)) return a.map((x) => (typeof x === "string" ? x : (x && (x.name || x.id)) || "")).filter(Boolean);
    }
  } catch { /* CDP unavailable → caller falls back to local */ }
  return [];
}

// Local-engine audiences (NOT Adobe) — for honest fallback display when Adobe returns no
// membership, so a surface can still show what the profile qualifies for without claiming it
// came from RT-CDP. Returns [{ id, name, source }]; [] if unavailable.
async function localAudiencesFor(identity) {
  try {
    const pid = personaIdFor(identity);
    if (pid && cdpWired()) {
      const r = await cdp.getProfileFromCdp(pid);
      const a = r && r.provenance && r.provenance.localAudiences;
      if (Array.isArray(a)) return a;
    }
  } catch { /* unavailable */ }
  return [];
}

// Publish computed segment membership back to Adobe as a streamed event.
async function publish(identity, segments) {
  try {
    const list = (segments || []).filter(Boolean);
    if (!list.length) return false;
    if (typeof cdpEvents.streamEvent === "function") { await cdpEvents.streamEvent("segmentMembership", identity, { segments: list }); return true; }
    if (typeof cdpEvents.emit === "function") { cdpEvents.emit("segmentMembership", identity, { segments: list }); return true; }
  } catch { /* non-fatal */ }
  return false;
}

module.exports = { audiencesFor, localAudiencesFor, publish, cdpWired, personaIdFor };
