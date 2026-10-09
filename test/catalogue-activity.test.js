import test from "node:test";
import assert from "node:assert/strict";
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

test("scheduled Worker checks watches but never imports the catalogue", () => {
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(index, /await runChecks\(\{ \.\.\.env, DB: meter\.db \}\)/);
  assert.doesNotMatch(index, /syncCatalogue|shouldRunCatalogueSync/);
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"crons":\s*\["\*\/5 \* \* \* \*"\]/);
});
