#!/usr/bin/env node
/* Xperion Airways · MCP stdio bridge.
   Desktop AI tools that only speak stdio (Claude Desktop, some IDE plugins) run this locally; it
   proxies every MCP request to the airline's remote MCP endpoint with your token, so the tool
   list, resources and prompts are exactly the server's.

   Claude Desktop → Settings → Developer → Edit Config:
   {
     "mcpServers": {
       "xperion-airways": {
         "command": "node",
         "args": ["/path/to/Xperion-Airways/mcp/xperion-mcp.js"],
         "env": { "XPERION_URL": "http://20.40.50.197:7811", "XPERION_TOKEN": "xp_…" }
       }
     }
   }                                                                                             */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const URL_ = (process.env.XPERION_URL || "http://127.0.0.1:7811").replace(/\/$/, "");
const TOKEN = process.env.XPERION_TOKEN || "";
if (!TOKEN) { console.error("XPERION_TOKEN is required (mint one: POST /api/admin/mcp/token)"); process.exit(1); }

async function remote() {
  const client = new Client({ name: "xperion-stdio-bridge", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  await client.connect(transport);
  return client;
}

const local = new Server({ name: "xperion-airways", version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
local.setRequestHandler(ListToolsRequestSchema, async () => { const c = await remote(); try { return await c.listTools(); } finally { await c.close(); } });
local.setRequestHandler(CallToolRequestSchema, async (req) => { const c = await remote(); try { return await c.callTool({ name: req.params.name, arguments: req.params.arguments || {} }); } finally { await c.close(); } });
local.setRequestHandler(ListResourcesRequestSchema, async () => { const c = await remote(); try { return await c.listResources(); } finally { await c.close(); } });
local.setRequestHandler(ReadResourceRequestSchema, async (req) => { const c = await remote(); try { return await c.readResource({ uri: req.params.uri }); } finally { await c.close(); } });
local.setRequestHandler(ListPromptsRequestSchema, async () => { const c = await remote(); try { return await c.listPrompts(); } finally { await c.close(); } });
local.setRequestHandler(GetPromptRequestSchema, async (req) => { const c = await remote(); try { return await c.getPrompt({ name: req.params.name, arguments: req.params.arguments || {} }); } finally { await c.close(); } });

await local.connect(new StdioServerTransport());
