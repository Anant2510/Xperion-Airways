# WebMCP surface — Xperion v2

How the v2 web app publishes the 27-tool agent contract to in-browser AI agents
(Gemini in Chrome, Copilot in Edge, any WebMCP client), so they can operate the
site directly instead of scraping the DOM.

Companion to `AIRLINE-ADAPTER.md`, which defines the contract itself. This
document covers only the browser surface.

---

## The shape of it

```
                    ┌──────────────────────────────┐
  browser agent ──► │  document.modelContext       │
                    │  27 tools, schemas from      │
                    │  GET /api/ai/tools           │
                    └──────────────┬───────────────┘
                                   │  web/v2/webmcp.js
                                   ▼
                    POST /api/ai/tool  { name, input, sessionId }
                                   │
                                   ▼
                          agentRunTool(name, input, session)
                                   │
                    ┌──────────────┴───────────────┐
                    │   tenant adapter (airline.js) │
                    └──────────────────────────────┘
```

`/api/ai/tool` is the **only** thing added on the server. It shares
`agentRunTool()` and `buildUI()` with `/api/ai/agent` (the v2 chat) and, through
it, with the WhatsApp webhook. One implementation, one session store, three
surfaces. There is no second copy of any tool.

---

## Server endpoints

### `POST /api/ai/tool`

Executes exactly one named tool. A browser agent has already chosen the tool and
does not need prose back, so this skips the model loop that `/api/ai/agent` runs.

```jsonc
// request
{ "name": "search_flights",
  "input": { "origin": "OPO", "dest": "LIS", "date": "2026-09-04" },
  "sessionId": "v2-k3f9x1" }

// response
{ "ok": true,
  "tool": "search_flights",
  "result":  { "ok": true, "origin": "OPO", "dest": "LIS", "flights": [ … ] },
  "cards":   [ { "type": "flights", … } ],      // identical to what the chat gets
  "command": { "action": "show_search", … },
  "tenant":  "xperion" }
```

- Tenant, identity (`req.uid`) and session keying (`${tenant}::${sessionId}`)
  are resolved exactly as in `/api/ai/agent`. A WebMCP call is indistinguishable
  from a chat tool call at the adapter.
- `session.pending` is written on `needs_confirm` and cleared on success, so a
  confirmation started by a browser agent can be completed by typing "yes" into
  the Xperion chat, and vice versa.
- **Names are checked against `REQUIRED_TOOLS` before dispatch.** A browser agent
  is not a trusted caller; without this, an injected page script could reach any
  internal function whose name happened to match.
- Rejections are logged as `webmcp_tool_rejected`, calls as `webmcp_tool_call`,
  throws as `webmcp_tool_error`, all in the `events` table.

### `GET /api/ai/tools`

The contract itself, templated for the resolved tenant:

```jsonc
{ "tenant": "xperion", "currency": "EUR",
  "tools": [ { "name": "…", "description": "…", "input_schema": { … },
               "implemented": true } ] }
```

`implemented` reflects whether *this tenant's* adapter fulfils the tool. Xperion
returns 27/27; Nordvind returns 18/27 and the client registers only those 18
rather than publishing tools that always fail.

The client fetches this at boot instead of carrying a local copy, so editing
`AGENT_TOOLS` in `server.js` reaches browser agents on the next page load. Do not
hardcode schemas in the client.

---

## Client — `web/v2/webmcp.js`

Installed once from `main.jsx`:

```js
useEffect(() => { installWebMCP(); return uninstallWebMCP; }, []);
```

Handlers read live trip state at call time, so nothing needs re-registering per
route. `installWebMCP()` is idempotent and returns a no-op teardown on a browser
without WebMCP — v2 is bit-for-bit unchanged there.

### What the client adds

Calling `/api/ai/tool` from outside the page would already work. Everything
below is the part that only in-page code can do, and it is the reason this file
exists rather than a fetch wrapper.

**State projection.** Each tool result is written onto the module state in
`trip.js`, which fires its `notify()` pub/sub — so the nav basket badge, the
right-rail summary and the cart screen re-render exactly as they do for a human
click. The projections live in the `PROJECT` map:

| tool | client effect |
|---|---|
| `search_flights` | `trip.origin/dest/date`, caches the flight list, `syncTripRoute()` |
| `select_flight` | `setLeg("outbound", …)` |
| `add_extras` / `remove_extras` | rewrites `trip.extras`, preserving `cat`/`source` |
| `change_seat` | `trip.seat`, and a paid seat becomes a basket line |
| `hold_fare` | `setFareHold(…)` so the lock survives a reload |
| `checkout` | `trip.pnr` |
| `get_journey` / `express_usual` | restores the route |

> The flights inside a `search_flights` **result** carry no `origin`/`dest` —
> the route sits one level up. `syncTripRoute()` drops any outbound whose flight
> does not match the searched route, so the cache stamps the route onto each
> flight. Removing that stamp makes agent-selected flights vanish on the next
> navigation. There is a regression test for it.

**Navigation.** `buildUI()`'s `command` speaks v1 screen names; `SCREEN_ROUTE`
maps them onto v2 routes. One deliberate override: `list_seats` emits
`navigate→miles`, which is why asking about seats currently jumps to Frequent
Flyer. `SCREEN_OVERRIDE` sends it to `seatchange` instead rather than reproduce
that defect on a new surface. **Fixing it at source in `buildUI()` would also fix
the chat** — worth doing separately.

**The confirmation gate.** Tools run in the page as the signed-in user, which is
what makes them useful and what makes them dangerous. `confirm: true` is
forwarded only if this page has already seen a `needs_confirm` for the same
tool, and the gate closes again after one use. `checkout` has no confirm flag in
the server contract, so the client adds one and advertises it in the published
schema — an agent that never asks cannot book. Covered by
`CONFIRM_REQUIRED = { cancel_booking, upgrade_cabin, split_booking, checkout }`.

**Agent session key.** Persisted in `localStorage` under `flyxperion_agent_sid`, so
a browser agent resumes the same server-side agent session across reloads.

> `ai.jsx:404` still mints `"v2-" + random` per mount, so the chat's own state
> dies on reload and is not shared with this surface. Changing that one line to
> read `flyxperion_agent_sid` would unify chat, WebMCP and reload continuity. Not
> done here because it changes chat behaviour.

### Screen-scoped tools

`registerScreenTool(tool)` registers from the component that owns a screen and
returns an unregister function for the effect teardown, so a tool exists only
while its screen is open. Use it for anything that acts on what is currently
rendered rather than on booking state.

### Console access

`window.__tapTools.run(name, input)` executes a tool without an agent — useful
for demoing on a browser where the flag is unavailable, and for debugging.

---

## Browser support

The registration getter moved from `Navigator` to `Document` in the May 2026
spec draft; Chrome 150 deprecated `navigator.modelContext`. `host()` resolves
`document.modelContext` first, then `navigator.modelContext`, then returns null.

To enable natively: Chrome 146+, `chrome://flags` → *Experimental Web Platform
Features* → Enabled → relaunch. Verify in the DevTools WebMCP panel that 27
tools are registered before relying on it.

Without the flag, load the `@mcp-b/global` polyfill before the bundle and the
same code path runs.

---

## Tests

| file | what it proves |
|---|---|
| `test-webmcp.mjs` | 55 assertions. Loads the real `trip.js` / `lib.js` / `webmcp.js` against a live server; every one of the 27 tools executes; each state projection asserted individually. |
| `test-bundle.mjs` | 18 assertions. Boots the **built** `public/v2/app.js` in jsdom, waits for `main.jsx`'s effect to register the contract, drives the tools as an agent would, and asserts the persisted `flyxperion_trip` changed — i.e. that the agent and the UI share one basket. |
| `_qa.mjs` | The existing harness. 115/117 after these changes — identical to an untouched extract of the same repo, so no regression. The two failures (sofia and lars have no voucher row) are pre-existing. `_qa.mjs` is state-sensitive: restore `data/tap.db` before trusting a count. |

Run them with a server on the expected port; both spin one up in the scripts
under `scripts/` if you add them there.

---

## Adding a tool

1. Add it to `AGENT_TOOLS` in `server.js` and to `REQUIRED_TOOLS` in
   `airline.js`, and implement it in each tenant adapter — i.e. nothing specific
   to WebMCP.
2. It appears on `GET /api/ai/tools` and registers itself on the next page load.
3. Add a `PROJECT` entry in `webmcp.js` **only if** it should move the UI.

A tool with no projection still works; it just answers the agent without
changing what the customer sees.
