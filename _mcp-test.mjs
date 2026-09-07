// MCP acceptance — connects to the running server as an MCP client (the way Claude Desktop, Cursor
// or an agent would), mints a token, and exercises tools, resources and prompts.
// Usage: BASE=http://127.0.0.1:7810 node _mcp-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const BASE = process.env.BASE || "http://127.0.0.1:7810";
const results = []; const ok = (n, p, d = "") => { results.push(!!p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const parse = (r) => JSON.parse(r.content[0].text);

const info = await fetch(BASE + "/mcp/info").then((r) => r.json());
ok("discovery endpoint describes the server", info.name === "xperion-airways" && info.tools >= 30 && /\/mcp$/.test(info.endpoint), `${info.tools} tools · ${info.resources} resources · ${info.prompts} prompts`);
const noAuth = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok("no token → 401 with a hint", noAuth.status === 401);

const minted = await post("/api/admin/mcp/token", { persona: "daniel", client: "test" });
ok("token minted for a persona", minted.ok && /^xp_/.test(minted.token) && minted.uid === 1, minted.label);
const connect = async (token) => { const c = new Client({ name: "test-client", version: "1.0" }); await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c; };
const c = await connect(minted.token);

const tools = await c.listTools();
ok("tools/list returns the published contract plus the autonomy tools", tools.tools.length >= 30 && ["search_flights", "select_flight", "checkout", "get_destination_brief", "get_my_profile", "get_disruption_status", "get_trip_risk"].every((n) => tools.tools.some((t) => t.name === n)), `${tools.tools.length} tools`);
ok("every tool carries a JSON input schema", tools.tools.every((t) => t.inputSchema && t.inputSchema.type === "object"));

const me = parse(await c.callTool({ name: "get_my_profile", arguments: {} }));
ok("get_my_profile is the token's customer", me.ok && me.customer.first_name === "Daniel" && Array.isArray(me.upcoming_trips), `${me.customer.tier} · ${me.upcoming_trips.length} trips`);
const search = parse(await c.callTool({ name: "search_flights", arguments: { origin: "MIA", dest: "JFK", days: 7, sort: "price" } }));
ok("search_flights works through MCP with the window + sort extensions", search.ok && search.window && search.flights.length > 0 && search.flights[0].date, `${search.flights.length} flights · cheapest $${search.flights[0].price} on ${search.flights[0].date}`);
const sel = parse(await c.callTool({ name: "select_flight", arguments: { flight_no: search.flights[0].flight_no, date: search.flights[0].date } }));
ok("select_flight carries the date from a window result", sel.ok === true && sel.flight_no === search.flights[0].flight_no, `${sel.flight_no} ${sel.route || ""} ${sel.dep || ""}`);
const brief = parse(await c.callTool({ name: "get_destination_brief", arguments: { city: "Delhi" } }));
ok("get_destination_brief answers over MCP", brief.ok && brief.city === "New Delhi" && typeof brief.text === "string", brief.mode);
const dis = parse(await c.callTool({ name: "get_disruption_status", arguments: {} }));
ok("get_disruption_status reads the autonomy layer", dis.ok && "linked" in dis && "pending" in dis);
const risk = parse(await c.callTool({ name: "get_trip_risk", arguments: {} }));
ok("get_trip_risk assesses the next trip", risk.ok && risk.trip_risk_label && Array.isArray(risk.alternatives), `${risk.city} ${risk.date}: ${risk.trip_risk_label} · ${risk.alternatives.length} alternatives`);
const unknown = await c.callTool({ name: "not_a_tool", arguments: {} });
ok("unknown tool is refused, not executed", unknown.isError === true);

const res = await c.listResources();
ok("resources: profile, bookings, network", res.resources.length === 3);
const net = JSON.parse((await c.readResource({ uri: "xperion://network" })).contents[0].text);
ok("network resource reads the served network", net.airports >= 1500 && net.country === "US");
const prompts = await c.listPrompts();
const pt = await c.getPrompt({ name: "plan_trip", arguments: { destination: "Denmark", when: "first week of October" } });
ok("prompts: plan_trip renders with arguments", prompts.prompts.length === 2 && /Denmark/.test(pt.messages[0].content.text));
await c.close();

const sofia = await post("/api/admin/mcp/token", { persona: "sofia" });
const c2 = await connect(sofia.token);
const me2 = parse(await c2.callTool({ name: "get_my_profile", arguments: {} }));
ok("a second token is a different customer (no leakage)", me2.customer.first_name === "Sofia");
await c2.close();
const revoked = await fetch(BASE + `/api/admin/mcp/token/${sofia.token}`, { method: "DELETE" }).then((r) => r.json());
const after = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${sofia.token}` }, body: "{}" });
ok("revoked token is refused", revoked.ok && after.status === 401);

/* customer self-service: "Connect your AI" — toggles per assistant, key bound to the logged-in customer */
const SID = "mcp-selfservice-" + Date.now().toString(36);
const H = { "content-type": "application/json", "x-session-id": SID };
await fetch(BASE + "/api/persona", { method: "POST", headers: H, body: JSON.stringify({ persona: "sofia", sessionId: SID }) });
const before = await fetch(BASE + "/api/me/mcp", { headers: H }).then((r) => r.json());
ok("self-service lists Claude, Gemini and Copilot, all off", before.ok && before.connections.length === 3 && before.connections.every((c) => !c.enabled), before.connections.map((c) => c.name).join(", "));
const on = await fetch(BASE + "/api/me/mcp/gemini", { method: "POST", headers: H, body: "{}" }).then((r) => r.json());
ok("switching Gemini on mints a key and returns that tool's config", on.ok && /^xp_/.test(on.token) && on.snippets.some((x) => /gemini/i.test(x.title) && /httpUrl/.test(x.code) && x.code.includes(on.token)), on.snippets.map((x) => x.title).join(" | "));
const cg = await connect(on.token);
const who = parse(await cg.callTool({ name: "get_my_profile", arguments: {} }));
ok("the key acts as the customer who switched it on (Sofia), not Daniel", who.customer?.first_name === "Sofia");
await cg.close();
const claudeOn = await fetch(BASE + "/api/me/mcp/claude", { method: "POST", headers: H, body: "{}" }).then((r) => r.json());
ok("Claude config includes the desktop bridge JSON and a Claude Code command", claudeOn.ok && claudeOn.snippets.some((x) => /Claude Desktop/.test(x.title) && /mcpServers/.test(x.code)) && claudeOn.snippets.some((x) => /claude mcp add/.test(x.code)));
const cop = await fetch(BASE + "/api/me/mcp/copilot", { method: "POST", headers: H, body: "{}" }).then((r) => r.json());
ok("Copilot config is the VS Code mcp.json shape", cop.ok && cop.snippets.some((x) => /"servers"/.test(x.code) && /"type": "http"/.test(x.code)));
const mid = await fetch(BASE + "/api/me/mcp", { headers: H }).then((r) => r.json());
ok("status shows all three on with masked keys", mid.connections.every((c) => c.enabled && /…/.test(c.token_masked)));
const off = await fetch(BASE + "/api/me/mcp/gemini", { method: "DELETE", headers: H }).then((r) => r.json());
const dead = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${on.token}` }, body: "{}" });
ok("switching Gemini off revokes its key immediately", off.ok && dead.status === 401 && off.connections.find((c) => c.client === "gemini").enabled === false);
const bridgeFile = await fetch(BASE + "/mcp/bridge.mjs");
ok("the desktop bridge is downloadable from the server", bridgeFile.ok && /StdioServerTransport/.test(await bridgeFile.text()));

/* the stdio bridge, spawned exactly as Claude Desktop spawns it */
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const bridge = new Client({ name: "desktop-sim", version: "1.0" });
try {
  await bridge.connect(new StdioClientTransport({ command: process.execPath, args: ["mcp/xperion-mcp.mjs"], env: { ...process.env, XPERION_URL: BASE, XPERION_TOKEN: minted.token } }));
  const bt = await bridge.listTools();
  const bme = parse(await bridge.callTool({ name: "get_my_profile", arguments: {} }));
  ok("stdio bridge (Claude Desktop path) proxies tools/list and tools/call to the remote server", bt.tools.length >= 30 && bme.customer?.first_name === "Daniel", `${bt.tools.length} tools via stdio`);
  await bridge.close();
} catch (e) { ok("stdio bridge (Claude Desktop path) proxies tools/list and tools/call to the remote server", false, e.message); }

const passed = results.filter(Boolean).length;
console.log(`\n===== MCP: ${passed}/${results.length} checks passed =====`);
process.exit(passed === results.length ? 0 : 1);
