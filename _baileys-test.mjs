// Baileys transport wiring — no phone needed. A mock socket stands in for WhatsApp; inbound
// messages go through the real dispatch() (LID resolution, guest provisioning, reply routing)
// and outbound sends are captured. Usage: node _baileys-test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.DB_PATH = "./data/baileys-test.db";
const fs = require("node:fs"); try { fs.rmSync("./data/baileys-test.db", { force: true }); } catch {}
const { db } = require("./server/db.js");
const { appCtx } = require("./server/appctx.js");
const pss = require("./server/pss.js");
const whatsapp = require("./server/whatsapp.js");
const transport = require("./server/whatsapp-baileys.js");
const session = require("./server/session.js");

const results = []; const ok = (n, p, d = "") => { results.push(!!p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

/* mock socket: records sends, exposes a lid→pn store */
const sent = [];
transport._state.sock = { sendMessage: async (jid, content) => { sent.push({ jid, text: content.text }); return { key: { id: "m" + sent.length } }; }, signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === "120280659804249@lid" ? "919871724927@s.whatsapp.net" : null) } } };
transport._state.connected = true; transport._state.me = "+919625833782";
whatsapp.setTransport(transport);
ok("conversation module reports baileys mode", whatsapp.MODE() === "baileys" && whatsapp.CONFIGURED() === true, whatsapp.MODE());

/* wire inbound the same way server.js does */
const inbound = async ({ from, text, pushName }) => appCtx.run({ app: "v2" }, async () => {
  const known = pss.resolveByPhone(from);
  await whatsapp.handleIncoming({ from, text, pushName, app: "v2", identity: known || null });
});
/* start() is not called (no real socket); dispatch() returns the normalised message and we hand it to handleIncoming exactly as start() would */
const dispatch = (m, opts) => transport.dispatch(m, opts);
const flow = async (m, opts) => { const n = await dispatch(m, opts); if (n) await inbound({ from: n.from, text: n.text, pushName: m.pushName }); return n; };

/* 1 · a persona messages from a phone-number JID */
const daniel = db.prepare("SELECT id, phone FROM users WHERE id=1").get();
const dJid = daniel.phone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
sent.length = 0;
const n1 = await flow({ key: { remoteJid: dJid, fromMe: false, id: "a1" }, pushName: "Daniel", message: { conversation: "hi" } });
ok("phone-number JID resolves to the persona", n1?.from === "whatsapp:" + daniel.phone.replace(/[^+0-9]/g, ""), n1?.from);
ok("a reply went back on the originating JID", sent.length >= 1 && sent[0].jid === dJid, sent[0] && sent[0].jid);
ok("reply is the numbered text menu (interactive templates off)", /1\b/.test(sent[0]?.text || "") && !/{{/.test(sent[0]?.text || ""), (sent[0]?.text || "").split("\n")[0].slice(0, 60));

/* 2 · a LID-addressed message with remoteJidAlt */
sent.length = 0;
const n2 = await flow({ key: { remoteJid: "120280659804249@lid", remoteJidAlt: "919871724927@s.whatsapp.net", fromMe: false, id: "a2" }, pushName: "Jack", message: { extendedTextMessage: { text: "hi" } } });
ok("LID resolved via remoteJidAlt", n2?.from === "whatsapp:+919871724927", n2?.from);
ok("reply routed to the LID JID, not a rebuilt phone JID", sent[0]?.jid === "120280659804249@lid", sent[0]?.jid);

/* 3 · a LID message without remoteJidAlt falls back to the signal store */
const n3 = await dispatch({ key: { remoteJid: "120280659804249@lid", fromMe: false, id: "a3" }, message: { conversation: "menu" } });
ok("LID resolved via lidMapping store", n3?.from === "whatsapp:+919871724927", n3?.from);

/* 4 · unknown number → anonymous guest, idempotent */
const before = db.prepare("SELECT COUNT(*) n FROM users").get().n;
sent.length = 0;
await flow({ key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false, id: "a4" }, pushName: "Priya Guest", message: { conversation: "hello" } });
await flow({ key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false, id: "a5" }, pushName: "Priya Guest", message: { conversation: "menu" } });
const after = db.prepare("SELECT COUNT(*) n FROM users").get().n;
const guest = session.userByPhone("+447700900123");
ok("unknown sender provisioned once as a guest (real row, no member number)", after === before + 1 && guest && !guest.member_no && guest.first_name === "Priya", guest && `uid ${guest.id} ${guest.full_name}`);
ok("guest is served (replies sent)", sent.length >= 2, `${sent.length} replies`);
ok("isGuest() distinguishes guests from members", session.isGuest(guest.id) === true && session.isGuest(1) === false);

/* 5 · skipped shapes: own sends, groups, status broadcast, empty */
const skipped = await Promise.all([
  dispatch({ key: { remoteJid: dJid, fromMe: true, id: "s1" }, message: { conversation: "x" } }),
  dispatch({ key: { remoteJid: "123@g.us", fromMe: false, id: "s2" }, message: { conversation: "x" } }),
  dispatch({ key: { remoteJid: "status@broadcast", fromMe: false, id: "s3" }, message: { conversation: "x" } }),
  dispatch({ key: { remoteJid: dJid, fromMe: false, id: "s4" }, message: { imageMessage: {} } }),
]);
ok("own sends, groups, status and empty messages are ignored", skipped.every((x) => x === null));
ok("text extracted from button / list / view-once shapes",
  transport.extractText({ buttonsResponseMessage: { selectedDisplayText: "2" } }) === "2" &&
  transport.extractText({ listResponseMessage: { title: "Check in" } }) === "Check in" &&
  transport.extractText({ viewOnceMessageV2: { message: { conversation: "yo" } } }) === "yo");

/* 6 · autonomy offer delivered over the transport and accepted by a WhatsApp reply */
const sim = require("./server/autonomy/sim.js"); const bridge = require("./server/autonomy/bridge.js");
sim.reset(); bridge.link(); sim.t72(); sim.t48();
await new Promise((r) => setTimeout(r, 300));
const offerOut = sent.find((s) => /tornado|weather/i.test(s.text || "") && /1\./.test(s.text || ""));
ok("proactive disruption offer went out over Baileys to the persona's number", !!offerOut, offerOut && offerOut.jid);
sent.length = 0;
await flow({ key: { remoteJid: dJid, fromMe: false, id: "a6" }, pushName: "Daniel", message: { conversation: "2" } });
ok("WhatsApp reply '2' accepted the offer via the same saga", /Done, Daniel/.test(sent[0]?.text || ""), (sent[0]?.text || "").slice(0, 80));
const b = db.prepare("SELECT status FROM bookings WHERE pnr='XPW01A'").get();
ok("real booking updated from the WhatsApp acceptance", ["rebooked", "refund_pending"].includes(b?.status), b?.status);

/* 7 · self-chat test mode: typed on the paired phone in "Message yourself" → handled; bot echoes never re-read */
transport._state.sock.user = { id: "919625833782:7@s.whatsapp.net", lid: "224466@lid" };
sent.length = 0;
const selfIn = await flow({ key: { remoteJid: "919625833782@s.whatsapp.net", fromMe: true, id: "typed-1" }, pushName: "Test", message: { conversation: "hi" } });
ok("self-chat message from the paired phone is handled as a customer", selfIn?.from === "whatsapp:+919625833782" && sent.length >= 1, selfIn?.from);
const echoId = sent.length ? "m" + sent.length : "m1";
const echo = await dispatch({ key: { remoteJid: "919625833782@s.whatsapp.net", fromMe: true, id: echoId }, message: { conversation: sent[0]?.text || "x" } });
ok("the bot's own reply in that chat is not re-dispatched (no loop)", echo === null);
const other = await dispatch({ key: { remoteJid: "447700900999@s.whatsapp.net", fromMe: true, id: "typed-2" }, message: { conversation: "hello" } });
ok("messages the burner sends to other people are still ignored", other === null);

/* 8 · honest status when disconnected */
transport._state.connected = false;
ok("send reports queued when the socket is down", /queued/.test(await whatsapp.sendText("+15551234567", "x")));

const passed = results.filter(Boolean).length;
console.log(`\n===== BAILEYS: ${passed}/${results.length} checks passed =====`);
try { fs.rmSync("./data/baileys-test.db", { force: true }); } catch {}
process.exit(passed === results.length ? 0 : 1);
