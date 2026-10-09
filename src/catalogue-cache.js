// Shared Cloudflare Cache API entries contain public catalogue data ONLY.
// Personal subscription flags must always be loaded after a cache hit.
export async function catalogueRevision(env) {
  const row = await env.DB.prepare(
    "SELECT next_allowed_at FROM catalogue_manual_refresh WHERE key = 'global'"
  ).first();
  return row?.next_allowed_at || "initial";
}

export function catalogueCacheKey(namespace, kind, scope, params, revision) {
  const query = new URLSearchParams(params);
  query.sort();
  const key = JSON.stringify({
    namespace, kind,
    sources: [...scope.sources].sort(), country: scope.country, city: scope.city,
    query: query.toString(), revision,
  });
  return new Request("https://event-watch.internal/cache?key=" + encodeURIComponent(key));
}

export async function withPublicCache(cache, key, ttlSeconds, load) {
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return await hit.json();
    } catch (error) {
      console.warn("Public catalogue cache read failed", error.message);
    }
  }
  const data = await load();
  if (cache) {
    try {
      await cache.put(key, Response.json(data, {
        headers: { "Cache-Control": `public, max-age=${ttlSeconds}` },
      }));
    } catch (error) {
      console.warn("Public catalogue cache write failed", error.message);
    }
  }
  return data;
}
