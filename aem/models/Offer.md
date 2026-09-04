# Content Fragment Model — Offer (affinity package)

Model name: **Offer**  ·  API name: `offer`  ·  config `/conf/tap`

| Field label    | Property name | Data type                 | Notes                                  |
|----------------|---------------|---------------------------|----------------------------------------|
| Offer id       | `id`          | Single line text          | e.g. "wc-final-week"                   |
| Affinity       | `affinity`    | Enumeration               | football / golf / music                |
| Badge          | `badge`       | Single line text          | e.g. "FIFA World Cup 2026"             |
| City           | `city`        | Single line text          | e.g. "New York"                        |
| IATA code      | `code`        | Single line text          | e.g. "JFK"                             |
| Event          | `event`       | Single line text          | e.g. "World Cup Quarter-Final"         |
| Venue          | `venue`       | Single line text          |                                        |
| Event date     | `date`        | Date & time (date-only)   | ISO date                               |
| Event price    | `eventPrice`  | Number                    | EUR                                    |
| Hotel          | `hotel`       | Single line text          |                                        |
| Hotel nights   | `hotelNights` | Number                    |                                        |
| Hotel price    | `hotelPrice`  | Number                    | EUR                                    |
| Flight desc    | `flightDesc`  | Single line text          | "Return {home} ⇄ JFK · Economy" — {home} filled by the app per traveller |
| Flight price   | `flightPrice` | Number                    | EUR                                    |
| Image          | `image`       | Content Reference (asset) | GraphQL exposes `_publishUrl`          |
| Blurb          | `blurb`       | Multi line text           | persuasive copy                        |

Notes
- The bundle **total** (= eventPrice + hotelPrice + flightPrice) is computed by the app, not stored.
- `affinity` is what the app matches against the traveller's CDP affinity trait (football/golf/music) to pick which offer to surface — content in AEM, targeting by CDP.
- The return-flight `flightDesc`/`flightPrice` is home-airport dependent, so keep the home placeholder generic in AEM and let the app localise it.
