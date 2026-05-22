import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type {
    EnsurePolymarketPricePointsResult,
    PolymarketPricePoint,
} from "./local-sqlite-polymarket-api";
import {
    ensurePolymarketPricePointsWithMetadata,
    loadPolymarketPricePoints,
    storePolymarketPricePoints,
} from "./local-sqlite-polymarket-api";
import { debugLogger } from "./debug-logger";
import {
    fetchPolymarketHistoryWithFallback,
    normalizePolymarketHistoryPoints,
    type PolymarketHistoryPoint,
} from "./polymarket-history-client";
import { mapWithConcurrencyLimit } from "./async-pool";

const POLYMARKET_PROXY_HISTORY_URL = "/api/polymarket-history";
const POLYMARKET_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const HISTORY_REQUEST_TIMEOUT_MS = 6000;
// First-run signal-exit scoring can touch hundreds of 5m events on a 1m chart.
// Keep ingestion parallel enough that the initial backtest finishes before the
// client-side ensure timeout expires.
const MAX_CONCURRENT_FETCHES = 24;
const MAX_EVENT_STARTS_PER_LOAD_REQUEST = 100;
const MAX_PRICE_POINTS_PER_LOAD_REQUEST = 500000;
const MAX_OUTCOMES_PER_SERVER_ENSURE = 100;
// Finder can span long 1m ranges, which turns stored-price lookup into dozens
// of local SQLite requests. Keep those batched so the browser/dev server does
// not drop same-origin fetches under a large Promise.all fan-out.
const MAX_CONCURRENT_LOAD_REQUESTS = 4;
const MAX_CONCURRENT_ENSURE_REQUESTS = 2;
const inFlightExistingLoads = new Map<string, Promise<PolymarketPricePoint[]>>();
const inFlightServerEnsures = new Map<string, Promise<EnsurePolymarketPricePointsResult>>();

function runCoalesced<T>(
    inFlight: Map<string, Promise<T>>,
    key: string,
    work: () => Promise<T>
): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = work().finally(() => {
        if (inFlight.get(key) === promise) {
            inFlight.delete(key);
        }
    });
    inFlight.set(key, promise);
    return promise;
}

function buildEventStartKey(seriesId: string, eventStartTs: readonly number[]): string {
    return `${seriesId}:${eventStartTs.join(",")}`;
}

function buildEnsureKey(seriesId: string, outcomes: readonly PolymarketOutcomeRow[]): string {
    return `${seriesId}:${outcomes
        .map((outcome) => [
            outcome.event_start_ts,
            outcome.event_end_ts,
            outcome.yes_token_id,
        ].join(":"))
        .sort()
        .join(",")}`;
}

async function fetchYesHistory(
    yesTokenId: string,
    eventStartTs: number,
    eventEndTs: number
): Promise<PolymarketHistoryPoint[]> {
    const params = new URLSearchParams({
        market: yesTokenId,
        startTs: String(Math.max(0, eventStartTs - 15)),
        endTs: String(eventEndTs),
    });
    const urls = [
        `${POLYMARKET_PROXY_HISTORY_URL}?${params.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${params.toString()}`,
    ];
    const windowedPoints = normalizePolymarketHistoryPoints(await fetchPolymarketHistoryWithFallback(urls, {
        timeoutMs: HISTORY_REQUEST_TIMEOUT_MS,
    }));
    if (windowedPoints.length > 0) {
        return windowedPoints;
    }

    const fallbackParams = new URLSearchParams({
        market: yesTokenId,
        interval: "max",
    });
    const fallbackPoints = normalizePolymarketHistoryPoints(await fetchPolymarketHistoryWithFallback([
        `${POLYMARKET_PROXY_HISTORY_URL}?${fallbackParams.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${fallbackParams.toString()}`,
    ], { timeoutMs: HISTORY_REQUEST_TIMEOUT_MS }));
    return fallbackPoints.filter(
        (pt) => pt.t >= eventStartTs && pt.t <= eventEndTs
    );
}

async function fetchPricePointsForEvent(
    outcome: PolymarketOutcomeRow,
    seriesId: string
): Promise<PolymarketPricePoint[]> {
    if (!outcome.yes_token_id) return [];

    try {
        const yesPoints = await fetchYesHistory(
            outcome.yes_token_id,
            outcome.event_start_ts,
            outcome.event_end_ts
        );

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
    let fetched = 0;

    const rows = await mapWithConcurrencyLimit(outcomes, MAX_CONCURRENT_FETCHES, async (outcome) => {
        const points = await fetchPricePointsForEvent(outcome, seriesId);
        fetched += 1;
        onProgress?.(fetched, outcomes.length);
        return points;
    });

    return rows.flat();
}

async function loadExistingPricePoints(
    seriesId: string,
    eventStartTs: readonly number[]
): Promise<PolymarketPricePoint[]> {
    if (eventStartTs.length === 0) {
        return [];
    }

    const rows = await runCoalesced(
        inFlightExistingLoads,
        buildEventStartKey(seriesId, eventStartTs),
        async () => {
            const chunks: number[][] = [];
            for (let index = 0; index < eventStartTs.length; index += MAX_EVENT_STARTS_PER_LOAD_REQUEST) {
                chunks.push(eventStartTs.slice(index, index + MAX_EVENT_STARTS_PER_LOAD_REQUEST));
            }

            const chunkRows = await mapWithConcurrencyLimit(
                chunks,
                MAX_CONCURRENT_LOAD_REQUESTS,
                (chunk) => loadPolymarketPricePoints({
                    seriesId,
                    eventStartTs: chunk,
                    limit: MAX_PRICE_POINTS_PER_LOAD_REQUEST,
                })
            );

            return chunkRows
                .flat()
                .sort((left, right) => left.ts - right.ts);
        }
    );

    return rows.slice();
}

function buildCoveredEventStartSet(
    outcomes: readonly PolymarketOutcomeRow[],
    points: readonly PolymarketPricePoint[]
): Set<number> {
    const coverageByEvent = new Map<number, { timestamps: Set<number>; latestTs: number }>();

    for (const point of points) {
        let coverage = coverageByEvent.get(point.event_start_ts);
        if (!coverage) {
            coverage = {
                timestamps: new Set<number>(),
                latestTs: Number.NEGATIVE_INFINITY,
            };
            coverageByEvent.set(point.event_start_ts, coverage);
        }
        coverage.timestamps.add(point.ts);
        coverage.latestTs = Math.max(coverage.latestTs, point.ts);
    }

    const coveredEventStarts = new Set<number>();
    for (const outcome of outcomes) {
        const coverage = coverageByEvent.get(outcome.event_start_ts);
        if (
            coverage
            && coverage.timestamps.size >= 2
            && coverage.latestTs >= outcome.event_end_ts - 60
        ) {
            coveredEventStarts.add(outcome.event_start_ts);
        }
    }

    return coveredEventStarts;
}

function mergePricePoints(
    left: readonly PolymarketPricePoint[],
    right: readonly PolymarketPricePoint[]
): PolymarketPricePoint[] {
    const mergedByKey = new Map<string, PolymarketPricePoint>();
    for (const point of [...left, ...right]) {
        mergedByKey.set(`${point.series_id}:${point.event_start_ts}:${point.ts}`, point);
    }
    return Array.from(mergedByKey.values()).sort((a, b) => a.ts - b.ts);
}

async function ensurePricePointsViaApi(
    seriesId: string,
    outcomes: readonly PolymarketOutcomeRow[]
): Promise<EnsurePolymarketPricePointsResult> {
    const chunks: PolymarketOutcomeRow[][] = [];
    for (let index = 0; index < outcomes.length; index += MAX_OUTCOMES_PER_SERVER_ENSURE) {
        chunks.push(outcomes.slice(index, index + MAX_OUTCOMES_PER_SERVER_ENSURE));
    }

    const results = await mapWithConcurrencyLimit(
        chunks,
        MAX_CONCURRENT_ENSURE_REQUESTS,
        (chunk) => runCoalesced(
            inFlightServerEnsures,
            buildEnsureKey(seriesId, chunk),
            () => ensurePolymarketPricePointsWithMetadata({
                seriesId,
                outcomes: chunk,
            })
        )
    );

    return {
        rows: mergePricePoints([], results.flatMap((result) => result.rows)),
        upserted: results.reduce((sum, result) => sum + result.upserted, 0),
        fetchedEvents: results.reduce((sum, result) => sum + result.fetchedEvents, 0),
        failedEvents: results.reduce((sum, result) => sum + result.failedEvents, 0),
        missingTokenEvents: results.reduce((sum, result) => sum + result.missingTokenEvents, 0),
    };
}

export async function ensurePricePointsForOutcomes(
    outcomes: readonly PolymarketOutcomeRow[],
    seriesId: string,
    options?: {
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

    let basePoints = existingPoints;
    let outcomesToFetch = uncoveredOutcomes;

    try {
        const ensureResult = await ensurePricePointsViaApi(seriesId, uncoveredOutcomes);
        const ensuredPoints = ensureResult.rows;
        debugLogger.info("polymarket.price_points.ensure_via_api_complete", {
            seriesId,
            toFetch: uncoveredOutcomes.length,
            rows: ensuredPoints.length,
            upserted: ensureResult.upserted,
            fetchedEvents: ensureResult.fetchedEvents,
            failedEvents: ensureResult.failedEvents,
            missingTokenEvents: ensureResult.missingTokenEvents,
        });
        if (ensuredPoints.length > 0) {
            const mergedPoints = mergePricePoints(existingPoints, ensuredPoints);
            const coveredAfterEnsure = buildCoveredEventStartSet(outcomes, mergedPoints);
            outcomesToFetch = uncoveredOutcomes.filter(
                (outcome) => !coveredAfterEnsure.has(outcome.event_start_ts)
            );
            if (outcomesToFetch.length === 0) {
                return mergedPoints;
            }
            basePoints = mergedPoints;
            debugLogger.info("polymarket.price_points.ensure_via_api_partial", {
                seriesId,
                remainingEvents: outcomesToFetch.length,
            });
        }
    } catch (error) {
        debugLogger.info("polymarket.price_points.ensure_via_api_failed", {
            seriesId,
            toFetch: uncoveredOutcomes.length,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const newPoints = await processBatch(
        outcomesToFetch,
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

    return mergePricePoints(basePoints, newPoints);
}
