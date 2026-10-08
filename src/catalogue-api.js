import { currentUser, requireUser } from "./auth.js";
import { HttpError, json, nowIso, readJson, uuid } from "./utils.js";
import {
  normalizeEventUrl,
  normalizeLgsUrl,
  fetchEvent,
  fetchLgsStore,
} from "./adapters.js";
import {
  catalogueStoreEvents,
  mergeCatalogueStores,
  refreshCatalogueItem,
  sameStoreIdentity,
  saveRecord,
  syncCatalogue,
} from "./catalogue.js";
import { fetchPlayStoreEvents, playEvent, playQuery } from "./sources.js";
import { normalizeCheckInterval } from "./schedule.js";
import { CONNECTORS, getPreferences, savePreferences, browseScope, scopeConditions } from './browse-preferences.js';

const KINDS = {
  event: ["events", "subscriptions", "event_id"],
  store: ["lgs_stores", "lgs_subscriptions", "store_id"],
};

// Each occurrence of a query parameter represents another selected filter value.
function facetValues(params, key) {
  return [...new Set(params.getAll(key).map(value => value.trim()).filter(Boolean))].slice(0, 50);
}
function addFacet(where, args, field, values) {
  if (!values.length) return;
  // Feed values may spell a format/type with spaces or underscores. Match both.
  const column = ["format", "category"].includes(field)
    ? `REPLACE(e.${field}, '_', ' ')`
    : `e.${field}`;
  where.push(`${column} COLLATE NOCASE IN (${values.map(() => "?").join(",")})`);
  args.push(...values.map(value =>
    ["format", "category"].includes(field) ? value.replaceAll("_", " ") : value));
}


function countryNames(code) {
  if (code === "*") return [];
  const names = [code];
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    if (name && name !== code) names.push(name);
  } catch {}
  if (code === "GB") names.push("UK", "United Kingdom");
  if (code === "US") names.push("USA", "United States", "United States of America");
  return [...new Set(names)];
}

function cityMatches(actual, wanted) {
  if (!wanted) return true;
  return String(actual || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .includes(
      String(wanted)
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase(),
    );
}

const placeKey = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function pointDistanceKm(a, b) {
  const toRad = (n) => (Number(n) * Math.PI) / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.longitude) - toRad(a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function knownScopeLocations(env, scope) {
  if (scope.country === "*") return { cities: new Map(), points: [] };

  const countries = countryNames(scope.country);
  const marks = countries.map(() => "?").join(",");
  const rows =
    (
      await env.DB.prepare(
        `SELECT city, AVG(latitude) AS latitude, AVG(longitude) AS longitude FROM events
         WHERE country IN (${marks}) AND city IS NOT NULL AND city <> ''
         GROUP BY city
         UNION ALL
         SELECT city, AVG(latitude) AS latitude, AVG(longitude) AS longitude FROM lgs_stores
         WHERE country IN (${marks}) AND city IS NOT NULL AND city <> ''
         GROUP BY city
         LIMIT 160`,
      )
        .bind(...countries, ...countries)
        .all()
    ).results || [];

  const cities = new Map();
  const points = [];
  for (const row of rows) {
    const key = placeKey(row.city);
    if (key && !cities.has(key)) cities.set(key, row.city);
    if (
      row.latitude != null && row.longitude != null &&
      Number.isFinite(Number(row.latitude)) &&
      Number.isFinite(Number(row.longitude))
    )
      points.push({
        city: row.city || null,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      });
  }
  return { cities, points };
}

function inferPlayScope(record, scope, known) {
  if (scope.country === "*" || record.country) return record;

  let matchedCity = null;
  const city = placeKey(record.city);
  if (city && known.cities.has(city)) matchedCity = known.cities.get(city);

  if (
    !matchedCity &&
    Number.isFinite(Number(record.latitude)) &&
    Number.isFinite(Number(record.longitude))
  ) {
    let nearest = null;
    for (const point of known.points) {
      const distance = pointDistanceKm(record, point);
      if (!nearest || distance < nearest.distance)
        nearest = { ...point, distance };
    }
    if (nearest && nearest.distance <= 25)
      matchedCity = record.city || nearest.city || null;
  }

  if (!matchedCity && scope.city && cityMatches(record.city, scope.city))
    matchedCity = record.city || scope.city;
  if (!matchedCity && !city) return record;
  if (!matchedCity && city && !known.cities.has(city)) return record;

  const inferredCity = record.city || matchedCity || null;
  return {
    ...record,
    city: inferredCity,
    country: scope.country,
    store: record.store
      ? {
          ...record.store,
          city: record.store.city || inferredCity,
          country: scope.country,
        }
      : record.store,
  };
}

function storeQuality(store) {
  return (
    Number(Boolean(store.address)) * 4 +
    Number(Boolean(store.city)) * 2 +
    Number(
      Number.isFinite(Number(store.latitude)) &&
        Number.isFinite(Number(store.longitude)),
    ) * 2 +
    Number(Boolean(store.country))
  );
}

async function reconcileStoreDuplicates(env, scope) {
  if (scope.country === "*") return { merged: 0 };

  const countries = countryNames(scope.country);
  const marks = countries.map(() => "?").join(",");
  const stores =
    (
      await env.DB.prepare(
        `SELECT e.*,
          (SELECT COUNT(*) FROM lgs_subscriptions s WHERE s.store_id = e.id) AS saved_count,
          (SELECT COUNT(*) FROM catalogue_sources cs WHERE cs.kind = 'store' AND cs.entity_id = e.id) AS source_count
         FROM lgs_stores e
         WHERE e.country IN (${marks})
         ORDER BY e.title COLLATE NOCASE, e.id
         LIMIT 75`,
      )
        .bind(...countries)
        .all()
    ).results || [];

  let merged = 0;
  const removed = new Set();

  for (let i = 0; i < stores.length; i++) {
    if (removed.has(stores[i].id)) continue;
    for (let j = i + 1; j < stores.length; j++) {
      if (removed.has(stores[j].id)) continue;
      if (!sameStoreIdentity(stores[i], stores[j])) continue;

      const a = stores[i];
      const b = stores[j];
      const scoreA =
        Number(a.saved_count || 0) * 100 +
        Number(a.source_count || 0) * 20 +
        storeQuality(a);
      const scoreB =
        Number(b.saved_count || 0) * 100 +
        Number(b.source_count || 0) * 20 +
        storeQuality(b);
      const keep = scoreA >= scoreB ? a : b;
      const drop = keep.id === a.id ? b : a;

      await mergeCatalogueStores(env, keep.id, drop.id);
      removed.add(drop.id);
      merged++;

      if (drop.id === stores[i].id) {
        stores[i] = keep;
        break;
      }
    }
  }

  return { merged };
}

function averagePoint(points) {
  if (!points.length) return null;
  return {
    latitude:
      points.reduce((sum, point) => sum + Number(point.latitude), 0) /
      points.length,
    longitude:
      points.reduce((sum, point) => sum + Number(point.longitude), 0) /
      points.length,
  };
}

function playRegionalAnchors(scope, known, request) {
  const maxDistanceMeters = 160934; // Riot UI maximum: 100 miles.
  const coverageKm = 135;
  const validPoints = known.points.filter(
    (point) =>
      Number.isFinite(Number(point.latitude)) &&
      Number.isFinite(Number(point.longitude)),
  );

  if (scope.city) {
    const city = placeKey(scope.city);
    const matches = validPoints.filter(
      (point) => placeKey(point.city) === city,
    );
    const anchor = averagePoint(matches.length ? matches : validPoints);
    if (anchor)
      return { anchors: [anchor], distanceMeters: maxDistanceMeters };
  }

  const byCity = new Map();
  for (const point of validPoints) {
    const key =
      placeKey(point.city) ||
      `${Number(point.latitude).toFixed(2)},${Number(point.longitude).toFixed(2)}`;
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(point);
  }
  const candidates = [...byCity.values()]
    .map(averagePoint)
    .filter(Boolean);

  const anchors = [];
  for (const candidate of candidates) {
    if (
      anchors.every(
        (anchor) => pointDistanceKm(candidate, anchor) > coverageKm,
      )
    )
      anchors.push(candidate);
    if (anchors.length >= 20) break;
  }

  const cf = request.cf || {};
  if (
    String(cf.country || "").toUpperCase() === scope.country &&
    Number.isFinite(Number(cf.latitude)) &&
    Number.isFinite(Number(cf.longitude))
  ) {
    const point = {
      latitude: Number(cf.latitude),
      longitude: Number(cf.longitude),
    };
    if (
      anchors.every((anchor) => pointDistanceKm(point, anchor) > coverageKm)
    )
      anchors.unshift(point);
  }

  return {
    anchors: anchors.slice(0, 20),
    distanceMeters: maxDistanceMeters,
  };
}

async function safeSyncCatalogue(env, options) {
  try {
    return await syncCatalogue(env, options);
  } catch (error) {
    console.error("Catalogue refresh failed", options.source, error.message);
    return { source: options.source, error: error.message };
  }
}

async function refreshPlayRegion(env, scope, request) {
  if (scope.country === "*") return null;

  const knownLocations = await knownScopeLocations(env, scope);
  const cf = request.cf || {};
  if (String(cf.country || "").toUpperCase() === scope.country) {
    if (cf.city) {
      const key = placeKey(cf.city);
      if (key && !knownLocations.cities.has(key))
        knownLocations.cities.set(key, cf.city);
    }
    if (
      Number.isFinite(Number(cf.latitude)) &&
      Number.isFinite(Number(cf.longitude))
    )
      knownLocations.points.unshift({
        city: cf.city || null,
        latitude: Number(cf.latitude),
        longitude: Number(cf.longitude),
      });
  }

  let { anchors, distanceMeters } = playRegionalAnchors(
    scope,
    knownLocations,
    request,
  );
  let broadFallback = false;
  if (!anchors.length) {
    // Bootstrap a country/city whose stores are not indexed yet. Play requires
    // coordinates, but accepts a world-scale radius; scope filtering below
    // ensures only relevant records are written.
    anchors = [{ latitude: 0, longitude: 0 }];
    distanceMeters = 40075000;
    broadFallback = true;
  }

  const seenTournamentIds = new Set();
  let imported = 0;
  let scanned = 0;
  let inferred = 0;
  let pages = 0;
  // Mark partial coverage when more anchors exist than the per-request budget.
  let complete = anchors.length <= 2;
  const at = nowIso();

  for (const anchor of anchors.slice(0, 2)) {
    let after = null;
    let anchorComplete = false;

    for (let anchorPage = 0; anchorPage < 2; anchorPage++) {
      const data = await playQuery("CompeteTournamentSearch", {
        sport: "rb",
        filter: { rb: { coords: anchor, distanceMeters } },
        sortBy: {},
        first: 50,
        ...(after ? { after } : {}),
      });

      const listing = data.competeTournamentSearch;
      if (!Array.isArray(listing?.edges) || !listing.pageInfo)
        throw new Error("Invalid Play Riftbound listing.");

      for (const edge of listing.edges) {
        const tournament = edge.node?.tournament;
        const organizer = edge.node?.organizer;
        if (!tournament || !organizer) continue;

        const tournamentId = String(tournament.id || "");
        if (!tournamentId || seenTournamentIds.has(tournamentId)) continue;
        seenTournamentIds.add(tournamentId);
        scanned++;

        let record = playEvent(tournament, organizer);
        const originalCountry = record.country;
        record = inferPlayScope(record, scope, knownLocations);
        if (!originalCountry && record.country) inferred++;

        if (record.country !== scope.country) continue;
        if (!cityMatches(record.city, scope.city)) continue;

        await saveRecord(env, "event", record, at);
        imported++;
      }

      pages++;
      if (!listing.pageInfo.hasNextPage) {
        anchorComplete = true;
        break;
      }

      const next = listing.pageInfo.endCursor;
      if (!next || next === after)
        throw new Error("Invalid Play Riftbound pagination.");
      after = next;
    }

    if (!anchorComplete) complete = false;
  }

  try {
    await env.DB.prepare(
      "UPDATE catalogue_sync SET last_checked_at = ?, last_error = NULL WHERE source = 'play'",
    )
      .bind(at)
      .run();
  } catch (error) {
    console.error("Could not update Play source status", error.message);
  }

  return {
    source: "play",
    count: imported,
    scanned,
    inferred,
    anchors: Math.min(anchors.length, 2),
    pages,
    complete,
    regional: true,
    broadFallback,
  };
}

async function scopedUvsStores(env, scope) {
  const where = ["e.source = 'uvs'"];
  const args = [];

  if (scope.country !== "*") {
    const countries = countryNames(scope.country);
    where.push(`e.country IN (${countries.map(() => "?").join(",")})`);
    args.push(...countries);
  }
  if (scope.city) {
    where.push("e.city LIKE ?");
    args.push(`%${scope.city}%`);
  }

  return (
    (
      await env.DB.prepare(
        `SELECT e.* FROM lgs_stores e
         WHERE ${where.join(" AND ")}
         ORDER BY e.title COLLATE NOCASE
         LIMIT 6`,
      )
        .bind(...args)
        .all()
    ).results || []
  );
}

async function refreshUvsRegion(env, scope) {
  const refreshed = [];

  // Advance the shared catalogue a little, but do not hammer D1 with dozens
  // of global pages in a single user request.
  for (const source of ["uvs-stores", "uvs-stores", "uvs-events"]) {
    const result = await safeSyncCatalogue(env, {
      source,
      force: true,
      enabled: scope.sources,
    });
    refreshed.push(result);
    if (result.error) break;
  }

  let stores = [];
  try {
    stores = await scopedUvsStores(env, scope);
  } catch (error) {
    refreshed.push({ source: "uvs-region", error: error.message });
    return refreshed;
  }

  let refreshedStores = 0;
  let visibleEvents = 0;
  const errors = [];

  // Store event endpoints are the authoritative UVS listing for a store and
  // are much cheaper than writing hundreds of unrelated global records.
  for (const store of stores) {
    try {
      const events = await catalogueStoreEvents(env, store, { refresh: true, maxPages: 1, resultLimit: 150 });
      refreshedStores++;
      visibleEvents += events.filter(
        (event) =>
          (scope.country === "*" ||
            countryNames(scope.country).includes(event.country)) &&
          cityMatches(event.city, scope.city),
      ).length;
    } catch (error) {
      errors.push(`${store.title}: ${error.message}`);
    }
  }

  refreshed.push({
    source: "uvs-region",
    stores: refreshedStores,
    events: visibleEvents,
    ...(errors.length ? { error: errors.slice(0, 3).join("; ") } : {}),
  });
  return refreshed;
}

export async function handleCatalogueApi(request, env) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === '/api/catalogue/preferences') {
    if (method === 'GET') {
      const user = await currentUser(request, env);
      return json({ user, preferences: await getPreferences(env, user), connectors: CONNECTORS });
    }
    if (method === 'PUT') {
      const user = await requireUser(request, env);
      return json({ preferences: await savePreferences(env, user, await readJson(request)) });
    }
  }
  if (method === "POST" && path === "/api/catalogue/refresh") {
    const scope = await browseScope(
      env,
      await currentUser(request, env),
      url.searchParams,
    );
    if (!scope?.sources.length)
      return json({ refreshed: [], setup_required: true });

    // Every manual refresh shares one D1-backed global 30-minute cooldown.
    // This prevents anonymous scope/city variation from bypassing the budget.
    const now = nowIso();
    const nextAllowed = new Date(Date.now() + 30 * 60_000).toISOString();
    const lease = await env.DB.prepare(
      "UPDATE catalogue_manual_refresh SET next_allowed_at = ? WHERE key = 'global' AND next_allowed_at <= ?"
    ).bind(nextAllowed, now).run();
    if (!lease.meta?.changes)
      return json({ refreshed: [], rate_limited: true, retry_after_seconds: 1800 });

    const refreshed = [];

    if (scope.sources.includes("uvs"))
      refreshed.push(...(await refreshUvsRegion(env, scope)));

    if (scope.sources.includes("play")) {
      try {
        const regional = await refreshPlayRegion(env, scope, request);
        if (regional) refreshed.push(regional);
        else
          refreshed.push(
            await safeSyncCatalogue(env, {
              source: "play",
              force: true,
              enabled: scope.sources,
            }),
          );
      } catch (error) {
        const at = nowIso();
        try {
          await env.DB.prepare(
            "UPDATE catalogue_sync SET last_error = ?, last_checked_at = ? WHERE source = 'play'",
          )
            .bind(String(error.message).slice(0, 400), at)
            .run();
        } catch (statusError) {
          console.error("Could not store Play source error", statusError.message);
        }
        refreshed.push({ source: "play", error: error.message });
      }
    }

    if (scope.sources.includes("uvs") && scope.sources.includes("play")) {
      try {
        const stores = await reconcileStoreDuplicates(env, scope);
        if (stores.merged)
          refreshed.push({ source: "store-identity", merged: stores.merged });
      } catch (error) {
        console.error("Store reconciliation failed", error.message);
        refreshed.push({ source: "store-identity", error: error.message });
      }
    }

    return json({ refreshed });
  }
  if (method === "GET" && path === "/api/catalogue/sources") {
    const scope = await browseScope(env, await currentUser(request, env), url.searchParams);
    if (!scope?.sources.length) return json({ sources: [] });
    const sources =
      (
        await env.DB.prepare(
          "SELECT source, cursor, last_checked_at, last_completed_at, last_error FROM catalogue_sync",
        ).all()
      ).results || [];
    return json({ sources: sources.filter(s => scope.sources.includes(s.source === 'play' ? 'play' : 'uvs')) });
  }
  if (method === "POST" && path === "/api/catalogue/resolve") {
    await requireUser(request, env);
    const body = await readJson(request),
      kind = body.kind;
    if (!KINDS[kind]) throw new HttpError(400, "Choose an event or store.");
    let parsed;
    try {
      parsed =
        kind === "event"
          ? await normalizeEventUrl(body.url)
          : normalizeLgsUrl(body.url);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const [table] = KINDS[kind],
      key = kind === "event" ? "event_key" : "store_key",
      link = kind === "event" ? "event_url" : "store_url";
    const sourceKey = parsed.eventKey || parsed.storeKey;
    const alias = await env.DB.prepare(
      "SELECT entity_id FROM catalogue_sources WHERE kind = ? AND source_key = ?",
    )
      .bind(kind, sourceKey)
      .first();
    let item = alias
      ? await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
          .bind(alias.entity_id)
          .first()
      : await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`)
          .bind(sourceKey)
          .first();
    if (!item) {
      const id = uuid(),
        at = nowIso();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO ${table} (id, ${key}, ${link}, adapter, source_host, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          sourceKey,
          parsed.canonicalUrl,
          parsed.adapter,
          parsed.sourceHost,
          parsed.adapter === "play"
            ? "play"
            : parsed.adapter.startsWith("riftbound")
              ? "uvs"
              : "other",
          at,
          at,
        )
        .run();
      item = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`)
        .bind(sourceKey)
        .first();
    }
    item = await refreshCatalogueItem(env, kind, item);
    if (kind === "event" && item.adapter === "generic") {
      try {
        const snapshot = await fetchEvent(item);
        await env.DB.prepare(
          "UPDATE events SET title = ?, status = ?, status_reason = ?, last_checked_at = ? WHERE id = ?",
        )
          .bind(
            snapshot.title,
            snapshot.status,
            snapshot.reason,
            nowIso(),
            item.id,
          )
          .run();
      } catch {
        /* The detail page reports unknown availability and retains the link. */
      }
    }
    return json({ id: item.id, kind }, 201);
  }
  const listMatch = path.match(/^\/api\/catalogue\/(events|stores)$/);
  if (method === "GET" && listMatch) {
    const kind = listMatch[1] === "events" ? "event" : "store";
    const [table, subs, fk] = KINDS[kind];
    const user = await currentUser(request, env);
    const p = url.searchParams,
      view = p.get("view") || "browse";
    if (
      !["browse", "collection", "bookmarks", "watching", "joined", "archive"].includes(view)
    )
      throw new HttpError(400, "Unknown section.");
    if (view !== "browse" && !user)
      throw new HttpError(401, "Sign in to sync and view your saved items.");
    const where = [],
      args = [user?.id || ""];
    if (view === 'browse') {
      const scope = await browseScope(env, user, p);
      if (!scope?.sources.length)
        return json({ items: [], total: 0, page: 1, pages: 0, setup_required: true });
      const constraints = scopeConditions(scope, kind);
      where.push(...constraints.where);
      args.push(...constraints.args);
    }
    if (view === "collection") {
      const allowedCollection = new Set([
        "watching",
        "bookmarked",
        "joined",
        "archived",
      ]);
      const rawCollection =
        p.get("collection") ?? "watching,bookmarked,joined";
      const selectedCollection = [
        ...new Set(
          rawCollection
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      if (selectedCollection.some((value) => !allowedCollection.has(value)))
        throw new HttpError(400, "Unknown collection filter.");

      const visible = [];
      if (selectedCollection.includes("watching"))
        visible.push("s.watching = 1");
      if (selectedCollection.includes("bookmarked"))
        visible.push("s.bookmarked = 1");
      if (kind === "event" && selectedCollection.includes("joined"))
        visible.push("s.joined = 1");

      const collectionGroups = [];
      if (visible.length)
        collectionGroups.push(
          `(s.archived = 0 AND (${visible.join(" OR ")}))`,
        );
      if (selectedCollection.includes("archived"))
        collectionGroups.push("s.archived = 1");

      where.push(
        collectionGroups.length
          ? `(${collectionGroups.join(" OR ")})`
          : "0 = 1",
      );
    } else if (view === "archive") where.push("s.archived = 1");
    else {
      if (view !== "browse") where.push("s.archived = 0");
      if (view === "bookmarks") where.push("s.bookmarked = 1");
      if (view === "watching") where.push("s.watching = 1");
      if (view === "joined")
        where.push(kind === "event" ? "s.joined = 1" : "0 = 1");
    }
    const q = (p.get("q") || "").trim().slice(0, 200);
    if (q) {
      where.push(
        `(e.title LIKE ? ESCAPE '\\' OR e.address LIKE ? ESCAPE '\\' OR e.city LIKE ? ESCAPE '\\'${kind === "event" ? " OR e.host_lgs LIKE ? ESCAPE '\\'" : ""})`,
      );
      const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(...Array(kind === "event" ? 4 : 3).fill(term));
    }
    const selectedSources = facetValues(p, "source");
    if (selectedSources.length) {
      const markers = selectedSources.map(() => "?").join(",");
      where.push(
        `(e.source IN (${markers}) OR EXISTS (SELECT 1 FROM catalogue_sources cs WHERE cs.kind = ? AND cs.entity_id = e.id AND cs.source IN (${markers})))`,
      );
      args.push(...selectedSources, kind, ...selectedSources);
    }
    addFacet(where, args, "country", facetValues(p, "country"));
    addFacet(where, args, "city", facetValues(p, "city"));
    if (kind === "event") {
      for (const field of ["format", "category", "status"])
        addFacet(where, args, field, facetValues(p, field));
      const stores = facetValues(p, "store");
      if (stores.length) {
        const markers = stores.map(() => "?").join(",");
        where.push(`(e.host_lgs COLLATE NOCASE IN (${markers}) OR e.store_id IN (SELECT id FROM lgs_stores WHERE title COLLATE NOCASE IN (${markers})))`);
        args.push(...stores, ...stores);
      }
      const prices = facetValues(p, "price");
      if (prices.includes("free") !== prices.includes("paid"))
        where.push(prices.includes("free") ? "e.price_minor = 0" : "e.price_minor > 0");
      for (const [param, operator] of [
        ["from", ">="],
        ["to", "<"],
      ])
        if (p.get(param)) {
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(p.get(param)) ||
            !Number.isFinite(Date.parse(p.get(param)))
          )
            throw new HttpError(400, "Invalid date filter.");
          const date = new Date(`${p.get(param)}T00:00:00Z`);
          if (param === "to") date.setUTCDate(date.getUTCDate() + 1);
          where.push(`e.starts_at ${operator} ?`);
          args.push(date.toISOString());
        }
      if (
        !p.get("from") &&
        p.get("when") !== "all" &&
        (view === "browse" || view === "collection")
      ) {
        where.push("(e.starts_at IS NULL OR e.starts_at >= ?)");
        args.push(nowIso());
      }
    }
    const sorts = {
      name: "e.title COLLATE NOCASE ASC",
      newest: "e.created_at DESC",
      location:
        "e.country COLLATE NOCASE, e.city COLLATE NOCASE, e.title COLLATE NOCASE",
      date:
        kind === "event"
          ? "e.starts_at IS NULL, e.starts_at ASC"
          : "e.title COLLATE NOCASE ASC",
      latest:
        kind === "event"
          ? "e.starts_at IS NULL, e.starts_at DESC"
          : "e.title COLLATE NOCASE DESC",
    };
    const sort = sorts[p.get("sort") || "date"];
    if (!sort) throw new HttpError(400, "Unknown sort order.");
    const page = Math.max(
      1,
      Math.min(100000, Number.parseInt(p.get("page"), 10) || 1),
    );
    const limit = 24,
      clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM ${table} e LEFT JOIN ${subs} s ON s.${fk} = e.id AND s.user_id = ? ${clause}`;
    const count = await env.DB.prepare(`SELECT COUNT(*) AS total ${from}`)
      .bind(...args)
      .first();
    const fields = `s.id AS subscription_id, COALESCE(s.bookmarked, 0) AS bookmarked, COALESCE(s.watching, 0) AS watching,
      COALESCE(s.archived, 0) AS archived, COALESCE(s.active, 0) AS active, s.check_interval_minutes,
      ${kind === "event" ? "COALESCE(s.joined, 0) AS joined, s.notify_open, s.notify_slots," : ""}
      (SELECT GROUP_CONCAT(DISTINCT cs.source) FROM catalogue_sources cs WHERE cs.entity_id = e.id AND cs.kind = '${kind}') AS sources`;
    const items =
      (
        await env.DB.prepare(
          `SELECT e.*, ${fields} ${from} ORDER BY ${sort}, e.id LIMIT ? OFFSET ?`,
        )
          .bind(...args, limit, (page - 1) * limit)
          .all()
      ).results || [];
    return json({
      items,
      total: count.total,
      page,
      pages: Math.ceil(count.total / limit),
    });
  }
  if (method === "GET" && path === "/api/catalogue/filters") {
    const p = url.searchParams;
    const view = p.get("view") === "collection" ? "collection" : "browse";
    const kind = p.get("kind") === "store" ? "store" : "event";
    const user = await currentUser(request, env);
    const scope = view === "browse" ? await browseScope(env, user, p) : null;
    const empty = { country: [], city: [], store: [], format: [], category: [] };
    if (view === "browse" && !scope?.sources.length) return json(empty);
    if (view === "collection" && !user) return json(empty);
    // Browse facets are identical for all users with the same configured scope.
    // Cache only public scope-derived metadata, never private collection facets.
    const facetCache = view === "browse" ? globalThis.caches?.default : null;
    const facetKey = facetCache ? new Request(
      "https://event-watch.internal/facets?scope=" +
        encodeURIComponent(JSON.stringify([kind, [...scope.sources].sort(), scope.country, scope.city]))
    ) : null;
    if (facetKey) {
      try {
        const cached = await facetCache.match(facetKey);
        if (cached) return json(await cached.json());
      } catch (error) { console.warn("Facet cache lookup failed", error.message); }
    }
    const [table, subscriptions, foreignKey] = KINDS[kind];
    const constraints = view === "browse"
      ? scopeConditions(scope, kind)
      : { where: [`EXISTS (SELECT 1 FROM ${subscriptions} s WHERE s.${foreignKey} = e.id AND s.user_id = ?)`], args: [user.id] };
    const condition = constraints.where.join(" AND ");
    const results = { ...empty };
    for (const field of (kind === "event" ? ["country", "city", "format", "category"] : ["country", "city"])) {
      const sql = `SELECT DISTINCT TRIM(e.${field}) AS value FROM ${table} e
        WHERE ${condition} AND e.${field} IS NOT NULL AND TRIM(e.${field}) <> ''
        ORDER BY value COLLATE NOCASE LIMIT 500`;
      results[field] = ((await env.DB.prepare(sql).bind(...constraints.args).all()).results || []).map(r => r.value);
    }
    if (kind === "event") {
      const names = new Set();
      const queries = [
        `SELECT DISTINCT TRIM(e.host_lgs) AS value FROM events e
          WHERE ${condition} AND e.host_lgs IS NOT NULL AND TRIM(e.host_lgs) <> ''
          ORDER BY value COLLATE NOCASE LIMIT 500`,
        `SELECT DISTINCT TRIM(st.title) AS value FROM events e JOIN lgs_stores st ON st.id = e.store_id
          WHERE ${condition} AND st.title IS NOT NULL AND TRIM(st.title) <> ''
          ORDER BY value COLLATE NOCASE LIMIT 500`,
      ];
      for (const sql of queries) {
        for (const row of (await env.DB.prepare(sql).bind(...constraints.args).all()).results || []) names.add(row.value);
      }
      results.store = [...names].sort((a, b) => a.localeCompare(b));
    }
    if (facetKey) {
      try {
        await facetCache.put(facetKey, Response.json(results, {
          headers: { "cache-control": "public, max-age=3600" },
        }));
      } catch (error) { console.warn("Facet cache store failed", error.message); }
    }
    return json(results);
  }
  const match = path.match(
    /^\/api\/catalogue\/(event|store)\/([^/]+)(?:\/(state|events))?$/,
  );
  if (!match) throw new HttpError(404, "Not found.");
  const [, kind, id, action] = match,
    [table, subs, fk] = KINDS[kind];
  let item = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .bind(id)
    .first();
  if (!item) throw new HttpError(404, "This item could not be found.");
  if (method === "GET" && !action) {
    const user = await currentUser(request, env);
    item = await refreshCatalogueItem(env, kind, item);
    const state = user
      ? await env.DB.prepare(
          `SELECT * FROM ${subs} WHERE user_id = ? AND ${fk} = ?`,
        )
          .bind(user.id, id)
          .first()
      : null;
    const sources =
      (
        await env.DB.prepare(
          "SELECT source, url FROM catalogue_sources WHERE kind = ? AND entity_id = ?",
        )
          .bind(kind, id)
          .all()
      ).results || [];
    return json({ item, state, sources });
  }
  if (method === "GET" && kind === "store" && action === "events") {
    let warning = null;
    try {
      if (item.source === "play") {
        const snapshot = await fetchPlayStoreEvents(item);
        return json({
          events: snapshot.events.map((e) => ({
            title: e.title,
            event_url: e.eventUrl,
            event_key: e.eventKey,
          })),
          warning: null,
        });
      }
      if (item.source === "uvs" && item.source_id)
        await catalogueStoreEvents(env, item, { refresh: true });
      else if (item.adapter === "riftbound-store") {
        const snapshot = await fetchLgsStore(item);
        // Preserve older store watches while their public directory entry is being indexed.
        return json({
          events: snapshot.events.map((e) => ({
            title: e.title,
            event_url: e.eventUrl,
            event_key: `riftbound:${e.eventKey}`,
          })),
          warning: null,
        });
      }
    } catch {
      warning =
        "Could not refresh this store. Showing indexed events; the list may be incomplete.";
    }
    const events = await catalogueStoreEvents(env, item);
    return json({ events, warning });
  }
  if (method === "PATCH" && action === "state") {
    const user = await requireUser(request, env),
      body = await readJson(request);
    const allowed =
      kind === "event"
        ? [
            "bookmarked",
            "watching",
            "joined",
            "archived",
            "notify_open",
            "notify_slots",
          ]
        : ["bookmarked", "watching", "archived"];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Object.keys(body).length
    )
      throw new HttpError(400, "Provide an item setting.");
    for (const key of Object.keys(body))
      if (
        !(allowed.includes(key) && typeof body[key] === "boolean") &&
        key !== "check_interval_minutes"
      )
        throw new HttpError(400, "Invalid item setting.");
    let interval;
    if ("check_interval_minutes" in body) {
      interval = normalizeCheckInterval(body.check_interval_minutes, -1);
      if (interval === -1 || !Number.isInteger(body.check_interval_minutes))
        throw new HttpError(400, "Invalid check interval.");
    }
    const at = nowIso();
    // Insert a neutral personal record; a bookmark alone must never start monitoring.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${subs} (id, user_id, ${fk}, active, watching, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?)`,
    )
      .bind(uuid(), user.id, id, at, at)
      .run();
    const prior = await env.DB.prepare(
      `SELECT * FROM ${subs} WHERE user_id = ? AND ${fk} = ?`,
    )
      .bind(user.id, id)
      .first();
    const sets = [],
      values = [];
    for (const key of allowed)
      if (key in body) {
        sets.push(`${key} = ?`);
        values.push(Number(body[key]));
      }
    if (interval !== undefined) {
      sets.push("check_interval_minutes = ?");
      values.push(interval);
    }
    if (body.watching === true && !prior.watching) {
      sets.push("next_check_at = NULL");
      if (kind === "store") sets.push("initialized_at = NULL");
      else {
        sets.push("last_seen_status = ?");
        values.push(item.status || "UNKNOWN");
      }
    }
    sets.push("updated_at = ?");
    values.push(at, prior.id);
    await env.DB.prepare(`UPDATE ${subs} SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
    const state = await env.DB.prepare(`SELECT * FROM ${subs} WHERE id = ?`)
      .bind(prior.id)
      .first();
    return json({ state });
  }
  if (method === "DELETE" && action === "state") {
    const user = await requireUser(request, env);
    await env.DB.prepare(`DELETE FROM ${subs} WHERE user_id = ? AND ${fk} = ?`)
      .bind(user.id, id)
      .run();
    return json({ ok: true });
  }
  throw new HttpError(404, "Not found.");
}
