# Event Watch

A Cloudflare-hosted event browsing and monitoring client. Choose your event websites and location before browsing. Sign in to sync your setup, bookmarks, watches, joined events and archives across devices.

## Features

- User-managed sources: add/remove UVS / Riftbound Gaming Network and Play Riftbound through **Sources & location**, by website URL or connector button. Accounts start with no sources enabled.
- Required country choice (including an explicit Worldwide option) and optional city, saved to the account or locally for guests. No browse requests before setup. Removing all sources pauses browsing.
- Events and stores, source filters, country and location search, event dates, format, event type, availability and entry fee filters; paginated date, name, location and recently-added sorting.
- Public detail pages and internal navigation from stores to their events.
- Independent bookmarks and watches. Joining an event pauses its availability alerts. Archiving an item pauses its notifications while preserving its other settings.
- Event watches for registration openings and places becoming available; store watches for newly discovered events.
- Account email preferences and opt-in push notifications on each device.
- Existing accounts, watched links and archives migrate in place. Other public HTTPS event links can still be added manually through the generic adapter.
- Installable PWA, dark/light themes and responsive layouts.

## Source adapters and freshness

Source connectors are supported integrations, not automatically enabled account subscriptions. Arbitrary websites still need a connector; unsupported source URLs show an explanation instead of being silently imported. Personal source/location preferences constrain browse queries on the server. They do not hide existing bookmarks, watches or archives, nor change notification subscriptions.

Startup loads account/setup information in one request, then requests only the selected catalogue scope. Filter metadata and source freshness load independently. Country indexes avoid scanning unrelated regions; client result pages are cached for 30 seconds and metadata for 60 seconds. Refresh bypasses those caches, and changing saved item state invalidates result pages. Superseded search requests are cancelled. Browsing, catalogue details and store-event detail pages read existing indexed records without automatically importing or updating them. There are **no scheduled catalogue imports**. Only the Browse **Refresh** action discovers catalogue records, for the configured country/city and sources. Public Browse result pages and their exact totals are cached for two minutes (repeated requests skip the expensive catalogue scans). The response cache contains no personal fields: each signed-in user's Save/Watch/Join/Archive flags are loaded separately for the visible page. Shared Browse facet metadata is cached for six hours; both caches use a manual-Refresh revision key to invalidate after new imports. Personal Collection results and filter metadata are never shared. Cache API storage is local to a Cloudflare location and misses can still query D1. Manual Refresh is globally limited to one operation per 30 minutes using a D1-backed cooldown; UVS progresses through bounded source pages tracked separately per selected region and filters items **before** database writes. Play Riftbound uses bounded location searches, filtered to the selected region. Choosing Worldwide explicitly permits a global search. The UVS source's public listing endpoint has no verified geographical query contract, so regional Refresh may need multiple presses over time to reach events outside the first source pages. Direct watch checks retain their own intervals. Explicitly adding a link to your collection may still create and enrich that particular record.

`src/sources.js` contains the two structured public integrations:

- UVS: paginated `/api/v2/events/` and `/api/v2/game-stores/` via the existing public Hydra proxy, with individual event/store refreshes.
- Play Riftbound: the website's public persisted GraphQL operations for tournament search, tournament details and organizer summaries. The operation IDs were inspected on 2026-10-06. This is not an account-linking integration. Changes to upstream persisted operations require updating the IDs and adapter tests.

Play Riftbound stores are discovered from event listings; the public integration does not provide a separate complete store directory. Watched Play stores are checked directly against Play's tournament search around the organizer location and filtered by exact organizer ID, so their notifications no longer depend on catalogue progress. Search listings do not prove registration is open: individual event checks use registration policy, opening/closing times and capacity. Unknown information is shown as unknown.

`src/catalogue.js` supplies record deduplication for manual imports. D1 stores region-specific page cursors for UVS so repeat manual Refresh actions can continue discovery without resetting global import progress. **Sources & freshness** reports the selected region's last manual Refresh rather than an automatic indexer. Import failure preserves existing records. All watched events and stores are checked independently at the selected watch interval. UVS store watches now read the external store event listing **without importing it into the shared catalogue**; Play store watches use direct organizer-filtered tournament searches. Watch status and notification baseline writes are separate from general catalogue discovery. Manually added links remain explicit user-initiated additions and can be resolved individually.

Exact source IDs/URLs are deduplicated. Listings from different sources are merged only when the normalized name and full address match (and, for events, the exact start time and host also match). Alternate source links remain available. Incomplete metadata can leave duplicates separate rather than merging unrelated events.

## Personal state and notifications

The main navigation has two destinations: **Browse** and **Collection**. Collection combines watched, bookmarked, joined and archived items in one list. Watched, Bookmarked and Joined are shown by default; Archived is hidden until its chip is enabled. Event collections default to upcoming items sorted by soonest date, while the existing Time filter can include past events. Stores use the same Collection chips except Joined, which only applies to events.

The shared catalogue is separate from each user's subscriptions. `bookmarked`, `watching`, `joined` (events only) and `archived` are independent flags. The existing `active` flag represents notification eligibility:

- Event: watching and not joined and not archived.
- Store: watching and not archived.

Bookmarks never enable monitoring. Restore keeps prior watch/joined settings. Archiving a store does not change individually watched events. A joined or archived event is also excluded from new-event alerts originating from a store watch.

The scheduler wakes every five minutes for due watches and notification delivery. Due events/stores are selected using covering subscription indexes before fetching those particular records, and an unsent-alert index supports notification delivery. It **never imports the catalogue**, even at minute 0 and 30. Browsing, searches and detail views do not trigger catalogue updates. Supported watch intervals remain 5, 10, 15, 30, 60, 180, 360, 720 and 1440 minutes. Store watches silently establish an initial baseline and alert only on subsequent new IDs. Joined, unwatched and archived items discard pending direct alerts; delivery rechecks eligibility. Email digests and push deliveries retain separate retry records.

Email alerts require email verification. Push requires browser permission and is enabled per device. Signing out disables that device's subscription. Marking Joined is manual and does not register the user on the source website.

## D1 usage monitoring

API requests are sampled at 10% and every scheduled watch run emits a `D1_READ_SAMPLE` Worker log with the route family, `rowsRead`, `rowsWritten`, and call counts. This is non-persistent telemetry: it never writes monitoring rows to D1, never logs SQL bindings or personal data, and avoids adding cost. D1's `.first()` method does not expose read metadata, so logged `rowsRead` is a **lower bound**; use Cloudflare D1 Insights for complete account-level metrics. Savings depend on traffic, cache-hit rates and query plans, and must be verified after deployment.

## Development

Requires Node 22.22.2 or newer (tests use `node:sqlite`).

```sh
npm ci
npm run db:migrate:local
npm run dev
npm test
npx wrangler deploy --dry-run
```

The app uses Workers, D1, Cron Triggers and plain HTML/CSS/JavaScript. There is no frontend build step. Tests cover migration preservation, source parsing and pagination, saved-state isolation, notification suppression, store baselines, account settings, push delivery and PWA assets.

## Deployment

Pushes to `main` run `.github/workflows/deploy.yml`: install dependencies, run tests, apply D1 migrations only when `migrations/` changed, then deploy the Worker and assets. The existing GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are required. Manual `workflow_dispatch` is also supported.

```sh
npm run db:migrate:remote
npm run deploy
```

Keep the existing D1 binding and `APP_ORIGIN` in `wrangler.jsonc`. Migrations through `0012_query_read_optimizations.sql` are additive and preserve existing primary keys, account credentials, sessions, refresh intervals and archived watches. `0010` adds targeted lookup indexes and a single-row global cooldown for manual catalogue imports. Never replace the production database with a new empty one.

Before a production migration, retain a D1 backup / Time Travel recovery point. To recover a failed release, redeploy the previous Worker version; if reverting database changes is necessary, restore the matching database recovery point. The old interface does not understand bookmark-only or joined records, so a rollback after users have begun using the new states requires care rather than continued use of the old dashboard.

## Email and push setup

Email uses the Gmail API. Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` as Worker secrets; `GMAIL_SENDER_EMAIL`, `GMAIL_FROM_NAME` and `APP_ORIGIN` are configured in Wrangler. `npm run gmail:authorize` supports obtaining a Gmail refresh token. Never commit credentials.

Web Push uses a server-generated VAPID identity in D1. Keep the existing `push_config` row and device subscriptions when migrating; replacing the signing identity invalidates existing subscriptions. No separate push-provider account is required.

## Security and extension points

Passwords use salted PBKDF2-SHA256; session tokens are hashed in D1 and sent using HttpOnly, Secure, SameSite=Lax cookies. Saved-item mutations require authentication and same-origin requests. Personal state is joined to catalogue queries only for the authenticated user. Source text is escaped and registration remains on the original website.

Add new integrations in `src/sources.js` / `src/adapters.js`, normalize into the existing catalogue fields and add source-specific tests. Generic HTTPS pages use conservative HTML detection; client-only or authenticated pages may remain unknown and need a dedicated supported adapter.
