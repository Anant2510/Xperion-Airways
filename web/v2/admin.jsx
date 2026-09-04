// FlyTAP v2 — Admin / Operator Console. A separate surface (reached by signing in as an
// operator) that (1) sees every user's records in the DB and (2) is the ONLY place that
// triggers disruptions (delay/cancel) or price changes. All endpoints are admin-gated.
import React, { useState, useEffect } from "react";
import { api, money, miles, fmtDate } from "./lib.js";
import { Btn, Card, Pill, Icon, TierBadge, cx } from "./ui.jsx";

const Dot = ({ ok }) => <span className={cx("inline-block w-2 h-2 rounded-full", ok ? "bg-tap-green" : "bg-ink-faint")} />;
const Mono = ({ children, className = "" }) => <span className={cx("font-mono text-[11px]", className)}>{children}</span>;
const inp = "w-full bg-surface border border-line-strong rounded-lg px-2.5 py-1.5 text-[13px] outline-none focus:border-tap-green";
function Section({ icon, title, sub, right, children, accent }) {
  return (
    <Card className={cx("p-5", accent && "border-tap-green/40")}>
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

/* ── OPERATIONS — the only place disruptions / price changes are triggered ── */
function OpsPanel() {
  const [mode, setMode] = useState("booking");         // "booking" | "route"
  const [booked, setBooked] = useState([]);
  const [sel, setSel] = useState("");
  const [origin, setOrigin] = useState("MIA");
  const [dest, setDest] = useState("JFK");
  const [date, setDate] = useState("");
  const [action, setAction] = useState("delay");
  const [delay, setDelay] = useState(120);
  const [eco, setEco] = useState(""); const [prem, setPrem] = useState(""); const [bus, setBus] = useState("");
  const [busy, setBusy] = useState(false); const [res, setRes] = useState(null); const [err, setErr] = useState("");

  const loadBooked = () => api.get("/admin/ops/booked").then(d => {
    const list = (d?.bookings || []).map(b => ({
      key: b.flight_no + "|" + b.date + "|" + b.passenger,
      flight_no: b.flight_no, date: b.date,
      label: `${b.flight_no} · ${b.origin}→${b.dest} · ${b.date} · ${b.passenger} (${b.tier})${b.status !== "scheduled" ? " · " + b.status.toUpperCase() : ""}`,
    }));
    setBooked(list); if (list[0] && !sel) setSel(list[0].key);
  }).catch(() => {});
  useEffect(() => { loadBooked(); }, []);

  const trigger = async () => {
    setBusy(true); setErr(""); setRes(null);
    const body = { scope: mode, action };
    if (mode === "booking") { const [fn, d] = (sel || "").split("|"); if (!fn) { setErr("Pick a booking."); setBusy(false); return; } body.flight_no = fn; body.date = d; }
    else { if (!origin || !dest) { setErr("Enter origin and destination."); setBusy(false); return; } body.origin = origin.toUpperCase().trim(); body.dest = dest.toUpperCase().trim(); if (date) body.date = date; }
    if (action === "delay") body.delayMinutes = Number(delay) || 120;
    if (action === "reprice") { const cp = {}; if (eco) cp.Economy = +eco; if (prem) cp.Premium = +prem; if (bus) cp.Business = +bus; body.cabinPrices = cp; }
    try { const r = await api.post("/admin/ops/disrupt", body); if (!r.ok) throw new Error(r.error || "Failed"); setRes(r); loadBooked(); }
    catch (e) { setErr(e.message || "Failed"); } finally { setBusy(false); }
  };

  const seg = (val, cur, set, label) => (
    <button onClick={() => set(val)} className={cx("px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors", cur === val ? "bg-tap-green text-white border-tap-green" : "border-line-strong text-ink-muted hover:border-tap-green")}>{label}</button>
  );

  return (
    <Section icon="bolt" title="Operations — disruptions & price changes" sub="The only surface that can delay/cancel a flight or reprice cabins. Delay/cancel notifies affected travellers with personalized recovery." accent>
      <div className="flex items-center gap-2 mb-3">{seg("booking", mode, setMode, "A specific booking")}{seg("route", mode, setMode, "Whole route · day")}</div>

      {mode === "booking" ? (
        <label className="block mb-3">
          <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">Upcoming booking (any traveller)</span>
          {booked.length
            ? <select value={sel} onChange={e => setSel(e.target.value)} className={inp}>{booked.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}</select>
            : <div className="text-[12px] text-ink-faint">No upcoming bookings found.</div>}
        </label>
      ) : (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <label className="block"><span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">From</span><input value={origin} onChange={e => setOrigin(e.target.value)} maxLength={3} className={cx(inp, "uppercase")} /></label>
          <label className="block"><span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">To</span><input value={dest} onChange={e => setDest(e.target.value)} maxLength={3} className={cx(inp, "uppercase")} /></label>
          <label className="block"><span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} className={inp} /></label>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mb-3">{seg("delay", action, setAction, "Delay")}{seg("cancel", action, setAction, "Cancel")}{seg("reprice", action, setAction, "Reprice cabins")}{seg("clear", action, setAction, "Clear / reset")}</div>

      {action === "delay" && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="text-[12px] text-ink-muted">Delay by</span>
          <input type="number" value={delay} onChange={e => setDelay(e.target.value)} className={cx(inp, "w-20")} /> <span className="text-[12px] text-ink-muted">min</span>
          {[45, 90, 120, 180].map(m => <button key={m} onClick={() => setDelay(m)} className="px-2 py-1 rounded-md text-[11px] font-semibold bg-surface-soft hover:bg-lime-tint">{m}</button>)}
        </div>
      )}
      {action === "reprice" && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <label className="block"><span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">Economy $</span><input type="number" value={eco} onChange={e => setEco(e.target.value)} placeholder="129" className={inp} /></label>
          <label className="block"><span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">Premium $</span><input type="number" value={prem} onChange={e => setPrem(e.target.value)} placeholder="349" className={inp} /></label>
          <label className="block"><span className="block text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">Business $</span><input type="number" value={bus} onChange={e => setBus(e.target.value)} placeholder="899" className={inp} /></label>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Btn size="sm" disabled={busy} onClick={trigger}><Icon name="bolt" size={13} /> {busy ? "Applying…" : action === "clear" ? "Clear disruption" : action === "reprice" ? "Apply prices" : `Trigger ${action}`}</Btn>
        {err && <span className="text-[12px] text-tap-red font-medium">{err}</span>}
      </div>

      {res && (
        <div className="mt-4 rounded-xl border border-line bg-surface-soft p-3.5">
          <div className="flex items-center gap-2 text-[12px] font-semibold"><Dot ok /> {res.action.toUpperCase()} applied to {res.affected} flight{res.affected === 1 ? "" : "s"} · {res.flights?.slice(0, 4).join(", ")}{res.flights?.length > 4 ? ` +${res.flights.length - 4}` : ""}</div>
          {res.notifications?.length > 0 && <div className="text-[11px] text-ink-muted mt-1">Notified {res.notifications.length} traveller(s): {res.notifications.map(n => n.persona + (n.emailed ? " ✉" : "")).join(", ")}</div>}
          {res.preview && (<>
            <div className="mt-3 text-[10px] font-bold uppercase tracking-wide text-ink-slate">What the traveller sees (personalized)</div>
            <div className="text-[13px] font-bold mt-1">{res.preview.headline}</div>
            <div className="text-[12px] text-ink-muted mt-0.5">{res.preview.message}</div>
            <div className="mt-2 space-y-1">{res.preview.options.map((o, i) => <div key={i} className="text-[12px] flex gap-2"><span className="text-tap-green">•</span><span><b>{o.label}</b> <span className="text-ink-faint">— {o.detail}</span></span></div>)}</div>
            <div className="mt-2 text-[11px] text-tap-greenDeep font-semibold">🛡 {res.preview.compensation}</div>
          </>)}
        </div>
      )}
    </Section>
  );
}

/* ── Currently disrupted flights (live ops overview) ── */
function DisruptedPanel() {
  const [rows, setRows] = useState(null);
  const load = () => api.get("/admin/ops/flights").then(d => setRows(d?.flights || [])).catch(() => setRows([]));
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  return (
    <Section icon="clock" title="Currently disrupted" sub="Live delayed / cancelled flights" right={<Btn size="sm" variant="outline" onClick={load}><Icon name="refresh" size={12} /> Refresh</Btn>}>
      {rows == null ? <div className="text-[12px] text-ink-faint">Loading…</div>
        : rows.length === 0 ? <div className="text-[12px] text-ink-faint">Nothing disrupted right now — trigger something above.</div>
        : <div className="space-y-1.5">{rows.map((f, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-[12px]">
              <div><b>{f.flight_no}</b> · {f.origin}→{f.dest} · {f.flight_date}</div>
              <div className="flex items-center gap-2">
                {f.status === "cancelled" ? <Pill tone="red">Cancelled</Pill> : <Pill tone="gold">Delayed → {f.new_dep}</Pill>}
                {f.cabin_prices && <Pill tone="slate">Repriced</Pill>}
              </div>
            </div>))}</div>}
    </Section>
  );
}

/* ── ALL USERS — every record the DB holds, per traveller ── */
const KV = ({ k, v }) => <div className="flex justify-between gap-3 text-[12px] py-0.5"><span className="text-ink-faint">{k}</span><span className="font-medium text-right">{v ?? "—"}</span></div>;
function Table({ cols, rows, empty }) {
  if (!rows || !rows.length) return <div className="text-[12px] text-ink-faint py-1">{empty}</div>;
  return (
    <div className="overflow-x-auto"><table className="w-full text-[12px]">
      <thead><tr className="text-ink-faint text-left border-b border-line">{cols.map(c => <th key={c.k} className="font-semibold py-1.5 pr-3 whitespace-nowrap">{c.h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-line/60">{cols.map(c => <td key={c.k} className="py-1.5 pr-3 whitespace-nowrap">{c.r ? c.r(r) : (r[c.k] ?? "—")}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
function UserDetail({ uid }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api.get(`/admin/users/${uid}`).then(setD).catch(() => setD({ error: true })); }, [uid]);
  if (!d) return <div className="text-[12px] text-ink-faint p-4">Loading traveller…</div>;
  if (d.error) return <div className="text-[12px] text-tap-red p-4">Couldn't load this user.</div>;
  const u = d.user || {};
  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-x-6">
        <div><KV k="Member" v={u.member_no} /><KV k="Name" v={u.full_name} /><KV k="Tier" v={u.tier} /><KV k="Miles" v={miles(u.miles)} /><KV k="Home" v={u.home_airport} /></div>
        <div><KV k="Email" v={u.email} /><KV k="Phone" v={u.phone} /><KV k="Nationality" v={u.nationality} /><KV k="Card" v={u.card_brand ? `${u.card_brand} ${u.card_last4 || ""}` : "—"} /><KV k="Affinity" v={u.affinity_label || u.affinity} /></div>
      </div>
      <div><div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate mb-1">Bookings ({d.bookings?.length || 0})</div>
        <Table empty="No bookings." rows={d.bookings} cols={[
          { k: "pnr", h: "PNR" },
          { k: "flight", h: "Flight", r: b => `${b.flight_no} ${b.flight ? "· " + b.flight.origin + "→" + b.flight.dest : ""}` },
          { k: "flight_date", h: "Date" },
          { k: "seat", h: "Seat" },
          { k: "cabin", h: "Cabin", r: b => b.meta?.cabin || "—" },
          { k: "status", h: "Status", r: b => b.flight?.status && b.flight.status !== "scheduled" ? b.flight.status : (b.status || "confirmed") },
        ]} /></div>
      <div className="grid md:grid-cols-2 gap-4">
        <div><div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate mb-1">Payments ({d.payments?.length || 0})</div>
          <Table empty="No payments." rows={d.payments} cols={[
            { k: "total", h: "Total", r: p => money(p.total) },
            { k: "card_amt", h: "Card", r: p => money(p.card_amt) },
            { k: "miles_used", h: "Miles", r: p => miles(p.miles_used) },
            { k: "voucher_amt", h: "Voucher", r: p => money(p.voucher_amt) },
          ]} /></div>
        <div><div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate mb-1">Vouchers ({d.vouchers?.length || 0})</div>
          <Table empty="No vouchers." rows={d.vouchers} cols={[
            { k: "code", h: "Code" }, { k: "amount", h: "Amount", r: v => money(v.amount) },
            { k: "reason", h: "Reason" }, { k: "status", h: "Status" },
          ]} /></div>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div><div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate mb-1">Travel history ({d.history?.length || 0})</div>
          <Table empty="No history." rows={d.history} cols={[{ k: "route", h: "Route" }, { k: "flight_no", h: "Flight" }, { k: "trip_date", h: "Date" }, { k: "purpose", h: "Purpose" }]} /></div>
        <div><div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate mb-1">Recent events ({d.events?.length || 0})</div>
          <Table empty="No events." rows={(d.events || []).slice(0, 12)} cols={[{ k: "type", h: "Type", r: e => e.type || e.event_type || e.name }, { k: "created_at", h: "When" }]} /></div>
      </div>
    </div>
  );
}
function UsersPanel() {
  const [users, setUsers] = useState(null);
  const [sel, setSel] = useState(null);
  useEffect(() => { api.get("/admin/users").then(d => setUsers(d?.users || [])).catch(() => setUsers([])); }, []);
  return (
    <Section icon="user" title="All users — everything in the DB" sub={users ? `${users.length} travellers · click to drill into their records` : "Loading…"}>
      <div className="grid lg:grid-cols-[300px_1fr] gap-4">
        <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
          {(users || []).map(u => (
            <button key={u.id} onClick={() => setSel(u.id)} className={cx("w-full text-left rounded-xl border px-3 py-2.5 transition-colors", sel === u.id ? "border-tap-green bg-lime-tint/40" : "border-line hover:border-tap-green")}>
              <div className="flex items-center justify-between"><span className="text-[13px] font-semibold">{u.full_name}</span><TierBadge tier={u.tier} /></div>
              <div className="text-[11px] text-ink-faint mt-0.5">{u.member_no} · {u.home_airport} · {u.bookings} bookings · {money(u.spend)}</div>
            </button>
          ))}
          {users && users.length === 0 && <div className="text-[12px] text-ink-faint">No users.</div>}
        </div>
        <div className="rounded-xl border border-line p-4 min-h-[200px]">
          {sel ? <UserDetail uid={sel} /> : <div className="text-[12px] text-ink-faint h-full flex items-center justify-center">Select a traveller to see their full DB footprint.</div>}
        </div>
      </div>
    </Section>
  );
}

export function AdminConsole({ onLogout }) {
  return (
    <div className="min-h-screen bg-surface-soft">
      <header className="bg-surface-dark text-white">
        <div className="mx-auto max-w-page px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-white/10 inline-flex items-center justify-center"><Icon name="shield" size={18} /></span>
            <div><div className="font-black text-[18px] leading-none">Xperion Admin Console</div><div className="text-[11px] text-white/60 mt-0.5">Operator · full DB visibility · disruption & pricing control</div></div>
          </div>
          <Btn size="sm" variant="outline" onClick={onLogout} className="!text-white !border-white/30 hover:!bg-white/10">Sign out</Btn>
        </div>
      </header>
      <div className="mx-auto max-w-page px-6 py-8 space-y-5">
        <div className="grid lg:grid-cols-[1.7fr_1fr] gap-5 items-start">
          <OpsPanel />
          <DisruptedPanel />
        </div>
        <UsersPanel />
      </div>
    </div>
  );
}
