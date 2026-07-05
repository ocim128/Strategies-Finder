/**
 * Vite dev-server plugin that hosts Batch Backtest execution in Node.
 *
 * Mirrors the IBKR sync plugin's structure (`lib/ibkr-data/ibkr-data-vite-plugin.ts`)
 * 1:1: an owner-generation lock, a factored `processRunBatch` core that takes
 * a `writer` callback (so it is testable without an HTTP response), a Stop
 * endpoint that force-bumps the lock, and a status endpoint that snapshots
 * in-progress state for browser reattach after a tab reload.
 *
 * Why server-side at all: 1000+ IBKR 4H synthetic pairs hold ~5–10 GB of
 * per-row artifacts (`data` + `signals` + `result.trades`) for the Mine
 * Timing step. That workload OOMs a browser tab; Node can use main RAM
 * directly. The browser tab keeps only rendered scalars and DOM rows.
 *
 * Memory contract: the plugin holds `lastResults` (the full per-row artifacts
 * needed for Mine Timing) until one of three release triggers fires:
 *   1. Successful Mine completion (after streaming `done`).
 *   2. A new Run starting (`POST /run` resets `lastResults = []` first).
 *   3. A bounded TTL (default 10 minutes after the Run's `done` event with no
 *      Mine click) so a user who walks away doesn't leave ~5 GB pinned.
 *
 * The browser path got release (3) for free via tab reload; the server path
 * needs it explicitly.
 */

import type { Plugin } from "vite";
import { getHeapStatistics } from "node:v8";
import { debugLogger } from "../debug-logger";
import { beginNdjsonStream, HttpStatusError, readJsonBody, sendCaughtErrorJson, sendJson, type ViteHttpResponse } from "../vite-http-utils";
import { runBatchBacktest, type BatchBacktestRunInput, type BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { clearServerBatchDatasetCaches, loadServerBatchDataset } from "./server-batch-data-loader";
import {
    runBatchSyntheticStateMiner,
    resolveBatchSyntheticTargetSymbol,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";
import { parsePortfolioSyntheticPairSymbol } from "../portfolioLab/portfolio-lab-synthetic";
import { loadBuiltInStrategyByKey } from "../../strategyRegistry";
import type { BacktestSettings, Strategy, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import { toScalarRow, type BatchStreamEvent } from "./batch-backtest-stream-types";
import { setRuntimeLocalApiOrigin } from "../local-api-transport";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Artifact retention after a Run's `done` event with no Mine click. */
const DEFAULT_ARTIFACT_RETENTION_MS = 10 * 60 * 1000;
const HEAP_MB = 1024 * 1024;
const LARGE_RUN_SYMBOL_THRESHOLD = 400;
const VERY_LARGE_RUN_SYMBOL_THRESHOLD = 800;
const LARGE_RUN_MIN_HEAP_MB = 8192;
const VERY_LARGE_RUN_MIN_HEAP_MB = 12288;

// ---------------------------------------------------------------------------
// Module-scope state — single in-flight run per dev server (single-owner model)
// ---------------------------------------------------------------------------

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGen = 0;
let minerOwner = RUN_OWNER_NONE;
let minerOwnerGen = 0;

let runState: BatchRunSnapshot | null = null;
let lastResults: BatchBacktestSymbolResult[] = [];
let lastRunFingerprint: string | null = null;
let lastRunInterval: string | null = null;
let lastRunStrategyKey: string | null = null;
let abortController: AbortController | null = null;
let artifactReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let minerState: { running: boolean; startedAt: number; assets: number; pairs: number; verdicts: number; cancelled: boolean } | null = null;

export type BatchRunSnapshot = {
    startedAt: number;
    interval: string;
    strategyKey: string;
    total: number;
    completed: number;
    failed: number;
    currentSymbol: string | null;
    cancelled: boolean;
    rows: BatchBacktestSymbolResult[];
};

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

function buildRunFingerprint(args: {
    symbols: readonly string[];
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
    capitalSettings: unknown;
    interval: string;
}): string {
    return JSON.stringify({
        symbols: args.symbols,
        strategyKey: args.strategyKey,
        strategyParams: args.strategyParams,
        backtestSettings: args.backtestSettings,
        capitalSettings: args.capitalSettings,
        interval: args.interval,
    });
}

/**
 * Strip `data` / `signals` from a per-row result so it is safe to retain for
 * Mine while still being scalars-only on the wire. The runner already drops
 * `signals` for non-synthetic rows and prunes post-Mine; here we keep whatever
 * the runner produced so Mine can read it.
 */
function retainArtifacts(row: BatchBacktestSymbolResult): BatchBacktestSymbolResult {
    return row;
}

function clearArtifactReleaseTimer(): void {
    if (artifactReleaseTimer) {
        clearTimeout(artifactReleaseTimer);
        artifactReleaseTimer = null;
    }
}

/**
 * Release the per-row artifacts retained for Mine Timing. Mirrors the
 * browser-side post-Mine prune (commit 6401a53) plus the TTL defense-in-depth
 * the browser got for free via tab reload.
 *
 * Idempotent: safe to call when `lastResults` is already empty.
 */
function releaseLastResults(reason: string): void {
    clearArtifactReleaseTimer();
    if (lastResults.length === 0) return;
    debugLogger.info("batch.server.artifacts_released", {
        reason,
        rows: lastResults.length,
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
    lastResults = [];
    lastRunFingerprint = null;
    lastRunInterval = null;
    lastRunStrategyKey = null;
    clearServerBatchDatasetCaches();
}

function scheduleArtifactTtl(): void {
    clearArtifactReleaseTimer();
    artifactReleaseTimer = setTimeout(() => {
        releaseLastResults("ttl_expired");
    }, DEFAULT_ARTIFACT_RETENTION_MS);
}

function getV8HeapLimitMb(): number {
    return Math.floor(getHeapStatistics().heap_size_limit / HEAP_MB);
}

export function resolveServerBatchHeapWarning(symbolCount: number, heapLimitMb = getV8HeapLimitMb()): string | null {
    const normalizedCount = Math.max(0, Math.floor(Number.isFinite(symbolCount) ? symbolCount : 0));
    const normalizedHeap = Math.max(0, Math.floor(Number.isFinite(heapLimitMb) ? heapLimitMb : 0));
    const requiredHeapMb = normalizedCount >= VERY_LARGE_RUN_SYMBOL_THRESHOLD
        ? VERY_LARGE_RUN_MIN_HEAP_MB
        : normalizedCount >= LARGE_RUN_SYMBOL_THRESHOLD
            ? LARGE_RUN_MIN_HEAP_MB
            : 0;

    if (requiredHeapMb === 0 || normalizedHeap >= requiredHeapMb) {
        return null;
    }

    return [
        `Server-side Batch needs more Node heap for ${normalizedCount} symbols.`,
        `Current V8 heap limit is ~${normalizedHeap} MB; this run needs at least ${requiredHeapMb} MB.`,
        "Restart the app with run_playground.bat, or run: set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev",
    ].join(" ");
}

// ---------------------------------------------------------------------------
// Run + Miner core (factored out of the HTTP handlers for testability)
// ---------------------------------------------------------------------------

type StreamWriter = (event: BatchStreamEvent) => void;

/**
 * Core batch loop, factored out of the HTTP handler so it can be tested with a
 * stubbed loader and writer without spinning up Vite. Mirrors
 * `processSyncBatch` in the IBKR plugin.
 *
 * `owner` keys cancellation: the loop bails as soon as `runOwner !== owner`
 * (Stop force-bumped the lock or a newer run took it). The shared
 * `abortController` cancels in-flight dataset loads.
 */
export async function processRunBatch(
    input: BatchBacktestRunInput,
    writer: StreamWriter,
    owner: number,
): Promise<void> {
    const total = Math.max(1, input.symbols.length);

    runState = {
        startedAt: Date.now(),
        interval: input.interval,
        strategyKey: input.strategyKey,
        total,
        completed: 0,
        failed: 0,
        currentSymbol: null,
        cancelled: false,
        rows: [],
    };
    const snapshot = runState;
    const fingerprint = buildRunFingerprint({
        symbols: input.symbols,
        strategyKey: input.strategyKey,
        strategyParams: input.strategyParams,
        backtestSettings: input.backtestSettings,
        capitalSettings: input.capitalSettings,
        interval: input.interval,
    });

    writer({ type: "start", total, interval: input.interval, strategyKey: input.strategyKey });

    const lostOwnership = () => runOwner !== owner;
    let cancelled = false;

    try {
        const output = await runBatchBacktest(input, {
            setProgress: (percent, text) => {
                if (lostOwnership()) return;
                writer({ type: "progress", percent, text, status: text });
            },
            setStatus: (text) => {
                if (lostOwnership()) return;
                writer({ type: "progress", percent: 0, text, status: text });
            },
            onSymbolComplete: (index, result) => {
                if (lostOwnership()) return;
                if (runState === snapshot) {
                    snapshot.completed = index + 1;
                    snapshot.rows.push(toScalarRow(result));
                }
                // Server retains the full artifacts for Mine Timing.
                lastResults[index] = retainArtifacts(result);
                writer({ type: "symbol", index, total, row: toScalarRow(result) });
            },
            isCancelled: () => {
                if (lostOwnership()) {
                    cancelled = true;
                    return true;
                }
                return false;
            },
        });

        if (lostOwnership()) {
            cancelled = true;
            if (runState === snapshot) snapshot.cancelled = true;
        }

        // Fill any rows the runner back-filled (cancelled tail); push them on
        // the wire so the browser sees the full row list.
        for (let i = 0; i < output.results.length; i += 1) {
            const row = output.results[i]!;
            if (runState === snapshot && snapshot.rows[i] === undefined) {
                snapshot.rows.push(toScalarRow(row));
            }
            if (lastResults[i] === undefined) {
                lastResults[i] = retainArtifacts(row);
            }
        }

        if (runState === snapshot) {
            snapshot.completed = output.results.length;
            snapshot.failed = output.failedSymbols.length;
            snapshot.currentSymbol = null;
            snapshot.cancelled = cancelled;
        }

        lastRunFingerprint = fingerprint;
        lastRunInterval = input.interval;
        lastRunStrategyKey = input.strategyKey;

        writer({
            type: "done",
            ok: output.failedSymbols.length === 0 && !cancelled,
            cancelled,
            interval: input.interval,
            totals: { loadedSymbols: output.loadedSymbols, failedSymbols: output.failedSymbols.length },
            summary: `Done — ${output.results.length} pairs${output.failedSymbols.length > 0 ? `, ${output.failedSymbols.length} failed` : ""}${cancelled ? ", cancelled" : ""}`,
            serverHasArtifacts: hasMineableArtifacts(lastResults),
            fingerprint,
        });

        // Schedule the TTL release only if the run produced mineable
        // artifacts. Empty / fully-failed runs release immediately so the
        // server heap doesn't retain a placeholder.
        if (hasMineableArtifacts(lastResults)) {
            scheduleArtifactTtl();
        } else {
            releaseLastResults("run_no_artifacts");
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.run.fatal", { error: message });
        writer({ type: "fatal", error: message });
        releaseLastResults("run_fatal");
    } finally {
        abortController = null;
    }
}

function hasMineableArtifacts(rows: readonly BatchBacktestSymbolResult[]): boolean {
    return rows.some((row) => Boolean(row.result && row.data && row.signals && parsePortfolioSyntheticPairSymbol(row.symbol)));
}

// ---------------------------------------------------------------------------
// Miner core
// ---------------------------------------------------------------------------

export type MinerStreamWriter = (event: unknown) => void;

export async function processMine(
    fingerprint: string | null,
    interval: string | null,
    writer: MinerStreamWriter,
    owner: number,
): Promise<void> {
    const artifacts = collectMinerPairArtifacts();
    if (artifacts.length === 0) {
        writer({ type: "done", ok: true, cancelled: false, summary: "No completed synthetic pair artifacts to mine.", totals: { verdicts: 0 } });
        return;
    }
    if (!fingerprint || fingerprint !== lastRunFingerprint || !interval) {
        writer({ type: "fatal", error: "Rerun Batch before mining; settings or symbols changed." });
        return;
    }

    minerState = { running: true, startedAt: Date.now(), assets: 0, pairs: artifacts.length, verdicts: 0, cancelled: false };
    const snapshot = minerState;
    const lostOwnership = () => minerOwner !== owner;

    try {
        const targets = await loadMinerTargets(artifacts, interval);
        snapshot.assets = targets.length;
        writer({ type: "start", assets: targets.length, pairs: artifacts.length });
        if (lostOwnership()) {
            snapshot.cancelled = true;
            snapshot.running = false;
            writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: 0 } });
            return;
        }
        if (targets.length === 0) {
            snapshot.running = false;
            writer({ type: "done", ok: true, cancelled: false, summary: "No target asset candles loaded.", totals: { verdicts: 0 } });
            return;
        }
        const result = runBatchSyntheticStateMiner({ interval, targets, artifacts });
        snapshot.verdicts = result.verdicts.length;
        snapshot.running = false;
        if (lostOwnership()) {
            snapshot.cancelled = true;
            writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: result.verdicts.length } });
            return;
        }
        for (const verdict of result.verdicts) {
            if (lostOwnership()) {
                snapshot.cancelled = true;
                writer({ type: "done", ok: false, cancelled: true, summary: "Mining cancelled.", totals: { verdicts: result.verdicts.length } });
                return;
            }
            writer({ type: "verdict", verdict });
        }
        writer({
            type: "done",
            ok: true,
            cancelled: false,
            summary: `Miner | Assets ${result.verdicts.length}`,
            totals: { verdicts: result.verdicts.length },
        });
        // Mine was the last consumer of the per-row artifacts. Release them.
        releaseLastResults("mine_completed");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.mine.fatal", { error: message });
        snapshot.running = false;
        writer({ type: "fatal", error: message });
    } finally {
        if (minerState === snapshot) {
            snapshot.running = false;
        }
    }
}

function collectMinerPairArtifacts(): BatchSyntheticPairArtifact[] {
    const artifacts: BatchSyntheticPairArtifact[] = [];
    for (const row of lastResults) {
        if (!row.result || !row.data || !row.signals) continue;
        const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
        if (!parsed) continue;
        artifacts.push({
            symbol: row.symbol,
            baseAsset: parsed.baseAsset,
            quoteAsset: parsed.quoteAsset,
            baseSymbol: parsed.baseSymbol,
            quoteSymbol: parsed.quoteSymbol,
            data: row.data,
            signals: row.signals,
            result: row.result,
        });
    }
    return artifacts;
}

async function loadMinerTargets(
    pairArtifacts: readonly BatchSyntheticPairArtifact[],
    interval: string,
): Promise<BatchSyntheticTargetArtifact[]> {
    const assets = Array.from(new Set(
        pairArtifacts.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset])
            .map((asset) => asset.trim().toUpperCase())
            .filter(Boolean)
    )).sort();
    const markedSymbolByAsset = new Map<string, string>();
    for (const artifact of pairArtifacts) {
        for (const [asset, symbol] of [
            [artifact.baseAsset, artifact.baseSymbol],
            [artifact.quoteAsset, artifact.quoteSymbol],
        ] as const) {
            const key = asset?.trim().toUpperCase();
            if (key && symbol && !markedSymbolByAsset.has(key)) {
                markedSymbolByAsset.set(key, symbol);
            }
        }
    }
    const targets: BatchSyntheticTargetArtifact[] = [];
    for (const asset of assets) {
        if (minerOwner === RUN_OWNER_NONE) break;
        const symbol = markedSymbolByAsset.get(asset) ?? resolveBatchSyntheticTargetSymbol(asset);
        try {
            const data = await loadServerBatchDataset(symbol, interval);
            if (Array.isArray(data) && data.length > 0) {
                targets.push({ asset, symbol, data });
            }
        } catch (error) {
            debugLogger.warn("batch.server.mine.target_load_failed", {
                asset, symbol,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return targets;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function handleRunRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is already running. Use Stop first.");
    }
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "Mine Timing is currently running. Wait for it to finish before starting a new batch.");
    }

    const symbolsRaw = body.symbols;
    const symbols = parseSymbolsFromRequest(symbolsRaw);
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one symbol is required.");
    }
    const heapWarning = resolveServerBatchHeapWarning(symbols.length);
    if (heapWarning) {
        throw new HttpStatusError(507, heapWarning);
    }
    const interval = String(body.interval ?? "").trim().toLowerCase();
    if (!interval) {
        throw new HttpStatusError(400, "interval is required.");
    }
    const strategyKey = String(body.strategyKey ?? "").trim();
    if (!strategyKey) {
        throw new HttpStatusError(400, "strategyKey is required.");
    }

    const strategy = await resolveStrategy(strategyKey);
    const strategyParams = (body.strategyParams ?? {}) as StrategyParams;
    const backtestSettings = (body.backtestSettings ?? {}) as BacktestSettings;
    const capitalSettings = (body.capitalSettings ?? {}) as CapitalSettings;
    const useRustEnginePreference = body.useRustEnginePreference === true;

    const owner = ++runOwnerGen;
    runOwner = owner;
    clearArtifactReleaseTimer();
    lastResults = [];
    lastRunFingerprint = null;
    lastRunInterval = null;
    lastRunStrategyKey = null;
    abortController = new AbortController();

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processRunBatch(
            {
                interval,
                strategyKey,
                strategy,
                strategyParams,
                backtestSettings,
                capitalSettings,
                symbols,
                useRustEnginePreference,
                loadDataset: (sym, intv, signal) => loadServerBatchDataset(sym, intv, signal),
            },
            (event) => stream!.write(event),
            owner,
        );
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            /* best-effort */
        }
    } finally {
        if (runOwner === owner) {
            runOwner = RUN_OWNER_NONE;
        }
        abortController = null;
    }
}

function rememberLocalApiOriginFromRequest(req: { headers?: Record<string, unknown> }): void {
    const hostHeader = req.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (typeof host !== "string" || !host.trim()) return;

    const protoHeader = req.headers?.["x-forwarded-proto"];
    const protoValue = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const proto = typeof protoValue === "string" && protoValue.split(",")[0]?.trim().toLowerCase() === "https"
        ? "https"
        : "http";
    setRuntimeLocalApiOrigin(`${proto}://${host.trim()}`);
}

async function handleStopRequest(): Promise<{ ok: boolean; stopped: boolean }> {
    // Force-reset both run and miner locks so a stuck/hung run can always be
    // recovered without a server restart. Mirrors IBKR sync's Stop semantics.
    if (abortController) {
        try {
            abortController.abort();
        } catch {
            /* best-effort */
        }
    }
    const runWasActive = runOwner !== RUN_OWNER_NONE;
    const minerWasActive = minerOwner !== RUN_OWNER_NONE;
    runOwner = RUN_OWNER_NONE;
    minerOwner = RUN_OWNER_NONE;
    return { ok: true, stopped: runWasActive || minerWasActive };
}

async function handleMineRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    if (minerOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "Mine Timing is already running.");
    }
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A batch backtest is running. Use Stop first.");
    }
    if (lastResults.length === 0) {
        throw new HttpStatusError(400, "Run Batch before mining; no artifacts on server.");
    }
    const owner = ++minerOwnerGen;
    minerOwner = owner;

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processMine(
            typeof body.fingerprint === "string" ? body.fingerprint : null,
            typeof body.interval === "string" ? body.interval : lastRunInterval,
            (event) => stream!.write(event),
            owner,
        );
        stream.end();
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        try {
            stream.end({ type: "fatal", error: message });
        } catch {
            /* best-effort */
        }
    } finally {
        if (minerOwner === owner) {
            minerOwner = RUN_OWNER_NONE;
        }
        if (minerState && minerOwner === RUN_OWNER_NONE) {
            minerState.running = false;
        }
    }
}

function handleStatusRequest(): unknown {
    return {
        ok: true,
        running: runState !== null && runOwner !== RUN_OWNER_NONE,
        run: runState && runOwner !== RUN_OWNER_NONE
            ? {
                startedAt: runState.startedAt,
                interval: runState.interval,
                strategyKey: runState.strategyKey,
                total: runState.total,
                completed: runState.completed,
                failed: runState.failed,
                currentSymbol: runState.currentSymbol,
                cancelled: runState.cancelled,
                rows: runState.rows,
            }
            : null,
        lastRun: lastResults.length > 0
            ? {
                interval: lastRunInterval,
                strategyKey: lastRunStrategyKey,
                fingerprint: lastRunFingerprint,
                rowCount: lastResults.length,
                hasArtifacts: hasMineableArtifacts(lastResults),
            }
            : null,
        miner: minerState && minerOwner !== RUN_OWNER_NONE
            ? {
                running: true,
                startedAt: minerState.startedAt,
                assets: minerState.assets,
                pairs: minerState.pairs,
                verdicts: minerState.verdicts,
            }
            : null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSymbolsFromRequest(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        const text = String(item ?? "").trim().toUpperCase();
        if (!text) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

async function resolveStrategy(strategyKey: string): Promise<Strategy> {
    // Use `loadBuiltInStrategyByKey` (not `ensureBuiltInStrategyLoaded`) so the
    // strategy is registered into `strategyRegistry`, not just the catalog's
    // internal Map. The browser-side batch path gets this for free because the
    // strategy panel UI registers strategies into the registry on tab open;
    // the server-side path runs cold and the registry is empty, so we must
    // take the path that registers.
    const strategy = await loadBuiltInStrategyByKey(strategyKey);
    if (!strategy) {
        throw new HttpStatusError(400, `Strategy not loaded: ${strategyKey}`);
    }
    return strategy;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function batchBacktestVitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/batch-backtest/run", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleRunRequest(res as ViteHttpResponse, await readJsonBody(req));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                const result = await handleStopRequest();
                sendJson(res, 200, result);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/mine", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleMineRequest(res as ViteHttpResponse, await readJsonBody(req));
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/batch-backtest/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            sendJson(res, 200, handleStatusRequest());
        });
    };

    return {
        name: "batch-backtest",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

// Exported for tests only. `processRunBatch` and `processMine` consult
// module-scope `runOwner` / `minerOwner` for cancellation, mirroring the IBKR
// sync pattern. The HTTP handlers set those before invoking the factored
// functions; tests need a way to do the same without spinning up Vite.
export const __testInternals = {
    releaseLastResults,
    hasMineableArtifacts,
    DEFAULT_ARTIFACT_RETENTION_MS,
    setRunOwnerForTests(owner: number): void {
        runOwner = owner;
        if (owner === RUN_OWNER_NONE) {
            runState = null;
        }
    },
    setMinerOwnerForTests(owner: number): void {
        minerOwner = owner;
    },
    getRunStateForTests(): BatchRunSnapshot | null {
        return runState;
    },
};
