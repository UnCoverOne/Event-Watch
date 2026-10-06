import { syncCatalogue } from './catalogue.js';
import { handleApi } from './api.js';
import { runChecks } from './checker.js';
import { HttpError, json } from './utils.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/catalogue/sources' && ctx) ctx.waitUntil(syncCatalogue(env));
        return await handleApi(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message, code: error.code }, error.status);
      }
      console.error(error);
      return json({ error: 'Internal server error', code: 'internal_error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => { if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) await runChecks(env);
      else await syncCatalogue(env); })());
  },
};
