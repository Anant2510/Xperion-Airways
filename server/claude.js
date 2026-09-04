/* ──────────────────────────────────────────────────────────────
   Xperion Demo — Claude AI service (server-side)
   Set ANTHROPIC_API_KEY in .env for live AI. Without it, the
   demo still works using realistic cached responses.
   ────────────────────────────────────────────────────────────── */
const { db } = require("./db");

function danielContext() {
  const u = db.prepare("SELECT * FROM users WHERE id=1").get();
  const p = db.prepare("SELECT * FROM preferences WHERE user_id=1").get();
  const hist = db.prepare("SELECT flight_no,route,trip_date,dep_time FROM travel_history WHERE user_id=1 ORDER BY trip_date").all();
  const upcoming = db.prepare("SELECT pnr,flight_no,flight_date,seat FROM bookings WHERE user_id=1 AND status='confirmed' ORDER BY flight_date").all();
  const pastCount = db.prepare("SELECT COUNT(*) c FROM bookings WHERE user_id=1 AND status='completed'").get().c;
  const v = db.prepare("SELECT amount FROM vouchers WHERE user_id=1 AND status='active' ORDER BY id DESC LIMIT 1").get();
  // Derive the recurring pattern from real history rather than hardcoding it.
  const routeCounts = {};
  hist.forEach(h => { routeCounts[h.route] = (routeCounts[h.route] || 0) + 1; });
  const topRoute = Object.entries(routeCounts).sort((a, b) => b[1] - a[1])[0];
  const topFlight = (() => { const fc = {}; hist.forEach(h => { fc[h.flight_no] = (fc[h.flight_no] || 0) + 1; }); const t = Object.entries(fc).sort((a, b) => b[1] - a[1])[0]; return t ? t[0] : null; })();
  const patternLine = topRoute ? `flies ${topRoute[0]} most often${topFlight ? ` (often ${topFlight})` : ""}, based on their travel history` : "no strong route pattern yet";
  return `You are the AI inside Xperion Airways' digital channel, serving one logged-in customer.
CUSTOMER PROFILE (live from the customer database):
- ${u.full_name}, ${u.nationality}. Xperion Miles ${u.tier.toUpperCase()}. Home airport ${u.home_airport}.
- Miles: ${u.miles.toLocaleString()}.${v ? ` Voucher: €${v.amount}.` : ""} Saved card on file (details masked — never reveal or guess card brand or number).${u.affinity_label ? ` Interests (from card spend): ${u.affinity_label}.` : ""}
- Preferences: seat ${p.seat}; ${p.bag}; meal ${p.meal}; auto check-in ${p.auto_checkin ? "ON" : "OFF"}.
- Travel history (last ${hist.length} flights): ${hist.map(h => `${h.trip_date} ${h.flight_no} ${h.route} ${h.dep_time}`).join("; ")}.
- Bookings on file: ${pastCount} completed past trips, and ${upcoming.length} upcoming/active: ${upcoming.map(b => `${b.pnr} ${b.flight_no} on ${b.flight_date} seat ${b.seat}`).join("; ") || "none"}.
- Pattern: ${patternLine}.
- Personality: values efficiency and control, prefers quick action over extra steps.
Tone: crisp, professional, warm but brief. 24h times, EUR. Today is ${new Date().toDateString()}.`;
}

async function callClaude(messages, { json = false, maxTokens = 1000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no_api_key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: danielContext() + (json ? "\nCRITICAL: Respond with ONLY a valid JSON object. No preamble, no markdown fences." : ""),
      messages,
    }),
  });
  if (!res.ok) throw new Error("api_" + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (!json) return text;
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

/* ── Agentic tool-use call ───────────────────────────────────────
   Lets Claude call real tools (defined by the caller) in a loop.
   `runTool(name, input)` must return a JSON-serialisable result.
   Returns { reply, toolCalls } where reply is the final text and
   toolCalls is the ordered list of {name, input, result} executed,
   which the server turns into UI cards + a screen command. */
async function callClaudeAgent(messages, tools, runTool, { maxTokens = 1200, maxTurns = 5 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no_api_key");
  // If a key IS set but the network can't reach the API (e.g. blocked egress on the
  // VM), don't let the request hang: abort after AGENT_TIMEOUT_MS so the caller fails
  // over to the deterministic agent fast instead of spinning until the OS TCP timeout.
  const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 12000;
  const convo = [...messages];
  const toolCalls = [];
  const sys = danielContext() + `

You are an in-app booking agent. You can take real actions through tools that read and write the same database the website uses. When the customer wants to find, choose, add extras to, pay for, check in, change a seat for, or cancel a flight, USE THE TOOLS — don't just describe what you'd do, and never guess or assume the outcome.

RESUMING AN UNFINISHED BOOKING: bookings are shared across web, this chat and WhatsApp. If the customer says "where was I", "continue/resume my booking", "pick up where I left off", or refers to something already in progress, call get_journey FIRST. It returns the stage they left at and their selections and reloads the chosen flight into context — continue from that exact step, never restart. (If it returns in_progress:false, just offer a fresh search.)

BOOK MY USUAL (EXPRESS): if the customer says "book my usual", "express checkout my usual flight", or "rebook my regular route", call express_usual. It returns their recurring route, usual flight and the recommended next date, and opens the 2-step Express Checkout with seat, bags, saved card and tier perks pre-filled — confirm the route + recommended date back to them in one short sentence.

EXTRAS & PRICING: to add an ancillary use add_extras; to remove one (customer says "I don't want the meal", "remove wifi", "drop the bag") use remove_extras. Both tools return the recomputed basket total — ALWAYS state the new total exactly as returned, and never reuse a previous total after a change. If a removal changes the price, say the new lower price explicitly. Never describe a basket change you didn't make with a tool.

PERSONALIZED PACKAGES (card-derived): the customer has an affinity inferred from their co-branded Xperion card spend (football / golf / music). When they ask what to do, want ideas, ask about packages, weekends, or mention their interest, call get_recommendation and present the bundle (event ticket + hotel + return flight) warmly — say WHY it fits them (the card-spend signal), give the total, and mention any add-on (e.g. a discounted golf-bag). Don't invent events; use exactly what the tool returns.

SEATS — YOU CAN CHANGE THEM IN CHAT (do NOT send the customer to the website):
- "what seats are available", "show me seating options" → call list_seats and summarise the cabins (Business, Premium Economy, Economy) with what's free for the customer's tier.
- "change my seat", "move me to a window", "I want 12A", "put me in business" → call change_seat with the seat or the preference. Report the new seat, cabin and any fare difference from the result.
- Only mention the website seat map if change_seat returns ok:false because the seat is taken or invalid — and even then, offer the suggested free alternative it returns first.

GENUINENESS IS CRITICAL: your reply must reflect EXACTLY what the tool result says — never claim something happened that the tool didn't confirm. Tools return a "state" and sometimes a "message"; honour them:
- check_in → state "checked_in_now" (confirm the boarding pass, group, seat, flight), "already_checked_in" (tell them they're ALREADY checked in for that flight — do not pretend to check them in again), or "no_booking" (tell them there's no upcoming flight to check in for, offer to book).
- cancel_booking → state "needs_confirm" (ask them to confirm the specific PNR/route before cancelling — do NOT cancel yet), "cancelled" (confirm the refund split), or "no_booking" (nothing to cancel).
- If a tool returns ok:false, tell the customer the real reason plainly; never fabricate a success.

MILES, VOUCHER & PAYMENT:
- For ANY question about miles, points, voucher, balance, or how a trip can be paid ("how many miles do I have?", "what's my voucher worth?", "can I pay with miles?"), call get_wallet and answer with the LIVE numbers it returns — never quote a remembered balance, since it changes after bookings and cancellations.
- Miles convert at roughly 1,000 miles ≈ €3. A booking can be split across the voucher, miles and the saved card in one transaction.
- If the customer wants to redeem toward a flight, select the flight first, then call checkout (use_voucher / use_miles default to ON; set either false if they say "don't use my miles/voucher"). After checkout, state the real split (voucher −€X, miles −€Y, card €Z) from the result.

DESTINATIONS — NEVER ASSUME WHERE THEY WANT TO GO:
- HARD RULE: if a message names an origin (or implies one) but NO specific destination, your FIRST action must be to call list_destinations for that origin. Do not answer from memory, do not call search_flights, do not assume any city. Only after list_destinations returns may you reply.
- If the customer asks for flights but doesn't say a destination (e.g. "options for flights from Lisbon", "flights from Lisbon to any destination"), call list_destinations for that origin and present the real list of cities Xperion flies to from there, then ask which one. The customer's home airport is a pattern, NOT a reason to assume any particular destination — they may want anywhere. A hub like Lisbon alone serves dozens of destinations.
- If the customer asks a FACTUAL question about the network ("do we only fly to Porto from Lisbon?", "where can I fly from Madrid?"), call list_destinations and ANSWER the question in words (e.g. "No — from Lisbon you fly to 44 cities including Madrid, London, Paris, Frankfurt, New York and more"). Do NOT trigger a flight search for a factual question, and do NOT imply the network is smaller than it is.
- Only call search_flights once you know BOTH origin and a specific destination.
- When you do list destinations, add a brief personal touch where true (e.g. note the ones the customer has flown before), and if there are many, group or summarise (e.g. "44 cities — Europe, the Americas and Africa") rather than dumping all of them.

USE THE CONVERSATION CONTEXT — DO NOT ASK WHAT YOU ALREADY KNOW:
- The messages above are the running conversation. Always read them before acting. If the route, destination, date or a flight number was already established earlier in THIS conversation, carry it forward — never re-ask for it.
- If the customer refers to a specific flight number (e.g. "does XP1481 have availability for tomorrow", "tell me about the early morning one"), that flight number already identifies the route. Call get_flight_info with it — do NOT ask "which destination is XP1481 to?" and do NOT call list_destinations. You just showed these flights; you know them.
- "the early morning flight", "the first one", "option 2" etc. refer to flights you listed in your previous message — resolve them from context (the earliest departure is the early-morning one), don't start over.
- Stay on the active route. If the conversation is about Lisbon→Amsterdam and the next question is a follow-up ("are there seats", "how much", "what about tomorrow"), it is STILL about that route. Never silently switch the origin back to the customer's home airport mid-thread.
- Only ask a clarifying question when the needed detail genuinely has not appeared anywhere in the conversation.

After acting, reply in one or two crisp sentences using the real PNR, route, date and seat from the result; the UI renders cards and updates the screen, so don't list every flight in prose. Always work from the customer's real profile in your context (their saved card, voucher, miles, preferred seat, and travel pattern).`;

  for (let turn = 0; turn < maxTurns; turn++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
          max_tokens: maxTokens, system: sys, tools, messages: convo,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      // network failure or our own abort → throw so /api/ai/agent fails over to the
      // deterministic agent immediately (the chat never goes dead).
      throw new Error(e.name === "AbortError" ? `agent_timeout_${AGENT_TIMEOUT_MS}ms` : "agent_network: " + e.message);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error("api_" + res.status + ": " + (await res.text()).slice(0, 200));
    const data = await res.json();
    const blocks = data.content || [];
    convo.push({ role: "assistant", content: blocks });

    const toolUses = blocks.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) {
      const reply = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return { reply, toolCalls };
    }
    // Execute each requested tool and feed results back
    const results = [];
    for (const tu of toolUses) {
      let result;
      try { result = await runTool(tu.name, tu.input || {}); }
      catch (e) { result = { error: e.message }; }
      toolCalls.push({ name: tu.name, input: tu.input || {}, result });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 4000) });
    }
    convo.push({ role: "user", content: results });
  }
  // Ran out of turns — return whatever text we have
  return { reply: "Done.", toolCalls };
}

/* Cached fallbacks so the demo never stalls without a key/network */
const FALLBACKS = {
  plan: {
    title: "Your trip, planned around how you fly",
    summary: "Built around your usual travel rhythm.",
    legs: [
      { day: "Mon 15 Jun", flight: "XP1927", route: "Outbound", times: "07:05 – 08:00", why: "Matches the time you most often depart on this route." },
      { day: "Thu 18 Jun", flight: "XP1943", route: "Return", times: "18:35 – 19:30", why: "Your usual return window, with buffer after an afternoon wrap-up." },
    ],
    tip: "With your tier, you can fare-lock both legs free for 24h while plans confirm.",
  },
  recovery: {
    headline: "Your flight is delayed — new departure 08:55",
    message: "Your aircraft is arriving late, so the flight now departs 08:55 and lands 09:50. Here are your realistic options — no queue needed.",
    options: [
      { id: "KEEP", label: "Keep your flight · lands 09:50", detail: "We'll fast-track you on arrival per your tier." },
      { id: "ALT", label: "Move to the next departure", detail: "A later option with a guaranteed seat if your schedule can flex." },
    ],
    compensation: "Your tier + EU261: lounge access now, meal voucher added to your wallet automatically.",
  },
  offer: {
    subject: "Your travel pattern, rewarded",
    title: "A smarter way to fly your favourite route",
    preheader: "Book your regular route ahead and lock in fares + bonus miles.",
    body_html: "Based on how you've been flying lately, booking your regular route ahead this month lets us hold your usual seat, fix the fare below the recent average, and credit bonus miles toward your balance.",
    cta: "See my offer",
  },
  chat: "I can help with that. I can pull up your booking, change your seat, hold a fare, or check disruption risk — just say the word. (Live AI is offline in this environment, but all booking tools are fully functional.)",
};

/* ── Genuine-response layer ──────────────────────────────────────
   The DETERMINISTIC code computes verified facts (from the DB) and a
   `state`. This helper turns those verified facts into natural,
   on-brand language — the LLM only PHRASES facts, it never invents
   outcomes. If the API key is missing or the call fails, a built-in
   deterministic phrasing is returned, so the truth is identical with
   or without the LLM. Channel = "whatsapp" | "web".  ─────────────── */
async function phraseFromFacts(facts, { channel = "web", fallback } = {}) {
  const safe = fallback || facts.message || "Done.";
  if (!process.env.ANTHROPIC_API_KEY) return safe;
  try {
    const sys = danielContext() + `

You phrase the result of an action that ALREADY HAPPENED (or was verified) against the real database. You are given a JSON "facts" object with the true outcome. Write ONE short, natural, warm confirmation message to the customer that states exactly what the facts say — do not add, change, or invent any detail (no made-up times, gates, prices, or statuses). If the facts say an action could NOT happen (e.g. already done, nothing to do), say so plainly and helpfully. ${channel === "whatsapp" ? "This is WhatsApp: keep it to 1–3 short lines, no markdown headers. You may end with a brief next step." : "Keep it to 1–2 sentences."} Use 24h times and EUR. Never claim success the facts don't support.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 220, system: sys,
        messages: [{ role: "user", content: "facts = " + JSON.stringify(facts) }],
      }),
    });
    if (!res.ok) return safe;
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    return text || safe;
  } catch { return safe; }
}

module.exports = { callClaude, callClaudeAgent, phraseFromFacts, FALLBACKS, hasKey: () => !!process.env.ANTHROPIC_API_KEY };
