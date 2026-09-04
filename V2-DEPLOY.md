# FlyTAP v2 (new Figma) — LATEST  ·  Daniel end-to-end is now bookable
# Login · personalized Home · Search Results · Cart · Passenger · Payment · Confirmation

Parallel app at /v2/. Existing demo at / untouched. No server changes.

## Deploy (Mac → push, VM → pull) — same as before
Mac repo root:
    cp -R <unzip>/web/v2  web/ ;  cp -R <unzip>/public/v2  public/ ;  cp <unzip>/package.json package.json
    git add web/v2 public/v2 package.json && git commit -m "v2: booking spine cart→payment→confirmation" && git push
VM:
    git checkout -- public/app.js ; git pull ; npm run build:v2
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; npm start
Open http://localhost:7801/v2/  (hard-refresh)

## The full happy path now works end to end
Login → Home → (Search flight / a destination card) → Search Results → pick outbound fare
→ Pick inbound → fare → Continue to cart → add extras (real ancillaries) → Continue to
passenger → details prefilled from profile → Continue to payment → choose method
(Card / Xperion Miles / Mix / Split) → Pay → **real booking**: a row in bookings, the
confirmation email (SMTP live on the VM), the CDP "booked" event, travel-history updated,
and it shows in your existing Demo Console at /. Lands on the Confirmation screen with PNR,
itinerary, payment receipt, miles earned and "Useful for your trip" recommendations.

## Fidelity / what's first-pass vs deep
- Cart: flight summary + ancillary modules (Seats & baggage / Lounge / Protection / Onboard)
  from /api/ancillaries with add/remove + live re-price, plus demo Stay/Experience bundles.
  The full 8-module merchandising (hotels/cars from AEM) is Phase 3 (offers-headless).
- Payment: method tabs all present; **Card, Xperion Miles and Mix Method are functional**
  (real split into voucher+miles+card on /api/pay). Split Payment shows equal-split and
  charges the lead payer for the demo — per-passenger secure links (CH7·A17) come next.
- Passenger: Passenger 1 prefilled from the live profile; extra pax get blank forms.
- Express Checkout (B4) is still scaffolded — next, since it's the same flow condensed.
