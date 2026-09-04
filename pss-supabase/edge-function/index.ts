// ============================================================================
// Supabase Edge Function: pss-forward
// ----------------------------------------------------------------------------
// Fires when a row is inserted into pss_bookings (wired via a Database Webhook,
// see ../README.md). It HMAC-signs the row with the shared secret and forwards
// it to the FlyTAP backend's PSS ingest endpoint, which lands it in SQLite and
// streams it to Adobe RT-CDP.
//
// Deploy:   supabase functions deploy pss-forward --no-verify-jwt
// Secrets:  supabase secrets set FLYTAP_INGEST_URL=https://<your-app>/api/pss/ingest
//           supabase secrets set PSS_WEBHOOK_SECRET=<same secret as the backend>
// ============================================================================
import { createHmac } from "node:crypto";

Deno.serve(async (req) => {
  try {
    const evt = await req.json();            // Supabase DB-webhook envelope
    const record = evt?.record ?? evt;       // the inserted pss_bookings row
    const body = JSON.stringify(record);

    const secret = Deno.env.get("PSS_WEBHOOK_SECRET");
    const url = Deno.env.get("FLYTAP_INGEST_URL");
    if (!secret || !url) return new Response("missing FLYTAP_INGEST_URL / PSS_WEBHOOK_SECRET", { status: 500 });

    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pss-signature": signature },
      body,
    });
    return new Response(await r.text(), { status: r.status });
  } catch (e) {
    return new Response("forward error: " + (e?.message ?? e), { status: 500 });
  }
});
