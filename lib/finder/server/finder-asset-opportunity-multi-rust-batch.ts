import {
    compactMultiAssetWorkload,
    prepareRustRequest,
} from "../../rust-engine-client";
import type {
    PreparedRustRequest,
    RustMultiAssetBatchWorkload,
    RustEngineClient,
} from "../../rust-engine-client";
import type {
    AssetOpportunityRustBatchDispatch,
    AssetOpportunityRustBatchDispatchInput,
    AssetOpportunityRustBatchFailureReason,
    AssetOpportunityRustFreshBatchDispatch,
    AssetOpportunityRustFreshBatchDispatchInput,
    RustAssetOpportunityCandidateResult,
    RustAssetOpportunityFreshEntryCandidateResult,
} from "./finder-asset-opportunity-rust-batch";
import type { OHLCVData } from "../../types/strategies";
import {
    dispatchAssetOpportunityRustBatch,
    dispatchAssetOpportunityRustFreshEntryBatch,
    normalizeAssetOpportunityRustSummaryCandidateResult,
    validateAssetOpportunityRustFreshBatchResponse,
    validateAssetOpportunityRustSummaryBatchResponse,
} from "./finder-asset-opportunity-rust-batch";

// Keep each Rust request below the transport timeout at the default
// candidate-pool size. The endpoint parallelizes every workload internally;
// oversized requests only hold the HTTP slot longer and turn into a full
// TypeScript fallback when they cross the timeout.
const MAX_WORKLOADS_PER_REQUEST = 128;
const MAX_CACHE_WORKLOADS_PER_REQUEST = 32;
const MAX_BATCH_WAIT_MS = 12;
const DIRECT_FALLBACK_CONCURRENCY = 8;

type MultiAssetBatchClient = Pick<
    RustEngineClient,
    | "runMultiAssetAssetOpportunityBatchBacktestWithStatus"
    | "runMultiAssetFreshEntryBatchBacktestWithStatus"
    | "getDataCacheKey"
    | "invalidateCachedDataId"
> & Partial<Pick<RustEngineClient, "cacheData" | "cacheMultiAssetDataWithStatus">>;

type CandidateQueueEntry = {
    token: string;
    input: AssetOpportunityRustBatchDispatchInput;
    resolve: (result: AssetOpportunityRustBatchDispatch) => void;
};

type FreshQueueEntry = {
    token: string;
    input: AssetOpportunityRustFreshBatchDispatchInput;
    resolve: (result: AssetOpportunityRustFreshBatchDispatch) => void;
}

type CacheQueueEntry = {
    id: string;
    dataKey: string;
    data: OHLCVData[];
    signal: AbortSignal | undefined;
    maxRequestBytes: number;
    resolve: (cacheId: string | null) => void;
};

function prepareMultiRequest(request: {
    workloads: RustMultiAssetBatchWorkload[];
    [key: string]: unknown;
}): PreparedRustRequest {
    return prepareRustRequest({
        ...request,
        workloads: request.workloads.map(compactMultiAssetWorkload),
    });
}

function resolveTransportFallback(
    entries: Array<CandidateQueueEntry | FreshQueueEntry>,
    reason: AssetOpportunityRustBatchFailureReason,
    requestBytes: number,
    message?: string,
): void {
    for (const entry of entries) {
        entry.resolve({
            status: reason === "cancelled" ? "cancelled" : "fallback",
            reason,
            requests: 1,
            requestBytes,
            latencyMs: 0,
            ...(message ? { message } : {}),
        });
    }
}

async function resolveDirectCandidateFallbacks(entries: CandidateQueueEntry[]): Promise<void> {
    for (let start = 0; start < entries.length; start += DIRECT_FALLBACK_CONCURRENCY) {
        await Promise.all(entries.slice(start, start + DIRECT_FALLBACK_CONCURRENCY).map(async (entry) => {
            entry.resolve(await dispatchAssetOpportunityRustBatch(entry.input));
        }));
    }
}

async function resolveDirectFreshFallbacks(entries: FreshQueueEntry[]): Promise<void> {
    for (let start = 0; start < entries.length; start += DIRECT_FALLBACK_CONCURRENCY) {
        await Promise.all(entries.slice(start, start + DIRECT_FALLBACK_CONCURRENCY).map(async (entry) => {
            entry.resolve(await dispatchAssetOpportunityRustFreshEntryBatch(entry.input));
        }));
    }
}

export interface AssetOpportunityRustMultiBatchCoordinator {
    dispatchCandidate(input: AssetOpportunityRustBatchDispatchInput): Promise<AssetOpportunityRustBatchDispatch>;
    dispatchFresh(input: AssetOpportunityRustFreshBatchDispatchInput): Promise<AssetOpportunityRustFreshBatchDispatch>;
}

/**
 * Coalesces independent per-asset Rust calls produced by the Finder into
 * bounded multi-dataset requests. The caller still receives one dispatch
 * result per asset, so ranking, fresh detection, and fallback semantics stay
 * unchanged.
 */
export function createAssetOpportunityRustMultiBatchCoordinator(
    client: MultiAssetBatchClient,
    options?: { datasetCache?: Map<string, Promise<string | null>> },
): AssetOpportunityRustMultiBatchCoordinator {
    const candidateQueue: CandidateQueueEntry[] = [];
    const freshQueue: FreshQueueEntry[] = [];
    let sequence = 0;
    let candidateTimer: ReturnType<typeof setTimeout> | undefined;
    let freshTimer: ReturnType<typeof setTimeout> | undefined;
    let candidateFlushing = false;
    let freshFlushing = false;
    // The Rust endpoint parallelizes each request with Rayon. Keep candidate
    // and fresh-entry requests from multiplying independent Rayon pools and
    // oversubscribing the host when both queues are active.
    let rustRequestTail: Promise<void> = Promise.resolve();
    const cachedIdsByDataKey = new Map<string, string>();
    const pendingCacheIdsByDataKey = new Map<string, Promise<string | null>>();
    const cacheQueue: CacheQueueEntry[] = [];
    let cacheSequence = 0;
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    let cacheFlushing = false;
    const sharedDatasetCache = options?.datasetCache;
    const getDataKey = (data: OHLCVData[]): string => {
        return client.getDataCacheKey(data);
    };

    const scheduleCandidateFlush = (): void => {
        if (candidateTimer !== undefined) return;
        candidateTimer = setTimeout(() => {
            candidateTimer = undefined;
            void flushCandidates();
        }, MAX_BATCH_WAIT_MS);
    };
    const scheduleFreshFlush = (): void => {
        if (freshTimer !== undefined) return;
        freshTimer = setTimeout(() => {
            freshTimer = undefined;
            void flushFresh();
        }, MAX_BATCH_WAIT_MS);
    };

    async function withRustRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
        const previous = rustRequestTail;
        let release!: () => void;
        rustRequestTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    const scheduleCacheFlush = (): void => {
        if (cacheTimer !== undefined) return;
        cacheTimer = setTimeout(() => {
            cacheTimer = undefined;
            void flushCacheQueue();
        }, MAX_BATCH_WAIT_MS);
    };

    async function flushCacheQueue(): Promise<void> {
        if (cacheFlushing) return;
        cacheFlushing = true;
        try {
            while (cacheQueue.length > 0) {
                const entries = cacheQueue.splice(0, MAX_CACHE_WORKLOADS_PER_REQUEST);
                const maxRequestBytes = Math.min(...entries.map((entry) => entry.maxRequestBytes));
                const cacheIds = new Map<string, string>();
                if (client.cacheMultiAssetDataWithStatus) {
                    const response = await client.cacheMultiAssetDataWithStatus(
                        entries.map((entry) => ({ id: entry.id, data: entry.data })),
                        {
                            signal: entries[0]!.signal,
                            maxRequestBytes,
                            maxResponseBytes: 1 * 1024 * 1024,
                        },
                    );
                    if (response.ok) {
                        const payload = response.response as { datasets?: unknown };
                        if (Array.isArray(payload.datasets)) {
                            for (const dataset of payload.datasets) {
                                if (!dataset || typeof dataset !== "object") continue;
                                const id = (dataset as { id?: unknown }).id;
                                const cacheId = (dataset as { cacheId?: unknown }).cacheId;
                                if (typeof id === "string" && typeof cacheId === "string" && cacheId.length > 0) {
                                    cacheIds.set(id, cacheId);
                                }
                            }
                        }
                    }
                } else if (client.cacheData) {
                    await Promise.all(entries.map(async (entry) => {
                        const cacheId = await client.cacheData!(entry.data, {
                            signal: entry.signal,
                            maxRequestBytes: entry.maxRequestBytes,
                            maxResponseBytes: 1 * 1024 * 1024,
                        }).catch(() => null);
                        if (cacheId) cacheIds.set(entry.id, cacheId);
                    }));
                }
                for (const entry of entries) {
                    const cacheId = cacheIds.get(entry.id) ?? null;
                    if (cacheId) {
                        cachedIdsByDataKey.set(entry.dataKey, cacheId);
                        sharedDatasetCache?.set(entry.dataKey, Promise.resolve(cacheId));
                    } else {
                        pendingCacheIdsByDataKey.delete(entry.dataKey);
                    }
                    entry.resolve(cacheId);
                }
            }
        } finally {
            cacheFlushing = false;
            if (cacheQueue.length > 0) scheduleCacheFlush();
        }
    }

    function requestCacheId(
        dataKey: string,
        data: OHLCVData[],
        signal: AbortSignal | undefined,
        maxRequestBytes: number,
    ): Promise<string | null> {
        if (!client.cacheData && !client.cacheMultiAssetDataWithStatus) return Promise.resolve(null);
        const existing = pendingCacheIdsByDataKey.get(dataKey);
        if (existing) return existing;
        const promise = new Promise<string | null>((resolve) => {
            cacheQueue.push({
                id: `dataset-${cacheSequence++}`,
                dataKey,
                data,
                signal,
                maxRequestBytes,
                resolve,
            });
        });
        pendingCacheIdsByDataKey.set(dataKey, promise);
        if (cacheQueue.length >= MAX_CACHE_WORKLOADS_PER_REQUEST) void flushCacheQueue();
        else scheduleCacheFlush();
        return promise;
    }

    async function sendCandidateGroup(entries: CandidateQueueEntry[]): Promise<void> {
        const maxRequestBytes = Math.min(...entries.map((entry) => entry.input.maxRequestBytes));
        const maxResponseBytes = Math.min(...entries.map((entry) => entry.input.maxResponseBytes ?? Number.MAX_SAFE_INTEGER));
        const workloads: RustMultiAssetBatchWorkload[] = entries.map((entry) => ({
            id: entry.token,
            ...(entry.input.cacheId
                ? { cacheId: entry.input.cacheId }
                : { data: entry.input.cacheData ?? entry.input.data }),
            ...(entry.input.datasetStartIndex !== undefined ? { dataStartIndex: entry.input.datasetStartIndex } : {}),
            ...(entry.input.datasetEndIndex !== undefined ? { dataEndIndex: entry.input.datasetEndIndex } : {}),
            items: entry.input.items.map((item) => ({
                ...item,
                id: `${entry.token}:${item.id}`,
            })),
            lastDataTime: entry.input.lastDataTime ?? null,
        }));
        const requestBase = {
            initialCapital: entries[0]!.input.initialCapital,
            positionSizePercent: entries[0]!.input.positionSizePercent,
            commissionPercent: entries[0]!.input.commissionPercent,
            baseSettings: entries[0]!.input.baseSettings,
            sizing: entries[0]!.input.sizing,
        };
        const executionWorkloads = await resolveCachedWorkloads(
            workloads,
            entries[0]!.input.signal,
            maxRequestBytes,
        );
        const requestWorkloads = executionWorkloads ?? workloads;
        const request = { ...requestBase, workloads: requestWorkloads };
        const preparedRequest = prepareMultiRequest(request);
        const requestBytes = preparedRequest.requestBytes;
        if (requestBytes > maxRequestBytes) {
            await resolveDirectCandidateFallbacks(entries);
            return;
        }
        const transport = await withRustRequestSlot(() => client.runMultiAssetAssetOpportunityBatchBacktestWithStatus(
            requestWorkloads,
            request.initialCapital,
            request.positionSizePercent,
            request.commissionPercent,
            request.baseSettings,
            request.sizing,
            {
                signal: entries[0]!.input.signal,
                maxRequestBytes,
                maxResponseBytes: Number.isFinite(maxResponseBytes) ? maxResponseBytes : undefined,
                preparedRequest,
            },
        ));
        if (!transport.ok) {
            if (
                transport.reason === "timeout"
                || transport.reason === "network_error"
                || transport.reason === "health_unavailable"
                || transport.reason === "cancelled"
            ) {
                resolveTransportFallback(
                    entries,
                    transport.reason,
                    transport.requestBytes ?? requestBytes,
                    transport.message,
                );
                return;
            }
            if (transport.reason === "http_error") invalidateCachedWorkloads(entries, workloads);
            await resolveDirectCandidateFallbacks(entries);
            return;
        }
        const expectedIds = workloads.flatMap((workload) => workload.items.map((item) => item.id));
        const validated = validateAssetOpportunityRustSummaryBatchResponse(transport.response, expectedIds);
        if (!validated.ok) {
            await resolveDirectCandidateFallbacks(entries);
            return;
        }
        rememberResponseCacheIds(transport.response, entries, workloads);
        for (const entry of entries) {
            const results = new Map<string, RustAssetOpportunityCandidateResult>();
            for (const item of entry.input.items) {
                const wireId = `${entry.token}:${item.id}`;
                const result = validated.results.get(wireId);
                if (!result) {
                    await resolveDirectCandidateFallbacks(entries);
                    return;
                }
                const normalized = normalizeAssetOpportunityRustSummaryCandidateResult(result.summary);
                results.set(item.id, {
                    id: item.id,
                    result: normalized.result,
                    selectionResult: normalized.selectionResult,
                    endpointAdjusted: normalized.endpointAdjusted,
                    endpointRemovedTrades: normalized.endpointRemovedTrades,
                });
            }
            entry.resolve({
                status: "completed",
                results,
                requests: 1,
                requestBytes,
                latencyMs: (transport.elapsedMs ?? 0) / entries.length,
            });
        }
    }

    async function sendFreshGroup(entries: FreshQueueEntry[]): Promise<void> {
        const maxRequestBytes = Math.min(...entries.map((entry) => entry.input.maxRequestBytes));
        const maxResponseBytes = Math.min(...entries.map((entry) => entry.input.maxResponseBytes ?? Number.MAX_SAFE_INTEGER));
        const workloads: RustMultiAssetBatchWorkload[] = entries.map((entry) => ({
            id: entry.token,
            ...(entry.input.cacheId
                ? { cacheId: entry.input.cacheId }
                : { data: entry.input.cacheData ?? entry.input.data }),
            ...(entry.input.datasetStartIndex !== undefined ? { dataStartIndex: entry.input.datasetStartIndex } : {}),
            ...(entry.input.datasetEndIndex !== undefined ? { dataEndIndex: entry.input.datasetEndIndex } : {}),
            items: entry.input.items.map((item) => ({
                ...item,
                id: `${entry.token}:${item.id}`,
            })),
        }));
        const executionWorkloads = await resolveCachedWorkloads(workloads, entries[0]!.input.signal, maxRequestBytes);
        const requestWorkloads = executionWorkloads ?? workloads;
        const request = {
            workloads: requestWorkloads,
            initialCapital: entries[0]!.input.initialCapital,
            positionSizePercent: entries[0]!.input.positionSizePercent,
            commissionPercent: entries[0]!.input.commissionPercent,
            baseSettings: entries[0]!.input.baseSettings,
            sizing: entries[0]!.input.sizing,
        };
        const preparedRequest = prepareMultiRequest(request);
        const requestBytes = preparedRequest.requestBytes;
        if (requestBytes > maxRequestBytes) {
            await resolveDirectFreshFallbacks(entries);
            return;
        }
        const transport = await withRustRequestSlot(() => client.runMultiAssetFreshEntryBatchBacktestWithStatus(
            requestWorkloads,
            request.initialCapital,
            request.positionSizePercent,
            request.commissionPercent,
            request.baseSettings,
            request.sizing,
            {
                signal: entries[0]!.input.signal,
                maxRequestBytes,
                maxResponseBytes: Number.isFinite(maxResponseBytes) ? maxResponseBytes : undefined,
                preparedRequest,
            },
        ));
        if (!transport.ok) {
            if (
                transport.reason === "timeout"
                || transport.reason === "network_error"
                || transport.reason === "health_unavailable"
                || transport.reason === "cancelled"
            ) {
                resolveTransportFallback(
                    entries,
                    transport.reason,
                    transport.requestBytes ?? requestBytes,
                    transport.message,
                );
                return;
            }
            if (transport.reason === "http_error") invalidateCachedWorkloads(entries, workloads);
            await resolveDirectFreshFallbacks(entries);
            return;
        }
        const expectedIds = workloads.flatMap((workload) => workload.items.map((item) => item.id));
        const validated = validateAssetOpportunityRustFreshBatchResponse(transport.response, expectedIds);
        if (!validated.ok) {
            await resolveDirectFreshFallbacks(entries);
            return;
        }
        for (const entry of entries) {
            const results = new Map<string, RustAssetOpportunityFreshEntryCandidateResult>();
            for (const item of entry.input.items) {
                const wireId = `${entry.token}:${item.id}`;
                const result = validated.results.get(wireId);
                if (!result) {
                    await resolveDirectFreshFallbacks(entries);
                    return;
                }
                results.set(item.id, { id: item.id, summary: result.summary });
            }
            entry.resolve({
                status: "completed",
                results,
                requests: 1,
                requestBytes,
                latencyMs: (transport.elapsedMs ?? 0) / entries.length,
            });
        }
    }

    function invalidateCachedWorkloads(
        entries: Array<CandidateQueueEntry | FreshQueueEntry>,
        workloads: RustMultiAssetBatchWorkload[],
    ): void {
        for (const workload of workloads) {
            if (workload.cacheId) client.invalidateCachedDataId(workload.cacheId);
        }
        for (const entry of entries) {
            if (entry.input.data) forgetDataCacheReference(entry.input.data);
            if ("cacheData" in entry.input && entry.input.cacheData) {
                forgetDataCacheReference(entry.input.cacheData);
            }
        }
    }

    function forgetDataCacheReference(data: OHLCVData[]): void {
        const dataKey = getDataKey(data);
        cachedIdsByDataKey.delete(dataKey);
        pendingCacheIdsByDataKey.delete(dataKey);
        sharedDatasetCache?.delete(dataKey);
    }

    function rememberResponseCacheIds(
        response: unknown,
        entries: CandidateQueueEntry[],
        workloads: RustMultiAssetBatchWorkload[],
    ): void {
        if (!response || typeof response !== "object") return;
        const cacheIds = (response as { cacheIds?: unknown }).cacheIds;
        if (!Array.isArray(cacheIds)) return;
        const entryByToken = new Map(entries.map((entry) => [entry.token, entry]));
        const workloadByToken = new Map(workloads.map((workload) => [workload.id, workload]));
        for (const value of cacheIds) {
            if (!value || typeof value !== "object") continue;
            const token = (value as { id?: unknown }).id;
            const cacheId = (value as { cacheId?: unknown }).cacheId;
            if (typeof token !== "string" || typeof cacheId !== "string" || cacheId.length === 0) continue;
            const entry = entryByToken.get(token);
            const workload = workloadByToken.get(token);
            const data = entry?.input.cacheData ?? entry?.input.data;
            if (!workload || !data) continue;
            cachedIdsByDataKey.set(getDataKey(data), cacheId);
        }
    }

    async function resolveCachedWorkloads(
        workloads: RustMultiAssetBatchWorkload[],
        signal: AbortSignal | undefined,
        maxRequestBytes: number,
    ): Promise<RustMultiAssetBatchWorkload[] | null> {
        const cacheIds = new Map<string, string>();
        if (sharedDatasetCache) {
            await Promise.all(workloads.map(async (workload) => {
                if (workload.cacheId || !workload.data) return;
                const dataKey = getDataKey(workload.data);
                const cachedPromise = sharedDatasetCache.get(dataKey);
                if (!cachedPromise) return;
                const cacheId = await cachedPromise;
                if (cacheId) {
                    cacheIds.set(workload.id, cacheId);
                    cachedIdsByDataKey.set(dataKey, cacheId);
                }
            }));
        }
        const missing = workloads.filter((workload) => {
            if (workload.cacheId) {
                cacheIds.set(workload.id, workload.cacheId);
                return false;
            }
            const data = workload.data;
            if (!data) return false;
            const dataKey = getDataKey(data);
            const cachedId = cachedIdsByDataKey.get(dataKey) ?? cacheIds.get(workload.id);
            if (cachedId) cacheIds.set(workload.id, cachedId);
            return !cachedId;
        });
        if (missing.length > 0) {
            const dataByKey = new Map<string, OHLCVData[]>();
            for (const workload of missing) {
                if (workload.data) dataByKey.set(getDataKey(workload.data), workload.data);
            }
            const cachedEntries = await Promise.all([...dataByKey.entries()].map(([dataKey, data]) =>
                requestCacheId(dataKey, data, signal, maxRequestBytes).then((cacheId) => ({ dataKey, cacheId })),
            ));
            for (const { dataKey, cacheId } of cachedEntries) {
                if (!cacheId) return null;
                cachedIdsByDataKey.set(dataKey, cacheId);
                sharedDatasetCache?.set(dataKey, Promise.resolve(cacheId));
            }
            for (const workload of missing) {
                const data = workload.data;
                const cacheId = cacheIds.get(workload.id)
                    ?? (data ? cachedIdsByDataKey.get(getDataKey(data)) : undefined);
                if (!cacheId || !data) return null;
                cacheIds.set(workload.id, cacheId);
                cachedIdsByDataKey.set(getDataKey(data), cacheId);
            }
        }
        return workloads.map((workload) => ({
            ...workload,
            ...(cacheIds.has(workload.id)
                ? { data: undefined, cacheId: cacheIds.get(workload.id) }
                : {}),
        }));
    }

    async function flushCandidates(): Promise<void> {
        if (candidateFlushing) return;
        candidateFlushing = true;
        try {
            while (candidateQueue.length > 0) {
                const groups: CandidateQueueEntry[][] = [];
                while (candidateQueue.length > 0) {
                    groups.push(candidateQueue.splice(0, MAX_WORKLOADS_PER_REQUEST));
                }
                await Promise.all(groups.map((entries) => sendCandidateGroup(entries)));
            }
        } finally {
            candidateFlushing = false;
            if (candidateQueue.length > 0) scheduleCandidateFlush();
        }
    }

    async function flushFresh(): Promise<void> {
        if (freshFlushing) return;
        freshFlushing = true;
        try {
            while (freshQueue.length > 0) {
                const groups: FreshQueueEntry[][] = [];
                while (freshQueue.length > 0) {
                    groups.push(freshQueue.splice(0, MAX_WORKLOADS_PER_REQUEST));
                }
                await Promise.all(groups.map((entries) => sendFreshGroup(entries)));
            }
        } finally {
            freshFlushing = false;
            if (freshQueue.length > 0) scheduleFreshFlush();
        }
    }

    return {
        dispatchCandidate(input) {
            return new Promise((resolve) => {
                candidateQueue.push({ token: `candidate-${sequence++}`, input, resolve });
                if (candidateQueue.length >= MAX_WORKLOADS_PER_REQUEST) void flushCandidates();
                else scheduleCandidateFlush();
            });
        },
        dispatchFresh(input) {
            return new Promise((resolve) => {
                freshQueue.push({ token: `fresh-${sequence++}`, input, resolve });
                if (freshQueue.length >= MAX_WORKLOADS_PER_REQUEST) void flushFresh();
                else scheduleFreshFlush();
            });
        },
    };
}
