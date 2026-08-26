import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Plugin } from "vite";
import {
    fetchServerHistoricalData,
    getServerBatchDatasetCacheStats,
    loadServerBatchDataset,
} from "../../batch-backtest/server-batch-data-loader";
import { normalizeBatchSymbols, validateBatchSymbolToken } from "../../batch-backtest/batch-run-contract";
import { debugLogger } from "../../debug-logger";
import type { OHLCVData } from "../../types/strategies";
import {
    createDisconnectSafeStream,
    HttpStatusError,
    registerLocalJsonRoute,
    sendJson,
    type ViteHttpResponse,
} from "../../vite-http-utils";
import { prepareRankPairRelationships } from "../rank-pairs-input";
import {
    buildRankPairsCacheDelta,
    createRankPairsPerformanceTimings,
    formatRankPairsPerformanceDiagnostics,
    nowRankPairsMs,
    type RankPairsPerformanceDiagnostics,
} from "../rank-pairs-performance";
import {
    buildRankPairsSummary,
    copyPreambleForMode,
    serializeCopyRowForMode,
    sortRankPairResults,
    type AnyRankResult,
} from "../rank-pairs-result-format";
import { createRankPairsRecentLoader } from "../rank-pairs-recent-loader-core";
import {
    classifyPairRegime,
} from "../pair-regime-classifier";
import {
    classifyRecentPair,
    normalizeRecentPairEvalLastBars,
    normalizeRecentPairOosIgnoreLastBars,
} from "../recent-pair-classifier";
import type {
    RankPairsMode,
    RankResult,
    RecentRankResult,
} from "../rank-pairs-service";
import type {
    RankPairsRunStatusSnapshot,
    RankPairsStreamEvent,
} from "./rank-pairs-server-types";
import {
    resolveRankPairsLoadConcurrency,
    resolveRankPairsRecentLegCacheEntries,
} from "./rank-pairs-server-capacity";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_RUN_ID_LENGTH = 128;
const RENDER_LIMIT = 2_000;
const PROGRESS_INTERVAL_MS = 200;
const RUN_OWNER_NONE = 0;
const COPY_ARTIFACT_DIR_PREFIX = "strategies-finder-rank-pairs-";

interface CopyArtifact {
    runId: string;
    dir: string;
    file: string;
    bytes: number;
}

interface InternalRunState extends RankPairsRunStatusSnapshot {
    diagnosticsText: string;
}

const serverRecentLoader = createRankPairsRecentLoader(
    (symbol, interval, bars, options) =>
        fetchServerHistoricalData(symbol, interval, bars, options),
    { legCacheMaxEntries: resolveRankPairsRecentLegCacheEntries() },
);

let runOwner = RUN_OWNER_NONE;
let runOwnerGeneration = 0;
let runOwnerRunId: string | null = null;
let abortController: AbortController | null = null;
let pendingStopRunId: string | null = null;
let runState: InternalRunState | null = null;
let copyArtifact: CopyArtifact | null = null;

function parseRunId(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) {
        throw new HttpStatusError(400, "runId is required.");
    }
    const runId = raw.trim();
    if (runId.length > MAX_RUN_ID_LENGTH) {
        throw new HttpStatusError(400, `runId must be at most ${MAX_RUN_ID_LENGTH} characters.`);
    }
    return runId;
}

function parseMode(raw: unknown): RankPairsMode {
    if (raw === "history" || raw === "recent200") return raw;
    throw new HttpStatusError(400, "mode must be history or recent200.");
}

function parseInterval(raw: unknown): string {
    const interval = String(raw ?? "").trim().toLowerCase();
    if (!interval) throw new HttpStatusError(400, "interval is required.");
    return interval;
}

function parseSymbols(raw: unknown): string[] {
    const symbols = normalizeBatchSymbols(raw);
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one pair is required.");
    }
    for (const symbol of symbols) {
        const error = validateBatchSymbolToken(symbol);
        if (error) throw new HttpStatusError(400, `${symbol}: ${error}`);
    }
    return symbols;
}

function consumePendingStop(runId: string): boolean {
    if (pendingStopRunId !== runId) return false;
    pendingStopRunId = null;
    return true;
}

async function releaseArtifact(artifact: CopyArtifact | null): Promise<void> {
    if (!artifact) return;
    await unlink(artifact.file).catch(() => undefined);
    await rmdir(artifact.dir).catch(() => undefined);
}

async function writeText(
    stream: ReturnType<typeof createWriteStream>,
    text: string,
): Promise<void> {
    if (stream.write(text)) return;
    await once(stream, "drain");
}

async function writeCopyArtifact(
    runId: string,
    mode: RankPairsMode,
    results: readonly AnyRankResult[],
): Promise<CopyArtifact> {
    const stamp = `${process.pid}-${Date.now()}-`;
    const dir = await mkdtemp(join(tmpdir(), COPY_ARTIFACT_DIR_PREFIX + stamp));
    const file = join(dir, "copy-results.txt");
    const output = createWriteStream(file, { encoding: "utf8" });
    let bytes = 0;
    try {
        const preamble = `${copyPreambleForMode(mode).join("\n")}\n`;
        bytes += Buffer.byteLength(preamble);
        await writeText(output, preamble);
        for (let index = 0; index < results.length; index += 1) {
            const suffix = index + 1 === results.length ? "" : "\n";
            const line = `${serializeCopyRowForMode(results[index]!, mode)}${suffix}`;
            bytes += Buffer.byteLength(line);
            await writeText(output, line);
        }
        output.end();
        await once(output, "finish");
        return { runId, dir, file, bytes };
    } catch (error) {
        output.destroy();
        await unlink(file).catch(() => undefined);
        await rmdir(dir).catch(() => undefined);
        throw error;
    }
}

function shouldSweepOrphanEntry(entry: string): boolean {
    const tail = entry.slice(COPY_ARTIFACT_DIR_PREFIX.length);
    const match = tail.match(/^(\d+)-(\d+)-/);
    if (!match) return false;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) return true;
    if (pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "ESRCH";
    }
}

async function sweepOrphanedCopyArtifacts(): Promise<void> {
    const root = tmpdir();
    const entries = await readdir(root).catch(() => []);
    for (const entry of entries) {
        if (
            !entry.startsWith(COPY_ARTIFACT_DIR_PREFIX)
            || !shouldSweepOrphanEntry(entry)
        ) {
            continue;
        }
        const dir = join(root, entry);
        await unlink(join(dir, "copy-results.txt")).catch(() => undefined);
        await rmdir(dir).catch((error) => {
            debugLogger.warn("rank_pairs.server.orphan_sweep_failed", {
                entry,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
}

function emptyHistoryResult(symbol: string): RankResult {
    const regime = classifyPairRegime([]);
    regime.symbol = symbol;
    return { kind: "history", symbol, regime, status: "no_data" };
}

function emptyRecentResult(
    symbol: string,
    window: { evalLastBars: number; oosIgnoreLastBars: number },
): RecentRankResult {
    const recent = classifyRecentPair([], window);
    recent.symbol = symbol;
    return { kind: "recent", symbol, recent, status: "no_data" };
}

async function processPair(
    symbol: string,
    mode: RankPairsMode,
    interval: string,
    signal: AbortSignal,
    timings: ReturnType<typeof createRankPairsPerformanceTimings>,
    window: { evalLastBars: number; oosIgnoreLastBars: number },
): Promise<{ result: AnyRankResult; barCount: number } | null> {
    try {
        const loadStartedAt = nowRankPairsMs();
        let bars: OHLCVData[];
        try {
            const recentTargetBars = window.evalLastBars > 0
                ? window.evalLastBars + window.oosIgnoreLastBars
                : 0;
            const recent = mode === "recent200" && recentTargetBars > 0
                ? await serverRecentLoader.load(symbol, interval, signal, recentTargetBars)
                : null;
            bars = recent ?? await loadServerBatchDataset(symbol, interval, signal);
        } finally {
            timings.load += nowRankPairsMs() - loadStartedAt;
        }
        if (signal.aborted) return null;

        const classifyStartedAt = nowRankPairsMs();
        try {
            if (bars.length === 0) {
                return {
                    result: mode === "recent200"
                        ? emptyRecentResult(symbol, window)
                        : emptyHistoryResult(symbol),
                    barCount: 0,
                };
            }
            if (mode === "recent200") {
                const recent = classifyRecentPair(bars, window);
                recent.symbol = symbol;
                return {
                    result: {
                        kind: "recent",
                        symbol,
                        recent,
                        status: recent.type === "J" ? "no_data" : "ok",
                    },
                    barCount: bars.length,
                };
            }
            const regime = classifyPairRegime(bars);
            regime.symbol = symbol;
            return {
                result: {
                    kind: "history",
                    symbol,
                    regime,
                    status: regime.direction === "THIN" && regime.reason !== "OK"
                        ? "no_data"
                        : "ok",
                },
                barCount: bars.length,
            };
        } finally {
            timings.classify += nowRankPairsMs() - classifyStartedAt;
        }
    } catch (error) {
        if (signal.aborted) return null;
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("rank_pairs.server.pair_failed", { symbol, error: message });
        return {
            result: mode === "recent200"
                ? { ...emptyRecentResult(symbol, window), status: "failed", error: message }
                : { ...emptyHistoryResult(symbol), status: "failed", error: message },
            barCount: 0,
        };
    }
}

async function processRun(
    input: {
        runId: string;
        mode: RankPairsMode;
        interval: string;
        symbols: string[];
        reciprocalDuplicates: number;
        selfPairs: number;
        evalLastBars: number;
        oosIgnoreLastBars: number;
    },
    writer: (event: RankPairsStreamEvent) => void,
    owner: number,
    controller: AbortController,
): Promise<void> {
    const runStartedAt = nowRankPairsMs();
    const timings = createRankPairsPerformanceTimings();
    const batchCacheBefore = getServerBatchDatasetCacheStats();
    const recentCacheBefore = serverRecentLoader.getStats();
    const indexedResults = new Array<AnyRankResult | undefined>(input.symbols.length);
    let nextIndex = 0;
    let completed = 0;
    let totalBars = 0;
    let lastProgressAt = 0;
    const snapshot = runState!;
    const workerConcurrency = resolveRankPairsLoadConcurrency(input.symbols.length);

    writer({
        type: "start",
        runId: input.runId,
        total: input.symbols.length,
        interval: input.interval,
        mode: input.mode,
        evalLastBars: input.evalLastBars,
        oosIgnoreLastBars: input.oosIgnoreLastBars,
        workerConcurrency,
    });

    const isCancelled = (): boolean =>
        controller.signal.aborted || runOwner !== owner || runOwnerRunId !== input.runId;

    const runWorker = async (): Promise<void> => {
        while (!isCancelled()) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= input.symbols.length) return;
            const symbol = input.symbols[index]!;
            const processed = await processPair(
                symbol,
                input.mode,
                input.interval,
                controller.signal,
                timings,
                input,
            );
            if (!processed || isCancelled()) return;
            indexedResults[index] = processed.result;
            totalBars += processed.barCount;
            completed += 1;
            snapshot.completed = completed;
            snapshot.currentSymbol = symbol;
            snapshot.progressPercent = (completed / input.symbols.length) * 100;
            const remaining = input.symbols.length - completed;
            snapshot.statusText =
                `Server: ${completed.toLocaleString("en-US")}/${input.symbols.length.toLocaleString("en-US")}`
                + ` • ${remaining.toLocaleString("en-US")} remaining`
                + ` • ${workerConcurrency} loaders (${symbol})`;

            const now = nowRankPairsMs();
            if (
                completed === input.symbols.length
                || completed % 128 === 0
                || now - lastProgressAt >= PROGRESS_INTERVAL_MS
            ) {
                lastProgressAt = now;
                const progressStartedAt = nowRankPairsMs();
                writer({
                    type: "progress",
                    runId: input.runId,
                    completed,
                    total: input.symbols.length,
                    percent: snapshot.progressPercent,
                    currentSymbol: symbol,
                    status: snapshot.statusText,
                });
                timings.progress += nowRankPairsMs() - progressStartedAt;
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }
    };

    await Promise.all(Array.from({ length: workerConcurrency }, runWorker));

    const cancelled = isCancelled() || snapshot.cancelled;
    snapshot.phase = "finalizing";
    snapshot.statusText = cancelled ? "Finalizing stopped result..." : "Finalizing result...";
    const sortStartedAt = nowRankPairsMs();
    let results = sortRankPairResults(
        indexedResults.filter((result): result is AnyRankResult => result !== undefined),
        input.mode,
    );
    timings.sort += nowRankPairsMs() - sortStartedAt;
    const summary = buildRankPairsSummary(results, input.mode);
    let artifact: CopyArtifact | null = null;
    if (results.length > 0) {
        artifact = await writeCopyArtifact(input.runId, input.mode, results);
    }

    const cacheDelta = buildRankPairsCacheDelta(
        batchCacheBefore,
        getServerBatchDatasetCacheStats(),
    );
    const recentAfter = serverRecentLoader.getStats();
    cacheDelta.recentLegHits = recentAfter.legHits - recentCacheBefore.legHits;
    cacheDelta.recentLegMisses = recentAfter.legMisses - recentCacheBefore.legMisses;
    cacheDelta.recentLegEvictions = recentAfter.legEvictions - recentCacheBefore.legEvictions;
    cacheDelta.recentLegUpgrades = recentAfter.legUpgrades - recentCacheBefore.legUpgrades;
    cacheDelta.recentNetworkFallbacks =
        recentAfter.networkFallbacks - recentCacheBefore.networkFallbacks;
    cacheDelta.recentDeepPairFallbacks =
        recentAfter.deepPairFallbacks - recentCacheBefore.deepPairFallbacks;
    cacheDelta.recentLegCacheSize = recentAfter.legCacheSize;
    cacheDelta.recentLegCacheMaxEntries = recentAfter.legCacheMaxEntries;
    const diagnostics: RankPairsPerformanceDiagnostics = {
        totalPairs: input.symbols.length,
        processedPairs: results.length,
        renderedPairs: Math.min(results.length, RENDER_LIMIT),
        totalBars,
        elapsedMs: nowRankPairsMs() - runStartedAt,
        workerConcurrency,
        timingsMs: timings,
        cacheDelta,
    };

    const oldArtifact = copyArtifact;
    copyArtifact = artifact;
    await releaseArtifact(oldArtifact);

    snapshot.finishedAt = Date.now();
    snapshot.phase = cancelled ? "cancelled" : "done";
    snapshot.cancelled = cancelled;
    snapshot.completed = results.length;
    snapshot.currentSymbol = null;
    snapshot.progressPercent = input.symbols.length > 0
        ? (results.length / input.symbols.length) * 100
        : 100;
    snapshot.statusText = cancelled
        ? `Stopped (${results.length}/${input.symbols.length} pairs)`
        : `Done (${results.length} relationships)`;
    snapshot.resultCount = results.length;
    snapshot.terminalPreview = results.slice(0, RENDER_LIMIT);
    snapshot.summary = summary;
    snapshot.diagnostics = diagnostics;
    snapshot.diagnosticsText = formatRankPairsPerformanceDiagnostics(diagnostics);
    snapshot.copyAvailable = artifact !== null;

    writer({
        type: "done",
        ok: !cancelled,
        cancelled,
        runId: input.runId,
        interval: input.interval,
        mode: input.mode,
        evalLastBars: input.evalLastBars,
        oosIgnoreLastBars: input.oosIgnoreLastBars,
        total: input.symbols.length,
        resultCount: results.length,
        preview: snapshot.terminalPreview,
        summary,
        diagnostics,
        copyAvailable: snapshot.copyAvailable,
        reciprocalDuplicates: input.reciprocalDuplicates,
        selfPairs: input.selfPairs,
    });
    debugLogger.event("rank_pairs.server.run_complete", {
        runId: input.runId,
        mode: input.mode,
        interval: input.interval,
        total: input.symbols.length,
        processed: results.length,
        cancelled,
        copyBytes: artifact?.bytes ?? 0,
        elapsedMs: diagnostics.elapsedMs,
    });
    results = [];
}

async function handleRunRequest(
    res: ViteHttpResponse,
    body: Record<string, unknown>,
): Promise<void> {
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A Rank Pairs run is already active. Use Stop first.");
    }
    const runId = parseRunId(body.runId);
    if (consumePendingStop(runId)) {
        throw new HttpStatusError(409, "Rank Pairs run was stopped before it started.");
    }
    const mode = parseMode(body.mode);
    const interval = parseInterval(body.interval);
    const evalLastBars = normalizeRecentPairEvalLastBars(body.evalLastBars);
    const oosIgnoreLastBars = normalizeRecentPairOosIgnoreLastBars(body.oosIgnoreLastBars);
    const prepared = prepareRankPairRelationships(parseSymbols(body.symbols));
    if (prepared.symbols.length === 0) {
        throw new HttpStatusError(400, "At least one non-self pair is required.");
    }
    if (consumePendingStop(runId)) {
        throw new HttpStatusError(409, "Rank Pairs run was stopped before it started.");
    }
    const priorArtifact = copyArtifact;
    copyArtifact = null;
    await releaseArtifact(priorArtifact);
    if (consumePendingStop(runId)) {
        throw new HttpStatusError(409, "Rank Pairs run was stopped before it started.");
    }

    const owner = ++runOwnerGeneration;
    const controller = new AbortController();
    runOwner = owner;
    runOwnerRunId = runId;
    abortController = controller;
    runState = {
        ok: true,
        running: true,
        terminal: false,
        runId,
        startedAt: Date.now(),
        finishedAt: null,
        phase: "running",
        interval,
        mode,
        evalLastBars,
        oosIgnoreLastBars,
        total: prepared.symbols.length,
        completed: 0,
        currentSymbol: null,
        progressPercent: 0,
        statusText: "Starting...",
        cancelled: false,
        resultCount: 0,
        terminalPreview: null,
        summary: null,
        diagnostics: null,
        diagnosticsText: "",
        copyAvailable: false,
        reciprocalDuplicates: prepared.reciprocalDuplicates,
        selfPairs: prepared.selfPairs,
        error: null,
    };

    const stream = createDisconnectSafeStream(res);
    try {
        await processRun(
            {
                runId,
                mode,
                interval,
                symbols: prepared.symbols,
                reciprocalDuplicates: prepared.reciprocalDuplicates,
                selfPairs: prepared.selfPairs,
                evalLastBars,
                oosIgnoreLastBars,
            },
            (event) => stream.write(event),
            owner,
            controller,
        );
        stream.end();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (runState?.runId === runId) {
            runState.running = false;
            runState.terminal = true;
            runState.phase = "fatal";
            runState.finishedAt = Date.now();
            runState.statusText = `Rank Pairs failed: ${message}`;
            runState.summary = runState.statusText;
            runState.error = message;
        }
        stream.end({ type: "fatal", runId, error: message } satisfies RankPairsStreamEvent);
        debugLogger.error("rank_pairs.server.run_failed", { runId, error: message });
    } finally {
        if (runState?.runId === runId) {
            runState.running = false;
            runState.terminal = true;
        }
        if (runOwner === owner) runOwner = RUN_OWNER_NONE;
        if (runOwnerRunId === runId) runOwnerRunId = null;
        if (abortController === controller) abortController = null;
    }
}

function handleStatusRequest(runId: string | null): RankPairsRunStatusSnapshot | null {
    if (!runState) return null;
    if (runId !== null && runState.runId !== runId) return null;
    const { diagnosticsText: _diagnosticsText, ...snapshot } = runState;
    return {
        ...snapshot,
        running: runOwner !== RUN_OWNER_NONE && runState.finishedAt === null,
        terminal: runState.finishedAt !== null,
        terminalPreview: runState.finishedAt === null ? null : runState.terminalPreview,
    };
}

async function handleStopRequest(rawRunId: unknown): Promise<{ ok: boolean; stopped: boolean }> {
    const runId = parseRunId(rawRunId);
    if (runOwner !== RUN_OWNER_NONE) {
        if (runOwnerRunId !== runId) return { ok: false, stopped: false };
        if (runState?.runId === runId) {
            runState.cancelled = true;
            runState.statusText = "Stopping...";
        }
        abortController?.abort();
        return { ok: true, stopped: true };
    }
    if (runState?.runId === runId && runState.terminal) {
        return { ok: true, stopped: false };
    }
    pendingStopRunId = runId;
    return { ok: true, stopped: false };
}

async function handleCopyRequest(res: ViteHttpResponse, runId: string | null): Promise<void> {
    if (
        !runId
        || !runState
        || runState.runId !== runId
        || !copyArtifact
        || copyArtifact.runId !== runId
    ) {
        throw new HttpStatusError(404, "No retained Copy Results artifact for this run.");
    }
    const payload = await readFile(copyArtifact.file);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(payload.byteLength));
    res.end(payload);
}

function registerRankPairsRoutes(middlewares: any): void {
    const unauthorizedMessage = "Unauthorized: Rank Pairs routes are local-only.";
    registerLocalJsonRoute(middlewares, "/api/rank-pairs/run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: MAX_BODY_BYTES,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => handleRunRequest(res, body),
    });
    registerLocalJsonRoute(middlewares, "/api/rank-pairs/stop", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: 4_096,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => {
            sendJson(res, 200, await handleStopRequest(body.runId));
        },
    });
    registerLocalJsonRoute(middlewares, "/api/rank-pairs/status", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: ({ res, url }) => {
            const runId = url.searchParams.has("runId") ? url.searchParams.get("runId") : null;
            const snapshot = handleStatusRequest(runId);
            if (!snapshot) {
                sendJson(res, 404, { ok: false, error: "No matching Rank Pairs run." });
                return;
            }
            sendJson(res, 200, snapshot);
        },
    });
    registerLocalJsonRoute(middlewares, "/api/rank-pairs/copy", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res, url }) => {
            await handleCopyRequest(res, url.searchParams.get("runId"));
        },
    });
}

export function rankPairsVitePlugin(): Plugin {
    return {
        name: "rank-pairs-server",
        configureServer(server) {
            void sweepOrphanedCopyArtifacts();
            registerRankPairsRoutes(server.middlewares);
        },
        configurePreviewServer(server) {
            void sweepOrphanedCopyArtifacts();
            registerRankPairsRoutes(server.middlewares);
        },
    };
}

export const __testInternals = {
    parseRunId,
    parseMode,
    parseSymbols,
    shouldSweepOrphanEntry,
    handleStopRequest,
    handleStatusRequest,
    registerRankPairsRoutesForTests: registerRankPairsRoutes,
    consumePendingStop,
    setRunStateForTests(state: InternalRunState | null): void {
        runState = state;
    },
    setRunOwnerForTests(owner: number, runId: string | null): void {
        runOwner = owner;
        runOwnerRunId = runId;
    },
    setAbortControllerForTests(controller: AbortController | null): void {
        abortController = controller;
    },
    resetForTests(): void {
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
        abortController = null;
        pendingStopRunId = null;
        runState = null;
    },
};
