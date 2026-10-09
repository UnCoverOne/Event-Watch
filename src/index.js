import { handleApi } from "./api.js";
import { runChecks } from "./checker.js";
import { HttpError, json } from "./utils.js";
import { meterD1, recordD1Stats } from "./d1-telemetry.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        // Sample 1 in 10 API requests; avoid additional D1 reads for metrics.
        if (Math.random() >= 0.1) return await handleApi(request, env);
        const meter = meterD1(env.DB);
        try {
          return await handleApi(request, { ...env, DB: meter.db });
        } finally {
          // Only route family is logged, never search queries, IDs or user data.
          const route = "/" + url.pathname.split("/").filter(Boolean).slice(0, 3)
            .map(part => /^[0-9a-f-]{20,}$/i.test(part) ? ":id" : part).join("/");
          recordD1Stats(route, meter.stats);
        }
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message, code: error.code }, error.status);
      }
      console.error(error);
      return json(
        { error: "Internal server error", code: "internal_error" },
        500,
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // Only existing watches are checked automatically.
        // Catalogue discovery and imports require an explicit Refresh action.
        const meter = meterD1(env.DB);
        try {
          await runChecks({ ...env, DB: meter.db });
        } finally {
          recordD1Stats("scheduled-watch-checks", meter.stats);
        }
      })(),
    );
  },
};
