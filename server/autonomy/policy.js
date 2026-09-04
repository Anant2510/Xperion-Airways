/* autonomy/policy.js — the policy-check service.
   Every agent action goes through execute(). Nothing else in the codebase may
   perform an Action: preconditions are validated against the LIVE graph at
   execution time (not planning time), tiers are enforced from the Action node,
   the kill switch is honoured, Tier-2 work is queued for a human instead of
   performed, and Tier-3 is refused outright. Every outcome is an AuditEvent. */
"use strict";
const G = require("./graph");
const O = require("./ontology");
const clock = require("./clock");

function killState() { return G.getNode("policy:kill_switch") || { global: false, events: {} }; }
function setKill({ global: g, eventId, on }) {
  const k = killState();
  if (typeof g === "boolean") k.global = g;
  if (eventId) k.events = { ...(k.events || {}), [eventId]: !!on };
  G.upsertNode("policy:kill_switch", "Policy", k);
  O.audit({ actor: "human", action: "KILL_SWITCH", rationale: JSON.stringify({ global: k.global, eventId, on }) });
  return k;
}
function frozen(predictionId) {
  const k = killState();
  return !!(k.global || (predictionId && k.events && k.events[predictionId]));
}

/* execute(name, payload, ctx)
   payload: predicate inputs (predictionId, passengerId, channel, amount, offerId, optionId, atHour…)
            plus perform(): () => result   and touched: [nodeIds] for the audit diff.
   ctx: { actor, rationale, predictionId } */
function execute(name, payload = {}, ctx = {}) {
  const a = G.getNode(`action:${name}`);
  const predictionId = ctx.predictionId || payload.predictionId || null;
  const base = { actor: ctx.actor || "agent", action: name, tier: a?.tier ?? null, inputs: payload, predictionId };

  if (!a) { O.audit({ ...base, rationale: "REFUSED: unknown action" }); return { ok: false, refused: "unknown_action" }; }
  if (a.tier === 3) { O.audit({ ...base, rationale: "REFUSED: Tier 3 is forbidden by policy" }); return { ok: false, refused: "tier3_forbidden" }; }
  if (a.tier <= 1 && frozen(predictionId)) {
    O.audit({ ...base, rationale: "REFUSED: kill switch active — Tier 0/1 frozen" });
    return { ok: false, refused: "kill_switch" };
  }

  const failed = [];
  for (const p of a.preconditions || []) {
    const fn = O.PRED[p];
    const inputs = p === "within_cap" ? { amount: payload.amount ?? 0, capRef: a.capRef } : payload;
    if (!fn || !fn(inputs)) failed.push(p);
  }
  if (failed.length) {
    O.audit({ ...base, rationale: `REFUSED: preconditions failed [${failed.join(", ")}]` });
    return { ok: false, refused: "preconditions", failed };
  }

  if (a.tier === 2) {
    const qid = `tier2:${name}:${G.hash({ payload, t: clock.nowIso() })}`;
    G.upsertNode(qid, "Tier2Item", {
      action: name, payload: { ...payload, perform: undefined, touched: undefined },
      predictionId, status: "PENDING", prepared_at: clock.nowIso(), rationale: ctx.rationale || "",
    });
    O.audit({ ...base, rationale: `QUEUED for human approval: ${ctx.rationale || name}` });
    return { ok: true, queued: qid };
  }

  const before = G.snapshot(payload.touched || []);
  let result = null;
  try { result = payload.perform ? payload.perform() : null; }
  catch (e) {
    O.audit({ ...base, rationale: `FAILED during perform: ${e.message}` });
    return { ok: false, error: e.message };
  }
  const after = G.snapshot(payload.touched || []);
  O.audit({ ...base, rationale: ctx.rationale || name, graphDiff: G.diff(before, after) });
  return { ok: true, result };
}

/* Tier-2 queue: humans approve; approval performs the packaged action outside the frozen tiers */
function tier2List() { return G.nodesByKind("Tier2Item").filter(i => i.status === "PENDING"); }
function tier2Approve(id, performMap = {}) {
  const item = G.getNode(id);
  if (!item || item.status !== "PENDING") return { ok: false, error: "not pending" };
  const perform = performMap[item.action];
  const result = perform ? perform(item.payload) : { note: "approved (no side effect wired in demo)" };
  G.setProps(id, { status: "APPROVED", approved_at: clock.nowIso() });
  O.audit({ actor: "human", action: `APPROVE:${item.action}`, tier: 2, inputs: item.payload, rationale: "ops controller approved", predictionId: item.predictionId });
  return { ok: true, result };
}

module.exports = { execute, setKill, killState, frozen, tier2List, tier2Approve };
