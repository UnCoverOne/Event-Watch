import { syncCatalogue } from "./catalogue.js";
import { currentUser } from './auth.js';
import { browseScope } from './browse-preferences.js';
import { handleApi } from "./api.js";
import { runChecks } from "./checker.js";
import { HttpError, json } from "./utils.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        // Keep initial indexing moving when scheduled triggers are delayed.
        // The shared lease and refresh interval bound work across all visitors.
        if (request.method === "GET" && url.pathname === "/api/catalogue/sources")
          ctx.waitUntil((async () => {
            const scope = await browseScope(env, await currentUser(request, env), url.searchParams);
            if (scope?.sources.length) await syncCatalogue(env, { enabled: scope.sources });
          })().catch((error) => console.error("Background catalogue sync failed", error)));
        return await handleApi(request, env);
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
        if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0)
          await runChecks(env);
        else await syncCatalogue(env);
      })(),
    );
  },
};
