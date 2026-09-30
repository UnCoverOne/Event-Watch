export const CHECK_INTERVALS = Object.freeze([5, 10, 15, 30, 60, 180, 360, 720, 1440]);

export function normalizeCheckInterval(value, fallback = 5) {
  const minutes = Number.parseInt(value, 10);
  return CHECK_INTERVALS.includes(minutes) ? minutes : fallback;
}

export function nextCheckAt(fromIso, intervalMinutes) {
  const from = new Date(fromIso);
  const minutes = normalizeCheckInterval(intervalMinutes);
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}
