const ACTIVITY_URL = "https://event-watch.internal/catalogue-browse-active";
export const CATALOGUE_ACTIVITY_SECONDS = 15 * 60;

function defaultCache() {
  return globalThis.caches?.default || null;
}

export async function markCatalogueBrowseActive(cache = defaultCache()) {
  if (!cache) return false;
  await cache.put(
    new Request(ACTIVITY_URL),
    new Response("1", {
      headers: {
        "cache-control": `public, max-age=${CATALOGUE_ACTIVITY_SECONDS}`,
      },
    }),
  );
  return true;
}

export async function catalogueBrowseActive(cache = defaultCache()) {
  if (!cache) return false;
  return Boolean(await cache.match(new Request(ACTIVITY_URL)));
}

export function isCatalogueBrowseRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (!/^\/api\/catalogue\/(events|stores)$/.test(url.pathname)) return false;
  return (url.searchParams.get("view") || "browse") === "browse";
}
