# Event Watch

A minimalist Cloudflare-native service that watches event pages and local game store listings, then emails users when registration becomes available or a watched LGS adds a new event.

Event Watch is **not tied to one event platform**. Users can paste any public HTTPS event page. The checker uses a site-adapter architecture:

- **Generic adapter** — conservative detection of common registration, booking, ticket, sold-out, closed, and not-yet-open states.
- **Riftbound adapter** — a specialized detector for Riftbound/UVS locator pages, included as the first platform-specific adapter.
- More adapters can be added later without changing accounts, subscriptions, notifications, or the dashboard.

## Stack

- Cloudflare Workers — API, authentication, scheduled checking, and static asset routing
- Cloudflare D1 — users, sessions, events, subscriptions, and notification history
- Cloudflare Cron Triggers — scheduler wakes every five minutes; each watch can use its own refresh interval
- Gmail API — verification and availability emails sent from your Gmail account
- GitHub Actions — tests and Cloudflare deployment
- Vanilla HTML/CSS/JS — deliberately small frontend

## How monitoring works

1. A signed-in user pastes an HTTPS event-page URL.
2. Event Watch canonicalizes the URL and selects an adapter.
3. The event is stored once even when several users watch it.
4. The Worker wakes every five minutes and checks only subscriptions whose selected refresh interval is due.
5. Status is classified as `AVAILABLE`, `FULL`, `NOT_OPEN`, `CLOSED`, `UNAVAILABLE`, or `UNKNOWN`.
6. Alerts are queued during the scheduler run and grouped by user. One digest email is sent after the refresh window, even if several watched items changed.\n7. LGS watches silently record the current listing as a baseline, then alert only for event IDs that appear later.

Each event or LGS watch can use a 5, 10, 15, or 30 minute interval, or 1, 3, 6, 12, or 24 hours. The dashboard defaults to dark mode and stores the user’s light/dark preference locally in the browser. Event Watch batches all alerts discovered in the same scheduler run into one email per user.\n\nFor unknown websites the detector intentionally favors avoiding false positives. A page must expose a clear action control such as **Register**, **Book now**, **Get tickets**, **Reserve a spot**, or **Sign up** before it is classified as available. Pages that render registration exclusively after client-side JavaScript, require authentication, block automated requests, or use unusual wording may need a dedicated adapter.

## Security notes

- Only public HTTPS URLs are accepted.
- Localhost and common private-network IPv4 ranges are rejected to reduce SSRF risk.
- URL credentials are rejected.
- Passwords are salted and hashed with PBKDF2-SHA256.
- Session tokens are random, stored only as SHA-256 hashes, and delivered in `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- Availability notifications are only sent to verified email addresses.
- API mutations enforce same-origin requests.
- Google OAuth client credentials and refresh token belong in Cloudflare secrets, never in Git.

## Local development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Run tests:

```bash
npm test
```

## Cloudflare setup

### 1. Create the D1 database

```bash
npx wrangler d1 create event-watch
```

Copy the returned database ID into `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`.

Apply the schema:

```bash
npx wrangler d1 migrations apply DB --remote
```

### 2. Configure email

Create a Resend account and verify a sending domain. Then change `NOTIFICATION_FROM` in `wrangler.jsonc` to an address on that domain.

Add the API key as a Worker secret:

```bash
npx wrangler secret put RESEND_API_KEY
```

### 3. Deploy

```bash
npm run deploy
```

After the first deploy, set `APP_ORIGIN` in `wrangler.jsonc` to the real Worker/custom-domain origin and deploy again. This is used when generating email-verification links.

### 4. GitHub Actions deployment

The repository includes `.github/workflows/deploy.yml`. Add these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare token needs enough permission to deploy Workers and manage the D1 database used by this app. The deployment workflow is currently manual. Run it from GitHub Actions after the Cloudflare secrets are configured.

## Adding another site-specific adapter

Site logic belongs in `src/`. `src/adapters.js` chooses which detector to use. A new adapter should return the common shape:

```js
{
  title: 'Example event',
  status: 'AVAILABLE',
  reason: 'A registration control is visible.',
  currentPlayers: null,
  capacity: null,
}
```

Prefer structured public APIs or stable server-rendered markup when a platform provides them. Keep platform-specific parsing isolated and add tests for full, closed, not-open, and available states.

## Current limitations

Event Watch performs ordinary HTTP fetching from a Cloudflare Worker; it is not a headless browser. Sites whose availability state only appears after running JavaScript may return `UNAVAILABLE` or an error until a dedicated API/adapter is added. This is intentional: guessing availability would create noisy alerts.


## LGS watch pages

The **LGS pages** dashboard tab currently supports Riftbound Gaming Network store URLs such as:

```
https://locator.riftbound.uvsgames.com/stores/<store-uuid>
```

When a store is first added, Event Watch records the event IDs already present without notifying the user. On later checks, newly observed `/events/<id>` links are treated as new LGS events and queued for the next digest email.

The database objects for this feature are created by `migrations/0003_lgs_watch_and_alert_queue.sql`. The same migration adds the generic alert queue used to batch event-availability and LGS-new-event notifications.


### Notification settings

Signed-in users can open **Settings** on the dashboard to enable or disable email alerts for their account and push alerts for the current browser/device independently. Email stays enabled by default and requires a verified address. Push is opt-in and asks for browser permission only when enabled; **Send test notification** checks delivery. Turning off push or signing out removes that browser subscription. Other subscribed devices remain enabled.

The existing scheduler sends alerts for registration availability and new events on watched LGS pages. Push notifications open the matching Event Watch detail page. Email and each device have separate delivery records, so transient failures retry without repeating successful channel deliveries. Expired push subscriptions are removed automatically.

Migration `0005_notifications.sql` adds notification preferences, device subscriptions, delivery records, and a server-side VAPID signing identity. The Worker generates and persists that identity in D1 on first use; the private key is never returned to clients or committed to source control. No additional provider account or deployment secret is required. Keep the D1 configuration row when migrating the database so existing device subscriptions continue to work.
