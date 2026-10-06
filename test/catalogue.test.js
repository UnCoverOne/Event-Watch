import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { handleApi } from "../src/api.js";
import {
  saveRecord,
  syncCatalogue,
  catalogueStoreEvents,
} from "../src/catalogue.js";
import {
  uvsEvent,
  uvsStore,
  playEvent,
  fetchSourcePage,
  parsePlayEventUrl,
} from "../src/sources.js";
import {
  checkOneEvent,
  checkOneLgs,
  alertIsEligible,
  shouldNotifyAvailability,
} from "../src/checker.js";
import { sha256 } from "../src/utils.js";

const files = readdirSync(new URL("../migrations/", import.meta.url)).sort();
function apply(db, list) {
  for (const name of list)
    db.exec(
      readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
}
async function fixture() {
  const db = new DatabaseSync(":memory:");
  apply(db, files);
  db.exec(
    "INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ('u','u@example.com','hash','2020','2020'), ('v','v@example.com','hash','2020','2020')",
  );
  db.prepare(
    "INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)",
  ).run("session", "u", await sha256("token"), "2099", "2020");
  const env = {
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        let values = [];
        return {
          bind(...v) {
            values = v;
            return this;
          },
          async first() {
            return statement.get(...values) || null;
          },
          async all() {
            return { results: statement.all(...values) };
          },
          async run() {
            return { meta: { changes: statement.run(...values).changes } };
          },
        };
      },
      async batch(statements) {
        return Promise.all(statements.map((s) => s.run()));
      },
    },
  };
  const request = async (path, method = "GET", body, authenticated = true) => {
    const response = await handleApi(
      new Request("https://event-watch.test" + path, {
        method,
        headers: {
          "content-type": "application/json",
          origin: "https://event-watch.test",
          ...(authenticated ? { cookie: "eventwatch_session=token" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
    return response.json();
  };
  return { db, env, request };
}
const raw = (id = 100) => ({
  id,
  name: `Nexus Night ${id}`,
  start_datetime: "2099-10-06T18:00:00Z",
  registered_user_count: 8,
  capacity: 16,
  queue_status: "ACCEPTING_SIGNUPS",
  settings: {
    show_registration_button: true,
    event_lifecycle_status: "SCHEDULED",
  },
  event_status: "SCHEDULED",
  gameplay_format: { name: "Constructed" },
  event_type: "LOCALS",
  cost_in_cents: 0,
  currency: "GBP",
  full_address: "1 High Street, London",
  latitude: 51.5,
  longitude: -0.1,
  store: {
    id: 20,
    name: "Test Games",
    city: "London",
    country: "GB",
    full_address: "1 High Street, London",
    latitude: 51.5,
    longitude: -0.1,
  },
});

test("additive migration preserves existing IDs, intervals and archive state", () => {
  const db = new DatabaseSync(":memory:");
  apply(
    db,
    files.filter((f) => f < "0006"),
  );
  db.exec(
    "INSERT INTO users VALUES ('u','u@x.test','hash',NULL,'2020','2020',1); INSERT INTO events (id,event_key,event_url,created_at,updated_at) VALUES ('e','key','https://example.com/e','2020','2020'); INSERT INTO subscriptions (id,user_id,event_id,active,check_interval_minutes,created_at,updated_at) VALUES ('s','u','e',0,60,'2020','2020');",
  );
  apply(
    db,
    files.filter((f) => f >= "0006"),
  );
  const s = db.prepare("SELECT * FROM subscriptions").get();
  assert.equal(s.id, "s");
  assert.equal(s.archived, 1);
  assert.equal(s.watching, 1);
  assert.equal(s.active, 0);
  assert.equal(s.check_interval_minutes, 60);
  assert.equal(
    db.prepare("SELECT entity_id FROM catalogue_sources").get().entity_id,
    "e",
  );
  db.close();
});
test("guest browsing, combined filters, pagination and literal search", async () => {
  const { env, db, request } = await fixture();
  for (let n = 0; n < 26; n++)
    await saveRecord(env, "event", uvsEvent(raw(100 + n)));
  let data = await request("/api/catalogue/events", "GET", undefined, false);
  assert.equal(data.total, 26);
  assert.equal(data.items.length, 24);
  assert.equal(data.pages, 2);
  data = await request(
    "/api/catalogue/events?page=2&country=GB&format=Constructed&price=free&status=AVAILABLE",
    "GET",
    undefined,
    false,
  );
  assert.equal(data.items.length, 2);
  data = await request("/api/catalogue/events?q=%25", "GET", undefined, false);
  assert.equal(data.total, 0);
  data = await request(
    "/api/catalogue/stores?q=London",
    "GET",
    undefined,
    false,
  );
  assert.equal(data.total, 1);
  await assert.rejects(
    request("/api/catalogue/events?view=bookmarks", "GET", undefined, false),
    (e) => e.status === 401,
  );
  await assert.rejects(
    request("/api/catalogue/events?sort=DROP%20TABLE"),
    (e) => e.status === 400,
  );
  db.close();
});
test("bookmarks, watches, joined and archive are independent and isolated per account", async () => {
  const { env, db, request } = await fixture();
  const id = await saveRecord(env, "event", uvsEvent(raw()));
  const path = `/api/catalogue/event/${id}/state`;
  let { state } = await request(path, "PATCH", { bookmarked: true });
  assert.equal(state.active, 0);
  assert.equal(state.watching, 0);
  ({ state } = await request(path, "PATCH", {
    watching: true,
    check_interval_minutes: 60,
  }));
  assert.equal(state.active, 1);
  assert.equal(state.bookmarked, 1);
  ({ state } = await request(path, "PATCH", { joined: true }));
  assert.equal(state.active, 0);
  assert.equal(state.watching, 1);
  ({ state } = await request(path, "PATCH", { archived: true }));
  assert.equal(state.joined, 1);
  ({ state } = await request(path, "PATCH", { archived: false }));
  assert.equal(state.active, 0);
  ({ state } = await request(path, "PATCH", { joined: false }));
  assert.equal(state.active, 1);
  assert.equal(state.check_interval_minutes, 60);
  db.exec("UPDATE sessions SET user_id='v'");
  assert.equal((await request("/api/catalogue/events?view=watching")).total, 0);
  await request(path, "PATCH", { joined: true });
  assert.equal(
    db.prepare("SELECT active FROM subscriptions WHERE user_id='u'").get()
      .active,
    1,
  );
  await assert.rejects(
    request(path, "PATCH", { watching: "true" }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    request(path, "PATCH", { user_id: "u" }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    request(path, "PATCH", { check_interval_minutes: 6 }),
    (e) => e.status === 400,
  );
  db.close();
});
test("joined and archived events suppress queued direct and store alerts", async () => {
  const { env, db, request } = await fixture();
  const id = await saveRecord(env, "event", uvsEvent(raw()));
  const path = `/api/catalogue/event/${id}/state`;
  const { state } = await request(path, "PATCH", { watching: true });
  db.prepare(
    "INSERT INTO alert_queue (id,user_id,kind,item_key,title,item_url,created_at,subscription_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    "q",
    "u",
    "event_available",
    `${state.id}:a`,
    "Event",
    "https://locator.riftbound.uvsgames.com/events/100",
    "2026",
    state.id,
  );
  await request(path, "PATCH", { joined: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alert_queue").get().n, 0);
  assert.equal(
    await alertIsEligible(env, {
      user_id: "u",
      item_url: "https://locator.riftbound.uvsgames.com/events/100",
    }),
    false,
  );
  await request(path, "PATCH", { joined: false, archived: true });
  assert.equal(
    await alertIsEligible(env, {
      user_id: "u",
      item_url: "https://locator.riftbound.uvsgames.com/events/100",
    }),
    false,
  );
  assert.equal(
    await alertIsEligible(env, {
      user_id: "v",
      item_url: "https://locator.riftbound.uvsgames.com/events/100",
    }),
    true,
  );
  db.close();
});
test("conservative duplicates share one record and personal state across source filters", async () => {
  const { env, db, request } = await fixture();
  const first = uvsEvent(raw());
  const id = await saveRecord(env, "event", first);
  const alternate = {
    ...first,
    source: "play",
    source_id: "p1",
    key: "play:p1",
    url: "https://playriftbound.com/en-US/events/p1",
    adapter: "play",
    status: "FULL",
  };
  const second = await saveRecord(env, "event", alternate);
  assert.equal(second, id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  assert.equal(
    db.prepare("SELECT status FROM events").get().status,
    "AVAILABLE",
  );
  await request(`/api/catalogue/event/${id}/state`, "PATCH", {
    bookmarked: true,
  });
  assert.equal(
    (await request("/api/catalogue/events?view=bookmarks&source=play")).total,
    1,
  );
  const different = await saveRecord(env, "event", {
    ...alternate,
    key: "play:p2",
    source_id: "p2",
    starts_at: "2099-10-07T18:00:00.000Z",
  });
  assert.notEqual(different, id);
  db.close();
});
test("failed source page retains data and cursor; retries are idempotent", async (t) => {
  const { env, db } = await fixture();
  t.mock.method(console, "error", () => {});
  let fail = true;
  t.mock.method(globalThis, "fetch", async () =>
    fail
      ? new Response("", { status: 503 })
      : Response.json({ results: [raw()], next_page_number: 2 }),
  );
  let result = await syncCatalogue(env, { source: "uvs-events", force: true });
  assert.ok(result.error);
  assert.equal(
    db
      .prepare("SELECT cursor FROM catalogue_sync WHERE source='uvs-events'")
      .get().cursor,
    null,
  );
  fail = false;
  await syncCatalogue(env, { source: "uvs-events", force: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  assert.equal(
    db
      .prepare("SELECT cursor FROM catalogue_sync WHERE source='uvs-events'")
      .get().cursor,
    "2",
  );
  db.close();
});
test("Play Riftbound uses its public persisted operation and rejects GraphQL errors", async (t) => {
  let bad = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://playriftbound.com/api/gql");
    const body = JSON.parse(options.body);
    assert.equal(body.operationName, "CompeteTournamentSearch");
    assert.equal(body.variables.filter.rb.distanceMeters, 40075000);
    assert.ok(body.extensions.persistedQuery.sha256Hash);
    return Response.json(
      bad
        ? { errors: [{ message: "Unavailable" }] }
        : {
            data: {
              competeTournamentSearch: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
    );
  });
  assert.deepEqual(await fetchSourcePage("play"), {
    events: [],
    stores: [],
    next: null,
  });
  bad = true;
  await assert.rejects(fetchSourcePage("play"), /Unavailable/);
  assert.equal(
    parsePlayEventUrl("https://playriftbound.com/en-US/events/abc").eventKey,
    "abc",
  );
  assert.throws(() => parsePlayEventUrl("https://evil.test/en-US/events/abc"));
});
test("source status requires explicit availability and respects time and capacity", () => {
  const t = {
    id: "p",
    name: "Event",
    startsAt: "2099-01-01T00:00:00Z",
    registrationPolicy: "OPEN",
    registrantCounts: [
      { status: "REGISTERED", count: 4 },
      { status: "WAITLISTED", count: 2 },
    ],
    config: { participantCapacity: 8 },
  };
  assert.equal(playEvent(t, null, false).status, "UNKNOWN");
  assert.equal(playEvent(t, null, true).status, "AVAILABLE");
  assert.equal(
    playEvent({ ...t, registrationStartAt: "2098-01-01T00:00:00Z" }, null, true)
      .status,
    "NOT_OPEN",
  );
  assert.equal(
    playEvent({ ...t, registrationPolicy: "CLOSED" }, null, true).status,
    "CLOSED",
  );
  assert.equal(
    playEvent({ ...t, config: { participantCapacity: 4 } }, null, true).status,
    "FULL",
  );
  assert.equal(
    uvsEvent({
      ...raw(),
      settings: {
        event_lifecycle_status: "EVENT_FINISHED",
        show_registration_button: true,
      },
    }).status,
    "CLOSED",
  );
  assert.equal(uvsEvent({ ...raw(), queue_status: null }).status, "UNKNOWN");
  assert.equal(
    shouldNotifyAvailability(
      { last_seen_status: "FULL", notify_slots: 0 },
      "AVAILABLE",
    ),
    false,
  );
  assert.equal(
    shouldNotifyAvailability(
      { last_seen_status: "NOT_OPEN", notify_open: 1 },
      "AVAILABLE",
    ),
    true,
  );
});
test("checks do not notify or poll joined/archived items, and a real vacancy alerts once", async (t) => {
  const { env, db, request } = await fixture();
  const id = await saveRecord(
    env,
    "event",
    uvsEvent({ ...raw(), registered_user_count: 16 }),
  );
  await request(`/api/catalogue/event/${id}/state`, "PATCH", {
    watching: true,
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(raw());
  });
  let event = db.prepare("SELECT * FROM events WHERE id=?").get(id);
  let result = await checkOneEvent(env, event);
  assert.equal(result.alertsQueued, 1);
  assert.equal(calls, 1);
  result = await checkOneEvent(env, event, {
    subscriptionId: db.prepare("SELECT id FROM subscriptions").get().id,
  });
  assert.equal(result.alertsQueued, 0);
  await request(`/api/catalogue/event/${id}/state`, "PATCH", { joined: true });
  result = await checkOneEvent(env, event);
  assert.equal(result.skipped, true);
  assert.equal(calls, 2);
  db.close();
});
test("store watchers baseline existing listings, notify only new events, and archive stops checks", async (t) => {
  const { env, db, request } = await fixture();
  const store = uvsStore({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    store: raw().store,
  });
  const id = await saveRecord(env, "store", store);
  const { state } = await request(`/api/catalogue/store/${id}/state`, "PATCH", {
    watching: true,
  });
  let records = [raw()];
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ results: records, next_page_number: null }),
  );
  const item = db.prepare("SELECT * FROM lgs_stores WHERE id=?").get(id);
  let result = await checkOneLgs(env, item, { subscriptionId: state.id });
  assert.equal(result.alertsQueued, 0);
  assert.equal(result.listedEvents, 1);
  records = [raw(), raw(101)];
  result = await checkOneLgs(env, item, { subscriptionId: state.id });
  assert.equal(result.alertsQueued, 1);
  await request(`/api/catalogue/store/${id}/state`, "PATCH", {
    archived: true,
  });
  result = await checkOneLgs(env, item, { subscriptionId: state.id });
  assert.equal(result.skipped, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM alert_queue").get().n, 0);
  db.close();
});

test("legacy display dates become sortable and past listings leave upcoming browse", async () => {
  const db = new DatabaseSync(":memory:");
  apply(
    db,
    files.filter((f) => f < "0007"),
  );
  db.prepare(
    "INSERT INTO events (id,event_key,event_url,event_date,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(
    "past",
    "past",
    "https://example.com/past",
    "Oct 1, 2026",
    "2026",
    "2026",
  );
  db.prepare(
    "INSERT INTO events (id,event_key,event_url,event_date,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(
    "future",
    "future",
    "https://example.com/future",
    "Oct 8, 2026",
    "2026",
    "2026",
  );
  apply(
    db,
    files.filter((f) => f >= "0007"),
  );
  assert.equal(
    db.prepare("SELECT starts_at FROM events WHERE id='past'").get().starts_at,
    "2026-10-01T00:00:00.000Z",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT id FROM events WHERE starts_at >= '2026-10-06' ORDER BY starts_at",
      )
      .all()
      .map((r) => r.id),
    ["future"],
  );
  db.close();
});

test("catalogue imports skip a leased source so other sources can progress", async (t) => {
  const { db, env } = await fixture();
  db.prepare("UPDATE catalogue_sync SET lease_until = ? WHERE source != 'uvs-stores'").run(new Date(Date.now() + 300000).toISOString());
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ results: [], next_page_number: null })));
  const result = await syncCatalogue(env);
  assert.equal(result.source, "uvs-stores");
  assert.equal(result.count, 0);
});

test("source requests use Workers-compatible manual redirects and reject redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response("", {
      status: 302,
      headers: { location: "https://unexpected.example/" },
    });
  });
  await assert.rejects(fetchSourcePage("uvs-events"), /HTTP 302/);
});
