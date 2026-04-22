import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { PolymarketPricePoint } from "./local-sqlite-polymarket-api";
import {
    ensurePolymarketPricePoints,
    loadPolymarketPricePoints,
    storePolymarketPricePoints,
} from "./local-sqlite-polymarket-api";
import { debugLogger } from "./debug-logger";

const POLYMARKET_PROXY_HISTORY_URL = "/api/polymarket-history";
const POLYMARKET_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const EVENT_DURATION_SEC = 300;
const HISTORY_REQUEST_TIMEOUT_MS = 6000;
// First-run signal-exit scoring can touch hundreds of 5m events on a 1m chart.
// Keep ingestion parallel enough that the initial backtest finishes before the
// client-side ensure timeout expires.
const MAX_CONCURRENT_FETCHES = 24;
const MAX_EVENT_STARTS_PER_LOAD_REQUEST = 100;
// Finder can span long 1m ranges, which turns stored-price lookup into dozens
// of local SQLite requests. Keep those batched so the browser/dev server does
// not drop same-origin fetches under a large Promise.all fan-out.
const MAX_CONCURRENT_LOAD_REQUESTS = 4;

type HistoryResponse = {
    history?: Array<{ t?: unknown; p?: unknown }>;
};

type RawHistoryPoint = {
    t: number;
    p: number;
};

function normalizeHistoryPoints(response: HistoryResponse | null): RawHistoryPoint[] {
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

async function fetchYesHistory(
    yesTokenId: string,
    eventStartTs: number
): Promise<RawHistoryPoint[]> {
    const params = new URLSearchParams({
        market: yesTokenId,
        startTs: String(Math.max(0, eventStartTs - 15)),
        endTs: String(eventStartTs + EVENT_DURATION_SEC),
    });
    const urls = [
        `${POLYMARKET_PROXY_HISTORY_URL}?${params.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${params.toString()}`,
    ];
    const windowedPoints = normalizeHistoryPoints(await fetchJsonWithFallback(urls));
    if (windowedPoints.length > 0) {
        return windowedPoints;
    }

    const fallbackParams = new URLSearchParams({
        market: yesTokenId,
        interval: "max",
    });
    const fallbackPoints = normalizeHistoryPoints(await fetchJsonWithFallback([
        `${POLYMARKET_PROXY_HISTORY_URL}?${fallbackParams.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${fallbackParams.toString()}`,
    ]));
    return fallbackPoints.filter(
        (pt) => pt.t >= eventStartTs && pt.t <= eventStartTs + EVENT_DURATION_SEC
    );
}

async function fetchPricePointsForEvent(
    outcome: PolymarketOutcomeRow,
    seriesId: string
): Promise<PolymarketPricePoint[]> {
    if (!outcome.yes_token_id) return [];

    try {
        const yesPoints = await fetchYesHistory(outcome.yes_token_id, outcome.event_start_ts);

        return yesPoints.map((pt) => ({
            series_id: seriesId,
            event_start_ts: outcome.event_start_ts,
            event_end_ts: outcome.event_end_ts,
            market_slug: outcome.market_slug || outcome.event_slug,
            yes_token_id: outcome.yes_token_id,
            no_token_id: outcome.no_token_id || "",
            ts: pt.t,
            yes_price: pt.p,
            no_price: pt.p !== null && pt.p !== undefined ? Math.round((1 - pt.p) * 10000) / 10000 : null,
            updated_at: Math.floor(Date.now() / 1000),
        }));
    } catch {
        debugLogger.info("polymarket.price_points.fetch_failed", {
            eventStartTs: outcome.event_start_ts,
            tokenId: outcome.yes_token_id,
        });
        return [];
    }
}

async function processBatch(
    outcomes: PolymarketOutcomeRow[],
    seriesId: string,
    onProgress?: (fetched: number, total: number) => void
): Promise<PolymarketPricePoint[]> {
    const allPoints: PolymarketPricePoint[] = [];
    let fetched = 0;

    for (let i = 0; i < outcomes.length; i += MAX_CONCURRENT_FETCHES) {
        const batch = outcomes.slice(i, i + MAX_CONCURRENT_FETCHES);
        const batchResults = await Promise.all(
            batch.map((outcome) => fetchPricePointsForEvent(outcome, seriesId))
        );
        for (const points of batchResults) {
            allPoints.push(...points);
        }
        fetched += batch.length;
        onProgress?.(fetched, outcomes.length);
    }

    return allPoints;
}

async function loadExistingPricePoints(
    seriesId: string,
    eventStartTs: readonly number[]
): Promise<PolymarketPricePoint[]> {
    if (eventStartTs.length === 0) {
        return [];
    }

    const chunks: number[][] = [];
    for (let index = 0; index < eventStartTs.length; index += MAX_EVENT_STARTS_PER_LOAD_REQUEST) {
        chunks.push(eventStartTs.slice(index, index + MAX_EVENT_STARTS_PER_LOAD_REQUEST));
    }

    const rows: PolymarketPricePoint[][] = [];
    for (let index = 0; index < chunks.length; index += MAX_CONCURRENT_LOAD_REQUESTS) {
        const batch = chunks.slice(index, index + MAX_CONCURRENT_LOAD_REQUESTS);
        const batchRows = await Promise.all(
            batch.map((chunk) => loadPolymarketPricePoints({
                seriesId,
                eventStartTs: chunk,
            }))
        );
        rows.push(...batchRows);
    }

    return rows
        .flat()
        .sort((left, right) => left.ts - right.ts);
}

function buildCoveredEventStartSet(
    outcomes: readonly PolymarketOutcomeRow[],
    points: readonly PolymarketPricePoint[]
): Set<number> {
    const distinctTimestampCountByEvent = new Map<number, Set<number>>();

    for (const point of points) {
        let timestamps = distinctTimestampCountByEvent.get(point.event_start_ts);
        if (!timestamps) {
            timestamps = new Set<number>();
            distinctTimestampCountByEvent.set(point.event_start_ts, timestamps);
        }
        timestamps.add(point.ts);
    }

    const coveredEventStarts = new Set<number>();
    for (const outcome of outcomes) {
        const timestamps = distinctTimestampCountByEvent.get(outcome.event_start_ts);
        if (timestamps && timestamps.size >= 2) {
            coveredEventStarts.add(outcome.event_start_ts);
        }
    }

    return coveredEventStarts;
}

export async function ensurePricePointsForOutcomes(
    outcomes: readonly PolymarketOutcomeRow[],
    seriesId: string,
    options?: {
        startTs?: number;
        endTs?: number;
        onProgress?: (fetched: number, total: number) => void;
    }
): Promise<PolymarketPricePoint[]> {
    if (outcomes.length === 0) return [];

    const eventStartTs = Array.from(new Set(
        outcomes
            .map((outcome) => outcome.event_start_ts)
            .filter((value) => Number.isFinite(value))
    )).sort((left, right) => left - right);

    const existingPoints = await loadExistingPricePoints(seriesId, eventStartTs);

    const coveredEventStarts = buildCoveredEventStartSet(outcomes, existingPoints);
    const uncoveredOutcomes = outcomes.filter(
        (o) => !coveredEventStarts.has(o.event_start_ts)
    );

    if (uncoveredOutcomes.length === 0) {
        return existingPoints;
    }

    debugLogger.info("polymarket.price_points.ingest_start", {
        seriesId,
        totalEvents: outcomes.length,
        alreadyCovered: coveredEventStarts.size,
        toFetch: uncoveredOutcomes.length,
    });

    try {
        const ensuredPoints = await ensurePolymarketPricePoints({
            seriesId,
            outcomes: uncoveredOutcomes,
        });
        if (ensuredPoints.length > 0) {
            const mergedByKey = new Map<string, PolymarketPricePoint>();
            for (const point of [...existingPoints, ...ensuredPoints]) {
                mergedByKey.set(`${point.series_id}:${point.event_start_ts}:${point.ts}`, point);
            }
            return Array.from(mergedByKey.values()).sort((left, right) => left.ts - right.ts);
        }
    } catch (error) {
        debugLogger.info("polymarket.price_points.ensure_via_api_failed", {
            seriesId,
            toFetch: uncoveredOutcomes.length,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const newPoints = await processBatch(
        uncoveredOutcomes,
        seriesId,
        options?.onProgress
    );

    if (newPoints.length > 0) {
        const storeResult = await storePolymarketPricePoints(newPoints);
        debugLogger.info("polymarket.price_points.stored", {
            pointsCount: newPoints.length,
            upserted: storeResult.upserted,
            ok: storeResult.ok,
        });
    }

    const merged = [...existingPoints, ...newPoints];
    return merged;
}
