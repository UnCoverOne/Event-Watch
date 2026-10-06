// Public source contracts inspected 2026-10-06. No source account credentials are used.
import { htmlToText } from "./riftbound.js";
export const UVS_API =
  "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";
export const PLAY_OPERATIONS = {
  CompeteTournamentSearch:
    "acbcbba681a9c9a8063f792f7d665ba1eda81b19528b6af19e523f0c2061bec2",
  GetCompeteTournamentForRiftboundPlayer:
    "b1bbb48ce34fe781db8af6bc81d1d643ddbaac21d3347cd532ae6d1162f8c13e",
  OrganizerSummary:
    "9142e18241bb86a3b4c2692d899b31aaf61d11065ca8a259191aa9cc0a06ed57",
};
export async function sourceJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response.json();
}
export async function playQuery(operationName, variables) {
  const data = await sourceJson("https://playriftbound.com/api/gql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apollographql-client-name": "Event Watch",
      "apollographql-client-version": "1.0",
    },
    body: JSON.stringify({
      operationName,
      variables,
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: PLAY_OPERATIONS[operationName],
        },
      },
    }),
  });
  if (data.errors?.length || !data.data)
    throw new Error(
      `Play Riftbound: ${data.errors?.[0]?.message || "Invalid response"}`,
    );
  return data.data;
}
export function uvsStore(record) {
  const s = record.store || record;
  if (!s.id || !s.name) throw new Error("Invalid UVS store record.");
  const publicId = record.store ? record.id : null;
  return {
    source: "uvs",
    source_id: String(s.id),
    key: publicId ? `riftbound:${publicId}` : `uvs-store:${s.id}`,
    url: publicId
      ? `https://locator.riftbound.uvsgames.com/stores/${publicId}`
      : `https://locator.riftbound.uvsgames.com/`,
    title: s.name,
    city: s.city || null,
    country: s.country || null,
    address: s.full_address || null,
    latitude: number(s.latitude),
    longitude: number(s.longitude),
    adapter: "riftbound-store",
  };
}
export function uvsEvent(r, at = Date.now()) {
  if (!r.id || !r.name) throw new Error("Invalid UVS event record.");
  const current = number(r.registered_user_count),
    capacity = number(r.capacity);
  let status = "UNKNOWN";
  if (
    /CANCEL|FINISHED/.test(
      `${r.event_status} ${r.settings?.event_lifecycle_status}`,
    ) ||
    Date.parse(r.start_datetime) <= at
  )
    status = "CLOSED";
  else if (capacity > 0 && current != null && current >= capacity)
    status = "FULL";
  else if (
    r.queue_status === "ACCEPTING_SIGNUPS" &&
    r.settings?.show_registration_button === true
  )
    status = "AVAILABLE";
  else if (/CLOSED|ENDED/.test(r.queue_status || "")) status = "CLOSED";
  return {
    source: "uvs",
    source_id: String(r.id),
    key: `riftbound:${r.id}`,
    url: `https://locator.riftbound.uvsgames.com/events/${r.id}`,
    adapter: "riftbound",
    title: r.name,
    starts_at: iso(r.start_datetime),
    event_date: iso(r.start_datetime),
    host_lgs: r.store?.name || null,
    store: r.store ? uvsStore(r.store) : null,
    address: r.full_address || null,
    city: r.store?.city || null,
    country: r.store?.country || null,
    latitude: number(r.latitude),
    longitude: number(r.longitude),
    format: r.gameplay_format?.name || null,
    category: r.event_type || null,
    price_minor: number(r.cost_in_cents),
    currency: r.currency || null,
    description: htmlToText(r.description || ""),
    status,
    status_reason:
      status === "UNKNOWN"
        ? "Registration availability is not published."
        : `Source reports ${status.toLowerCase().replaceAll("_", " ")}.`,
    current_players: current,
    capacity,
  };
}
let playCountryNames;
function normalizeCountryName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export function countryCodeFromFormattedAddress(address) {
  const country = String(address || "").split(",").at(-1)?.trim();
  if (!country) return null;
  const upper = country.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  const aliases = new Map([
    ["uk", "GB"],
    ["u k", "GB"],
    ["united kingdom", "GB"],
    ["usa", "US"],
    ["u s a", "US"],
    ["united states of america", "US"],
  ]);
  const normalized = normalizeCountryName(country);
  if (aliases.has(normalized)) return aliases.get(normalized);
  if (!playCountryNames) {
    playCountryNames = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        if (name && name !== code)
          playCountryNames.set(normalizeCountryName(name), code);
      }
  }
  return playCountryNames.get(normalized) || null;
}
export function playStore(s) {
  if (!s?.id || !s.name) throw new Error("Invalid Play Riftbound organizer.");
  return {
    source: "play",
    source_id: String(s.id),
    key: `play:${s.id}`,
    url: "https://playriftbound.com/en-US/events/",
    adapter: "play-store",
    title: s.name,
    address: s.physicalAddress?.formattedAddress || null,
    city: s.physicalAddress?.city || null,
    country: countryCodeFromFormattedAddress(s.physicalAddress?.formattedAddress),
    latitude: number(s.physicalAddress?.latitude),
    longitude: number(s.physicalAddress?.longitude),
  };
}
export function playEvent(
  t,
  organizer = null,
  detail = false,
  at = Date.now(),
) {
  if (!t?.id || !t.name) throw new Error("Invalid Play Riftbound tournament.");
  const counts = t.registrantCounts;
  const current = Array.isArray(counts)
    ? counts
        .filter((c) => String(c.status).toLowerCase() === "registered")
        .reduce((n, c) => n + (number(c.count) || 0), 0)
    : null;
  const capacity = number(t.config?.participantCapacity);
  let status = "UNKNOWN";
  if (
    Date.parse(t.startsAt) <= at ||
    (t.registrationEndAt && Date.parse(t.registrationEndAt) <= at)
  )
    status = "CLOSED";
  else if (t.registrationStartAt && Date.parse(t.registrationStartAt) > at)
    status = "NOT_OPEN";
  else if (capacity > 0 && current != null && current >= capacity)
    status = "FULL";
  else if (detail && String(t.registrationPolicy).toLowerCase() === "closed")
    status = "CLOSED";
  else if (detail && String(t.registrationPolicy).toLowerCase() === "open")
    status = "AVAILABLE";
  const store = organizer ? playStore(organizer) : null;
  return {
    source: "play",
    source_id: String(t.id),
    key: `play:${t.id}`,
    url: `https://playriftbound.com/en-US/events/${encodeURIComponent(t.id)}`,
    adapter: "play",
    title: t.name,
    starts_at: iso(t.startsAt),
    event_date: iso(t.startsAt),
    store,
    host_lgs: organizer?.name || null,
    address: organizer?.physicalAddress?.formattedAddress || null,
    city: organizer?.physicalAddress?.city || null,
    country: store?.country || null,
    latitude: number(organizer?.physicalAddress?.latitude),
    longitude: number(organizer?.physicalAddress?.longitude),
    format: t.config?.format || null,
    category: t.config?.tournamentType || null,
    price_minor:
      number(t.entryFee?.minorUnits) ??
      (String(t.pricing).toLowerCase() === "free" ? 0 : null),
    currency: t.entryFee?.currency || null,
    description: htmlToText(t.description || ""),
    status,
    status_reason:
      status === "UNKNOWN"
        ? "Open the event details to check registration availability."
        : `Source reports ${status.toLowerCase().replaceAll("_", " ")}.`,
    current_players: current,
    capacity,
  };
}
export async function fetchSourcePage(source, cursor = null) {
  if (source === "play") {
    const data = await playQuery("CompeteTournamentSearch", {
      sport: "rb",
      // Catalogue indexing must not invent a geographic origin. Play Riftbound
      // accepts an empty filter for the global tournament listing; user country
      // and city preferences are applied locally after records are indexed.
      filter: {},
      first: 10,
      ...(cursor ? { after: cursor } : {}),
    });
    const listing = data.competeTournamentSearch;
    if (!Array.isArray(listing?.edges) || !listing.pageInfo)
      throw new Error("Invalid Play Riftbound listing.");
    const next = listing.pageInfo.hasNextPage
      ? listing.pageInfo.endCursor
      : null;
    if (listing.pageInfo.hasNextPage && (!next || next === cursor))
      throw new Error("Invalid Play Riftbound pagination.");
    return {
      events: listing.edges.map(({ node }) =>
        playEvent(node.tournament, node.organizer),
      ),
      stores: [],
      next,
    };
  }
  const page = Number(cursor || 1);
  const store = source === "uvs-stores";
  const query = new URLSearchParams({
    game_slug: "riftbound",
    page_size: "10",
    page: String(page),
    ...(store ? {} : { upcoming_only: "true" }),
  });
  const data = await sourceJson(
    `${UVS_API}/${store ? "game-stores" : "events"}/?${query}`,
  );
  if (!Array.isArray(data.results)) throw new Error("Invalid UVS listing.");
  const next = data.next_page_number;
  if (next != null && (!Number.isSafeInteger(next) || next <= page))
    throw new Error("Invalid UVS pagination.");
  return {
    events: store
      ? []
      : data.results
          .filter((r) => !r.is_test_event && !r.is_template)
          .map((r) => uvsEvent(r)),
    stores: store ? data.results.map(uvsStore) : [],
    next: next == null ? null : String(next),
  };
}
export async function fetchPlayEvent(url) {
  const id = parsePlayEventUrl(url).eventKey;
  const data = await playQuery("GetCompeteTournamentForRiftboundPlayer", {
    tournamentId: id,
  });
  const raw = data.competeTournaments?.find((t) => t.id === id);
  if (!raw) throw new Error("This Play Riftbound event was not found.");
  const record = playEvent(raw, null, true);
  return {
    title: record.title,
    eventDate: record.event_date,
    hostLgs: null,
    status: record.status,
    reason: record.status_reason,
    currentPlayers: record.current_players,
    capacity: record.capacity,
    record,
  };
}
export function parsePlayEventUrl(input) {
  const url = new URL(input);
  const match = url.pathname.match(
    /^\/(?:[a-z]{2}-[A-Z]{2}\/)?events\/([A-Za-z0-9_-]+)\/?$/,
  );
  if (
    url.protocol !== "https:" ||
    !["playriftbound.com", "events.playriftbound.com"].includes(url.hostname) ||
    !match ||
    url.username ||
    url.password
  )
    throw new Error("Not a Play Riftbound event URL.");
  return {
    eventKey: match[1],
    canonicalUrl: `https://playriftbound.com/en-US/events/${match[1]}`,
  };
}
export function number(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))
    ? Number(v)
    : null;
}
function iso(v) {
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
}
