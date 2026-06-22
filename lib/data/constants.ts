export const DATA_CHART_TOTAL_LIMIT = 100_000;
export const DATA_PROVIDER_TOTAL_LIMIT = 65_000;
export const DATA_MAX_RECONNECT_ATTEMPTS = 5;
export const DATA_CACHE_SYNC_MIN_MS = 30_000;

/**
 * Desired final bar count for synthetic pair generation.
 * Source bars fetched = this × subBarRatio (capped at SYNTHETIC_SOURCE_BARS_LIMIT).
 * Ensures every target interval gets ~same number of bars regardless of ratio.
 */
export const SYNTHETIC_TARGET_BARS = 50_000;
export const SYNTHETIC_SOURCE_BARS_LIMIT = 1_000_000;

/**
 * Freshness window for the persisted synthetic-result cache (IndexedDB).
 * Within this window, a rebuild of the same pair reuses the cached bars;
 * after it, the build falls through to re-fetch legs so newly-ingested
 * history is picked up. Picked at 30 minutes to match the dataset/binance-
 * search TTLs already in the repo; on any interval >= 15m this is shorter
 * than one bar, so a fresh cache is definitionally up to date.
 */
export const SYNTHETIC_RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
