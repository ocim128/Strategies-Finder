/**
 * Vite plugin that registers the backtest HTTP API routes.
 *
 * This plugin exposes:
 * - GET  /api/backtest/health               - health + manifest fingerprint
 * - POST /api/backtest/:strategyKey          - single-run backtest
 * - POST /api/backtest/datasets             - cache dataset, return ref
 * - POST /api/backtest/:strategyKey/batch    - batch backtest
 * - POST /api/backtest/:strategyKey/search/random - random parameter search
 */

import type { Plugin } from "vite";
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import {
    executeBacktest,
    getManifestFingerprint,
} from "./backtest-executor";
import type {
    BacktestSingleRequest,
    BacktestBatchRequest,
    BacktestRandomSearchRequest,
    BacktestCrossSymbolDatasetRequest,
    DatasetUploadRequest,
    BacktestSingleResponse,
    BacktestBatchResponse,
    BacktestBatchItemResult,
    BacktestRandomSearchResponse,
    BacktestHealthResponse,
    BacktestErrorResponse,
    DatasetUploadResponse,
    CompactBacktestMetrics,
    EngineMode,
} from "./backtest-endpoint-contract";
import { BACKTEST_ENDPOINT_CAPITAL_SETTINGS, toCompactMetrics, toSlimSingleResult } from "./backtest-endpoint-contract";
import { stripEndpointIgnoredBacktestSettings } from "./backtest-endpoint-settings";
import { buildBacktestEndpointExecutorRequest } from "./backtest-endpoint-execution";
import { sendJson } from "./http-response-utils";
import type { OHLCVData, BacktestResult, StrategyParams } from "./types/strategies";
import { strategies as builtInStrategies } from "./strategies/library";
import { parseTimeToUnixSeconds } from "./time-normalization";

// ============================================================================
// Dataset cache
// ============================================================================

interface CachedDataset {
    ref: string;
    candles: OHLCVData[];
    hash: string;
    firstTime: number;
    lastTime: number;
    createdAt: number;
}

interface DatasetCacheError {
    error: string;
    status: number;
    code: string;
}

const datasetCache = new Map<string, CachedDataset>();
const DATASET_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DATASET_CACHE_MAX_ENTRIES = 200;

function createRandomSeed(): number {
    return Math.floor(Math.random() * 2147483647);
}

function cacheDataset(candles: OHLCVData[], keyHint?: string): CachedDataset | DatasetCacheError {
    // Evict stale entries periodically
    if (datasetCache.size > DATASET_CACHE_MAX_ENTRIES) {
        evictStaleDatasets();
    }

    const hash = computeCandleHash(candles);
    const ref = keyHint ?? `cache_${hash.slice(0, 12)}`;

    // If already cached with same ref, return existing
    const existing = datasetCache.get(ref);
    if (existing) {
        if (existing.hash === hash) return existing;
        return {
            error: `Cached dataset ref conflict: ${ref} already exists with different candle content.`,
            status: 409,
            code: "DATASET_REF_CONFLICT",
        };
    }

    const firstTime = toUnixSeconds(candles[0]?.time) ?? 0;
    const lastTime = toUnixSeconds(candles[candles.length - 1]?.time) ?? 0;

    const entry: CachedDataset = {
        ref,
        candles,
        hash,
        firstTime,
        lastTime,
        createdAt: Date.now(),
    };
    datasetCache.set(ref, entry);
    return entry;
}

function getDataset(ref: string): CachedDataset | null {
    const entry = datasetCache.get(ref);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > DATASET_CACHE_TTL_MS) {
        datasetCache.delete(ref);
        return null;
    }
    return entry;
}

function evictStaleDatasets(): void {
    const now = Date.now();
    for (const [ref, entry] of datasetCache) {
        if (now - entry.createdAt > DATASET_CACHE_TTL_MS) {
            datasetCache.delete(ref);
        }
    }
    if (datasetCache.size > DATASET_CACHE_MAX_ENTRIES) {
        // Still too many after TTL cleanup - evict oldest
        const entries = Array.from(datasetCache.entries())
            .sort((a, b) => a[1].createdAt - b[1].createdAt);
        const toDelete = entries.slice(0, entries.length - DATASET_CACHE_MAX_ENTRIES / 2);
        for (const [ref] of toDelete) datasetCache.delete(ref);
    }
}

function computeCandleHash(candles: OHLCVData[]): string {
    const h = createHash("md5");
    h.update(String(candles.length));
    if (candles.length === 0) {
        return h.digest("hex");
    }

    for (const candle of candles) {
        h.update(
            `${toUnixSeconds(candle.time) ?? 0}|${candle.open}|${candle.high}|${candle.low}|${candle.close}|${candle.volume};`
        );
    }

    const last = candles[candles.length - 1];
    h.update(
        `last:${toUnixSeconds(last.time) ?? 0}|${last.open}|${last.high}|${last.low}|${last.close}|${last.volume}`
    );
    return h.digest("hex");
}

function toUnixSeconds(t: OHLCVData["time"]): number | null {
    return parseTimeToUnixSeconds(t);
}

// ============================================================================
// JSON helpers
// ============================================================================

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const MAX_BODY = 100 * 1024 * 1024; // 100 MB
    for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += bytes.length;
        if (total > MAX_BODY) throw new Error("Request body too large");
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
}

function errorResponse(res: any, status: number, message: string, code?: string): void {
    sendJson(res, status, { ok: false, error: message, code } satisfies BacktestErrorResponse);
}

// ============================================================================
// Request helpers
// ============================================================================

function extractDatasetCandles(
    req: BacktestSingleRequest | BacktestBatchRequest | BacktestRandomSearchRequest,
    overrideRef?: string
): OHLCVData[] | { error: string; status: number } {
    const dataset = req.dataset;
    if (Array.isArray((dataset as any)?.candles)) {
        return (dataset as { candles: OHLCVData[] }).candles;
    }
    const ds = dataset as { ref?: string };
    const ref = overrideRef ?? ds?.ref;
    if (ref) {
        const cached = getDataset(ref);
        if (!cached) return { error: `Cached dataset not found: ${ref}`, status: 404 };
        return cached.candles;
    }
    return { error: "Invalid dataset: provide either candles array or cached ref", status: 400 };
}

function extractDatasetFromPayload(
    dataset: { candles: OHLCVData[] } | { ref: string } | undefined
): OHLCVData[] | { error: string; status: number } {
    if (Array.isArray((dataset as any)?.candles)) {
        return (dataset as { candles: OHLCVData[] }).candles;
    }
    const ref = (dataset as { ref?: string } | undefined)?.ref;
    if (typeof ref === "string" && ref.trim().length > 0) {
        const cached = getDataset(ref);
        if (!cached) return { error: `Cached dataset not found: ${ref}`, status: 404 };
        return cached.candles;
    }
    return { error: "Invalid dataset: provide either candles array or cached ref", status: 400 };
}

function extractCrossSymbolInput(
    request: { crossSymbol?: BacktestCrossSymbolDatasetRequest },
    strategyKey: string
): { secondarySymbol: string; secondaryData: OHLCVData[] } | { error: string; status: number } | null {
    const strategy = builtInStrategies[strategyKey];
    if (!strategy?.crossSymbolConfig) {
        return null;
    }

    const crossSymbol = request.crossSymbol;
    if (!crossSymbol) {
        return {
            error: `Strategy "${strategyKey}" requires crossSymbol.secondarySymbol and crossSymbol.dataset in the endpoint request.`,
            status: 400,
        };
    }

    const secondarySymbol = crossSymbol.secondarySymbol?.trim().toUpperCase();
    if (!secondarySymbol) {
        return {
            error: `crossSymbol.secondarySymbol is required for strategy "${strategyKey}".`,
            status: 400,
        };
    }

    const secondaryDataOrError = extractDatasetFromPayload(crossSymbol.dataset);
    if ("error" in secondaryDataOrError) {
        return secondaryDataOrError;
    }

    return {
        secondarySymbol,
        secondaryData: secondaryDataOrError,
    };
}

// ============================================================================
// Random parameter generator
// ============================================================================

/**
 * Seeded PRNG (mulberry32) so that random search is deterministic for
 * external reproducibility.
 */
function seededRandom(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function generateRandomParams(
    baseParams: StrategyParams,
    count: number,
    rangePercent: number,
    seed: number,
    freezeKeys: string[],
    paramSpecs: Record<string, number | [number, number] | [number, number, number]> | undefined
): StrategyParams[] {
    const rng = seededRandom(seed);
    const freezeSet = new Set(freezeKeys ?? []);
    const results: StrategyParams[] = [];

    for (let i = 0; i < count; i++) {
        const gen: StrategyParams = {};

        // Generate randomized params for known keys
        const allKeys = new Set([
            ...Object.keys(baseParams),
            ...(paramSpecs ? Object.keys(paramSpecs) : []),
        ]);

        for (const key of allKeys) {
            if (freezeSet.has(key)) {
                gen[key] = baseParams[key] ?? 0;
                continue;
            }

            const spec = paramSpecs?.[key];
            if (typeof spec === "number") {
                // Fixed override
                gen[key] = spec;
            } else if (Array.isArray(spec)) {
                const [min, max, step] = spec;
                gen[key] = steppedRandom(min, max, step ?? 1, rng);
            } else {
                // Default: rangePercent around base
                const base = baseParams[key] ?? 0;
                const halfRange = (base * rangePercent) / 100;
                gen[key] = base + (rng() - 0.5) * 2 * halfRange;
            }
        }

        results.push(gen);
    }

    return results;
}

function steppedRandom(min: number, max: number, step: number, rng: () => number): number {
    if (step <= 0) return min + rng() * (max - min);
    const steps = Math.floor((max - min) / step);
    return min + Math.floor(rng() * (steps + 1)) * step;
}

function getRequestBaseUrl(req?: IncomingMessage): string | undefined {
    const host = req?.headers?.host;
    if (typeof host !== "string" || host.trim().length === 0) return undefined;
    const forwardedProto = req?.headers?.["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto)
        ? forwardedProto[0]
        : typeof forwardedProto === "string" && forwardedProto.trim().length > 0
            ? forwardedProto
            : "http";
    return `${proto}://${host}`;
}

// ============================================================================
// Endpoint handlers
// ============================================================================

async function handleSingleBacktest(
    strategyKey: string,
    body: Record<string, unknown>,
    httpRequest?: import("http").IncomingMessage
): Promise<BacktestSingleResponse | BacktestErrorResponse> {
    const req = body as unknown as BacktestSingleRequest;

    if (!req.symbol || !req.interval) {
        return { ok: false, error: "symbol and interval are required" };
    }
    if (!req.strategyParams || typeof req.strategyParams !== "object") {
        return { ok: false, error: "strategyParams is required" };
    }

    const candlesOrError = extractDatasetCandles(req);
    if ("error" in candlesOrError) {
        return { ok: false, error: candlesOrError.error as string, code: "DATASET_ERROR" };
    }
    const candles = candlesOrError as OHLCVData[];
    const crossSymbolInput = extractCrossSymbolInput(req, strategyKey);
    if (crossSymbolInput && "error" in crossSymbolInput) {
        return { ok: false, error: crossSymbolInput.error, code: "DATASET_ERROR" };
    }

    // Resolve context
    const ctx = req.context ?? {};
    const nowSec = ctx.nowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = ctx.blockRange ?? null;
    const annotatePolymarket = ctx.annotatePolymarket ?? false;
    const engineMode = ctx.engineMode ?? "auto";

    let actualStrategyParams = req.strategyParams;
    let didRandomize = false;
    let randomSeed: number | undefined;

    // Fix: Merge requested params with the specific strategy's defaults
    // because standard backtest endpoint payloads might be copied from other strategies.
    // If random-parameter-range is used, we must randomize based on the TARGET strategy's defaults
    // not the potentially unrelated JSON payload parameters!
    const targetStrategy = builtInStrategies[strategyKey];
    if (targetStrategy) {
        const defaultTargetParams = targetStrategy.defaultParams ?? {};
        actualStrategyParams = { ...defaultTargetParams, ...req.strategyParams };
        
        // Remove keys that don't belong to the target strategy to avoid randomizing irrelevant params
        for (const key of Object.keys(actualStrategyParams)) {
            if (!(key in defaultTargetParams)) {
                delete actualStrategyParams[key];
            }
        }
    }

    const randomRangeHeader = httpRequest?.headers?.["random-parameter-range"];
    if (typeof randomRangeHeader === "string" && randomRangeHeader.trim().length > 0) {
        const rangeStr = randomRangeHeader;
        const rangePercent = parseFloat(rangeStr);
        if (!Number.isNaN(rangePercent)) {
            const headerSeed = httpRequest?.headers?.["random-seed"];
            const rawSeed = Array.isArray(headerSeed) ? headerSeed[0] : headerSeed;
            const parsedSeed = typeof rawSeed === "string" ? Number(rawSeed) : NaN;
            const seed = Number.isFinite(parsedSeed)
                ? Math.floor(parsedSeed)
                : createRandomSeed();
            randomSeed = seed;
            const baseForRandom = targetStrategy ? targetStrategy.defaultParams : actualStrategyParams;
            const randomizedParams = generateRandomParams(baseForRandom, 1, rangePercent, seed, [], undefined)[0];
            if (randomizedParams) {
                actualStrategyParams = randomizedParams;
                didRandomize = true;
            }
        }
    }

    // Merge symbol/interval into settings so the executor can use them
    const settingsRaw = { ...req.backtestSettings } as Record<string, unknown>;
    settingsRaw.symbol = req.symbol;
    settingsRaw.interval = req.interval;

    try {
        const startTs = Date.now();

        const result = await executeBacktest(buildBacktestEndpointExecutorRequest(
            strategyKey,
            candles,
            req.interval,
            actualStrategyParams,
            settingsRaw,
            engineMode,
            nowSec,
            blockRange,
            annotatePolymarket,
            crossSymbolInput ?? undefined,
            getRequestBaseUrl(httpRequest)
        ));

        // If the strategy is entry-only, we may need to use the parity-specific path
        // for 120m data, but executeBacktest already handles this.

        const manifest = getManifestFingerprint();
        return {
            ok: true,
            strategyKey,
            engineUsed: result.engineUsed,
            result: toSlimSingleResult(result.result),
            ...(didRandomize ? { strategyParams: actualStrategyParams } : {}),
            ...(didRandomize && randomSeed !== undefined ? { randomSeed } : {}),
            requestFingerprint: computeRequestFingerprint(req, actualStrategyParams),
            strategyManifestFingerprint: {
                strategyCount: manifest.strategyCount,
                hash: manifest.hash,
            },
            timingMs: Date.now() - startTs,
        };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "EXECUTION_ERROR",
        };
    }
}

async function handleBatchBacktest(
    strategyKey: string,
    body: Record<string, unknown>,
    httpRequest?: IncomingMessage
): Promise<BacktestBatchResponse | BacktestErrorResponse> {
    const req = body as unknown as BacktestBatchRequest;

    const candlesOrError = extractDatasetCandles(req);
    if ("error" in candlesOrError) {
        return { ok: false, error: candlesOrError.error as string, code: "DATASET_ERROR" };
    }
    const candles = candlesOrError as OHLCVData[];
    const crossSymbolInput = extractCrossSymbolInput(req, strategyKey);
    if (crossSymbolInput && "error" in crossSymbolInput) {
        return { ok: false, error: crossSymbolInput.error };
    }

    if (!Array.isArray(req.items) || req.items.length === 0) {
        return { ok: false, error: "items array is required and must not be empty" };
    }
    if (!req.symbol || !req.interval) {
        return { ok: false, error: "symbol and interval are required" };
    }

    const ctx = req.context ?? {} as NonNullable<typeof req.context>;
    const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = ctx?.blockRange ?? null;
    const annotatePolymarket = ctx?.annotatePolymarket ?? false;
    const engineMode = ctx?.engineMode ?? "auto";
    const compact = req.compact ?? false;

    const settingsRaw = { ...req.backtestSettings } as Record<string, unknown>;
    settingsRaw.symbol = req.symbol;
    settingsRaw.interval = req.interval;

    const startTs = Date.now();
    const results: BacktestBatchItemResult[] = [];

    for (const item of req.items) {
        try {
            const itemStart = Date.now();

            // Merge per-item overrides
            const itemSettings = item.backtestSettings
                ? { ...settingsRaw, ...item.backtestSettings } as Record<string, unknown>
                : settingsRaw;
            const itemCtx = item.context ?? {};

            const result = await executeBacktest(buildBacktestEndpointExecutorRequest(
                strategyKey,
                candles,
                req.interval,
                item.strategyParams,
                itemSettings,
                itemCtx.engineMode as EngineMode ?? engineMode,
                itemCtx.nowSec ?? nowSec,
                itemCtx.blockRange ?? blockRange,
                itemCtx.annotatePolymarket ?? annotatePolymarket,
                crossSymbolInput ?? undefined,
                getRequestBaseUrl(httpRequest)
            ));

            results.push({
                id: item.id,
                ok: true,
                strategyKey,
                engineUsed: result.engineUsed,
                result: compact ? toCompactMetrics(result.result) : result.result,
                timingMs: Date.now() - itemStart,
            });
        } catch (err) {
            results.push({
                id: item.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                strategyKey,
                engineUsed: "typescript",
                result: {} as BacktestResult | CompactBacktestMetrics,
                timingMs: 0,
            });
        }
    }

    const datasetRef = typeof (req.dataset as { ref?: string })?.ref === "string"
        ? (req.dataset as { ref: string }).ref
        : undefined;

    return {
        ok: true,
        strategyKey,
        datasetRef,
        processed: req.items.length,
        returned: results.length,
        topN: results.length,
        results,
        totalTimingMs: Date.now() - startTs,
    };
}

async function handleRandomSearch(
    strategyKey: string,
    body: Record<string, unknown>,
    httpRequest?: IncomingMessage
): Promise<BacktestRandomSearchResponse | BacktestErrorResponse> {
    const req = body as unknown as BacktestRandomSearchRequest;

    if (!req.baseParams || typeof req.baseParams !== "object") {
        return { ok: false, error: "baseParams is required" };
    }
    if (!req.randomization?.count || req.randomization.count < 1) {
        return { ok: false, error: "randomization.count must be >= 1" };
    }

    const candlesOrError = extractDatasetCandles(req);
    if ("error" in candlesOrError) {
        return { ok: false, error: candlesOrError.error as string };
    }
    const candles = candlesOrError as OHLCVData[];
    const crossSymbolInput = extractCrossSymbolInput(req, strategyKey);
    if (crossSymbolInput && "error" in crossSymbolInput) {
        return { ok: false, error: crossSymbolInput.error };
    }

    if (!req.symbol || !req.interval) {
        return { ok: false, error: "symbol and interval are required" };
    }

    const ctx = req.context ?? {} as NonNullable<typeof req.context>;
    const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    const engineMode = ctx?.engineMode ?? "auto";
    const blockRange = ctx?.blockRange ?? null;
    const annotatePolymarket = ctx?.annotatePolymarket ?? false;

    const settingsRaw = { ...req.backtestSettings } as Record<string, unknown>;
    settingsRaw.symbol = req.symbol;
    settingsRaw.interval = req.interval;

    const rng = req.randomization.seed ?? createRandomSeed();
    const paramsList = generateRandomParams(
        req.baseParams,
        req.randomization.count,
        req.randomization.rangePercent,
        rng,
        req.randomization.freezeKeys ?? [],
        req.randomization.paramSpecs
    );

    const ranking = req.ranking ?? { topN: 100, sortPriority: ["netProfitPercent"] };
    const compact = req.compact ?? false;
    const startTs = Date.now();

    // Execute all runs
    const allResults: Array<{
        params: StrategyParams;
        metrics: CompactBacktestMetrics;
        result: BacktestResult;
    }> = [];
    const failures: Array<{ index: number; error: string }> = [];

    for (let index = 0; index < paramsList.length; index += 1) {
        const params = paramsList[index];
        try {
            const executorResult = await executeBacktest(buildBacktestEndpointExecutorRequest(
                strategyKey,
                candles,
                req.interval,
                params,
                settingsRaw,
                engineMode,
                nowSec,
                blockRange,
                annotatePolymarket,
                crossSymbolInput ?? undefined,
                getRequestBaseUrl(httpRequest)
            ));

            allResults.push({
                params,
                metrics: toCompactMetrics(executorResult.result),
                result: executorResult.result,
            });
        } catch (error) {
            failures.push({
                index,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Filter by min/max trades
    const minTrades = ranking.minTrades ?? 0;
    const maxTrades = ranking.maxTrades ?? Infinity;
    const filtered = allResults.filter(r =>
        r.metrics.totalTrades >= minTrades && r.metrics.totalTrades <= maxTrades
    );

    // Sort
    const priority = ranking.sortPriority?.length
        ? ranking.sortPriority
        : ["netProfitPercent"] as typeof ranking.sortPriority;

    filtered.sort((a, b) => {
        for (const key of priority) {
            const va = (a.metrics as any)[key] ?? 0;
            const vb = (b.metrics as any)[key] ?? 0;
            if (vb !== va) return vb - va; // descending
        }
        return 0;
    });

    // Take top N
    const topN = ranking.topN ?? 100;
    const top = filtered.slice(0, topN);

    const datasetRef = typeof (req.dataset as { ref?: string })?.ref === "string"
        ? (req.dataset as { ref: string }).ref
        : undefined;

    return {
        ok: true,
        strategyKey,
        datasetRef,
        processed: paramsList.length,
        evaluated: allResults.length,
        failed: failures.length,
        returned: top.length,
        topN,
        results: top.map((r, i) => ({
            rank: i + 1,
            params: r.params,
            metrics: r.metrics,
            ...(compact ? {} : { result: r.result }),
        })),
        totalTimingMs: Date.now() - startTs,
        seed: rng,
        failureSamples: failures.slice(0, 5),
    };
}

function computeRequestFingerprint(
    req: BacktestSingleRequest,
    strategyParams: StrategyParams = req.strategyParams
): string {
    const h = createHash("md5");
    h.update(`${req.symbol}|${req.interval}|`);

    const ds = req.dataset;
    if (Array.isArray((ds as any)?.candles)) {
        h.update(`inline:${computeCandleHash((ds as { candles: OHLCVData[] }).candles)}`);
    } else {
        h.update(`ref:${(ds as { ref: string })?.ref ?? ""}`);
    }

    if (req.crossSymbol) {
        h.update(`|crossSymbol:${req.crossSymbol.secondarySymbol}|`);
        const secondaryDataset = req.crossSymbol.dataset;
        if (Array.isArray((secondaryDataset as any)?.candles)) {
            h.update(`inline:${computeCandleHash((secondaryDataset as { candles: OHLCVData[] }).candles)}`);
        } else {
            h.update(`ref:${(secondaryDataset as { ref: string })?.ref ?? ""}`);
        }
    }

    h.update(`|params:${JSON.stringify(strategyParams)}`);
    h.update(`|settings:${JSON.stringify(stripEndpointIgnoredBacktestSettings(req.backtestSettings))}`);
    h.update(`|capital:${JSON.stringify(BACKTEST_ENDPOINT_CAPITAL_SETTINGS)}`);
    h.update(`|context:${JSON.stringify(req.context)}`);

    return h.digest("hex");
}

// ============================================================================
// Plugin
// ============================================================================

export function backtestEndpointPlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/backtest", async (req: any, res: any) => {
            const method = req.method || "GET";
            const requestUrl = new URL(req.url || "/", "http://localhost");
            const pathParts = requestUrl.pathname.split("/").filter(Boolean);

            try {
                // GET /api/backtest/health
                if (method === "GET" && pathParts.length === 1 && pathParts[0] === "health") {
                    const manifest = getManifestFingerprint();
                    const { rustEngine } = await import("./rust-engine-client");

                    const healthResp: BacktestHealthResponse = {
                        ok: true,
                        version: "1.0.0",
                        manifest: {
                            strategyCount: manifest.strategyCount,
                            hash: manifest.hash,
                        },
                        enginePreference: {
                            rustPreferred: false,
                            rustAvailable: await rustEngine.checkHealth(),
                        },
                    };
                    sendJson(res, 200, healthResp);
                    return;
                }

                // POST /api/backtest/datasets
                if (method === "POST" && pathParts.length === 1 && pathParts[0] === "datasets") {
                    const body = await readJsonBody(req as IncomingMessage);
                    const uploadReq = body as unknown as DatasetUploadRequest;
                    if (!Array.isArray(uploadReq.candles) || uploadReq.candles.length === 0) {
                        errorResponse(res, 400, "candles array is required");
                        return;
                    }

                    const entry = cacheDataset(uploadReq.candles, uploadReq.keyHint);
                    if ("error" in entry) {
                        errorResponse(res, entry.status, entry.error, entry.code);
                        return;
                    }
                    const resp: DatasetUploadResponse = {
                        ok: true,
                        datasetRef: entry.ref,
                        hash: entry.hash,
                        candleCount: entry.candles.length,
                        firstTime: entry.firstTime,
                        lastTime: entry.lastTime,
                    };
                    sendJson(res, 200, resp);
                    return;
                }

                // POST /api/backtest/:strategyKey
                if (method === "POST" && pathParts.length === 1) {
                    const strategyKey = pathParts[0];
                    const body = await readJsonBody(req as IncomingMessage);
                    const result = await handleSingleBacktest(strategyKey, body, req as IncomingMessage);
                    const status = result.ok ? 200 : (result as BacktestErrorResponse).code === "EXECUTION_ERROR" ? 500 : 400;
                    sendJson(res, status, result);
                    return;
                }

                // POST /api/backtest/:strategyKey/batch
                if (method === "POST" && pathParts.length === 2 && pathParts[1] === "batch") {
                    const strategyKey = pathParts[0];
                    const body = await readJsonBody(req as IncomingMessage);
                    const result = await handleBatchBacktest(strategyKey, body, req as IncomingMessage);
                    const status = result.ok ? 200 : 400;
                    sendJson(res, status, result);
                    return;
                }

                // POST /api/backtest/:strategyKey/search/random
                if (method === "POST" && pathParts.length === 3 && pathParts[1] === "search" && pathParts[2] === "random") {
                    const strategyKey = pathParts[0];
                    const body = await readJsonBody(req as IncomingMessage);
                    const result = await handleRandomSearch(strategyKey, body, req as IncomingMessage);
                    const status = result.ok ? 200 : 400;
                    sendJson(res, status, result);
                    return;
                }

                sendJson(res, 404, { ok: false, error: "Not found" });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                sendJson(res, 500, { ok: false, error: message });
            }
        });
    };

    return {
        name: "backtest-endpoint",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}
