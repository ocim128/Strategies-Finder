import type { TimingEdgePersistedRun } from "./batch-backtest/mine-timing-persistence";
import {
    checkLocalApiAvailable,
    fetchLocalApi,
    isAbortLikeError,
} from "./local-api-transport";
import { debugLogger } from "./debug-logger";

/**
 * Browser-side transport for Mine Timing persistence. Mirrors the
 * asset-leadership transport 1:1 (same availability cache, same timeout
 * bands, same `ok: boolean` envelope). The Assets tab consumes loaded runs
 * via `loadMineTimingRunsResult`.
 */

const AVAILABILITY_CACHE_MS = 60000;
const SQLITE_REQUEST_TIMEOUT_MS = 8000;
const SQLITE_STORE_TIMEOUT_MS = 30000;
const SQLITE_API_AVAILABILITY_KEY = "sqlite";

async function checkAvailable(): Promise<boolean> {
    return checkLocalApiAvailable({
        key: SQLITE_API_AVAILABILITY_KEY,
        statusUrl: "/api/sqlite/status",
        cacheMs: AVAILABILITY_CACHE_MS,
        timeoutMs: SQLITE_REQUEST_TIMEOUT_MS,
    });
}

/**
 * Discriminated load result. Pre-Finding 3, the load path collapsed
 * API unavailability, timeouts, HTTP errors, invalid responses, and a
 * genuinely empty database into the same `[]` — so Asset Leadership showed
 * "No timing-edge data yet" even when the real problem was a missing dev
 * server route or a SQLite failure. The discriminated result lets the
 * service render an actionable diagnostic instead of a misleading empty
 * state.
 */
export type MineTimingLoadResult =
    | { ok: true; runs: TimingEdgePersistedRun[] }
    | { ok: false; reason: "unavailable" | "timeout" | "http" | "invalid_response"; message?: string };

export async function loadMineTimingRunsResult(limit = 50): Promise<MineTimingLoadResult> {
    const available = await checkAvailable();
    if (!available) {
        debugLogger.info("mine_timing.load.unavailable", { limit });
        return { ok: false, reason: "unavailable" };
    }

    const startedAt = Date.now();
    try {
        const response = await fetchLocalApi(
            `/api/sqlite/load-mine-timing?limit=${limit}`,
            { method: "GET", headers: { Accept: "application/json" } },
            SQLITE_REQUEST_TIMEOUT_MS
        );
        if (!response.ok) {
            debugLogger.warn("mine_timing.load.http_error", { limit, status: response.status, ms: Date.now() - startedAt });
            return { ok: false, reason: "http", message: `HTTP ${response.status}` };
        }
        const payload = (await response.json()) as { ok?: boolean; runs?: TimingEdgePersistedRun[] };
        if (!payload?.ok || !Array.isArray(payload.runs)) {
            debugLogger.warn("mine_timing.load.invalid_response", { limit, ms: Date.now() - startedAt });
            return { ok: false, reason: "invalid_response" };
        }
        debugLogger.info("mine_timing.load.ok", { limit, runs: payload.runs.length, ms: Date.now() - startedAt });
        return { ok: true, runs: payload.runs };
    } catch (error) {
        const reason: "unavailable" | "timeout" = isAbortLikeError(error) ? "timeout" : "unavailable";
        debugLogger.warn("mine_timing.load.throw", { limit, reason, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
        return { ok: false, reason, message: error instanceof Error ? error.message : String(error) };
    }
}

export async function storeMineTimingRun(run: TimingEdgePersistedRun): Promise<boolean> {
    const available = await checkAvailable();
    if (!available) return false;

    try {
        const response = await fetchLocalApi("/api/sqlite/store-mine-timing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                runId: run.runId,
                createdAt: run.createdAt,
                interval: run.interval,
                strategyKey: run.strategyKey,
                source: run.source,
                pairCount: run.pairCount,
                reruns: run.reruns,
                subsetSize: run.subsetSize,
                seed: run.seed,
                verdicts: run.verdicts,
            }),
        }, SQLITE_STORE_TIMEOUT_MS);
        if (!response.ok) return false;
        const payload = (await response.json()) as { ok?: boolean };
        return payload?.ok === true;
    } catch {
        return false;
    }
}

export async function clearMineTimingRuns(): Promise<boolean> {
    const available = await checkAvailable();
    if (!available) return false;

    try {
        const response = await fetchLocalApi("/api/sqlite/clear-mine-timing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        }, SQLITE_REQUEST_TIMEOUT_MS);
        if (!response.ok) return false;
        const payload = (await response.json()) as { ok?: boolean };
        return payload?.ok === true;
    } catch {
        return false;
    }
}
