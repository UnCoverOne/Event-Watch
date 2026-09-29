# Event Watch

A minimalist Cloudflare-native service that watches event pages and emails users when registration, booking, tickets, or places appear to become available.

Event Watch is **not tied to one event platform**. Users can paste any public HTTPS event page. The checker uses a site-adapter architecture:

- **Generic adapter** — conservative detection of common registration, booking, ticket, sold-out, closed, and not-yet-open states.
- **Riftbound adapter** — a specialized detector for Riftbound/UVS locator pages, included as the first platform-specific adapter.
- More adapters can be added later without changing accounts, subscriptions, notifications, or the dashboard.

## Stack

- Cloudflare Workers — API, authentication, scheduled checking, and static asset routing
- Cloudflare D1 — users, sessions, events, subscriptions, and notification history
- Cloudflare Cron Triggers — checks watched events every five minutes
- Resend — verification and availability emails
- GitHub Actions — tests and Cloudflare deployment
- Vanilla HTML/CSS/JS — deliberately small frontend

## How monitoring works

1. A signed-in user pastes an HTTPS event-page URL.
2. Event Watch canonicalizes the URL and selects an adapter.
3. The event is stored once even when several users watch it.
4. The Worker checks active events on the cron schedule.
5. Status is classified as `AVAILABLE`, `FULL`, `NOT_OPEN`, `CLOSED`, `UNAVAILABLE`, or `UNKNOWN`.
6. Email is sent only when an event transitions into `AVAILABLE`.

For unknown websites the detector intentionally favors avoiding false positives. A page must expose a clear action control such as **Register**, **Book now**, **Get tickets**, **Reserve a spot**, or **Sign up** before it is classified as available. Pages that render registration exclusively after client-side JavaScript, require authentication, block automated requests, or use unusual wording may need a dedicated adapter.

## Security notes

- Only public HTTPS URLs are accepted.
- Localhost and common private-network IPv4 ranges are rejected to reduce SSRF risk.
- URL credentials are rejected.
- Passwords are salted and hashed with PBKDF2-SHA256.
- Session tokens are random, stored only as SHA-256 hashes, and delivered in `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- Availability notifications are only sent to verified email addresses.
- API mutations enforce same-origin requests.
- The Resend API key belongs in a Cloudflare secret, never in Git.

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

The Cloudflare token needs enough permission to deploy Workers and manage the D1 database used by this app. Pushes to `main` then run tests, apply remote migrations, and deploy.

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
