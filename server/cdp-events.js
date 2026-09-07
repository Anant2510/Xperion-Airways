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
  const q = queueState();
  const c0 = cdp.rawConfig();
  let provisionError = null; try { provisionError = require("./cdp-streaming").status().lastError; } catch {}
  return { ...eventsStateBase(), queue: q, mode: c0.streamingUrl ? "streaming" : (c0.configured ? "batch" : "off"), inletUrl: c0.streamingUrl || null, flowId: c0.eventFlowId || null, batchEveryMs: Number(process.env.CDP_EVENT_BATCH_MS) || 15 * 60 * 1000, provisionError };
}
function eventsStateBase() {
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

/* Every event the app builds is kept here. With a streaming inlet it goes out immediately; without
   one it is batched into the event dataset through the Batch Ingestion API (the same path that
   put the personas in), every CDP_EVENT_BATCH_MS or on demand. Either way it reaches the profile. */
const { db } = require("./db");
db.exec(`CREATE TABLE IF NOT EXISTS cdp_event_queue (id INTEGER PRIMARY KEY, stage TEXT, event_type TEXT, loyalty_id TEXT, xdm_json TEXT, status TEXT, batch_id TEXT, created_at TEXT, sent_at TEXT);`);
function enqueue(payload, stage, identity, status) {
  try { db.prepare("INSERT INTO cdp_event_queue (stage,event_type,loyalty_id,xdm_json,status,created_at) VALUES (?,?,?,?,?,?)").run(stage, payload.body.xdmEntity.eventType, identity.loyaltyId, JSON.stringify(payload.body.xdmEntity), status, new Date().toISOString()); } catch {}
}
function queueState() {
  try {
    const q = db.prepare("SELECT status, COUNT(*) n FROM cdp_event_queue GROUP BY status").all().reduce((a, r) => (a[r.status] = r.n, a), {});
    const last = db.prepare("SELECT batch_id, sent_at, COUNT(*) n FROM cdp_event_queue WHERE status='batched' GROUP BY batch_id ORDER BY sent_at DESC LIMIT 1").get();
    return { queued: q.queued || 0, batched: q.batched || 0, streamed: q.streamed || 0, failed: q.failed || 0, lastBatch: last || null };
  } catch { return { queued: 0, batched: 0, streamed: 0, failed: 0, lastBatch: null }; }
}
/* batch the queued events into the event dataset: create batch → upload events.json → complete */
async function flushBatch({ limit = 1000 } = {}) {
  const c = cdp.rawConfig();
  if (!c.configured) return { ok: false, error: "Adobe credentials not configured" };
  if (!c.eventDatasetId) return { ok: false, error: "ADOBE_EVENT_DATASET_ID not set" };
  const rows = db.prepare("SELECT id, xdm_json FROM cdp_event_queue WHERE status='queued' ORDER BY id LIMIT ?").all(limit);
  if (!rows.length) return { ok: true, count: 0, note: "nothing queued" };
  const records = rows.map((r) => JSON.parse(r.xdm_json));
  const token = await cdp.imsToken(c);
  const H = (extra) => ({ Authorization: `Bearer ${token}`, "x-api-key": c.clientId, "x-gw-ims-org-id": c.imsOrg, "x-sandbox-name": c.sandbox, ...extra });
  const base = c.ingestApi;
  const txt = async (r) => { try { return (await r.text()).slice(0, 300); } catch { return ""; } };
  let r = await fetch(`${base}/batches`, { method: "POST", headers: H({ "Content-Type": "application/json" }), body: JSON.stringify({ datasetId: c.eventDatasetId, inputFormat: { format: "json", isMultiLineJson: false } }) });
  if (!r.ok) throw new Error(`create batch HTTP ${r.status} ${await txt(r)}`);
  const bj = await r.json(); const batchId = bj.id || Object.keys(bj)[0];
  r = await fetch(`${base}/batches/${batchId}/datasets/${c.eventDatasetId}/files/events.json`, { method: "PUT", headers: H({ "Content-Type": "application/octet-stream" }), body: JSON.stringify(records) });
  if (!r.ok) throw new Error(`upload HTTP ${r.status} ${await txt(r)}`);
  r = await fetch(`${base}/batches/${batchId}?action=COMPLETE`, { method: "POST", headers: H() });
  if (!r.ok) throw new Error(`complete HTTP ${r.status} ${await txt(r)}`);
  const upd = db.prepare("UPDATE cdp_event_queue SET status='batched', batch_id=?, sent_at=? WHERE id=?");
  const now = new Date().toISOString(); for (const row of rows) upd.run(batchId, now, row.id);
  _state.sent += rows.length; _state.recent.unshift({ at: now, stage: "batch", eventType: `${rows.length} events → batch ${batchId}`, loyaltyId: "" }); _state.recent = _state.recent.slice(0, 20);
  return { ok: true, batchId, datasetId: c.eventDatasetId, count: rows.length, note: "Batch submitted. AEP processes asynchronously; events appear on profiles in a few minutes." };
}
let batchTimer = null;
function startBatcher({ intervalMs = Number(process.env.CDP_EVENT_BATCH_MS) || 15 * 60 * 1000, log = console.log } = {}) {
  const c = cdp.rawConfig();
  if (!c.configured || process.env.CDP_EVENT_BATCH === "0") return null;
  if (c.streamingUrl) { log(`   CDP events: streaming in real time to ${c.streamingUrl.replace(/^https?:\/\//, "").slice(0, 60)}…`); return null; }
  log(`   CDP events: no streaming inlet; queued events are batched into dataset ${c.eventDatasetId || "(ADOBE_EVENT_DATASET_ID not set)"} every ${Math.round(intervalMs / 60000)} min`);
  const tick = () => { if (cdp.rawConfig().streamingUrl) return; if (queueState().queued > 0) flushBatch().catch((e) => log("   CDP event batch failed: " + e.message)); };
  batchTimer = setInterval(tick, intervalMs); if (batchTimer.unref) batchTimer.unref();
  return batchTimer;
}

async function streamEvent(stage, identity, step = {}) {
  const c = cdp.rawConfig();
  if (!identity || !identity.loyaltyId) return { skipped: "no loyaltyId" };
  const payload = buildEnvelope(c, stage, identity, step);
  if (!c.streamingUrl) { if (c.configured) enqueue(payload, stage, identity, "queued"); return { queued: c.configured, skipped: c.configured ? undefined : "no ADOBE_STREAMING_URL" }; }
  const url = c.streamingUrl + (c.eventSyncValidation ? "?SyncValidation=true" : "");
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

module.exports = { streamEvent, emit, eventsState, flushBatch, queueState, startBatcher, STAGE_EVENTTYPE };
