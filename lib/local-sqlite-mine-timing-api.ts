import type { TimingEdgePersistedRun } from "./batch-backtest/mine-timing-persistence";
import {
    checkLocalApiAvailable,
    fetchLocalApi,
} from "./local-api-transport";

/**
 * Browser-side transport for Mine Timing persistence. Mirrors the
 * asset-leadership transport 1:1 (same availability cache, same timeout
 * bands, same `ok: boolean` envelope). The Assets tab consumes loaded runs
 * via `loadMineTimingRuns`.
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

export async function loadMineTimingRuns(limit = 50): Promise<TimingEdgePersistedRun[]> {
    const available = await checkAvailable();
    if (!available) return [];

    try {
        const response = await fetchLocalApi(
            `/api/sqlite/load-mine-timing?limit=${limit}`,
            { method: "GET", headers: { Accept: "application/json" } },
            SQLITE_REQUEST_TIMEOUT_MS
        );
        if (!response.ok) return [];
        const payload = (await response.json()) as { ok?: boolean; runs?: TimingEdgePersistedRun[] };
        if (!payload?.ok || !Array.isArray(payload.runs)) return [];
        return payload.runs;
    } catch {
        return [];
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
