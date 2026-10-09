import test from "node:test";
import assert from "node:assert/strict";
import { meterD1 } from "../src/d1-telemetry.js";

test("metering records D1 rows read without changing prepared-statement behavior", async () => {
  const native = {
    prepare(query) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async all() { return { results: [{ query, bindings }], meta: { rows_read: 17, rows_written: 0 } }; },
        async run() { return { meta: { changes: 1, rows_read: 3, rows_written: 1 } }; },
        async first() { return { query, bindings }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
  const { db, stats } = meterD1(native);
  const rows = await db.prepare("list").bind(12).all();
  assert.deepEqual(rows.results[0], { query: "list", bindings: [12] });
  assert.deepEqual(await db.prepare("one").bind(42).first(), { query: "one", bindings: [42] });
  await db.prepare("write").bind("v").run();
  await db.batch([db.prepare("batch a").bind(1), db.prepare("batch b").bind(2)]);
  assert.deepEqual(stats, { rowsRead: 26, rowsWritten: 3, measuredCalls: 4, firstCalls: 1 });
});
