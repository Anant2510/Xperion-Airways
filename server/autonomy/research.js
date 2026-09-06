"use strict";
/* research.js — the analyst. Builds a DestinationBrief for a city and date window:

     facts   Open-Meteo daily forecast, NWS active alerts (US), Nager.Date public holidays —
             free, keyless, deterministic.
     analysis Claude with the web search tool (when ANTHROPIC_API_KEY is set): weather outlook,
             political/civil events, strikes, major events, advisories, notable news — as
             structured JSON with sources. Political content is summarised neutrally and
             attributed; nothing is asserted without a source.

   Governance (Option C): a brief is INFORMATION. It never raises a disruption probability and
   never triggers a tiered action; only structured feeds (feeds.js) can do that. Briefs reach the
   customer as Tier-0 messages and leave the decision with them.

   Cost control: cached in the graph for RESEARCH_TTL_MS (12 h), built only for booked
   destinations or on explicit request, capped at RESEARCH_MAX_PER_HOUR LLM calls. */

const G = require("./graph");
const O = require("./ontology");
const clock = require("./clock");
const { geocode } = require("./geo");
const feeds = require("./feeds");
const { AIRPORTS } = require("../routes-data");

let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }
let llmImpl = null;                       // injectable for tests: async (prompt) => string
function setLLM(f) { llmImpl = f; }

const TTL_MS = Number(process.env.RESEARCH_TTL_MS) || 12 * 60 * 60 * 1000;
const MAX_PER_HOUR = Number(process.env.RESEARCH_MAX_PER_HOUR) || 20;
const calls = [];                          // timestamps of LLM calls (rate limit)
const hasKey = () => !!process.env.ANTHROPIC_API_KEY && process.env.RESEARCH_ENABLED !== "0";
const cityOf = (code) => { const c = AIRPORTS[code]?.city || code; return /^[A-Z0-9 .'-]+$/.test(c) && c.length > 3 ? c.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : c; };
const countryOf = (code) => AIRPORTS[code]?.country || null;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
const idFor = (code, from, to, interest) => `brief:${code}:${from}:${to}${interest ? ":" + slug(interest) : ""}`;

/* ── facts ────────────────────────────────────────────────────────────── */
const RISK = { tornado_warning: 0.8, tornado_watch: 0.6, hurricane: 0.75, hurricane_watch: 0.6, severe_thunderstorm_warning: 0.55, severe_thunderstorm_watch: 0.45, blizzard: 0.65, winter_storm: 0.5, ice_storm: 0.6, flash_flood: 0.35, flood: 0.25, high_wind: 0.3, dense_fog: 0.35, extreme_heat: 0.1, convective_outlook: 0.35, heavy_rain: 0.2 };
async function holidays(country, from, to) {
  if (!country) return [];
  const years = new Set([from.slice(0, 4), to.slice(0, 4)]); const out = [];
  for (const y of years) {
    try {
      const r = await fetchImpl(`https://date.nager.at/api/v3/PublicHolidays/${y}/${country}`);
      if (!r.ok) continue;
      for (const h of await r.json()) if (h.date >= from && h.date <= to) out.push({ date: h.date, name: h.localName && h.localName !== h.name ? `${h.name} (${h.localName})` : h.name });
    } catch {}
  }
  return out;
}
async function facts(code, from, to) {
  const g = await geocode(code);
  const daily = (await feeds.openMeteoDaily(code, 14).catch(() => null) || []).filter((d) => d.date >= from && d.date <= to);
  const alerts = await feeds.nwsAlerts(code).catch(() => []);
  const outlook = g ? feeds.outlookAlerts(code, daily, g) : [];
  const risk = Math.max(0, ...alerts.map((a) => RISK[a.type] || 0.2), ...outlook.map((a) => RISK[a.type] || 0.2));
  const line = daily.length
    ? daily.map((d) => `${d.date.slice(5)} ${d.label}${d.tmax != null ? ` ${Math.round(d.tmin)}–${Math.round(d.tmax)}°C` : ""}${d.rain_mm >= 5 ? ` ${Math.round(d.rain_mm)}mm` : ""}${d.gust_kmh >= 60 ? ` gusts ${Math.round(d.gust_kmh)}km/h` : ""}`).join("; ")
    : "no forecast available";
  return { geo: g, weather: { outlook: line, days: daily, risk: Number(risk.toFixed(2)), alerts: [...alerts, ...outlook].map((a) => ({ type: a.type, headline: a.headline, source: a.source, valid: a.valid })) }, holidays: await holidays(countryOf(code), from, to) };
}

/* ── analysis (Claude + web search) ───────────────────────────────────── */
function prompt(code, from, to, f, interest) {
  return `You are a neutral travel-intelligence analyst for an airline. Research what could affect a traveller arriving in ${cityOf(code)} (${code}, ${countryOf(code)}) between ${from} and ${to}.${interest ? `\nThe traveller is specifically interested in: ${interest}. Find scheduled ${interest} events in or near the city on those dates (name, venue, date, ticket availability and an official or ticketing source) and list them as events with kind "sport", "concert" or "festival" as appropriate, before the general items.` : ""}
Cover: weather outlook (we already have a forecast: ${f.weather.outlook}; alerts: ${f.weather.alerts.map((a) => a.headline).join("; ") || "none"}), political or civil events (elections, protests, strikes, curfews), major scheduled events (sport, concerts, festivals, conferences), official travel advisories, transport or airport disruption, health notices, and any other notable news for those dates. Public holidays already known: ${f.holidays.map((h) => `${h.date} ${h.name}`).join(", ") || "none"}.
Use web search. Be factual and neutral: describe political events without taking a side, attribute every claim to a source, and omit anything you cannot source. Estimate impact on a visitor's trip, not on the country.
Source quality matters: prefer official and authoritative sources (national meteorological service, airport operator, government travel advisories, transport authorities, major national and international news outlets); use blogs or aggregators only when nothing better exists. Anything rated medium or high impact needs at least two independent sources; if you can only find one, rate it low and say so in the note. Always include the official travel-advisory level for the country from a government source (e.g. the US State Department or the UK FCDO), even when it is unchanged. Put health notices (disease activity, air quality) in events with kind "health". Do not pad: an empty list is the right answer when nothing is happening.
After researching, respond with the JSON object wrapped exactly like <brief>{...}</brief>, nothing else outside the tags:
<brief>{"summary": "2-3 sentences for the traveller", "events": [{"kind": "political|civil|strike|sport|concert|festival|conference|transport|health|other", "title": "", "date": "YYYY-MM-DD or range", "impact": "low|medium|high", "note": "one sentence", "source": "url"}], "advisories": [{"level": "", "summary": "", "source": "url"}], "news": [{"title": "", "note": "", "source": "url"}], "travel_impact": "none|low|medium|high", "confidence": 0.0}</brief>`;
}
async function callClaude(text) {
  if (llmImpl) return llmImpl(text);
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.RESEARCH_MODEL || process.env.CLAUDE_MODEL || "claude-sonnet-5", max_tokens: 1800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: Number(process.env.RESEARCH_MAX_SEARCHES) || 7 }],
      messages: [{ role: "user", content: text }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(j.error && j.error.message) || "request failed"}`);
  const texts = (j.content || []).filter((b) => b.type === "text");
  const cites = [];
  for (const b of texts) for (const c of b.citations || []) if (c.url) cites.push({ title: c.title || c.url, url: c.url });
  return { text: texts.map((b) => b.text).join("\n"), cites, usage: j.usage };
}
function parseJSON(text) {
  const raw = String(text || "");
  const tagged = raw.match(/<brief>([\s\S]*?)<\/brief>/i);
  const candidates = [tagged && tagged[1], raw].filter(Boolean);
  for (const c of candidates) {
    const clean = c.replace(/```json|```/g, "").trim();
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if (a < 0 || b <= a) continue;
    try { const o = JSON.parse(clean.slice(a, b + 1)); if (o && typeof o === "object") return o; } catch {}
  }
  return null;
}
/* one repair pass, no web search: turn free-form findings into the JSON shape */
async function repairJSON(findings) {
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.RESEARCH_MODEL || process.env.CLAUDE_MODEL || "claude-sonnet-5", max_tokens: 1200,
      messages: [{ role: "user", content: `Convert these research findings into the JSON object described, keeping every source URL. Respond with ONLY the JSON object.\n\nFINDINGS:\n${String(findings).slice(0, 12000)}\n\nSHAPE: {"summary": "", "events": [{"kind": "", "title": "", "date": "", "impact": "low|medium|high", "note": "", "source": "url"}], "advisories": [{"level": "", "summary": "", "source": "url"}], "news": [{"title": "", "note": "", "source": "url"}], "travel_impact": "none|low|medium|high", "confidence": 0.0}` }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(j.error && j.error.message) || "repair failed"}`);
  return parseJSON((j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
}
function rateOk() { const now = Date.now(); while (calls.length && now - calls[0] > 3600000) calls.shift(); return calls.length < MAX_PER_HOUR; }

/* ── the brief ────────────────────────────────────────────────────────── */
async function build(code, from, to, { force = false, interest = null } = {}) {
  code = String(code || "").toUpperCase();
  const id = idFor(code, from, to, interest);
  const cached = G.getNode(id);
  if (cached && !force && cached.expires_at > clock.nowIso()) return { ...cached, cached: true };
  const f = await facts(code, from, to);
  let analysis = null, mode = "facts-only", sources = [], error = null;
  if (hasKey()) {
    if (!rateOk()) error = `research rate limit (${MAX_PER_HOUR}/h) reached`;
    else {
      calls.push(Date.now());
      try {
        const out = await callClaude(prompt(code, from, to, f, interest));
        const res = typeof out === "string" ? { text: out, cites: [] } : out;
        analysis = parseJSON(res.text);
        if (!analysis && res.text && !llmImpl) { try { analysis = await repairJSON(res.text); } catch (e) { error = "repair: " + String(e.message || e).slice(0, 120); } }
        if (analysis) { mode = "llm+facts"; sources = [...res.cites, ...[...(analysis.events || []), ...(analysis.advisories || []), ...(analysis.news || [])].filter((x) => x.source).map((x) => ({ title: x.title || x.summary || x.source, url: x.source }))]; }
        else error = error || `analysis returned no JSON (${String(res.text || "").slice(0, 160).replace(/\s+/g, " ")}…)`;
      } catch (e) { error = String(e.message || e).slice(0, 160); }
    }
  }
  const seen = new Set(); sources = sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url));
  const brief = {
    code, city: cityOf(code), country: countryOf(code), window: { from, to }, interest: interest || null,
    generated_at: clock.nowIso(), expires_at: new Date(Date.parse(clock.nowIso()) + TTL_MS).toISOString(), mode, error,
    weather: f.weather, holidays: f.holidays,
    events: analysis?.events || [], advisories: analysis?.advisories || [], news: analysis?.news || [],
    travel_impact: analysis?.travel_impact || (f.weather.risk >= 0.5 ? "medium" : f.weather.risk >= 0.3 ? "low" : "none"),
    summary: analysis?.summary || defaultSummary(code, from, to, f),
    confidence: analysis?.confidence ?? (f.weather.days.length ? 0.6 : 0.3),
    sources, source_count: sources.length,
  };
  G.upsertNode(id, "DestinationBrief", brief);
  G.upsertNode(`ap:${code}`, "Airport", { code, city: brief.city, country: brief.country, ...(f.geo ? { geo: { lat: f.geo.lat, lon: f.geo.lon } } : {}) });
  G.upsertEdge(id, "BRIEF_FOR", `ap:${code}`);
  O.audit({ actor: "research", action: "DESTINATION_BRIEF", rationale: `${brief.city} ${from}→${to}: ${mode}, impact ${brief.travel_impact}, ${sources.length} source(s)${error ? " · " + error : ""}` });
  return { ...brief, id, cached: false };
}
function defaultSummary(code, from, to, f) {
  const w = f.weather;
  const worst = w.alerts[0];
  const wx = worst ? `${worst.headline} (${worst.source})` : w.days.length ? `mostly ${mode(w.days.map((d) => d.label))}` : "no forecast yet";
  const hol = f.holidays.length ? ` Public holiday: ${f.holidays.map((h) => `${h.name} on ${h.date.slice(5)}`).join(", ")}.` : "";
  return `${cityOf(code)}, ${from.slice(5)} to ${to.slice(5)}: weather ${wx}.${hol} No live analysis available for events or advisories.`;
}
const mode = (arr) => arr.sort((a, b) => arr.filter((v) => v === a).length - arr.filter((v) => v === b).length).pop();

/* customer-facing text (chat + WhatsApp), short and sourced */
function briefText(b, { max = 4 } = {}) {
  const lines = [`Destination brief · ${b.city} · ${b.window.from.slice(5)} to ${b.window.to.slice(5)}`];
  lines.push(`Weather: ${b.weather.alerts.length ? b.weather.alerts.slice(0, 2).map((a) => a.headline).join("; ") : (b.weather.days.length ? b.weather.days.map((d) => `${d.date.slice(5)} ${d.label}`).slice(0, 4).join(", ") : "no forecast yet")}.`);
  const ev = (b.events || []).slice(0, max).map((e) => `• ${e.title}${e.date ? ` (${e.date})` : ""} — ${e.impact} impact${e.note ? `: ${e.note}` : ""}`);
  if (ev.length) lines.push("Happening there:", ...ev);
  if ((b.holidays || []).length) lines.push(`Public holiday: ${b.holidays.map((h) => `${h.name} ${h.date.slice(5)}`).join(", ")}.`);
  if ((b.advisories || []).length) lines.push(`Advisory: ${b.advisories[0].summary}${b.advisories[0].level ? ` (${b.advisories[0].level})` : ""}.`);
  lines.push(`Overall trip impact: ${b.travel_impact}. ${b.mode === "llm+facts" ? `${b.source_count} sources.` : "Forecast and holidays only; live event analysis unavailable."}`);
  return lines.join("\n");
}

function list() { return G.nodesByKind("DestinationBrief").sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at))); }
function status() { return { enabled: hasKey(), llm: hasKey() ? "claude + web search" : "facts-only (no ANTHROPIC_API_KEY)", ttl_ms: TTL_MS, max_per_hour: MAX_PER_HOUR, calls_last_hour: calls.filter((t) => Date.now() - t < 3600000).length, briefs: list().length }; }

module.exports = { build, briefText, list, status, facts, parseJSON, prompt, setFetch, setLLM, addDays, idFor };
