// Non-persistent D1 metering. D1 .all/.run/.batch include meta.rows_read;
// .first() returns only a record, so count these calls separately. Logs
// deliberately omit SQL, request parameters, identities and bind values.
export function meterD1(db) {
  const originals = new WeakMap();
  const stats = { rowsRead: 0, rowsWritten: 0, measuredCalls: 0, firstCalls: 0 };

  function collect(result) {
    if (!result) return;
    stats.measuredCalls++;
    stats.rowsRead += Number(result.meta?.rows_read || 0);
    stats.rowsWritten += Number(result.meta?.rows_written || 0);
  }

  function statementProxy(statement) {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args) => statementProxy(target.bind(...args));
        if (key === "all" || key === "run")
          return async (...args) => {
            const result = await target[key](...args);
            collect(result);
            return result;
          };
        if (key === "first")
          return async (...args) => {
            stats.firstCalls++;
            return target.first(...args);
          };
        return Reflect.get(target, key);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  }

  const wrappedDb = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (...args) => statementProxy(target.prepare(...args));
      if (key === "batch") return async (items) => {
        const result = await target.batch(items.map(item => originals.get(item) || item));
        for (const entry of result) collect(entry);
        return result;
      };
      return Reflect.get(target, key);
    },
  });
  return { db: wrappedDb, stats };
}

export function recordD1Stats(route, stats) {
  console.info("D1_READ_SAMPLE", JSON.stringify({
    route, ...stats, note: "rowsRead excludes .first() calls; D1 Insights gives full totals",
  }));
}
