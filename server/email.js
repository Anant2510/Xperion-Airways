/* ──────────────────────────────────────────────────────────────
   Xperion Demo — email service
   • Every email is rendered with the Xperion-branded template and
     stored in the `emails` table (visible in the Demo Console).
   • If SMTP_* env vars are set, it is ALSO genuinely delivered
     via Nodemailer — point DEMO_EMAIL_TO at your own inbox for
     the customer demo.
   ────────────────────────────────────────────────────────────── */
const nodemailer = require("nodemailer");
const { db, now } = require("./db");
const { currentApp } = require("./appctx");

// CDP forwarder (email + WhatsApp modules write events directly, outside server.js's log()).
// Guarded require so it no-ops cleanly when the cdp-events module is absent (e.g. partial slice).
let _cdpEvents = null; try { _cdpEvents = require("./cdp-events"); } catch { _cdpEvents = null; }
function _cdpIdent() { try { const u = db.prepare("SELECT member_no, email FROM users WHERE id=1").get() || {}; return { loyaltyId: u.member_no, email: u.email }; } catch { return {}; } }
function cdpForward(type, attrs, rowId) {
  (async () => {
    let ok = false;
    try {
      if (_cdpEvents && typeof _cdpEvents.streamEvent === "function") ok = (await _cdpEvents.streamEvent(type, _cdpIdent(), attrs || {})) !== false;
      else if (_cdpEvents && typeof _cdpEvents.emit === "function") { _cdpEvents.emit(type, _cdpIdent(), attrs || {}); ok = true; }
    } catch { ok = false; }
    try { if (rowId) db.prepare("UPDATE events SET delivery=? WHERE id=?").run(ok ? "sent" : "pending", rowId); } catch { }
  })();
}

const SMTP_READY = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
let transporter = null;
if (SMTP_READY) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const GREEN = "#00A357", DEEP = "#063A28", GOLD = "#C9A227";

// Recipient identity for the shell header/footer — read live from the DB so
// emails are addressed to whichever persona is active (not hardcoded to Daniel).
function recipientInfo() {
  try {
    const { db } = require("./db");
    const u = db.prepare("SELECT full_name, member_no, tier FROM users WHERE id=1").get();
    if (u) return { name: u.full_name, member: u.member_no, tier: u.tier };
  } catch {}
  return { name: "Xperion traveller", member: "", tier: "Member" };
}
const TIER_BADGE = { Platinum: "linear-gradient(120deg,#5A6470,#9AA6B2)", Gold: "linear-gradient(120deg,#C9A227,#E8C75A)", Silver: "linear-gradient(120deg,#9AA0A6,#C7CDD2)" };

function wrap({ title, accent = GREEN, preheader = "", bodyHtml, cta }) {
  const r = recipientInfo();
  const badge = TIER_BADGE[r.tier] || TIER_BADGE.Gold;
  return `<!doctype html><html><body style="margin:0;background:#F2F6F3;font-family:Helvetica,Arial,sans-serif">
  <span style="display:none">${preheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #DCE7E0">
      <tr><td style="background:${DEEP};padding:18px 28px">
        <span style="font-size:22px;font-weight:900;letter-spacing:-0.5px">
          <span style="color:#E2354B">T</span><span style="color:#fff">A</span><span style="color:${GREEN}">P</span>
        </span>
        <span style="color:#ffffff99;font-size:11px;letter-spacing:2px;margin-left:8px">AIR PORTUGAL · MILES&amp;GO</span>
        <span style="float:right;background:${badge};color:#231A03;font-size:10px;font-weight:bold;padding:4px 10px;border-radius:99px">${(r.tier || "Member").toUpperCase()}</span>
      </td></tr>
      <tr><td style="height:4px;background:${accent}"></td></tr>
      <tr><td style="padding:30px 32px 8px">
        <h1 style="margin:0 0 14px;font-size:22px;color:#0E1F18">${title}</h1>
        <div style="font-size:14px;line-height:1.65;color:#3c4a44">${bodyHtml}</div>
        ${cta ? `<div style="margin:26px 0 8px"><a href="${cta.url || "#"}" style="background:${GREEN};color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:13px 26px;border-radius:10px;display:inline-block">${cta.label}</a></div>` : ""}
      </td></tr>
      <tr><td style="padding:18px 32px 26px;font-size:11px;color:#9aa6a0;border-top:1px solid #EEF3F0">
        Sent to ${r.name}${r.member ? " · Member " + r.member : ""} · You receive these because proactive notifications are ON.<br/>
        Xperion Airways demo environment — Reimagined pre-travel journey.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

const { AIRPORTS } = require("./routes-data");
const cityName = (c) => (AIRPORTS[c] && AIRPORTS[c].city) || c;
const routeLabel = (f) => `${cityName(f.origin || "MIA")} → ${cityName(f.dest || "JFK")}`;

const flightRow = (f) => `
  <table width="100%" style="background:#F2F6F3;border-radius:10px;margin:14px 0"><tr>
    <td style="padding:14px 18px">
      <b style="font-size:18px;color:#0E1F18">${f.origin || "MIA"} ${f.dep}</b>
      <span style="color:${GREEN};margin:0 8px">✈</span>
      <b style="font-size:18px;color:#0E1F18">${f.dest || "JFK"} ${f.arr}</b>
      <div style="font-size:12px;color:#6b7a73;margin-top:3px">${f.flight_no}${f.flight_date ? " · " + f.flight_date : ""}${(() => { try { const { db } = require("./db"); const pr = db.prepare("SELECT seat FROM preferences WHERE user_id=1").get(); return pr?.seat ? " · Seat " + pr.seat.split(" ")[0] : ""; } catch { return ""; } })()} · ${f.aircraft || ""}</div>
    </td>
  </tr></table>`;

// Quick persona accessor for templates (seat short-code, card string, tier, first name).
function me() {
  try {
    const { db } = require("./db");
    const u = db.prepare("SELECT full_name, tier, card_brand, card_last4 FROM users WHERE id=1").get() || {};
    const pr = db.prepare("SELECT seat FROM preferences WHERE user_id=1").get() || {};
    const v = db.prepare("SELECT amount FROM vouchers WHERE user_id=1 ORDER BY id DESC LIMIT 1").get() || {};
    return {
      first: (u.full_name || "there").split(" ")[0],
      tier: u.tier || "Member",
      card: "your saved card",
      seat: (pr.seat || "").split(" ")[0] || "your seat",
      voucher: v.amount || 0,
    };
  } catch { return { first: "there", tier: "Member", card: "card", seat: "your seat", voucher: 0 }; }
}

const TEMPLATES = {
  booking_confirmation: ({ f, pnr, pay }) => {
    const r = recipientInfo();
    let card = "card";
    let seat = "your seat";
    try {
      const { db } = require("./db");
      const u = db.prepare("SELECT card_brand, card_last4 FROM users WHERE id=1").get();
      if (u) card = "your saved card";
      const pr = db.prepare("SELECT seat FROM preferences WHERE user_id=1").get();
      if (pr?.seat) seat = pr.seat.split(" ")[0];
    } catch {}
    return {
    subject: `Booked ✓ ${f.flight_no} ${routeLabel(f)} — ${pnr}`,
    html: wrap({
      title: `You're booked, ${r.name.split(" ")[0]}.`,
      preheader: "Instant confirmation — boarding pass arrives automatically 24h before.",
      bodyHtml: `Confirmation <b>${pnr}</b> — paid in one transaction:
        voucher <b>−$${pay.voucher_amt.toFixed(2)}</b>, ${pay.miles_used.toLocaleString()} miles <b>−$${pay.miles_amt.toFixed(2)}</b>, ${card} <b>$${pay.card_amt.toFixed(2)}</b>.
        ${flightRow(f)}
        Auto check-in is ON — your boarding pass will simply appear in the app 24 hours before departure. Your preferences are pre-applied to seat ${seat}.`,
      cta: { label: "Manage this booking" },
    }),
    };
  },
  extras_confirmation: ({ f, pnr, names = [], total = 0 }) => ({
    subject: `Extras added ✓ ${pnr}${f && f.flight_no ? " — " + f.flight_no : ""}`,
    html: wrap({
      title: "Your extras are added.",
      accent: GOLD,
      bodyHtml: `We've added these to <b>${pnr}</b>${total > 0 ? ` and charged <b>$${Number(total).toFixed(2)}</b> to your saved card` : " at no extra charge"}:
        <ul style="padding-left:18px;margin:10px 0">${names.map(n => `<li style="margin:6px 0">${n}</li>`).join("")}</ul>
        ${f ? flightRow(f) : ""}
        They're on your booking now — view them any time under Manage my booking.`,
      cta: { label: "Manage this booking" },
    }),
  }),
  disruption: ({ f, recovery }) => ({
    subject: `⚠ ${f.flight_no} update — new departure ${f.new_dep} · your options inside`,
    html: wrap({
      title: recovery.headline,
      accent: "#E2354B",
      preheader: "We've already prepared your rebooking options — one tap, no queue.",
      bodyHtml: `${recovery.message}
        ${flightRow({ ...f, dep: f.new_dep, arr: f.new_arr })}
        <b>Your options (free, one tap in the app):</b>
        <ul style="padding-left:18px;margin:10px 0">${recovery.options.map(o => `<li style="margin:6px 0"><b>${o.label}</b><br/><span style="color:#6b7a73">${o.detail}</span></li>`).join("")}</ul>
        <div style="background:#FFF9EC;border:1px solid ${GOLD}55;border-radius:10px;padding:12px 14px;font-size:13px">🛡 ${recovery.compensation}</div>`,
      cta: { label: "Choose in the app" },
    }),
  }),
  /* Enterprise Autonomy: proactive weather alert with one-tap options, sent before disruption */
  weather_alert: ({ fi, card }) => ({
    subject: `⚠ Weather risk for ${fi.flight_no} on ${fi.date} — your options are ready`,
    html: wrap({
      title: `A heads-up before anything goes wrong`,
      accent: "#E2354B",
      preheader: `Tornado watch near ${card.destCity}. Seats already held — one tap in the app.`,
      bodyHtml: `A tornado watch near <b>${card.destCity}</b> overlaps the arrival of your flight <b>${fi.flight_no}</b> on ${fi.date}. Our disruption model puts the risk at <b>${card.probability}%</b>.<br/><br/>
        We have already held seats and prepared your options. Nothing is charged and your booking ${card.pnr} stays as it is until you choose.
        <ul style="padding-left:18px;margin:10px 0">${(card.options || []).map((o, i) => `<li style="margin:6px 0"><b>${i + 1}. ${o.label}</b><br/><span style="color:#6b7a73">${o.detail}</span></li>`).join("")}</ul>
        ${card.holdUntil ? `<div style="font-size:12px;color:#6b7a73">Seats held until ${card.holdUntil.replace("T", " ").slice(0, 16)} UTC.</div>` : ""}`,
      cta: { label: "Choose in the app" },
    }),
  }),
  recovery_confirmed: ({ pnr, option, items = [] }) => ({
    subject: `Done ✓ ${option.label} — ${pnr} updated`,
    html: wrap({
      title: "Handled. Nothing else to do.",
      bodyHtml: `Your choice is confirmed: <b>${option.label}</b>.<ul style="padding-left:18px;margin:10px 0">${items.map((x) => `<li style="margin:4px 0">${x}</li>`).join("")}</ul>Booking ${pnr} is updated in My Trips; nothing was charged.`,
      cta: { label: "Open My Trips" },
    }),
  }),
  rebooked: ({ option, pnr }) => ({
    subject: `Done ✓ ${option.label} — ${pnr} updated`,
    html: wrap({
      title: "Rebooked. Nothing else to do.",
      bodyHtml: `Your choice is confirmed: <b>${option.label}</b>.<br/><br/>
        New boarding pass issued in the app · seat ${me().seat} kept · airport transfer moved automatically · calendar invite updated.`,
      cta: { label: "Open boarding pass" },
    }),
  }),
  disruption_resolution: ({ pnr, summary = [], rebookFlight }) => {
    const badge = { refund: ["#8C590D", "#FFF4D6", "Refund"], voucher: ["#2E7D33", "#EBF7ED", "Voucher"], rebook: ["#1A1F29", "#EEF1F4", "Rebook"] };
    const money = (n) => `\u20ac${Number(n || 0).toFixed(2)}`;
    const paxBlocks = summary.map(s => {
      const [fg, bg, lbl] = badge[s.type] || ["#333", "#eee", s.type];
      const ancRows = (s.ancillaries || []).map(a =>
        `<tr><td style="padding:3px 0;font-size:12px;color:#555">${a.name}</td>` +
        `<td style="padding:3px 0;font-size:12px;text-align:right;color:#555">${a.disposition}${a.amount ? " \u00b7 " + (a.amount < 0 ? "\u2212" : "+") + money(Math.abs(a.amount)) : ""}</td></tr>`
      ).join("");
      const headline = s.type === "refund" ? `Refunded ${money(s.totalBack || s.amount)} to the original card`
        : s.type === "voucher" ? `Travel voucher ${money(s.amount)}${s.code ? " \u00b7 code " + s.code : ""}`
        : `Rebooked${rebookFlight ? " on " + rebookFlight.flight_no : ""}${s.ancillaryTotal ? " \u00b7 fare adj " + (s.ancillaryTotal < 0 ? "\u2212" : "+") + money(Math.abs(s.ancillaryTotal)) : ""}`;
      return `<div style="border:1px solid #E8E8E5;border-radius:12px;padding:14px 16px;margin:10px 0">` +
        `<div style="display:flex;justify-content:space-between;align-items:center">` +
        `<b style="font-size:14px">${s.name}</b>` +
        `<span style="background:${bg};color:${fg};font-size:11px;font-weight:700;border-radius:999px;padding:3px 10px">${lbl}</span>` +
        `</div>` +
        `<div style="font-size:13px;color:#1A1F29;margin-top:4px">${headline}</div>` +
        (ancRows ? `<table style="width:100%;margin-top:8px;border-top:1px solid #F0F0EE">${ancRows}</table>` : "") +
        `</div>`;
    }).join("");
    return {
      subject: `${pnr}: your disruption resolution is confirmed`,
      html: wrap({
        title: "Your resolution is confirmed",
        accent: GREEN,
        preheader: "Each traveller has been serviced individually.",
        bodyHtml: `Here's exactly what we've done for each traveller on <b>${pnr}</b>, including how your extras were handled:${paxBlocks}` +
          `<div style="background:#F7FBF7;border:1px solid ${GREEN}33;border-radius:10px;padding:12px 14px;font-size:13px;margin-top:6px">You'll also receive this update by SMS and push. No further action is needed.</div>`,
        cta: { label: "View in the app" },
      }),
    };
  },
  hold_confirmation: ({ f, total, expires, duration, fee }) => {
    const label = duration === "7d" ? "7 days" : duration === "48h" ? "48 hours" : "24 hours";
    const deductible = duration === "7d" ? "" : " — fully deductible from your final fare";
    return ({
      subject: `Held for you — ${f.flight_no} locked for ${label} ($${(fee || 0).toFixed(2)} fee)`,
      html: wrap({
        title: "Take your time. We'll hold it.",
        accent: GOLD,
        bodyHtml: `Your fare on ${f.flight_no} — flight, seat ${me().seat} and current taxes — is locked at <b>$${(total || 0).toFixed(2)}</b> for <b>${label}</b>. Hold fee <b>$${(fee || 0).toFixed(2)}</b>${deductible}.
        ${flightRow(f)}
        The price won't move even if fares rise. We'll remind you 6 hours before the hold expires on <b>${expires}</b>.`,
        cta: { label: "Complete booking" },
      }),
    });
  },
  cancelled: ({ b, pay }) => ({
    subject: `Cancelled ✓ ${b.pnr} — refund issued instantly`,
    html: wrap({
      title: "Cancelled, refunded, done.",
      bodyHtml: `Booking <b>${b.pnr}</b> (${b.flight_no}) is cancelled.${pay ? `<br/><br/>Your refund went back the way you paid, instantly: ${pay.miles_used > 0 ? `<b>${pay.miles_used.toLocaleString()} miles</b> restored, ` : ""}${pay.voucher_amt > 0 ? `voucher <b>$${pay.voucher_amt.toFixed(2)}</b> reactivated, ` : ""}<b>$${pay.card_amt.toFixed(2)}</b> returned to your ${me().card}.` : ""}<br/><br/>No forms, no waiting on hold.`,
      cta: { label: "Book a new trip" },
    }),
  }),
  personal_offer: ({ offer }) => ({
    subject: offer.subject,
    html: wrap({
      title: offer.title,
      preheader: offer.preheader || "",
      bodyHtml: offer.body_html,
      cta: { label: offer.cta || "See your offer" },
    }),
  }),
  search_followup: ({ origin, dest, originCity, destCity, date, low }) => ({
    subject: `Still thinking about ${destCity}? Your ${originCity} → ${destCity} search is saved`,
    html: wrap({
      title: `Pick up where you left off, ${me().first}.`,
      preheader: `Your ${originCity} → ${destCity} search is saved — fares from $${low}.`,
      bodyHtml: `You were looking at <b>${originCity} (${origin}) → ${destCity} (${dest})</b> for ${date}.
        ${flightRow({ origin, dest, dep: "", arr: "", flight_no: "Xperion", aircraft: "" })}
        We've saved it to your trips so you can finish in one tap — fares currently from <b>$${low}</b>.
        Your seat ${me().seat} and usual extras are pre-set${me().voucher ? `, and you can pay with your $${me().voucher} voucher + miles` : ""}.`,
      cta: { label: `Resume ${destCity} search` },
    }),
  }),
  search_offer: ({ origin, dest, originCity, destCity, date, low, discount }) => ({
    subject: `A little nudge for ${destCity} — $${discount} off if you book today`,
    accent: GOLD,
    html: wrap({
      title: `Your ${destCity} trip, with $${discount} off.`,
      accent: GOLD,
      preheader: `Exclusive ${me().tier} offer on your saved ${originCity} → ${destCity} search.`,
      bodyHtml: `Still on the fence about <b>${originCity} → ${destCity}</b>? As a Xperion Miles ${me().tier} member, here's <b>$${discount} off</b> if you book this route today.
        ${flightRow({ origin, dest, dep: "", arr: "", flight_no: "Xperion", aircraft: "" })}
        That brings your fare to about <b>$${Math.max(0, low - discount)}</b> before voucher and miles. The offer is held for 48 hours — one tap to book.`,
      cta: { label: `Book ${destCity} with $${discount} off` },
    }),
  }),
};

async function sendEmail(type, data) {
  const user = db.prepare("SELECT * FROM users WHERE id=1").get();
  const to = process.env.DEMO_EMAIL_TO || (data && data.to) || user.email;
  const { subject, html } = TEMPLATES[type](data);

  let status = "logged (no SMTP configured)", providerId = null;
  if (SMTP_READY) {
    try {
      const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM || `"Xperion Airways" <${process.env.SMTP_USER}>`,
        to, subject, html,
      });
      status = "delivered via SMTP"; providerId = info.messageId;
    } catch (e) { status = "send failed: " + e.message.slice(0, 80); }
  }
  const r = db.prepare(`INSERT INTO emails (user_id,to_addr,subject,email_type,html,status,provider_id,created_at,app)
    VALUES (1,?,?,?,?,?,?,?,?)`).run(to, subject, type, html, status, providerId, now(), currentApp());
  const evRow = db.prepare("INSERT INTO events (type,payload_json,created_at,app) VALUES (?,?,?,?)")
    .run("email_" + type, JSON.stringify({ to, subject, status }), now(), currentApp());
  cdpForward("email_" + type, { to, subject, status, channel: "Email" }, Number(evRow.lastInsertRowid));
  return { id: Number(r.lastInsertRowid), to, subject, status, providerId };
}

module.exports = { sendEmail, SMTP_READY };
