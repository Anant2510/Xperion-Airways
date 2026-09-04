"use strict";
/* ── Adobe RT-CDP — real-time EVENT streaming (DCS inlet) ──────────────────────
   Streams demo behaviour (search, booking, check-in) into the Xperion Traveller Event
   dataset via the Data Collection (DCS) streaming inlet, so the unified profile
   keeps learning and segments re-qualify from activity.

   - Identity: loyaltyId is PRIMARY (per-persona distinct; Email kept non-primary).
   - Maps each demo action to a journeyStep stage with a distinct eventType.
   - Fire-and-forget: a slow/erroring CDP never blocks the user's transaction.
   - Envelope matches the working DCS payload: { header, body:{ xdmMeta, xdmEntity } }. */

const cdp = require("./cdp");

// demo action → journeyStep.stage : eventType (distinct per stage)
const STAGE_EVENTTYPE = {
  search:   "search",
  results:  "searchResults",
  resumed:  "searchResumed",
  selected: "flightSelected",
  booked:   "booking",
  checkin:  "checkIn",
  boarding: "boarding",
  cancelled:"cancellation",
};

const _state = { sent: 0, failed: 0, recent: [] };
function eventsState() {
  const c = cdp.rawConfig();
  return { configured: !!c.streamingUrl, syncValidation: c.eventSyncValidation, sent: _state.sent, failed: _state.failed, recent: _state.recent.slice(0, 12) };
}

const CT = "application/vnd.adobe.xed-full+json;version=1.11";
function clean(o) { const out = {}; for (const [k, v] of Object.entries(o || {})) { if (v !== null && v !== undefined) out[k] = v; } return out; }

function buildEnvelope(c, stage, identity, step) {
  const schemaRef = { id: c.eventSchemaId, contentType: CT };
  const identityMap = { loyaltyId: [{ id: identity.loyaltyId, primary: true }] };
  if (identity.email) identityMap.Email = [{ id: identity.email, primary: false }];
  return {
    header: {
      schemaRef, imsOrgId: c.imsOrg, datasetId: c.eventDatasetId,
      createdAt: String(Date.now()),
      flowId: c.eventFlowId || undefined,
      source: { name: "Xperion Traveller Event Dataset" },
    },
    body: {
      xdmMeta: { schemaRef },
      xdmEntity: {
        _id: (step && step._id) || `${stage}-${Date.now().toString(36)}`,
        eventType: STAGE_EVENTTYPE[stage] || stage,
        timestamp: new Date().toISOString(),
        identityMap,
        _aeppsemea: { journeyStep: clean(Object.assign({ stage }, step)) },
      },
    },
  };
}

async function streamEvent(stage, identity, step = {}) {
  const c = cdp.rawConfig();
  if (!c.streamingUrl) return { skipped: "no ADOBE_STREAMING_URL" };
  if (!identity || !identity.loyaltyId) return { skipped: "no loyaltyId" };
  const url = c.streamingUrl + (c.eventSyncValidation ? "?SyncValidation=true" : "");
  const payload = buildEnvelope(c, stage, identity, step);
  const entry = { at: new Date().toISOString(), stage, eventType: payload.body.xdmEntity.eventType, loyaltyId: identity.loyaltyId };
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const text = await r.text().catch(() => "");
    entry.ok = r.ok; entry.status = r.status;
    if (r.ok) {
      _state.sent++;
    } else {
      _state.failed++;
      // FULL error capture (was sliced to 200, which chopped off Adobe's report{}).
      // Keep the whole response body, the parsed validation report, and the exact
      // payload we sent — so /api/admin/cdp/events shows which field the schema rejected.
      entry.error = String(text).slice(0, 6000);
      try {
        const j = JSON.parse(text);
        if (j && j.title)  entry.title  = j.title;
        if (j && j.detail) entry.detail = j.detail;
        if (j && j.report) entry.report = j.report;   // <-- names the offending field(s)
      } catch { /* non-JSON error body kept as entry.error */ }
      entry.payload = payload;                          // <-- the rejected XDM, for comparison
    }
    _state.recent.unshift(entry); _state.recent = _state.recent.slice(0, 20);
    return { ok: r.ok, status: r.status, body: String(text).slice(0, 1000) };
  } catch (e) {
    entry.ok = false; entry.error = String((e && e.message) || e);
    _state.failed++; _state.recent.unshift(entry); _state.recent = _state.recent.slice(0, 20);
    return { ok: false, error: entry.error };
  }
}

// fire-and-forget: never let event streaming throw into the request path
function emit(stage, identity, step) { streamEvent(stage, identity, step).catch(() => {}); }

module.exports = { streamEvent, emit, eventsState, STAGE_EVENTTYPE };
