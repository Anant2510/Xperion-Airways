// ─────────────────────────────────────────────────────────────────────────────
// Airline adapter seam (Phase 1 of the multi-airline carve).
//
// The chat engine (live Claude agent + offline fallback + buildUI card layer) is
// airline-agnostic. What is airline-SPECIFIC is how each of the 27 agent tools is
// fulfilled — Xperion fulfils them against its own SQLite; another airline would fulfil
// them against its reservation/loyalty APIs.
//
// Contract: an airline adapter is { id, tools } where tools is an object keyed by
// TOOL NAME (verbatim from AGENT_TOOLS — snake_case, no renaming, so there is no
// mapping layer to get wrong). Each tool is (input, ctx) => result:
//   input  — the tool's input as defined by its input_schema in AGENT_TOOLS
//   ctx    — { uid, session }: the acting customer id and the per-conversation
//            session object (adapters may read/write session state such as
//            session.lastSearch / session.selected, exactly as the legacy
//            inline implementations did)
//   result — a plain object. Shapes must match what buildUI() understands, so the
//            A2UI cards render identically for every airline. The canonical shapes
//            are documented per-tool in AIRLINE-ADAPTER.md.
//
// Migration model: tools are moved out of the legacy inline chain in
// agentRunTool() one at a time. The dispatcher checks the tenant's adapter FIRST;
// anything not yet migrated falls through to the inline chain unchanged, so
// behaviour is identical during the whole migration. registerAirline() returns
// the list of not-yet-implemented tools so the boot banner can show live progress.
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_TOOLS = [
  "split_booking", "resolve_disruption", "search_multi_city", "park_trip",
  "hold_fare", "get_hold", "upgrade_cabin", "get_disruption", "rebook_flight",
  "get_refund_status", "search_flights", "list_destinations", "get_suggestions",
  "select_flight", "get_flight_info", "add_extras", "remove_extras", "list_seats",
  "change_seat", "checkout", "get_booking", "get_wallet", "get_recommendation",
  "get_journey", "express_usual", "check_in", "cancel_booking",
];

const registry = new Map();

// Per-tenant configuration. Everything the chat engine needs to speak as a given airline
// WITHOUT reading that airline's database: display name, default origin, money/locale, and
// whether the tenant has a CDP personalisation feed. `model` optionally pins a per-tenant
// Claude model; null means use the server default (CLAUDE_MODEL).
const DEFAULT_CONFIG = {
  name: "Airline",
  shortName: null,     // used inside tool descriptions ("Search <shortName> flights"); defaults to name
  homeAirport: "LIS",
  currency: "EUR",
  locale: "en",
  brandLine: null,     // one-line description injected into the agent's situational context
  cdp: false,          // true only for tenants with a live customer-data platform feed
  theme: null,         // { accent, accentDeep, accentDark, highlight, tint, danger } — null = default palette
  model: null,
};

function createAirlineAdapter(id, tools, config) {
  if (!id || typeof id !== "string") throw new Error("airline adapter needs a string id");
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}), id };
  cfg.shortName = cfg.shortName || cfg.name;
  return { id, tools: tools || {}, config: cfg };
}

// Registers the adapter and returns the tool names it does NOT implement (still
// served by the legacy inline chain for Xperion, or unavailable for other tenants).
function registerAirline(adapter) {
  registry.set(adapter.id, adapter);
  return REQUIRED_TOOLS.filter((t) => typeof adapter.tools[t] !== "function");
}

// Unknown tenants fall back to "xperion" so a missing/typo'd header can never take
// the chat down — it just behaves as the default airline.
function getAirline(id) {
  return registry.get(id) || registry.get("xperion");
}

// Phase 2 tenant resolution. Unlike getAirline() this REPORTS what happened, so the caller
// can log an unknown tenant instead of silently serving it as Xperion. `known` is false both for
// an unrecognised id and for no id at all (the default-tenant case).
// The default tenant is CONFIGURATION, not "xperion" baked into the engine — a deployment that
// never serves Xperion sets DEFAULT_AIRLINE to its own id. AIRLINE_STRICT=1 turns an unrecognised
// explicit tenant into an error (`rejected`) instead of silently serving the default, which is
// what you want in production; the lenient default suits demos where a typo shouldn't 400.
const DEFAULT_TENANT = process.env.DEFAULT_AIRLINE || "xperion";
const STRICT_TENANTS = process.env.AIRLINE_STRICT === "1";
function resolveTenant(requestedId) {
  const wanted = (requestedId || "").trim();
  const exact = wanted ? registry.get(wanted) : null;
  const rejected = STRICT_TENANTS && !!wanted && !exact;
  const adapter = exact || (rejected ? null : registry.get(DEFAULT_TENANT)) || null;
  return {
    id: adapter ? adapter.id : (wanted || DEFAULT_TENANT),
    requested: wanted || null,
    known: !!exact,
    rejected,
    adapter,
    config: adapter ? adapter.config : { ...DEFAULT_CONFIG, id: DEFAULT_TENANT },
  };
}

// Registry snapshot for the boot banner / health output: who is onboarded and how complete.
function listAirlines() {
  return [...registry.values()].map((a) => {
    const missing = REQUIRED_TOOLS.filter((t) => typeof a.tools[t] !== "function");
    return { id: a.id, name: a.config.name, implemented: REQUIRED_TOOLS.length - missing.length, total: REQUIRED_TOOLS.length, missing };
  });
}

module.exports = { REQUIRED_TOOLS, DEFAULT_TENANT, createAirlineAdapter, registerAirline, getAirline, resolveTenant, listAirlines };
