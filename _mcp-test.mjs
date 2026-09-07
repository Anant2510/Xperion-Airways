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

const passed = results.filter(Boolean).length;
console.log(`\n===== MCP: ${passed}/${results.length} checks passed =====`);
process.exit(passed === results.length ? 0 : 1);
