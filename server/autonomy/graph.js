/* autonomy/graph.js — property graph on the embedded store.
   The graph is the single source of truth for the autonomy layer: every entity
   from the ontology is a node row, every relationship an edge row, and agents
   communicate ONLY by reading and writing here (plus the event bus in bus.js,
   which itself only announces graph changes).
   ADR-001 (see ONTOLOGY.md) records why a property graph on SQLite rather than
   a dedicated graph DB or RDF store for the reference build. */
"use strict";
const { db } = require("../db");
const crypto = require("node:crypto");

db.exec(`
CREATE TABLE IF NOT EXISTS kg_nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, props_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_kind ON kg_nodes(kind);
CREATE TABLE IF NOT EXISTS kg_edges (
  src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, props_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, PRIMARY KEY (src, rel, dst));
CREATE INDEX IF NOT EXISTS idx_kg_edges_rel ON kg_edges(rel);
CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(dst);
`);

const nowIso = () => new Date().toISOString();
const j = (o) => JSON.stringify(o ?? {});
const p = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

function upsertNode(id, kind, props = {}) {
  const ex = db.prepare("SELECT props_json FROM kg_nodes WHERE id=?").get(id);
  if (ex) {
    const merged = { ...p(ex.props_json), ...props };
    db.prepare("UPDATE kg_nodes SET kind=?, props_json=?, updated_at=? WHERE id=?").run(kind, j(merged), nowIso(), id);
    return { id, kind, ...merged };
  }
  db.prepare("INSERT INTO kg_nodes (id, kind, props_json, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(id, kind, j(props), nowIso(), nowIso());
  return { id, kind, ...props };
}
function getNode(id) {
  const r = db.prepare("SELECT * FROM kg_nodes WHERE id=?").get(id);
  return r ? { id: r.id, kind: r.kind, ...p(r.props_json) } : null;
}
function setProps(id, props) {
  const n = getNode(id); if (!n) return null;
  return upsertNode(id, n.kind, { ...props });
}
function nodesByKind(kind) {
  return db.prepare("SELECT * FROM kg_nodes WHERE kind=?").all(kind).map(r => ({ id: r.id, kind: r.kind, ...p(r.props_json) }));
}
function upsertEdge(src, rel, dst, props = {}) {
  const ex = db.prepare("SELECT props_json FROM kg_edges WHERE src=? AND rel=? AND dst=?").get(src, rel, dst);
  if (ex) {
    db.prepare("UPDATE kg_edges SET props_json=? WHERE src=? AND rel=? AND dst=?").run(j({ ...p(ex.props_json), ...props }), src, rel, dst);
  } else {
    db.prepare("INSERT INTO kg_edges (src, rel, dst, props_json, created_at) VALUES (?,?,?,?,?)").run(src, rel, dst, j(props), nowIso());
  }
  return { src, rel, dst, ...props };
}
function edges({ src, rel, dst } = {}) {
  let q = "SELECT * FROM kg_edges WHERE 1=1"; const a = [];
  if (src) { q += " AND src=?"; a.push(src); }
  if (rel) { q += " AND rel=?"; a.push(rel); }
  if (dst) { q += " AND dst=?"; a.push(dst); }
  return db.prepare(q).all(...a).map(r => ({ src: r.src, rel: r.rel, dst: r.dst, ...p(r.props_json) }));
}
function out(src, rel) { return edges({ src, rel }).map(e => ({ node: getNode(e.dst), edge: e })); }
function into(dst, rel) { return edges({ dst, rel }).map(e => ({ node: getNode(e.src), edge: e })); }
function deleteEdge(src, rel, dst) { db.prepare("DELETE FROM kg_edges WHERE src=? AND rel=? AND dst=?").run(src, rel, dst); }

/* traverse: follow a chain of {rel, dir:'out'|'in', kind?} steps from a start id */
function traverse(startId, steps) {
  let frontier = [startId];
  for (const s of steps) {
    const next = new Set();
    for (const id of frontier) {
      const hop = s.dir === "in" ? into(id, s.rel) : out(id, s.rel);
      for (const { node } of hop) if (node && (!s.kind || node.kind === s.kind)) next.add(node.id);
    }
    frontier = [...next];
  }
  return frontier.map(getNode).filter(Boolean);
}

/* snapshot + diff, for AuditEvent.graph_diff */
function snapshot(ids) {
  const s = {};
  for (const id of ids) { const n = getNode(id); if (n) s[id] = n; }
  return s;
}
function diff(before, after) {
  const d = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = j(before[k]), a = j(after[k]);
    if (b !== a) d[k] = { before: before[k] ?? null, after: after[k] ?? null };
  }
  return d;
}
const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

function stats() {
  return {
    nodes: db.prepare("SELECT kind, COUNT(*) n FROM kg_nodes GROUP BY kind ORDER BY n DESC").all(),
    edges: db.prepare("SELECT rel, COUNT(*) n FROM kg_edges GROUP BY rel ORDER BY n DESC").all(),
  };
}
function wipe() { db.exec("DELETE FROM kg_nodes; DELETE FROM kg_edges;"); }

module.exports = { upsertNode, getNode, setProps, nodesByKind, upsertEdge, edges, out, into, deleteEdge, traverse, snapshot, diff, hash, stats, wipe, nowIso };
