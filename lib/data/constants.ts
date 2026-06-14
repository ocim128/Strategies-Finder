export const DATA_CHART_TOTAL_LIMIT = 100_000;
export const DATA_PROVIDER_TOTAL_LIMIT = 65_000;
export const DATA_MAX_RECONNECT_ATTEMPTS = 5;
export const DATA_CACHE_SYNC_MIN_MS = 30_000;

/**
 * Desired final bar count for synthetic pair generation.
 * Source bars fetched = this × subBarRatio (capped at DATA_CHART_TOTAL_LIMIT).
 * Ensures every target interval gets ~same number of bars regardless of ratio.
 */
export const SYNTHETIC_TARGET_BARS = 10_000;
