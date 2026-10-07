import { syncCatalogue } from "./catalogue.js";
import { handleApi } from "./api.js";
import { runChecks } from "./checker.js";
import { HttpError, json } from "./utils.js";
import {
  catalogueBrowseActive,
  isCatalogueBrowseRequest,
  markCatalogueBrowseActive,
} from "./catalogue-activity.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        if (isCatalogueBrowseRequest(request))
          ctx.waitUntil(
            markCatalogueBrowseActive().catch((error) =>
              console.error("Could not mark catalogue browsing active", error),
            ),
          );
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
        if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) {
          await runChecks(env);
        } else if (await catalogueBrowseActive()) {
          await syncCatalogue(env);
        }
      })(),
    );
  },
};
