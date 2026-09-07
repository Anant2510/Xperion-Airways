"use strict";
/* mcp.js — Xperion Airways as an MCP server (Model Context Protocol).

   Any MCP-capable AI tool — Claude Desktop, Claude.ai connectors, Cursor, VS Code / Copilot,
   Windsurf, an agent built on the Anthropic or OpenAI SDKs — can search, book, check in, read a
   customer's trips, get a destination brief with risk-aware alternatives, and act on a live
   disruption offer, through the SAME tool contract the in-app assistant uses. Nothing is
   duplicated: tools/list is the published registry, tools/call is agentRunTool().

   Endpoint   POST/GET/DELETE /mcp   (Streamable HTTP, stateless: one MCP server per request)
   Auth       Authorization: Bearer <token>  → the customer the token was minted for
   Tokens     POST /api/admin/mcp/token {persona}  (Demo Console / ops page mint them)
   Discovery  GET /mcp/info (public)                                                            */

const crypto = require("crypto");
const { db, now } = require("./db");

db.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (token TEXT PRIMARY KEY, user_id INTEGER, label TEXT, scopes TEXT, created_at TEXT, last_used_at TEXT, calls INTEGER DEFAULT 0);`);

let deps = null;   // injected by server.js: { AGENT_TOOLS, toolsFor, agentRunTool, getSession, resolveTenant, autonomy, PERSONA_UID }
function init(d) { deps = d; }

/* ── tokens ─────────────────────────────────────────────────────────────── */
function mint({ uid, label, scopes = "customer" }) {
  const token = "xp_" + crypto.randomBytes(18).toString("hex");
  db.prepare("INSERT INTO mcp_tokens (token,user_id,label,scopes,created_at) VALUES (?,?,?,?,?)").run(token, uid, label || null, scopes, now());
  return { token, uid, label, scopes };
}
function lookup(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM mcp_tokens WHERE token=?").get(token);
  if (row) db.prepare("UPDATE mcp_tokens SET last_used_at=?, calls=calls+1 WHERE token=?").run(now(), token);
  return row || null;
}
function list() { return db.prepare("SELECT token, user_id, label, scopes, created_at, last_used_at, calls FROM mcp_tokens ORDER BY created_at DESC").all().map((r) => ({ ...r, token: r.token.slice(0, 8) + "…" + r.token.slice(-4) })); }
function revoke(token) { return db.prepare("DELETE FROM mcp_tokens WHERE token=?").run(token).changes > 0; }
function bearer(req) { const h = String(req.headers.authorization || ""); const m = h.match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : (req.query && req.query.token) || null; }

/* ── the tool surface ───────────────────────────────────────────────────── */
/* MCP-only tools layered on the bridge / autonomy layer for the customer the token belongs to */
const EXTRA_TOOLS = [
  { name: "get_my_profile", description: "The signed-in customer's profile: name, tier, miles, home airport, preferences, vouchers and upcoming trips. Call this first when the customer asks about 'my' anything.", input_schema: { type: "object", properties: {} } },
  { name: "get_disruption_status", description: "Whether the autonomy layer is watching or has acted on the customer's trips: active weather predictions, an open proactive offer with its options, or a completed recovery. Use for 'is my flight affected', 'any disruption', 'what did you do about the storm'.", input_schema: { type: "object", properties: {} } },
  { name: "accept_disruption_option", description: "Accept one option from the customer's open disruption offer (from get_disruption_status). Runs the execution saga: rebooking, hotel, taxi, reissue. Only when the customer has clearly chosen.", input_schema: { type: "object", properties: { optionId: { type: "string", description: "The option id from get_disruption_status, or its 1-based number." } }, required: ["optionId"] } },
  { name: "get_trip_risk", description: "Risk-aware alternatives for one of the customer's bookings: the day-by-day risk window at the destination (weather, strikes, political or civil events, advisories) and concrete options to lower the chance of getting stuck — safer dates with flights and prices, a nearby alternate airport, or keep-with-flex.", input_schema: { type: "object", properties: { pnr: { type: "string", description: "Booking reference, e.g. XPX43K. Omit for the next upcoming trip." } } } },
  { name: "take_trip_alternative", description: "Apply one alternative from get_trip_risk (by its id): moves the booking to the safer date or airport, reversibly, or adds Flex. Only when the customer has chosen.", input_schema: { type: "object", properties: { alternativeId: { type: "string" } }, required: ["alternativeId"] } },
];
function toolList(tenantCfg) {
  const base = deps.toolsFor(tenantCfg).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema || { type: "object", properties: {} } }));
  return [...base, ...EXTRA_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))];
}
async function runTool(name, input, ctx) {
  const { uid, session } = ctx;
  const A = deps.autonomy;
  if (name === "get_my_profile") {
    const u = db.prepare("SELECT id, first_name, full_name, email, phone, tier, miles, home_airport, nationality, member_no FROM users WHERE id=?").get(uid);
    const trips = db.prepare("SELECT pnr, flight_no, flight_date, seat, status, meta_json FROM bookings WHERE user_id=? AND status IN ('confirmed','rebooked') AND flight_date >= date('now') ORDER BY flight_date").all(uid).map((b) => { let m = {}; try { m = JSON.parse(b.meta_json || "{}"); } catch {} return { pnr: b.pnr, flight_no: b.flight_no, date: b.flight_date, origin: m.origin, dest: m.dest, seat: b.seat, status: b.status, recovery: m.recovery ? m.recovery.label : null }; });
    const vouchers = db.prepare("SELECT code, amount, expiry FROM vouchers WHERE user_id=? AND status='available'").all(uid);
    return { ok: true, customer: u, upcoming_trips: trips, vouchers };
  }
  if (name === "get_disruption_status") return { ok: true, ...A.bridge.status(uid) };
  if (name === "accept_disruption_option") return A.bridge.acceptForUser(uid, input.optionId);
  if (name === "get_trip_risk") {
    const b = input.pnr ? db.prepare("SELECT * FROM bookings WHERE pnr=? AND user_id=?").get(String(input.pnr).toUpperCase(), uid) : db.prepare("SELECT * FROM bookings WHERE user_id=? AND status IN ('confirmed','rebooked') AND flight_date >= date('now') ORDER BY flight_date LIMIT 1").get(uid);
    if (!b) return { ok: false, message: input.pnr ? "No such booking for this customer." : "No upcoming trip." };
    const a = await A.alternatives.assess(b);
    return a ? { ok: true, ...a } : { ok: false, message: "Could not assess this booking (no route on file)." };
  }
  if (name === "take_trip_alternative") return A.alternatives.take(uid, input.alternativeId);
  return deps.agentRunTool(name, input, session);
}

/* ── resources & prompts ────────────────────────────────────────────────── */
const RESOURCES = [
  { uri: "xperion://me/profile", name: "My profile", description: "The signed-in customer's profile and upcoming trips", mimeType: "application/json" },
  { uri: "xperion://me/bookings", name: "My bookings", description: "All bookings for the signed-in customer", mimeType: "application/json" },
  { uri: "xperion://network", name: "Route network", description: "Airports, countries and hubs Xperion serves", mimeType: "application/json" },
];
async function readResource(uri, ctx) {
  if (uri === "xperion://me/profile") return runTool("get_my_profile", {}, ctx);
  if (uri === "xperion://me/bookings") return { bookings: db.prepare("SELECT pnr, flight_no, flight_date, seat, status FROM bookings WHERE user_id=? ORDER BY flight_date DESC").all(ctx.uid) };
  if (uri === "xperion://network") { const { AIRPORTS } = require("./routes-data"); const codes = Object.keys(AIRPORTS); return { airports: codes.length, countries: new Set(codes.map((c) => AIRPORTS[c].country)).size, hubs: ["MIA", "JFK"], country: "US", currency: "USD" }; }
  throw new Error("unknown resource");
}
const PROMPTS = [
  { name: "plan_trip", description: "Plan a trip end to end for the signed-in customer: search, pick, extras, checkout.", arguments: [{ name: "destination", description: "City, airport or country", required: true }, { name: "when", description: "Date or phrase like 'first week of October'", required: false }] },
  { name: "trip_risk_check", description: "Check the customer's next trip for disruption risk and present the options that lower it.", arguments: [{ name: "pnr", description: "Booking reference (optional)", required: false }] },
];
function promptText(name, args) {
  if (name === "plan_trip") return `Plan a trip to ${args.destination}${args.when ? ` around ${args.when}` : ""} for me. Start with get_my_profile, then search_flights (use days=7 if I gave a week), show me the options with dates and prices, and only proceed to extras and checkout after I choose.`;
  if (name === "trip_risk_check") return `Check my ${args.pnr ? `booking ${args.pnr}` : "next trip"} for disruption risk with get_trip_risk. Tell me the risk level and why, list the alternatives with their risk and price delta, and wait for my choice before take_trip_alternative.`;
  return "";
}

/* ── one MCP server per request (stateless Streamable HTTP) ─────────────── */
async function buildServer(ctx) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const T = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "xperion-airways", version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  server.setRequestHandler(T.ListToolsRequestSchema, async () => ({ tools: toolList(ctx.tenant.config) }));
  server.setRequestHandler(T.CallToolRequestSchema, async (req) => {
    const name = req.params.name; const input = req.params.arguments || {};
    const known = toolList(ctx.tenant.config).some((t) => t.name === name);
    if (!known) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown tool" }) }], isError: true };
    let result; try { result = await runTool(name, input, ctx); } catch (e) { result = { ok: false, error: String(e.message || e) }; }
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result && result.ok === false && !!result.error };
  });
  server.setRequestHandler(T.ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
  server.setRequestHandler(T.ReadResourceRequestSchema, async (req) => ({ contents: [{ uri: req.params.uri, mimeType: "application/json", text: JSON.stringify(await readResource(req.params.uri, ctx)) }] }));
  server.setRequestHandler(T.ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(T.GetPromptRequestSchema, async (req) => ({ messages: [{ role: "user", content: { type: "text", text: promptText(req.params.name, req.params.arguments || {}) } }] }));
  return server;
}

async function handle(req, res) {
  const token = bearer(req);
  const row = lookup(token);
  if (!row) { res.set("WWW-Authenticate", 'Bearer realm="xperion-airways"'); return res.status(401).json({ error: "unauthorized", hint: "Authorization: Bearer <token> — mint one with POST /api/admin/mcp/token {persona}" }); }
  const tenant = deps.resolveTenant(req.get("x-airline-tenant"));
  const session = deps.getSession(`${tenant.id}::mcp:${token.slice(-8)}`); session.uid = row.user_id; session.tenant = tenant.id;
  const ctx = { uid: row.user_id, session, tenant, token: row };
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = await buildServer(ctx);
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function info(req) {
  const base = `${req.protocol}://${req.get("host")}`;
  return { name: "xperion-airways", protocol: "MCP · Streamable HTTP", endpoint: `${base}/mcp`, auth: "Authorization: Bearer <token>", tools: toolList(deps.resolveTenant(null).config).length, resources: RESOURCES.length, prompts: PROMPTS.length,
    connect: { claude_desktop_stdio: { command: "node", args: ["mcp/xperion-mcp.js"], env: { XPERION_URL: base, XPERION_TOKEN: "<token>" } }, cursor_or_vscode_remote: { url: `${base}/mcp`, headers: { Authorization: "Bearer <token>" } }, note: "Claude.ai custom connectors need an https URL: put a TLS proxy or tunnel in front of the server." } };
}

module.exports = { init, handle, info, mint, lookup, list, revoke, toolList, EXTRA_TOOLS };
