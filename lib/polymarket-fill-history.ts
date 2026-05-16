import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import {
    fetchPolymarketHistoryWithFallback,
    normalizePolymarketHistoryPoints,
    type PolymarketHistoryPoint,
} from "./polymarket-history-client";

const POLYMARKET_PROXY_HISTORY_URL = "/api/polymarket-history";
const POLYMARKET_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const EVENT_DURATION_SEC = 300;
const WINDOW_OFFSETS_SEC = [0, 60, 120, 180, 240] as const;
const HISTORY_REQUEST_TIMEOUT_MS = 6000;

export interface PolymarketFillHistoryWindow {
    yesMinPrice: number | null;
    yesMaxPrice: number | null;
    sampleCount: number;
}

export interface PolymarketFillHistorySummary {
    eventStartTs: number;
    yesTokenId: string;
    windows: PolymarketFillHistoryWindow[];
}

const historyCache = new Map<string, Promise<PolymarketFillHistorySummary>>();

async function fetchHistoryPoints(row: PolymarketOutcomeRow): Promise<PolymarketHistoryPoint[]> {
    const params = new URLSearchParams({
        market: row.yes_token_id,
        startTs: String(Math.max(0, row.event_start_ts - 15)),
        endTs: String(row.event_start_ts + EVENT_DURATION_SEC),
    });
    const windowedUrls = [
        `${POLYMARKET_PROXY_HISTORY_URL}?${params.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${params.toString()}`,
    ];
    const windowedPoints = normalizePolymarketHistoryPoints(await fetchPolymarketHistoryWithFallback(windowedUrls, {
        timeoutMs: HISTORY_REQUEST_TIMEOUT_MS,
    }));
    if (windowedPoints.length > 0) {
        return windowedPoints;
    }

    const fallbackParams = new URLSearchParams({
        market: row.yes_token_id,
        interval: "max",
    });
    return normalizePolymarketHistoryPoints(await fetchPolymarketHistoryWithFallback([
        `${POLYMARKET_PROXY_HISTORY_URL}?${fallbackParams.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${fallbackParams.toString()}`,
    ], { timeoutMs: HISTORY_REQUEST_TIMEOUT_MS }));
}

function summarizeHistory(row: PolymarketOutcomeRow, points: PolymarketHistoryPoint[]): PolymarketFillHistorySummary {
    let cursor = 0;
    let yesMin = Number.POSITIVE_INFINITY;
    let yesMax = Number.NEGATIVE_INFINITY;
    let sampleCount = 0;

    const windows = WINDOW_OFFSETS_SEC.map((offsetSec) => {
        const checkpointTs = row.event_start_ts + offsetSec;

        while (cursor < points.length && points[cursor]!.t <= checkpointTs) {
            const point = points[cursor]!;
            if (point.t >= row.event_start_ts && point.t <= row.event_start_ts + EVENT_DURATION_SEC) {
                yesMin = Math.min(yesMin, point.p);
                yesMax = Math.max(yesMax, point.p);
                sampleCount++;
            }
            cursor++;
        }

        return {
            yesMinPrice: sampleCount > 0 ? yesMin : null,
            yesMaxPrice: sampleCount > 0 ? yesMax : null,
            sampleCount,
        };
    });

    return {
        eventStartTs: row.event_start_ts,
        yesTokenId: row.yes_token_id,
        windows,
    };
}

export function loadPolymarketFillHistorySummary(row: PolymarketOutcomeRow): Promise<PolymarketFillHistorySummary> {
    const cacheKey = `${row.yes_token_id}:${row.event_start_ts}`;
    const cached = historyCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    let pending: Promise<PolymarketFillHistorySummary>;
    pending = fetchHistoryPoints(row)
        .then((points) => summarizeHistory(row, points))
        .catch((error) => {
            if (historyCache.get(cacheKey) === pending) {
                historyCache.delete(cacheKey);
            }
            throw error;
        });
    historyCache.set(cacheKey, pending);
    return pending;
}
