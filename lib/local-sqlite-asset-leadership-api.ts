import type { AssetLeadershipObservation, AssetLeadershipPersistedRun } from "./types/finder";
import {
    checkLocalApiAvailable,
    fetchLocalApi,
} from "./local-api-transport";

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

export async function loadAssetLeadershipRuns(limit = 50): Promise<AssetLeadershipPersistedRun[]> {
    const available = await checkAvailable();
    if (!available) return [];

    try {
        const response = await fetchLocalApi(
            `/api/sqlite/load-asset-leadership?limit=${limit}`,
            { method: "GET", headers: { Accept: "application/json" } },
            SQLITE_REQUEST_TIMEOUT_MS
        );
        if (!response.ok) return [];
        const payload = (await response.json()) as { ok?: boolean; runs?: AssetLeadershipPersistedRun[] };
        if (!payload?.ok || !Array.isArray(payload.runs)) return [];
        return payload.runs;
    } catch {
        return [];
    }
}

export async function storeAssetLeadershipRun(run: AssetLeadershipPersistedRun, observations: readonly AssetLeadershipObservation[]): Promise<boolean> {
    const available = await checkAvailable();
    if (!available) return false;

    try {
        const response = await fetchLocalApi("/api/sqlite/store-asset-leadership", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                runId: run.runId,
                createdAt: run.createdAt,
                interval: run.interval,
                strategyPreset: run.strategyPreset,
                strategyCount: run.strategyCount,
                universeSymbolCount: run.universeSymbolCount,
                topN: run.topN,
                candidates: run.candidates,
                observations,
            }),
        }, SQLITE_STORE_TIMEOUT_MS);
        if (!response.ok) return false;
        const payload = (await response.json()) as { ok?: boolean };
        return payload?.ok === true;
    } catch {
        return false;
    }
}

export async function clearAssetLeadershipRuns(): Promise<boolean> {
    const available = await checkAvailable();
    if (!available) return false;

    try {
        const response = await fetchLocalApi("/api/sqlite/clear-asset-leadership", {
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
