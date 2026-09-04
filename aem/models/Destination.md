# Content Fragment Model — Destination

Create under **AEM → Tools → General → Content Fragment Models** (in config `/conf/tap`).
Model name: **Destination**  ·  API name (used in GraphQL): `destination`

| Field label   | Property name | Data type                | Notes                                   |
|---------------|---------------|--------------------------|-----------------------------------------|
| City          | `city`        | Single line text         | e.g. "Lisbon"                           |
| IATA code     | `code`        | Single line text         | e.g. "LIS" (used as the join key)       |
| Suggestion tag| `tag`         | Single line text         | e.g. "Your weekly route"                |
| Base price    | `basePrice`   | Number                   | from-price in EUR                       |
| Miles price   | `milesPrice`  | Number (optional)        | award price in miles, blank if none     |
| Emoji         | `emoji`       | Single line text         | e.g. "🌉"                               |
| Image         | `image`       | Content Reference (asset)| DAM image; GraphQL exposes `_publishUrl`. (A plain URL text field also works.) |
| Blurb         | `blurb`       | Multi line text          | short marketing copy                    |
| Region        | `region`      | Single line text         | e.g. "Iberia", "Atlantic"               |
| Affinity      | `affinity`    | Enumeration              | values: football, golf, music, none     |

Notes
- `code` is the stable key the app joins on to overlay personalization (flown/searched/reason). Keep it canonical (IATA).
- Personalization is NOT modelled in AEM — the per-traveller "reason" line is computed by the app from CDP/behaviour and merged after the content is fetched.
