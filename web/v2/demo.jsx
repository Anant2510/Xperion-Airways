// FlyTAP v2 — Demo Console. A presenter-facing view of everything happening at the
// backend: the live SQLite customer DB, the event stream and its 1:1 CDP payloads,
// Adobe RT-CDP streaming + profile source, AEM headless content integration, the
// card-spend→affinity→offer derivation, a system self-test, and the email outbox.
// Read-only against the (unchanged) /api/admin/*, /api/datasource, /api/aem/status
// endpoints — the same ones the v1 console uses, plus an explicit AEM indicator.
import React, { useState, useEffect } from "react";
import { api, EUR, miles, fmtDate, LANGS, I18N_TABLE, getLang, setLang, onLangChange } from "./lib.js";
import { Btn, Card, Pill, Eyebrow, Icon, Divider, cx } from "./ui.jsx";

/* ── small helpers ────────────────────────────────────────────── */
const Dot = ({ ok }) => <span className={cx("inline-block w-2 h-2 rounded-full", ok ? "bg-tap-green" : "bg-ink-faint")} />;
const Mono = ({ children, className = "" }) => <span className={cx("font-mono", className)}>{children}</span>;
function Section({ icon, title, sub, right, children, accent }) {
  return (
    <Card className={cx("p-5 v2-in", accent && "border-tap-green/40")}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2.5">
          {icon && <span className="w-9 h-9 rounded-xl bg-lime-tint text-tap-greenDeep inline-flex items-center justify-center shrink-0"><Icon name={icon} size={17} /></span>}
          <div><div className="font-bold text-[15px]">{title}</div>{sub && <div className="text-[11px] text-ink-faint">{sub}</div>}</div>
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

/* ── 1 · INTEGRATIONS (incl. the explicit AEM status you asked for) ── */
function Integrations() {
  const [ds, setDs] = useState(null);       // /api/datasource
  const [cdpEv, setCdpEv] = useState(null); // /api/admin/cdp/events
  const [aem, setAem] = useState(null);     // /api/aem/status
  const [health, setHealth] = useState(null); // /api/health
  const [content, setContent] = useState(null); // live content source from /api/destinations
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [d, e, a, h, dest] = await Promise.all([
      api.get("/datasource").catch(() => null),
      api.get("/admin/cdp/events").catch(() => null),
      api.get("/aem/status").catch(() => null),
      api.get("/health").catch(() => null),
      api.get("/destinations").catch(() => null),
    ]);
    setDs(d); setCdpEv(e); setAem(a); setHealth(h);
    setContent(Array.isArray(dest) && dest[0] ? dest[0].contentSource : null);
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const switchTo = async (id) => {
    if (busy || ds?.source === id) return;
    setBusy(true);
    try { await api.post("/datasource", { source: id }); } catch {} finally { setBusy(false); await load(); }
  };

  const aemConfigured = !!aem?.configured;
  const aemServing = content === "aem";
  const cdpConfigured = !!cdpEv?.configured;

  const Tile = ({ name, ok, warn, value, note }) => (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate">{name}</div>
        <Pill tone={ok ? "green" : warn ? "gold" : "slate"}>{value}</Pill>
      </div>
      {note && <div className="text-[11px] text-ink-faint mt-1.5">{note}</div>}
    </div>
  );

  return (
    <Section icon="bolt" title="Integrations & data sources" sub="What's wired right now — toggled live, no redeploy" accent
      right={<Btn size="sm" variant="outline" onClick={load}><Icon name="refresh" size={13} /> Refresh</Btn>}>
      {/* Profile source switch (SQLite ⇄ Adobe RT-CDP) */}
      <div className="rounded-xl border border-line p-3 mb-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate mb-2">Profile source</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {(ds?.sources || [{ id: "sqlite", label: "SQLite (local)", desc: "" }, { id: "adobe", label: "Adobe Real-Time CDP", desc: "" }]).map(s => {
            const active = ds?.source === s.id;
            return (
              <button key={s.id} disabled={busy} onClick={() => switchTo(s.id)} className="text-left">
                <div className={cx("rounded-lg border p-2.5 transition-colors h-full", active ? "border-tap-green bg-lime-tint" : "border-line-strong hover:border-tap-green/50")}>
                  <div className="flex items-center gap-2">
                    <span className={cx("w-4 h-4 rounded-full border-2 inline-flex items-center justify-center", active ? "border-tap-green bg-tap-green text-white" : "border-line-strong")}>{active && <Icon name="check" size={10} />}</span>
                    <span className="font-bold text-[13px]">{s.label}</span>
                  </div>
                  {s.desc && <div className="text-[11px] text-ink-muted mt-1">{s.desc}</div>}
                </div>
              </button>
            );
          })}
        </div>
        {ds?.source === "adobe" && ds?.provenance && (
          <div className="text-[11px] text-tap-greenDeep mt-2 flex items-center gap-1.5"><Icon name="spark" size={12} /> Hydrated from Adobe — mode {ds.provenance.mode}{ds.provenance.audiences ? ` · ${ds.provenance.audiences.length} audiences` : ""}</div>
        )}
      </div>
      {/* Integration tiles */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <Tile name="Adobe RT-CDP" ok={cdpConfigured} warn={!cdpConfigured}
          value={cdpConfigured ? "Streaming" : "Simulated"}
          note={cdpConfigured ? `${(cdpEv?.sent || 0).toLocaleString()} events sent${cdpEv?.failed ? ` · ${cdpEv.failed} failed` : ""}${cdpEv?.syncValidation ? " · validated" : ""}` : "No IMS credentials — events buffered locally"} />
        <Tile name="AEM (headless content)" ok={aemConfigured} warn={!aemConfigured}
          value={aemConfigured ? (aemServing ? "Integrated · serving" : "Configured") : "Not configured"}
          note={aemConfigured
            ? `${aem.base || "GraphQL endpoint"} · project ${aem.project}${aemServing ? " — destinations live from AEM" : ""}`
            : `Using local content${content ? ` (source: ${content})` : ""} — set AEM_ENABLED + AEM_GRAPHQL_URL`} />
        <Tile name="Xperion AI" ok={(health?.ai || "").startsWith("live")} warn={!(health?.ai || "").startsWith("live")}
          value={(health?.ai || "").startsWith("live") ? "Live" : "Fallback"} note={health?.ai || "—"} />
        <Tile name="Email + WhatsApp" ok={!/not configured/i.test(health?.smtp || "x")} warn={/not configured/i.test(health?.smtp || "x")}
          value={!/not configured/i.test(health?.smtp || "x") ? "Sending" : "Outbox"}
          note={`SMTP: ${/not configured/i.test(health?.smtp || "x") ? "DB outbox" : "live"} · WhatsApp: ${/not configured/i.test(health?.whatsapp || "x") ? "logged" : "live"}`} />
      </div>
    </Section>
  );
}

/* ── 2 · SYSTEM SELF-TEST ── */
function SelfTest() {
  const [r, setR] = useState(null);
  const [running, setRunning] = useState(false);
  const run = async () => { setRunning(true); try { setR(await api.get("/admin/selftest")); } catch {} finally { setRunning(false); } };
  useEffect(() => { run(); }, []);
  const groups = r ? [...new Set(r.checks.map(c => c.group))] : [];
  return (
    <Section icon="check" title="System self-test" sub="Live read-only checks across data, search, personalization & integrations"
      accent={r?.ok}
      right={<div className="flex items-center gap-2">{r && <Pill tone={r.ok ? "green" : "red"}>{r.passed}/{r.total} passing</Pill>}{r?.advisory > 0 && <Pill tone="gold">{r.advisory} advisory</Pill>}<Btn size="sm" variant="outline" onClick={run}><Icon name="refresh" size={13} /> {running ? "Running…" : "Re-run"}</Btn></div>}>
      {!r ? <div className="text-[12px] text-ink-faint">Running checks…</div> : (
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
          {groups.map(g => (
            <div key={g} className="py-1">
              <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1 mt-1">{g}</div>
              {r.checks.filter(c => c.group === g).map(c => (
                <div key={c.name} className="flex items-start gap-2 py-0.5">
                  <span className={cx("mt-0.5 shrink-0", c.ok ? "text-tap-green" : c.name.includes("AI") ? "text-[#C9A227]" : "text-tap-red")}><Icon name={c.ok ? "check" : "info"} size={13} /></span>
                  <div className="min-w-0"><div className="text-[12px] font-semibold">{c.name}</div>{c.detail && <div className="text-[10px] text-ink-faint truncate"><Mono>{c.detail}</Mono></div>}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── 3 · DB + CDP BRIDGE ── */
function CdpBridge() {
  const [d, setD] = useState(null);
  const [ev, setEv] = useState(null);
  const [copied, setCopied] = useState(null);
  const load = async () => {
    const [a, b] = await Promise.all([api.get("/admin/cdp").catch(() => null), api.get("/admin/cdp/events").catch(() => null)]);
    setD(a); setEv(b);
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const copy = async (e) => { try { await navigator.clipboard.writeText(JSON.stringify(e.cdpPayload, null, 2)); } catch {} setCopied(e.id); setTimeout(() => setCopied(null), 1400); };
  if (!d) return <Section icon="db" title="Live database & CDP bridge"><div className="text-[12px] text-ink-faint">Reading database…</div></Section>;
  const tone = (t) => t.includes("cancel") ? "red" : t.includes("search") ? "gold" : (t.includes("pay") || t.includes("book") || t.includes("checkin")) ? "green" : "slate";
  const pretty = (t) => t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const countKeys = ["events", "searches", "bookings", "payments", "wa_messages", "travel_history"];
  return (
    <Section icon="db" title="Live database & CDP bridge" sub={`${d.db.engine} · ${d.db.path}`} accent
      right={<div className="flex items-center gap-2"><Pill tone="green"><Dot ok /> {d.totalRows.toLocaleString()} rows · live</Pill>{ev?.configured && <Pill tone="dark"><Icon name="bolt" size={11} /> {(ev.sent || 0).toLocaleString()} → Adobe CDP{ev.failed ? ` · ${ev.failed} failed` : ""}</Pill>}</div>}>
      {/* row counts */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 mb-4">
        {countKeys.map(t => (
          <div key={t} className="rounded-xl bg-surface-mute p-2 text-center">
            <div className="text-[18px] font-black v2-num text-tap-greenDeep">{(d.counts[t] ?? 0).toLocaleString()}</div>
            <div className="text-[9px] uppercase tracking-wide text-ink-faint truncate">{t.replace("_", " ")}</div>
          </div>
        ))}
      </div>
      {/* Adobe live stream (only when configured) */}
      {ev?.configured && ev.recent?.length > 0 && (
        <div className="rounded-xl border border-tap-green/40 p-3 mb-4 bg-lime-tint/40">
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-2">Streaming to Adobe RT-CDP — {ev.sent} sent{ev.failed ? `, ${ev.failed} failed` : ""}{ev.syncValidation ? " · validated" : ""}</div>
          <div className="flex flex-col gap-1">
            {ev.recent.slice(0, 6).map((e, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-[10px]">
                <span className="flex items-center gap-2 min-w-0"><span className={cx("px-1.5 py-0.5 rounded-full font-semibold shrink-0", e.ok ? "bg-tap-green/10 text-tap-greenDeep" : "bg-tap-red/10 text-tap-red")}>{e.eventType || e.stage}</span><Mono className="text-ink-faint truncate">{e.loyaltyId}</Mono></span>
                <span className="text-ink-faint shrink-0">{e.ok ? `✓ ${e.status || "sent"}` : `✗ ${e.error ? String(e.error).slice(0, 32) : "failed"}`}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* event stream → CDP payload */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Event stream → CDP ingest <span className="text-ink-faint normal-case font-normal">· tap to copy CDP payload</span></div>
          <div className="space-y-1 max-h-[260px] overflow-auto pr-1">
            {d.events.length === 0 && <div className="text-[12px] text-ink-faint">No events yet — click around the site.</div>}
            {d.events.map(e => (
              <button key={e.id} onClick={() => copy(e)} className="w-full flex items-start gap-2 py-1 border-b border-line text-left hover:bg-surface-mute rounded transition-colors">
                <Pill tone={tone(e.type)} className="shrink-0 mt-0.5">{pretty(e.type)}</Pill>
                <Mono className="text-[10px] text-ink-faint truncate min-w-0 flex-1">{JSON.stringify(e.payload)}</Mono>
                {copied === e.id ? <span className="text-[9px] font-bold text-tap-green shrink-0 flex items-center gap-0.5"><Icon name="check" size={11} /> copied</span> : <Mono className="text-[9px] text-ink-faint shrink-0">{(e.at || "").slice(11, 19)}</Mono>}
              </button>
            ))}
          </div>
        </div>
        {/* CDP object mapping */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Maps to your CDP (Segment · Adobe · Salesforce)</div>
          <div className="space-y-1.5">
            {(d.cdpMapping || []).map(m => (
              <div key={m.cdp} className="rounded-xl border border-line p-2.5">
                <div className="flex items-center justify-between gap-2"><div className="font-bold text-[12px]">{m.cdp}</div><Mono className="text-[9px] text-ink-faint truncate">{m.source}</Mono></div>
                <div className="text-[10px] text-ink-muted mt-0.5">{m.example}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 4 · AFFINITY (card-spend → affinity → offer) ── */
function Affinity() {
  const [rec, setRec] = useState(null);
  useEffect(() => { const f = () => api.get("/recommendation").then(setRec).catch(() => {}); f(); const t = setInterval(f, 6000); return () => clearInterval(t); }, []);
  if (!rec) return null;
  const maxShare = Math.max(...(rec.categories || []).map(c => c.share), 1);
  const emoji = rec.affinity === "football" ? "⚽" : rec.affinity === "golf" ? "⛳" : "🎵";
  return (
    <Section icon="star" title="Card-spend → affinity → offer" sub="The derivation behind the “Made for you” block on the home page">
      <div className="grid md:grid-cols-3 gap-4 items-stretch">
        <div className="rounded-xl border border-line p-4">
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-2">1 · Card spend (CDP traits)</div>
          <div className="text-[13px] font-bold mb-3">Xperion Miles co-branded card <span className="text-ink-faint font-semibold">•••• ••••</span></div>
          <div className="space-y-2">
            {(rec.categories || []).map((c, i) => (
              <div key={i}>
                <div className="flex justify-between text-[11px] mb-0.5"><span className="font-semibold">{c.name}</span><span className="text-ink-faint">{c.share}%</span></div>
                <div className="h-1.5 rounded-full bg-surface-mute"><div className="h-full rounded-full" style={{ width: `${(c.share / maxShare) * 100}%`, background: i === 0 ? "#9efd38" : "#5E7A68" }} /></div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-tap-green/30 bg-surface-dark text-white p-4 flex flex-col justify-center items-center text-center">
          <div className="text-[10px] font-bold uppercase tracking-wide text-white/50 mb-2">2 · Derived affinity</div>
          <div className="text-2xl mb-1">{emoji}</div>
          <div className="text-[20px] font-black text-lime">{rec.affinity_label}</div>
          <div className="text-[11px] text-white/60 mt-2 leading-snug">{rec.rationale}</div>
        </div>
        <div className="rounded-xl border border-line p-4">
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-2">3 · Assembled offer</div>
          <div className="text-[13px] font-bold mb-1">{rec.package?.event}</div>
          <div className="text-[11px] text-ink-faint mb-3">{rec.package?.city} · {rec.package?.badge}</div>
          <div className="space-y-1 text-[11px] text-ink-muted">
            <div className="flex justify-between"><span>Event ticket</span><span className="v2-num">{EUR(rec.package?.eventPrice || 0)}</span></div>
            <div className="flex justify-between"><span>Hotel · {rec.package?.hotelNights}n</span><span className="v2-num">{EUR(rec.package?.hotelPrice || 0)}</span></div>
            <div className="flex justify-between"><span>Return flight</span><span className="v2-num">{EUR(rec.package?.flightPrice || 0)}</span></div>
            {rec.package?.addon && <div className="flex justify-between text-tap-greenDeep"><span>+ {rec.package.addon.label}</span><span className="v2-num">{EUR(rec.package.addon.price)}</span></div>}
            <div className="flex justify-between font-bold pt-1.5 mt-1.5 border-t border-line text-ink"><span>Bundle total</span><span className="v2-num">{EUR(rec.package?.total || 0)}</span></div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 5 · DB TABLE INSPECTOR ── */
function DbInspector() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("users");
  useEffect(() => { const f = () => api.get("/admin/db").then(setData).catch(() => {}); f(); const t = setInterval(f, 4000); return () => clearInterval(t); }, []);
  if (!data) return <Section icon="grid" title="Customer database"><div className="text-[12px] text-ink-faint">Loading database…</div></Section>;
  const tables = Object.keys(data.tables);
  const rows = data.tables[tab] || [];
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <Section icon="grid" title="Customer database" sub="Every click on the site writes here · auto-refreshes">
      <div className="flex flex-wrap gap-1.5 mb-3">
        {tables.map(t => (
          <button key={t} onClick={() => setTab(t)} className={cx("px-3 py-1.5 rounded-full text-[11px] font-semibold transition-colors", t === tab ? "bg-surface-dark text-white" : "bg-surface border border-line text-ink-muted hover:bg-surface-mute")}>
            {t} <span className="opacity-60">({data.tables[t].length})</span>
          </button>
        ))}
      </div>
      <div className="border border-line rounded-xl overflow-auto max-h-[440px]">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-surface"><tr>{cols.map(c => <th key={c} className="text-left px-3 py-2 font-bold text-ink-slate border-b border-line whitespace-nowrap">{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i % 2 ? "bg-surface-mute/50" : ""}>
                {cols.map(c => <td key={c} className="px-3 py-1.5 whitespace-nowrap max-w-[240px] truncate"><Mono>{String(r[c] ?? "")}</Mono></td>)}
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="px-3 py-6 text-ink-faint text-[12px]">No rows yet — interact with the site and it appears here.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ── 6 · EMAIL CENTER ── */
function EmailCenter() {
  const [emails, setEmails] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => { const f = () => api.get("/admin/emails").then(e => setEmails(e || [])).catch(() => {}); f(); const t = setInterval(f, 4000); return () => clearInterval(t); }, []);
  const view = async (id) => { try { setOpen(await api.get(`/admin/emails/${id}`)); } catch {} };
  return (
    <Section icon="mail" title="Email center" sub="Transactional emails the backend generated (DB outbox / live SMTP)">
      <div className="space-y-2 max-h-[460px] overflow-auto pr-1">
        {emails.length === 0 && <div className="text-[12px] text-ink-faint">No emails yet — book a flight, check in, rebook, or cancel.</div>}
        {emails.map(e => (
          <div key={e.id} className="rounded-xl border border-line p-3">
            <div className="text-[12px] font-bold truncate">{e.subject}</div>
            <div className="text-[11px] text-ink-faint truncate">to {e.to_addr} · {e.created_at}</div>
            <div className="flex items-center justify-between mt-1.5">
              <Pill tone={String(e.status || "").startsWith("delivered") || String(e.status || "").startsWith("sent") ? "green" : "gold"}>{e.status}</Pill>
              <button onClick={() => view(e.id)} className="text-[11px] font-bold text-tap-greenDeep flex items-center gap-1"><Icon name="info" size={12} /> Preview</button>
            </div>
          </div>
        ))}
      </div>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(6,30,22,.6)" }} onClick={() => setOpen(null)}>
          <div className="bg-surface rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-line flex items-center justify-between">
              <div className="min-w-0"><div className="text-[13px] font-bold truncate">{open.subject}</div><div className="text-[11px] text-ink-faint">to {open.to_addr} · {open.status}</div></div>
              <button onClick={() => setOpen(null)} aria-label="Close" className="text-ink-faint"><Icon name="x" size={18} /></button>
            </div>
            <iframe title="email preview" srcDoc={open.html || "<p style='font-family:sans-serif;padding:24px;color:#666'>No HTML body stored.</p>"} className="flex-1 w-full min-h-[420px] rounded-b-2xl" sandbox="" />
          </div>
        </div>
      )}
    </Section>
  );
}

/* ── ROUTE COMPONENT ── */
/* ── Unified customer profile · 360° (Phase 3) — the stitch + segments + offer ── */
function UnifiedProfile() {
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); api.get("/cdp/profile").then(x => setP(x && x.id ? x : null)).catch(() => setP(null)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);
  const ch = (p && p.channels) || {};
  return (
    <Section icon="user" title="Unified customer profile · 360°" accent
      sub="Adobe RT-CDP mirror — identities stitched across offline (PSS) and online (web), with live segment membership and the segment-driven offer."
      right={<Btn size="sm" variant="outline" onClick={load}><Icon name="refresh" size={12} /> Refresh</Btn>}>
      {loading && !p ? <div className="text-[12px] text-ink-faint py-3">Loading profile…</div>
        : !p ? <div className="text-[12px] text-ink-faint py-3">No profile yet — create a PSS booking, or run a search/booking on the site, then refresh.</div>
          : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-surface-dark text-white inline-flex items-center justify-center font-bold">{(p.name || "?").slice(0, 1)}</div>
                <div>
                  <div className="font-bold text-[14px] flex items-center gap-2">{p.name || "Unknown"} {p.stitched && <Pill tone="lime"><Icon name="check" size={10} /> Stitched</Pill>}</div>
                  <div className="text-[11px] text-ink-faint">{p.tier || "Member"} · profile #{p.id}</div>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="rounded-xl border border-line p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Identity graph</div>
                  <div className="space-y-1 text-[12px]">
                    <div><span className="text-ink-faint">loyaltyId </span><Mono>{(p.identities.loyaltyId || []).join(", ") || "—"}</Mono></div>
                    <div><span className="text-ink-faint">email </span><Mono>{(p.identities.email || []).join(", ") || "—"}</Mono></div>
                    <div><span className="text-ink-faint">ecid </span><Mono>{(p.identities.ecid || []).join(", ") || "—"}</Mono></div>
                  </div>
                </div>
                <div className="rounded-xl border border-line p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Channels</div>
                  <div className="flex gap-2 flex-wrap">
                    <Pill tone={ch.pss ? "green" : "slate"}>PSS · offline {ch.pss || 0}</Pill>
                    <Pill tone={ch.web ? "green" : "slate"}>Web · online {ch.web || 0}</Pill>
                  </div>
                  <div className="flex gap-4 mt-2 text-[12px]">
                    <span><b className="v2-num">{p.bookings}</b> <span className="text-ink-faint">bookings</span></span>
                    <span><b className="v2-num">{EUR(p.total_spend)}</b> <span className="text-ink-faint">spend</span></span>
                    <span><b className="v2-num">{miles(p.miles)}</b> <span className="text-ink-faint">mi</span></span>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Segment membership</div>
                <div className="flex flex-wrap gap-1.5">
                  {(p.segments || []).length === 0 ? <span className="text-[12px] text-ink-faint">No segments yet.</span>
                    : p.segments.map(s => <Pill key={s} tone={s.indexOf("Stitched") === 0 ? "lime" : "slate"}>{s}</Pill>)}
                </div>
              </div>

              {p.offer && (
                <div className="rounded-xl border border-tap-green/40 bg-lime-tint/40 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-tap-greenDeep mb-1">Triggered offer · driven by segment “{p.offer.segment}”</div>
                  <div className="text-[13px] font-bold">{p.offer.email.title}</div>
                  <div className="text-[12px] text-ink-muted mt-0.5">{p.offer.email.subject}</div>
                </div>
              )}
            </div>
          )}
    </Section>
  );
}

/* ── Segments & decisioning (Phase 3) — audiences the unified profile qualifies for ── */
function SegmentsPanel({ shared }) {
  const active = shared?.profile?.user?.member_no || "";
  const [members, setMembers] = useState([]);
  const [member, setMember] = useState("");
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/pss/members").then(m => { setMembers(m || []); setMember(active || (m && m[0] && m[0].member_no) || ""); }).catch(() => {}); }, [active]);
  const run = (mno) => { const id = mno || member; if (!id) return; setBusy(true); api.get("/segments/" + encodeURIComponent(id)).then(setData).catch(() => setData(null)).finally(() => setBusy(false)); };
  useEffect(() => { if (member) run(member); }, [member]);
  const p = data?.profile;
  return (
    <Section icon="star" title="Segments &amp; decisioning"
      right={data ? <Pill tone={data.source === "adobe" ? "green" : "dark"}>{data.source === "adobe" ? "Adobe RT-CDP" : "local engine"}</Pill> : null}
      sub="Audiences the unified (online + offline/PSS) profile qualifies for — and the offer each drives. Reads Adobe RT-CDP audiences when wired, else the local engine.">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={member} onChange={e => setMember(e.target.value)} className="bg-surface border border-line-strong rounded-lg px-3 py-1.5 text-[12px]">
          {members.map(m => <option key={m.member_no} value={m.member_no}>{m.name} · {m.tier} · {m.member_no}</option>)}
        </select>
        <Btn size="sm" variant="outline" onClick={() => run()} disabled={busy}>{busy ? "Evaluating…" : "Re-evaluate"}</Btn>
      </div>
      {p && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-center">
          {[["Tier", p.tier], ["Miles", miles(p.miles)], ["Total spend", EUR(p.totalSpend)], ["Bookings", p.bookings], ["Offline (PSS)", p.pssCount]].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-surface-mute p-2"><div className="text-[9px] uppercase tracking-wide text-ink-faint">{k}</div><div className="text-[14px] font-bold v2-num">{v}</div></div>
          ))}
        </div>
      )}
      <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Qualifying segments</div>
      <div className="flex flex-wrap gap-2">
        {(!data || (data.segments || []).length === 0) && <span className="text-[12px] text-ink-faint">No segments yet — book this member in the PSS app, then re-evaluate.</span>}
        {(data?.segments || []).map(s => (
          <span key={s.id} className="inline-flex flex-col rounded-lg border border-tap-green/40 bg-lime-tint/40 px-3 py-1.5">
            <span className="text-[12px] font-bold text-tap-greenDeep">{s.name}</span>
            <span className="text-[10px] text-ink-muted">{s.why}</span>
          </span>
        ))}
      </div>
      {data?.decided && (
        <div className="mt-3 rounded-xl border border-line bg-surface-soft p-3">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Decided offer · from top segment “{data.decided.name}”</div>
          <div className="text-[13px] font-bold">{data.decided.email?.title}</div>
          <div className="text-[12px] text-ink-muted">{data.decided.email?.subject}</div>
        </div>
      )}
    </Section>
  );
}

/* ── Personalization ledger — per recommendation, the exact records that drove it ── */
function PersonalizationLedger() {
  const [d, setD] = useState(null);
  useEffect(() => { const f = () => api.get("/admin/personalization").then(setD).catch(() => { }); f(); const t = setInterval(f, 6000); return () => clearInterval(t); }, []);
  if (!d) return <Section icon="analytics" title="Personalization ledger"><div className="text-[12px] text-ink-faint">Reading personalization decisions…</div></Section>;
  const recTables = d.records || {};
  return (
    <Section icon="analytics" title="Personalization ledger" sub="Every recommendation on the site, traced to the exact DB rows & RT-CDP audiences that drove it" accent
      right={<span className={cx("inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full", d.cdpOn ? "bg-lime-tint text-tap-greenDeep" : "bg-surface-mute text-ink-muted")}><Dot ok={d.cdpOn} /> RT-CDP {d.cdpOn ? "live" : "DB-only"}</span>}>
      <div className="rounded-xl bg-surface-soft border border-line p-3 mb-3 text-[12px]">
        <span className="font-bold">{d.identity?.name}</span> · {d.identity?.tier} · {miles(d.identity?.miles)} mi · {d.identity?.home_airport}
        {!!(d.audiences && d.audiences.length) && <div className="mt-1 text-[11px] text-ink-muted">Adobe RT-CDP audiences: {d.audiences.join(", ")}</div>}
        {!!(d.segments && d.segments.length) && <div className="mt-0.5 text-[11px] text-ink-muted">Segments: {d.segments.map(s => s.name).join(", ")}</div>}
      </div>
      <div className="space-y-3">
        {(d.surfaces || []).map((s, si) => (
          <div key={si} className="border border-line rounded-xl overflow-hidden">
            <div className="bg-surface-mute px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ink-slate">{s.surface} <span className="opacity-60">({s.items.length})</span></div>
            <div className="divide-y divide-line">
              {s.items.length === 0 && <div className="px-3 py-3 text-[12px] text-ink-faint">No active recommendations for this surface yet.</div>}
              {s.items.map((it, ii) => (
                <div key={ii} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="font-semibold text-[13px]">{it.title}</div>
                    {it.via && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-lime-tint text-tap-greenDeep">{it.via}</span>}
                  </div>
                  {it.reason && <div className="text-[11px] text-ink-muted mt-0.5">{it.reason}</div>}
                  {!!(it.signals && it.signals.length) && (
                    <ul className="mt-1 space-y-0.5">
                      {it.signals.map((sig, k) => <li key={k} className="text-[11px] text-ink-700 flex items-start gap-1.5"><Icon name="spark" size={10} className="text-tap-green mt-0.5 shrink-0" /><Mono className="text-[10.5px]">{sig}</Mono></li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 grid md:grid-cols-3 gap-3">
        {[["travel_history", "Travel history"], ["searches", "Searches"], ["bookings", "Bookings"]].map(([key, label]) => {
          const rows = recTables[key] || [];
          const cols = rows[0] ? Object.keys(rows[0]) : [];
          return (
            <div key={key} className="border border-line rounded-xl overflow-hidden">
              <div className="bg-surface-mute px-3 py-2 text-[11px] font-bold text-ink-slate">{label} <span className="opacity-60">({rows.length})</span></div>
              <div className="overflow-auto max-h-[200px]">
                <table className="w-full text-[10.5px]">
                  <thead className="sticky top-0 bg-surface"><tr>{cols.map(c => <th key={c} className="text-left px-2 py-1 font-bold text-ink-slate border-b border-line whitespace-nowrap">{c}</th>)}</tr></thead>
                  <tbody>{rows.map((r, i) => <tr key={i} className={i % 2 ? "bg-surface-mute/40" : ""}>{cols.map(c => <td key={c} className="px-2 py-1 whitespace-nowrap max-w-[150px] truncate"><Mono>{typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "")}</Mono></td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// E1 · Experimentation & governance — A/B / multivariate testing, a no-code workflow
// configurator/publisher, and AI governance (on/off + decision-log pointer).
function ExperimentationPanel() {
  const [experiments, setExperiments] = useState([
    { id: "exp-fare-layout", name: "Fare card layout", metric: "Fare selection rate", status: "running", winner: "B · Inline bundles", active: null, variants: [{ k: "A · Expandable", split: 50, conv: 4.2 }, { k: "B · Inline bundles", split: 50, conv: 4.9 }] },
    { id: "exp-bundle-rank", name: "Bundle ranking model", metric: "Ancillary attach", status: "running", winner: "C · Segment-weighted", active: null, variants: [{ k: "A · Price-first", split: 34, conv: 3.1 }, { k: "B · Loyalty-weighted", split: 33, conv: 3.8 }, { k: "C · Segment-weighted", split: 33, conv: 4.4 }] },
    { id: "exp-conf-recs", name: "Confirmation recs count", metric: "Post-book add rate", status: "ready", winner: null, active: null, variants: [{ k: "A · 2 cards", split: 50, conv: 6.0 }, { k: "B · 3 cards", split: 50, conv: 6.7 }] },
  ]);
  const promote = (id, k) => setExperiments(xs => xs.map(x => x.id === id ? { ...x, status: "promoted", active: k } : x));
  const [steps, setSteps] = useState([
    { k: "Search", on: true, locked: true }, { k: "Results & fare brands", on: true, locked: true },
    { k: "Seat selection", on: true }, { k: "Ancillary upsell", on: true }, { k: "Cross-sell (3rd-party)", on: true },
    { k: "Passenger details", on: true, locked: true }, { k: "Payment", on: true, locked: true },
  ]);
  const [published, setPublished] = useState(false);
  const toggleStep = (i) => { setSteps(s => s.map((x, j) => j === i && !x.locked ? { ...x, on: !x.on } : x)); setPublished(false); };
  const [ai, setAi] = useState({ master: true, recs: true, ranking: true, offers: true });
  const setAiFlag = (k) => setAi(a => k === "master" ? { master: !a.master, recs: !a.master, ranking: !a.master, offers: !a.master } : { ...a, [k]: !a[k] });
  return (<>
    <Section icon="star" title="A/B &amp; multivariate testing" sub="Live experiments comparing flows, layouts and offers against a success metric" accent>
      <div className="space-y-3">
        {experiments.map(x => (
          <div key={x.id} className="rounded-xl border border-line p-3.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[13px] font-bold">{x.name}</div>
              <div className="flex items-center gap-2"><span className="text-[10px] text-ink-faint">Metric: {x.metric}</span><Pill tone={x.status === "promoted" ? "green" : x.status === "running" ? "gold" : "slate"}>{x.status === "promoted" ? "Promoted" : x.status === "running" ? "Running" : "Ready"}</Pill></div>
            </div>
            <div className="grid sm:grid-cols-3 gap-2 mt-2.5">
              {x.variants.map(v => {
                const best = x.winner === v.k, isActive = x.active === v.k;
                return <div key={v.k} className={cx("rounded-lg border p-2.5", isActive ? "border-tap-green bg-lime-tint/40 ring-1 ring-tap-green" : best ? "border-tap-green/40" : "border-line")}>
                  <div className="text-[11px] font-semibold flex items-center gap-1">{v.k}{best && <span className="text-[9px] font-bold uppercase bg-lime-tint text-tap-greenDeep rounded px-1">lead</span>}</div>
                  <div className="text-[10px] text-ink-faint mt-0.5">{v.split}% traffic</div>
                  <div className="text-[15px] font-black v2-num mt-1">{v.conv}%</div>
                  {!isActive && x.status !== "promoted" && <button onClick={() => promote(x.id, v.k)} className="text-[10px] font-semibold text-tap-greenDeep hover:underline mt-1">Promote →</button>}
                  {isActive && <div className="text-[10px] font-bold text-tap-greenDeep mt-1">✓ Live to 100%</div>}
                </div>;
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
    <Section icon="grid" title="Workflow configurator &amp; publisher" sub="Toggle booking-flow steps and publish a variant — no developer needed">
      <div className="flex flex-wrap gap-2">
        {steps.map((s, i) => (
          <button key={s.k} onClick={() => toggleStep(i)} disabled={s.locked} className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors", s.on ? "border-tap-green bg-lime-tint text-tap-greenDeep" : "border-line text-ink-faint", s.locked && "opacity-60 cursor-not-allowed")}>
            <span className={cx("w-3.5 h-3.5 rounded inline-flex items-center justify-center", s.on ? "bg-tap-green text-white" : "border border-line-strong")}>{s.on && <Icon name="check" size={9} />}</span>{s.k}{s.locked && <span className="text-[9px] text-ink-faint">· required</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-3">
        <Btn size="sm" onClick={() => setPublished(true)} disabled={published}>{published ? "Published ✓" : "Publish flow variant"}</Btn>
        <span className="text-[11px] text-ink-faint">{steps.filter(s => s.on).length} of {steps.length} steps active{published && " · live now"}</span>
      </div>
    </Section>
    <Section icon="bolt" title="AI governance" sub="Switch AI-driven features on/off and review the decision log" accent>
      <label className="flex items-center justify-between rounded-xl border border-line p-3.5">
        <div><div className="text-[13px] font-bold">AI personalization</div><div className="text-[11px] text-ink-faint">Master switch for all AI-driven recommendations, ranking and offers</div></div>
        <button onClick={() => setAiFlag("master")} className={cx("w-11 h-6 rounded-full relative transition-colors shrink-0", ai.master ? "bg-tap-green" : "bg-surface-mute")}><span className={cx("absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all", ai.master ? "right-0.5" : "left-0.5")} /></button>
      </label>
      <div className="grid sm:grid-cols-3 gap-2 mt-2">
        {[["recs", "Recommendations"], ["ranking", "Offer ranking"], ["offers", "Contextual offers"]].map(([k, l]) => (
          <button key={k} onClick={() => ai.master && setAiFlag(k)} disabled={!ai.master} className={cx("rounded-lg border p-2.5 text-left transition-colors", ai[k] && ai.master ? "border-tap-green bg-lime-tint/40" : "border-line", !ai.master && "opacity-50")}>
            <div className="text-[11px] font-semibold flex items-center justify-between">{l}<span className={cx("text-[9px] font-bold uppercase", ai[k] && ai.master ? "text-tap-greenDeep" : "text-ink-faint")}>{ai[k] && ai.master ? "ON" : "OFF"}</span></div>
          </button>
        ))}
      </div>
      <div className="text-[11px] text-ink-muted mt-2.5 flex items-center gap-1.5"><Icon name="doc" size={12} className="text-ink-faint" /> Decision log: every AI recommendation is traced in the <span className="font-semibold">Personalization ledger</span> above, with the DB rows &amp; audiences that drove it.</div>
    </Section>
  </>);
}

// B2 · Regional language showcase — proves Portuguese is localized by region.
function LocalizationPanel() {
  const [, tick] = useState(0);
  useEffect(() => onLangChange(() => tick(n => n + 1)), []);
  const lang = getLang();
  const rows = Object.entries(I18N_TABLE).filter(([, v]) => v[1] !== v[2]);
  return (
    <Section icon="globe" title="Regional language · pt-PT vs pt-BR" sub="Portuguese is localized by region — a Brazilian member sees Brazilian wording, not European" accent
      right={<div className="flex gap-1">{Object.keys(LANGS).map(k => <button key={k} onClick={() => setLang(k)} className={cx("px-2.5 py-1 rounded-full text-[11px] font-semibold border", lang === k ? "border-tap-green bg-lime-tint text-tap-greenDeep" : "border-line text-ink-muted")}>{k === "en" ? "EN" : k === "pt-PT" ? "PT" : "BR"}</button>)}</div>}>
      <div className="text-[12px] text-ink-muted mb-3">Active: <span className="font-semibold text-ink">{LANGS[lang]}</span>. {rows.length} of the terms below differ between European and Brazilian Portuguese — the engine picks the right variant per member.</div>
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="grid grid-cols-3 bg-surface-soft text-[10px] font-bold uppercase tracking-wide text-ink-faint">
          <div className="p-2.5">English</div><div className="p-2.5">Portugal (pt-PT)</div><div className="p-2.5">Brasil (pt-BR)</div>
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-3 border-t border-line text-[12px]">
            <div className="p-2.5 text-ink-muted">{v[0]}</div>
            <div className={cx("p-2.5 font-semibold", lang === "pt-PT" ? "bg-lime-tint/40 text-tap-greenDeep" : "text-ink")}>{v[1]}</div>
            <div className={cx("p-2.5 font-semibold", lang === "pt-BR" ? "bg-lime-tint/40 text-tap-greenDeep" : "text-ink")}>{v[2]}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-ink-faint mt-2">Switch language in the top-right of the site (or here) — the nav and bundle/booking labels update live across the app.</div>
    </Section>
  );
}

export function DemoConsole({ shared, go }) {
  const [dbPath, setDbPath] = useState("");
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { api.get("/admin/cdp").then(d => setDbPath(d?.db?.path || "")).catch(() => {}); }, []);
  const reset = async () => {
    setResetting(true);
    try { const r = await api.post("/admin/reset", {}); setNote(`Demo reset — re-seeded ${r.persona} (source: ${r.source}).`); }
    catch { setNote("Reset failed — check the server."); }
    finally { setResetting(false); setTimeout(() => setNote(""), 4000); }
  };
  return (
    <div className="mx-auto max-w-page px-6 py-8">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <Eyebrow>Demo-only</Eyebrow>
          <h1 className="text-[30px] font-black mt-1 flex items-center gap-2"><span className="text-tap-green"><Icon name="db" size={26} /></span> Demo Console</h1>
          <p className="text-[12px] text-ink-faint mt-1">Live view of the backend — DB writes, CDP event stream, Adobe & AEM integration status, and the email outbox. {dbPath && <Mono>{dbPath}</Mono>}</p>
        </div>
        <div className="flex items-center gap-2">
          <Btn size="sm" variant="outline" onClick={() => go("home")}>← Back to site</Btn>
          <Btn size="sm" variant="danger" disabled={resetting} onClick={reset}><Icon name="refresh" size={13} /> {resetting ? "Resetting…" : "Reset demo"}</Btn>
        </div>
      </div>
      {note && <div className="mt-3 rounded-lg bg-lime-tint text-tap-greenDark px-3 py-2 text-[12px] inline-flex items-center gap-1.5"><Icon name="check" size={13} /> {note}</div>}

      <div className="space-y-5 mt-6">
        <Integrations />
        <SelfTest />
        <CdpBridge />
        <UnifiedProfile />
        <Affinity />
        <SegmentsPanel shared={shared} />
        <PersonalizationLedger />
        <LocalizationPanel />
        <ExperimentationPanel />
        <div className="grid lg:grid-cols-[1.6fr_1fr] gap-5 items-start">
          <DbInspector />
          <EmailCenter />
        </div>
      </div>
    </div>
  );
}
