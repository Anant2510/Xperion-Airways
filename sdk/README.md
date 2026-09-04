# Airline Chat SDK

An embeddable A2UI chat widget. The partner app renders one component; the agent loop,
the 27-tool contract, the 16 interactive card types, theming and currency all come from
the shared service.

## Install / render

```jsx
import { AirlineChat } from "airline-chat-sdk";

<AirlineChat
  endpoint="https://chat.example.com"
  tenant="nordvind"
  getToken={async () => await auth.getAccessToken()}
  onNavigate={(screen, params) => router.push(screen, params)}
/>
```

Non-React hosts:

```js
import { mountAirlineChat } from "airline-chat-sdk";
const unmount = await mountAirlineChat(document.getElementById("chat"), {
  endpoint: "https://chat.example.com", tenant: "nordvind", getToken,
});
```

## Props

| Prop | Purpose |
|---|---|
| `endpoint` | Base URL of the shared chat service |
| `tenant` | Airline id registered server-side (sent as `x-airline-tenant`) |
| `getToken` | `async () => token` — per-request bearer token |
| `brand` | Optional: theme/name before the first reply arrives |
| `embedded` | Inline panel (default) or full-height page |
| `onNavigate` | Called when a card asks the host app to navigate |
| `transport` | Replace the built-in fetch entirely (retries, tracing, proxy) |
| `headers` | Extra headers merged into every request |

## Theming

Colours are CSS variables, defaulted to the shared palette. The server sends the tenant's
palette in `brand.theme` on every reply and the widget applies it, so **theming needs no
client release** — change it server-side in the adapter config.

```
--air-accent  --air-accent-deep  --air-accent-dark  --air-highlight  --air-tint  --air-danger
```

Override in the host stylesheet to pin them:

```css
:root { --air-accent:#0b6ea8; --air-tint:#e8f6fd; }
```

## Currency

Money renders in the tenant's configured currency (`brand.currency`), symbol chosen per
currency. Nothing to configure client-side.

## What the widget renders

Whatever the agent emits: flight lists, selected flight, confirmation, booking hub, seat
map, seat result, confirm prompts, upgraded, cancelled, check-in, refund, extras basket,
package, destinations, suggestions, wallet. Every button routes back through the same
endpoint, so **capabilities added server-side appear without a client release**.

## Identity

The widget never authenticates anyone. The host app authenticates its own customer and
supplies a token via `getToken`; the service validates it and resolves the customer through
that tenant's adapter. See `server/AIRLINE-ADAPTER.md` for the identity design.

## Current limitations

- **Theme variables are set on the document root**, not scoped to the widget element. Fine
  for a dedicated app; a host embedding the widget beside other themed content should pin
  the variables in its own stylesheet.
- **`Pill` tones** (`lime`/`slate` status chips) still come from the host design system's
  component rather than the theme variables — 3 sites.
- **The live system prompt is TAP-branded** until `server/claude.js` accepts a per-tenant
  context; see the Phase 2 section of `server/AIRLINE-ADAPTER.md`.
- The SDK ships as source. Bundling/publishing (npm package, versioning) is not set up here.
