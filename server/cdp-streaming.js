"use strict";
/* cdp-streaming.js — server-side real-time ingestion into Adobe RT-CDP, provisioned by the server.

   TAP V2 streamed events server-side (no Web SDK). That needs an HTTP API streaming inlet in the
   sandbox, which is four Flow Service objects:

     1. base connection   HTTP API streaming source  (connectionSpec bc7b00d6-…)  → inletUrl
     2. source connection on that base connection
     3. target connection the event dataset in the Data Lake (connectionSpec c604ff05-…)
     4. dataflow          source → target, no transformation (flowSpec d8a6f005-…)  → flowId

   provision() creates them with the credentials already in .env, stores inletUrl + flowId in the
   database (so the config survives restarts and needs no env edit), and from that moment
   cdp-events.js streams every event in real time instead of batching. Every API response is
   returned verbatim on failure so a permissions or spec problem is visible, not guessed. */

const { db } = require("./db");
const cdp = require("./cdp");

const FLOW = "https://platform.adobe.io/data/foundation/flowservice";
const SPEC = {
  httpApiSource: "bc7b00d6-623a-4dfc-9fdb-f1240aeadaeb",   // HTTP API (streaming) source
  dataLakeTarget: "c604ff05-7f1a-43c0-8e18-33bf874cb11c",  // Data Lake target
  streamNoTransform: "d8a6f005-7eaf-4153-983e-e8574508b877", // streaming dataflow, XDM, no mapping
};
db.exec(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT);`);
const getSetting = (k) => { try { return db.prepare("SELECT v FROM settings WHERE k=?").get(k)?.v || null; } catch { return null; } };
const setSetting = (k, v) => db.prepare("INSERT OR REPLACE INTO settings (k,v,updated_at) VALUES (?,?,?)").run(k, v, new Date().toISOString());

/* runtime override read by cdp.rawConfig(): env wins if set, otherwise what provision() stored */
function stored() { return { streamingUrl: getSetting("adobe_streaming_url") || "", eventFlowId: getSetting("adobe_event_flow_id") || "", baseConnectionId: getSetting("adobe_stream_base_id") || "", provisionedAt: getSetting("adobe_stream_provisioned_at") || null }; }

async function call(c, token, method, path, body) {
  const r = await fetch(`${FLOW}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "x-api-key": c.clientId, "x-gw-ims-org-id": c.imsOrg, "x-sandbox-name": c.sandbox, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let j = null, text = ""; try { text = await r.text(); j = JSON.parse(text); } catch {}
  if (!r.ok) { const e = new Error(`${method} ${path} → HTTP ${r.status}: ${(j && (j.message || j.title || j.detail)) || text.slice(0, 300)}`); e.status = r.status; e.body = j || text; throw e; }
  return j;
}
const firstId = (j) => (j && (j.id || (Array.isArray(j.items) && j.items[0]?.id))) || null;

async function provision({ name = "Xperion Airways · server-side events" } = {}) {
  const c = cdp.rawConfig();
  if (!c.configured) return { ok: false, error: "Adobe credentials not configured" };
  if (!c.eventDatasetId || !c.eventSchemaId) return { ok: false, error: "ADOBE_EVENT_DATASET_ID and ADOBE_EVENT_SCHEMA_ID are required" };
  const steps = [];
  try {
    const token = await cdp.imsToken(c);
    /* 1 · base connection (the inlet) */
    const base = await call(c, token, "POST", "/connections", { name, description: "Server-side XDM ExperienceEvents from the Xperion Airways app (no Web SDK)", connectionSpec: { id: SPEC.httpApiSource, version: "1.0" }, auth: { specName: "Streaming Connection", params: { sourceId: `xperion-${Date.now().toString(36)}`, dataType: "xdm", name } } });
    const baseId = firstId(base); steps.push({ step: "base connection", id: baseId });
    const baseGet = await call(c, token, "GET", `/connections/${baseId}`);
    const item = (baseGet.items && baseGet.items[0]) || baseGet;
    const inletUrl = item.inletUrl || item.details?.inletUrl || item.auth?.params?.inletUrl || null;
    if (!inletUrl) throw Object.assign(new Error("base connection created but no inletUrl returned"), { body: baseGet });
    steps.push({ step: "inlet url", inletUrl });
    /* 2 · source connection */
    const src = await call(c, token, "POST", "/sourceConnections", { name: `${name} · source`, connectionId: baseId, baseConnectionId: baseId, connectionSpec: { id: SPEC.httpApiSource, version: "1.0" }, data: { format: "delimited" } });
    const srcId = firstId(src); steps.push({ step: "source connection", id: srcId });
    /* 3 · target connection on the event dataset */
    const tgt = await call(c, token, "POST", "/targetConnections", { name: `${name} · event dataset`, connectionSpec: { id: SPEC.dataLakeTarget, version: "1.0" }, data: { format: "parquet_xdm", schema: { id: c.eventSchemaId, version: "application/vnd.adobe.xed-full+json;version=1" } }, params: { dataSetId: c.eventDatasetId } });
    const tgtId = firstId(tgt); steps.push({ step: "target connection", id: tgtId });
    /* 4 · dataflow */
    const flow = await call(c, token, "POST", "/flows", { name: `${name} · dataflow`, flowSpec: { id: SPEC.streamNoTransform, version: "1.0" }, sourceConnectionIds: [srcId], targetConnectionIds: [tgtId], transformations: [] });
    const flowId = firstId(flow); steps.push({ step: "dataflow", id: flowId });
    setSetting("adobe_streaming_url", inletUrl); setSetting("adobe_event_flow_id", flowId); setSetting("adobe_stream_base_id", baseId); setSetting("adobe_stream_provisioned_at", new Date().toISOString());
    return { ok: true, inletUrl, flowId, baseConnectionId: baseId, sourceConnectionId: srcId, targetConnectionId: tgtId, steps, note: "Real-time streaming is live: events now go to the inlet as they happen. Allow a minute for the dataflow to become active in AEP." };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status || null, response: e.body || null, steps, hint: e.status === 403 ? "The credential lacks permission to manage Sources/Dataflows: add the 'Manage Sources' role to its product profile in Admin Console, or create the HTTP API source in the AEP UI and set ADOBE_STREAMING_URL + ADOBE_EVENT_FLOW_ID." : "Compare the response with the AEP Flow Service docs; the exact rejection is above." };
  }
}
function forget() { for (const k of ["adobe_streaming_url", "adobe_event_flow_id", "adobe_stream_base_id", "adobe_stream_provisioned_at"]) db.prepare("DELETE FROM settings WHERE k=?").run(k); return { ok: true }; }
function status() { const c = cdp.rawConfig(); const s = stored(); return { streaming: !!c.streamingUrl, inletUrl: c.streamingUrl || null, flowId: c.eventFlowId || null, source: process.env.ADOBE_STREAMING_URL ? "env" : (s.streamingUrl ? "provisioned" : "none"), provisionedAt: s.provisionedAt }; }

module.exports = { provision, forget, status, stored };
