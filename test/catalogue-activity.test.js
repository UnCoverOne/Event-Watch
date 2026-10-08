import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunCatalogueSync } from "../src/index.js";
import { readFileSync } from "node:fs";
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

test("catalogue refresh schedule is fixed and independent of visitor activity", () => {
  assert.equal(shouldRunCatalogueSync(Date.parse("2026-10-07T12:00:00Z")), true);
  assert.equal(shouldRunCatalogueSync(Date.parse("2026-10-07T12:30:00Z")), true);
  assert.equal(shouldRunCatalogueSync(Date.parse("2026-10-07T12:05:00Z")), false);
  assert.equal(shouldRunCatalogueSync(Date.parse("2026-10-07T12:55:00Z")), false);
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"crons":\s*\["\*\/5 \* \* \* \*"\]/);
});
