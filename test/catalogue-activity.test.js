import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  catalogueBrowseActive,
  isCatalogueBrowseRequest,
  markCatalogueBrowseActive,
} from "../src/catalogue-activity.js";

class MemoryCache {
  constructor() { this.rows = new Map(); }
  async put(request, response) { this.rows.set(request.url, response); }
  async match(request) { return this.rows.get(request.url) || undefined; }
}

test("catalogue browsing activity uses cache rather than D1", async () => {
  const cache = new MemoryCache();
  assert.equal(await catalogueBrowseActive(cache), false);
  assert.equal(await markCatalogueBrowseActive(cache), true);
  assert.equal(await catalogueBrowseActive(cache), true);
  assert.equal(
    isCatalogueBrowseRequest(new Request("https://x.test/api/catalogue/events")),
    true,
  );
  assert.equal(
    isCatalogueBrowseRequest(new Request("https://x.test/api/catalogue/stores?view=browse")),
    true,
  );
  assert.equal(
    isCatalogueBrowseRequest(new Request("https://x.test/api/catalogue/events?view=watching")),
    false,
  );
});

test("idle non-watch cron skips D1 catalogue work", async () => {
  const prior = globalThis.caches;
  globalThis.caches = { default: new MemoryCache() };
  try {
    let prepares = 0;
    const env = {
      DB: {
        prepare() {
          prepares++;
          throw new Error("D1 should not be touched while catalogue browsing is idle.");
        },
      },
    };
    let pending;
    worker.scheduled(
      { scheduledTime: Date.parse("2026-10-07T12:01:00Z") },
      env,
      { waitUntil(promise) { pending = promise; } },
    );
    await pending;
    assert.equal(prepares, 0);
  } finally {
    globalThis.caches = prior;
  }
});
