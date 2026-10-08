import { syncCatalogue } from "./catalogue.js";
import { handleApi } from "./api.js";
import { runChecks } from "./checker.js";
import { HttpError, json } from "./utils.js";

export function shouldRunCatalogueSync(scheduledTime) {
  const minutes = new Date(scheduledTime).getUTCMinutes();
  return minutes === 0 || minutes === 30;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/"))
        return await handleApi(request, env);
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
        // Watch checks remain every five minutes. Catalogue indexing is
        // independent of visits and limited to one 50-item page per half hour.
        await runChecks(env);
        if (shouldRunCatalogueSync(controller.scheduledTime))
          await syncCatalogue(env);
      })(),
    );
  },
};
