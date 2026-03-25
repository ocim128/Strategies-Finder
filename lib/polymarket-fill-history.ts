import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

const POLYMARKET_PROXY_HISTORY_URL = "/api/polymarket-history";
const POLYMARKET_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const EVENT_DURATION_SEC = 300;
const WINDOW_OFFSETS_SEC = [0, 60, 120, 180, 240] as const;
const HISTORY_REQUEST_TIMEOUT_MS = 6000;

type HistoryPoint = {
    t: number;
    p: number;
};

type HistoryResponse = {
    history?: Array<{ t?: unknown; p?: unknown }>;
};

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

function normalizeHistoryPoints(response: HistoryResponse | null): HistoryPoint[] {
    const rows = Array.isArray(response?.history) ? response.history : [];
    const dedup = new Map<number, number>();

    for (const row of rows) {
        const t = Math.floor(Number(row?.t));
        const p = Number(row?.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
        if (p < 0 || p > 1) continue;
        dedup.set(t, p);
    }

    return Array.from(dedup.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, p]) => ({ t, p }));
}

async function fetchJsonWithFallback(urls: string[]): Promise<HistoryResponse> {
    let lastError: unknown = null;
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(HISTORY_REQUEST_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }
            return await response.json() as HistoryResponse;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error("Failed to load Polymarket history.");
}

async function fetchHistoryPoints(row: PolymarketOutcomeRow): Promise<HistoryPoint[]> {
    const params = new URLSearchParams({
        market: row.yes_token_id,
        startTs: String(Math.max(0, row.event_start_ts - 15)),
        endTs: String(row.event_start_ts + EVENT_DURATION_SEC),
    });
    const windowedUrls = [
        `${POLYMARKET_PROXY_HISTORY_URL}?${params.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${params.toString()}`,
    ];
    const windowedPoints = normalizeHistoryPoints(await fetchJsonWithFallback(windowedUrls));
    if (windowedPoints.length > 0) {
        return windowedPoints;
    }

    const fallbackParams = new URLSearchParams({
        market: row.yes_token_id,
        interval: "max",
    });
    return normalizeHistoryPoints(await fetchJsonWithFallback([
        `${POLYMARKET_PROXY_HISTORY_URL}?${fallbackParams.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${fallbackParams.toString()}`,
    ]));
}

function summarizeHistory(row: PolymarketOutcomeRow, points: HistoryPoint[]): PolymarketFillHistorySummary {
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

    const pending = fetchHistoryPoints(row).then((points) => summarizeHistory(row, points));
    historyCache.set(cacheKey, pending);
    return pending;
}
