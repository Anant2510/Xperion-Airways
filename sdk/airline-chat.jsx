// ─────────────────────────────────────────────────────────────────────────────
// Airline Chat SDK — embeddable A2UI chat widget.
//
// A partner airline's app renders one component. Everything else — the agent loop,
// the 27-tool contract, the 16 interactive card types, theming and currency — comes
// from the shared service the widget talks to.
//
//   import { AirlineChat } from "airline-chat-sdk";
//
//   <AirlineChat
//     endpoint="https://chat.example.com"   // your deployment of the shared service
//     tenant="nordvind"                     // the airline id registered server-side
//     getToken={async () => authToken}      // per-request bearer token (see identity notes)
//   />
//
// The widget renders whatever cards the agent emits and routes every button tap back
// through the same endpoint, so adding a capability server-side needs no client release.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { AIConcierge } from "../web/v2/ai.jsx";

// Transport: one POST per turn. Kept tiny and dependency-free on purpose — a partner can
// replace it wholesale (pass your own `transport`) to add retries, tracing or a proxy.
function makeTransport({ endpoint, tenant, getToken, headers }) {
  const base = String(endpoint || "").replace(/\/$/, "");
  return async function transport(path, body) {
    const token = typeof getToken === "function" ? await getToken() : null;
    const res = await fetch(`${base}/api${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tenant ? { "x-airline-tenant": tenant } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chat_${res.status}`);
    return res.json();
  };
}

export function AirlineChat({
  endpoint, tenant, getToken, headers,     // connection
  brand,                                    // optional: theme before the first reply lands
  embedded = true,                          // inline panel (default) vs full-height page
  onNavigate,                               // called when a card wants the host app to navigate
  transport: customTransport,
  shared = {},
}) {
  const transport = React.useMemo(
    () => customTransport || makeTransport({ endpoint, tenant, getToken, headers }),
    [customTransport, endpoint, tenant, getToken, headers]
  );
  return (
    <AIConcierge
      shared={shared}
      embedded={embedded}
      brand={brand}
      transport={transport}
      go={(screen, params) => { if (typeof onNavigate === "function") onNavigate(screen, params); }}
    />
  );
}

// Convenience for non-React hosts: mount into a DOM node.
//   import { mountAirlineChat } from "airline-chat-sdk";
//   mountAirlineChat(document.getElementById("chat"), { endpoint, tenant, getToken });
export function mountAirlineChat(el, options) {
  if (!el) throw new Error("mountAirlineChat needs a DOM element");
  // React 18+: the host supplies react-dom/client; kept as a dynamic import so the SDK
  // itself stays renderer-agnostic and doesn't force a ReactDOM version on the host.
  return import("react-dom/client").then(({ createRoot }) => {
    const root = createRoot(el);
    root.render(<AirlineChat {...options} />);
    return () => root.unmount();
  });
}

export default AirlineChat;
