/**
 * Vite dev-server plugin that hosts Finder Symbol Universe execution in Node.
 *
 * Mirrors `lib/batch-backtest/batch-backtest-vite-plugin.ts` in shape —
 * owner-generation lock, a factored `processFinderUniverseRun(input, writer,
 * owner)` core that takes a `writer` callback (so it is testable without an
 * HTTP response), a Stop endpoint that force-bumps the lock, and a status
 * endpoint for ad-hoc introspection of in-progress / last-run state.
 *
 * Why server-side at all: the Finder Symbol Universe runner holds N full
 * OHLCV datasets (~5–10 MB each at the 100k-bar cap) in browser-tab memory for
 * the whole evaluation loop (`finder-runner-universe.ts` line ~502). That
 * workload OOMs a browser tab on large universes; Node can use main RAM
 * directly. The browser tab keeps only the rendered scalar survivor rows.
 *
 * What this plugin is NOT (per plan §"What Should NOT Be Changed"):
 *   - It has NO Mine / artifact / TTL surface. Universe has no Mine step;
 *     copying Batch's artifact directory + 10-min TTL machinery would be dead
 *     code. The server holds datasets only for the run duration, then releases.
 *   - It does NOT touch the current-chart Finder path. That path already has
 *     a top-K heap and is single-dataset; it is not memory-pressured.
 *   - It does NOT broaden Universe to Polymarket scoring (Universe rejects it
 *     in `assertUniverseRunSupported`).
 *
 * The core `runFinderUniverseExecution` is reused UNCHANGED — server-side
 * dispatch only swaps the `loadDataset` callback for the Node-side loader.
 * Determinism and browser/server parity come from reusing the same core (same
 * as Batch reusing `runBatchBacktest`); there is no second implementation to
 * drift. The server runs IS only; the browser runs the OOS pass on the
 * returned survivors (`FinderManager.runUniverseFinder` feeds server results
 * into the shared OOS tail). Server-side OOS is a documented follow-up.
 *
 * Reattach: the browser does NOT consume `/api/finder/status` on reload in v1;
 * the endpoint exists only for `curl` introspection. See docs/finder-server-side.md.
 *
 * MEMORY CONTRACT (test-enforced, plan Phase 4): every `candidate` event
 * written by this plugin MUST be scalar-only. `toScalarCandidate` +
 * `assertCandidateIsScalar` enforce this at the source so a future field that
 * accidentally carries an OHLCV / signals / trades array cannot reach the wire
 * and re-pressurize the browser tab.
 */

import type { Plugin } from "vite";
import { getHeapStatistics } from "node:v8";
import { debugLogger } from "../../debug-logger";
import {
    beginNdjsonStream,
    HttpStatusError,
    readJsonBody,
    sendCaughtErrorJson,
    sendJson,
    type ViteHttpResponse,
} from "../../vite-http-utils";
import { runFinderUniverseExecution } from "../finder-runner-universe";
import type { FinderSelectedStrategy } from "../finder-runner";
import { FinderParamSpace } from "../finder-param-space";
import { sliceFinderDataWindow } from "../finder-manager-logic";
import type { CapitalSettings } from "../../types/backtest";
import type { FinderDiagnostics, FinderOptions, FinderUniverseCandidate } from "../../types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { loadBuiltInStrategyByKey } from "../../../strategyRegistry";
import {
    clearServerFinderDatasetCaches,
    getServerFinderDatasetCacheStats,
    loadServerFinderDataset,
} from "./server-finder-data-loader";
import {
    assertCandidateIsScalar,
    toScalarCandidate,
    type FinderStreamEvent,
} from "./finder-stream-types";
import { resolveFinderUniverseHeapWarning } from "./finder-server-heap-guard";
import { rememberLoopbackOriginFromRequest } from "../../local-api-transport";
import {
    clampFinderOptions,
    FINDER_BATCH_MAX_BODY_BYTES,
} from "../../server-request-limits";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAP_MB = 1024 * 1024;

// Stateless param-space generator (no constructor args, no browser deps).
// Module-scope so it's reused across requests, mirroring FinderManager.paramSpace.
const paramSpace = new FinderParamSpace();

// ---------------------------------------------------------------------------
// Module-scope state — single in-flight run per dev server (single-owner model)
// ---------------------------------------------------------------------------

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGen = 0;

let runState: FinderRunSnapshot | null = null;
let abortController: AbortController | null = null;

export type FinderRunSnapshot = {
    startedAt: number;
    interval: string;
    strategyKey: string;
    totalSymbols: number;
    /** Surviving candidates accumulated so far (scalar-only). */
    candidates: FinderUniverseCandidate[];
    /** Terminal diagnostics once the run finishes; null while in flight. */
    diagnostics: FinderDiagnostics | null;
    cancelled: boolean;
    /** Final summary string; populated on done. */
    summary: string | null;
};

// ---------------------------------------------------------------------------
// Run core (factored out of the HTTP handlers for testability)
// ---------------------------------------------------------------------------

type StreamWriter = (event: FinderStreamEvent) => void;

/**
 * Arguments for {@link processFinderUniverseRun}. Mirrors the shape the browser
 * `FinderManager.runUniverseFinder` builds for `runFinderUniverseExecution`,
 * plus `useRustEnginePreference` (the documented Rust-engine-trap fix) and the
 * universe `symbols` list (which the browser reads from the DOM).
 */
export interface FinderUniverseServerRunInput {
    interval: string;
    symbols: string[];
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategy: FinderSelectedStrategy;
    /** Candidate exit strategies Finder may sample for Exit Strategy Override. */
    exitStrategyCandidates?: FinderSelectedStrategy[];
    /**
     * Mirrors the user's Rust-engine UI toggle. Optional to match
     * {@link FinderUniverseRunInput.useRustEnginePreference} so tests can omit
     * it; the production HTTP handler always sets it from the request body.
     * See `shouldAttemptRust` for the Node-path semantics.
     */
    useRustEnginePreference?: boolean;
    /**
     * Data loader. Tests inject a stub; production wires
     * {@link loadServerFinderDataset}. Decoupled so the core is testable
     * without the dev server.
     */
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    /**
     * Optional override for `generateParamSets` (tests inject a deterministic
     * generator). Production wires the FinderManager param-space generator.
     */
    generateParamSets?: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    /** Provider lookup for cross-symbol strategies. */
    getProvider?: (symbol: string) => string;
}

/**
 * Core universe run, factored out of the HTTP handler so it can be tested with
 * a stubbed loader and writer without spinning up Vite. Mirrors
 * `processRunBatch` in the Batch plugin.
 *
 * `owner` keys cancellation: the loop bails as soon as `runOwner !== owner`
 * (Stop force-bumped the lock or a newer run took it). The shared
 * `abortController` cancels in-flight dataset loads.
 *
 * Parity: this is a THIN WRAPPER over `runFinderUniverseExecution`. The same
 * core that powers the browser path powers the server path; the only
 * difference is the `loadDataset` callback. Determinism and browser/server
 * result parity come from reusing the core.
 */
export async function processFinderUniverseRun(
    input: FinderUniverseServerRunInput,
    writer: StreamWriter,
    owner: number,
): Promise<void> {
    const symbols = input.symbols;
    const totalSymbols = symbols.length;
    const candidatePlansEstimate = estimateCandidateCount(input);

    runState = {
        startedAt: Date.now(),
        interval: input.interval,
        strategyKey: input.selectedStrategy.key,
        totalSymbols,
        candidates: [],
        diagnostics: null,
        cancelled: false,
        summary: null,
    };
    const snapshot = runState;

    writer({
        type: "start",
        totalCandidates: candidatePlansEstimate,
        totalSymbols,
        interval: input.interval,
        strategyKey: input.selectedStrategy.key,
    });

    const lostOwnership = () => runOwner !== owner;
    let cancelled = false;
    // Track the latest progress percent so `setStatus`-style status updates
    // (which the runner emits per-symbol) don't reset the bar to 0 server-side.
    let lastPercent = 0;
    // Dedup survivors by identity key. The runner re-emits the FULL survivor
    // set on every throttled `onResultsUpdate` (not just newly-passed ones),
    // so without per-identity tracking the same candidate is streamed once per
    // update — at topN=100 and a 750ms cadence that is up to 100 redundant wire
    // events + 100 browser sorts/DOM rebuilds per snapshot. Track which
    // identities have already been streamed so each is emitted AT MOST ONCE.
    // The terminal `done.candidates` slice remains authoritative, so a missed
    // incremental emit never loses a survivor.
    const survivorByKey = new Map<string, FinderUniverseCandidate>();
    const emittedKeys = new Set<string>();
    const identityKey = (c: FinderUniverseCandidate) =>
        `${c.strategyKey}|${JSON.stringify(c.params)}|${c.exitStrategyKey ?? ""}|${JSON.stringify(c.exitStrategyParams ?? {})}`;

    const mergeSurvivors = (results: readonly FinderUniverseCandidate[]): void => {
        for (const candidate of results) {
            survivorByKey.set(identityKey(candidate), candidate);
        }
        const merged = [...survivorByKey.values()];
        snapshot.candidates = merged;
    };

    try {
        const output = await runFinderUniverseExecution(
            {
                interval: input.interval,
                options: input.options,
                settings: input.settings,
                capitalSettings: input.capitalSettings,
                selectedStrategy: input.selectedStrategy,
                loadDataset: input.loadDataset,
                getProvider: input.getProvider,
                generateParamSets: input.generateParamSets ?? (() => []),
                exitStrategyCandidates: input.exitStrategyCandidates,
                // Thread the request's Rust preference into the runner so
                // executeBacktest opts in to Rust server-side (the documented
                // Rust-engine trap fix; see shouldAttemptRust).
                useRustEnginePreference: input.useRustEnginePreference,
            },
            {
                setProgress: (percent, text) => {
                    if (lostOwnership()) return;
                    lastPercent = percent;
                    writer({ type: "progress", percent, text, status: text });
                },
                setStatus: (text) => {
                    if (lostOwnership()) return;
                    writer({ type: "progress", percent: lastPercent, text, status: text });
                },
                yieldControl: async () => {
                    // Actually yield to the Node event loop so pending control
                    // requests (/api/finder/stop, /status, /api/sqlite/*) get
                    // serviced. Without this the universe runner's deliberate
                    // yield cadence (every 256 evaluations or 1s) was a no-op,
                    // and CPU-bound strategy/backtest work could keep the Vite
                    // dev server from processing Stop until the run completed.
                    // `setImmediate` schedules after I/O but before timers, which
                    // is the right phase to interleave with incoming requests.
                    await new Promise<void>((resolve) => setImmediate(resolve));
                },
                isCancelled: () => {
                    if (lostOwnership()) {
                        cancelled = true;
                        return true;
                    }
                    return false;
                },
                onResultsUpdate: (results) => {
                    if (lostOwnership()) return;
                    mergeSurvivors(results);
                    // Build an identity-key -> position index ONCE per update so
                    // each emitted candidate carries its real snapshot position.
                    // indexOf() would always return -1 here because
                    // toScalarCandidate produces a fresh deep clone (by-reference
                    // search can't match it); the identity key matches by value.
                    const indexByKey = new Map<string, number>();
                    for (let i = 0; i < snapshot.candidates.length; i += 1) {
                        indexByKey.set(identityKey(snapshot.candidates[i]!), i);
                    }
                    // Emit ONLY candidates whose identity has not been streamed
                    // yet. The runner re-emits the full survivor slice on every
                    // throttled update; without this guard, each update
                    // re-streams every survivor (up to topN events per update)
                    // and the browser rebuilds the DOM that many times. The
                    // terminal `done.candidates` slice is the authoritative
                    // finalization, so skipping a re-emit cannot drop a survivor.
                    for (const candidate of results) {
                        const key = identityKey(candidate);
                        if (emittedKeys.has(key)) continue;
                        emittedKeys.add(key);
                        const scalar = toScalarCandidate(candidate);
                        assertCandidateIsScalar(scalar);
                        writer({
                            type: "candidate",
                            index: indexByKey.get(key) ?? -1,
                            totalCandidates: candidatePlansEstimate,
                            candidate: scalar,
                        });
                    }
                },
            },
        );

        if (lostOwnership()) {
            cancelled = true;
            if (runState === snapshot) snapshot.cancelled = true;
        }

        // Reconcile the snapshot with the runner's terminal results — the
        // runner's `output.results` is the authoritative final survivor slice
        // (already sorted + sliced to topN), so replace the accumulated merge.
        const terminalResults = output.results.map(toScalarCandidate);
        for (const scalar of terminalResults) {
            assertCandidateIsScalar(scalar);
        }
        snapshot.candidates = terminalResults;
        snapshot.diagnostics = output.diagnostics ?? null;
        const summary = cancelled
            ? `Cancelled — ${terminalResults.length} survivors`
            : `Done — ${terminalResults.length} survivors, ${output.failedSymbols.length} failed symbols`;
        snapshot.summary = summary;

        writer({
            type: "done",
            ok: !cancelled,
            cancelled,
            interval: input.interval,
            totals: {
                loadedSymbols: output.loadedSymbols,
                failedSymbols: output.failedSymbols.length,
                survivors: terminalResults.length,
                oosRemoved: 0,
            },
            // Ship the terminal survivors on `done` so the browser doesn't
            // rely solely on throttled `candidate` events. The 750ms results
            // throttle means the final passers may never have been emitted as
            // a `candidate` event (the last flush before `done` can miss them);
            // adopting this slice on `done` is the authoritative finalization.
            candidates: terminalResults,
            summary,
            diagnostics: output.diagnostics ?? null,
            cacheStats: getServerFinderDatasetCacheStats(),
        });

        debugLogger.event("finder.server.run.complete", {
            symbols: totalSymbols,
            loadedSymbols: output.loadedSymbols,
            failedSymbols: output.failedSymbols.length,
            survivors: terminalResults.length,
            cancelled,
            durationMs: Date.now() - snapshot.startedAt,
            heapUsedMb: Math.round(process.memoryUsage().heapUsed / HEAP_MB),
            heapLimitMb: Math.floor(getHeapStatistics().heap_size_limit / HEAP_MB),
            interval: input.interval,
            strategyKey: input.selectedStrategy.key,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn("finder.server.run.fatal", { error: message });
        writer({ type: "fatal", error: message });
    } finally {
        abortController = null;
    }
}

/**
 * Rough estimate of the candidate-plan count for the `start` event. Mirrors
 * the browser status text ("Evaluating candidate N/M"). The exact count is
 * derived inside the runner from the param space; without re-running the
 * generator we approximate from `options.maxRuns`, which is the upper bound
 * for random mode (the only mode Universe supports).
 */
function estimateCandidateCount(input: FinderUniverseServerRunInput): number {
    return Math.max(1, Math.floor(input.options.maxRuns ?? 1));
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

interface FinderUniverseRequestBody {
    symbols: unknown;
    interval: unknown;
    options: unknown;
    settings: unknown;
    capitalSettings: unknown;
    strategyKey: unknown;
    exitStrategyKeys?: unknown;
    useRustEnginePreference?: unknown;
    /**
     * Browser-supplied provider map (symbol -> provider label) for the
     * cross-symbol mismatch guard. The browser builds this from
     * `dataManager.getProvider(symbol)`; the server has no browser state, so
     * without this map it would have to return a constant and silently allow
     * provider-mismatched cross-symbol pairs the browser rejects. See Finding 4.
     */
    providerBySymbol?: unknown;
}

async function handleRunRequest(res: ViteHttpResponse, body: FinderUniverseRequestBody): Promise<void> {
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A Finder universe run is already running. Use Stop first.");
    }

    const symbols = normalizeSymbols(body.symbols);
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one symbol is required.");
    }
    const heapWarning = resolveFinderUniverseHeapWarning(symbols.length);
    if (heapWarning) {
        throw new HttpStatusError(507, heapWarning);
    }
    const interval = parseInterval(body.interval);
    const strategyKey = parseStrategyKey(body.strategyKey);
    const strategy = await resolveStrategy(strategyKey);
    const options = parseOptions(body.options);
    assertUniverseOptions(options);
    const settings = (body.settings ?? {}) as BacktestSettings;
    const capitalSettings = (body.capitalSettings ?? {}) as CapitalSettings;
    const useRustEnginePreference = body.useRustEnginePreference === true;

    const selectedStrategy: FinderSelectedStrategy = {
        key: strategyKey,
        name: strategy.name,
        strategy,
    };
    const exitStrategyCandidates = await resolveExitStrategyCandidates(body.exitStrategyKeys);
    const providerBySymbol = parseProviderBySymbol(body.providerBySymbol);

    const owner = ++runOwnerGen;
    runOwner = owner;
    abortController = new AbortController();

    // The browser `FinderManager.runUniverseFinder` loadDataset wrapper applies
    // sliceFinderDataWindow(data, options.dataSlice) before evaluation. The
    // server loader returns the RAW series (its slice stays at the call site so
    // the loader stays symmetric with the Batch loader); apply the same slice
    // here so browser/server results match for half-window / OOS / data-slice
    // runs (parity bug fixed 2026-07).
    const dataSlice = options.dataSlice ?? "all";
    const loadDatasetWithSlice = (sym: string, intv: string, signal?: AbortSignal): Promise<OHLCVData[]> =>
        loadServerFinderDataset(sym, intv, signal)
            .then((data) => sliceFinderDataWindow(data, dataSlice));

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    try {
        stream = beginNdjsonStream(res);
        await processFinderUniverseRun(
            {
                interval,
                symbols,
                options,
                settings,
                capitalSettings,
                selectedStrategy,
                exitStrategyCandidates,
                useRustEnginePreference,
                loadDataset: loadDatasetWithSlice,
                getProvider: (symbol) => resolveServerProvider(symbol, providerBySymbol),
                generateParamSets: (defaultParams, finderOptions) =>
                    paramSpace.generateParamSets(defaultParams, finderOptions),
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

function rememberLocalApiOriginFromRequest(req: { headers?: Record<string, unknown>; socket?: { localAddress?: string; localPort?: number } | null }): void {
    // Derive the origin from the server's bound socket, not the spoofable Host
    // header (Finding 6). See `rememberLoopbackOriginFromRequest`.
    rememberLoopbackOriginFromRequest(req);
}

async function handleStopRequest(): Promise<{ ok: boolean; stopped: boolean }> {
    if (abortController) {
        try {
            abortController.abort();
        } catch {
            /* best-effort */
        }
    }
    const runWasActive = runOwner !== RUN_OWNER_NONE;
    runOwner = RUN_OWNER_NONE;
    return { ok: true, stopped: runWasActive };
}

/**
 * Snapshot of in-progress / last-run state for `GET /api/finder/status`. Used
 * only for ad-hoc `curl` introspection — the browser does NOT reattach via
 * this endpoint in v1 (unlike Batch). Returns the scalar candidate snapshot;
 * for a large universe that means a large JSON response, which is acceptable
 * for a manual debugging call (not an automated poll loop).
 */
function handleStatusRequest(): unknown {
    return {
        ok: true,
        running: runState !== null && runOwner !== RUN_OWNER_NONE,
        run: runState && runOwner !== RUN_OWNER_NONE
            ? {
                startedAt: runState.startedAt,
                interval: runState.interval,
                strategyKey: runState.strategyKey,
                totalSymbols: runState.totalSymbols,
                candidateCount: runState.candidates.length,
                candidates: runState.candidates,
                cancelled: runState.cancelled,
            }
            : null,
        lastRun: runState && runOwner === RUN_OWNER_NONE
            ? {
                interval: runState.interval,
                strategyKey: runState.strategyKey,
                candidateCount: runState.candidates.length,
                summary: runState.summary,
                diagnostics: runState.diagnostics,
            }
            : null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSymbols(raw: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const source = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
    for (const item of source) {
        if (typeof item !== "string") continue;
        const normalized = item.trim().toUpperCase();
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            out.push(normalized);
        }
    }
    return out;
}

function parseInterval(raw: unknown): string {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!value) {
        throw new HttpStatusError(400, "interval is required.");
    }
    return value;
}

function parseStrategyKey(raw: unknown): string {
    const value = String(raw ?? "").trim();
    if (!value) {
        throw new HttpStatusError(400, "strategyKey is required.");
    }
    return value;
}

function parseOptions(raw: unknown): FinderOptions {
    if (!raw || typeof raw !== "object") {
        throw new HttpStatusError(400, "options is required.");
    }
    // The browser serializes the full FinderOptions object; trust its shape but
    // surface a clear error if the universe block is missing (Universe mode is
    // the only supported scope server-side).
    const options = raw as FinderOptions;
    // Clamp topN/maxRuns to the UI-declared range so a typed/persisted/direct-
    // API value can't request a 1000× workload (Finding 5). Symbols/universe
    // blocks are validated by `assertUniverseOptions` below.
    return clampFinderOptions(options);
}

function assertUniverseOptions(options: FinderOptions): void {
    if (options.scope !== "symbol_universe") {
        throw new HttpStatusError(400, "Server-side Finder requires scope 'symbol_universe'.");
    }
    if (!options.universe || options.universe.symbols.length === 0) {
        throw new HttpStatusError(400, "options.universe.symbols must be a non-empty array.");
    }
}

async function resolveStrategy(strategyKey: string): Promise<Strategy> {
    // Use `loadBuiltInStrategyByKey` (not `ensureBuiltInStrategyLoaded`) so the
    // strategy is registered into `strategyRegistry`, mirroring the Batch
    // plugin. The server runs cold (no strategy panel UI) so the registry is
    // empty until we take the path that registers.
    const strategy = await loadBuiltInStrategyByKey(strategyKey);
    if (!strategy) {
        throw new HttpStatusError(400, `Strategy not loaded: ${strategyKey}`);
    }
    return strategy;
}

async function resolveExitStrategyCandidates(
    rawKeys: unknown,
): Promise<FinderSelectedStrategy[] | undefined> {
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) return undefined;
    const candidates: FinderSelectedStrategy[] = [];
    for (const key of rawKeys) {
        if (typeof key !== "string") continue;
        const strategy = await loadBuiltInStrategyByKey(key);
        if (strategy) {
            candidates.push({ key, name: strategy.name, strategy });
        }
    }
    return candidates.length > 0 ? candidates : undefined;
}

/**
 * Parse the browser-supplied provider map (symbol -> provider label). Returns
 * a normalized map keyed by uppercased symbol. Rejects (400) a non-object or
 * a map with non-string values so a malformed payload can't silently turn the
 * mismatch guard into an allow-all.
 *
 * The map is advisory: a symbol absent from the map falls back to the default
 * provider (the browser's default is spot Binance). This matches the browser's
 * own `dataManager.getProvider` behavior, which returns the default for an
 * unrecognized symbol.
 */
function parseProviderBySymbol(raw: unknown): Map<string, string> {
    const out = new Map<string, string>();
    if (raw === undefined || raw === null) return out;
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new HttpStatusError(400, "providerBySymbol must be an object mapping symbol -> provider.");
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "string") {
            throw new HttpStatusError(400, `providerBySymbol["${key}"] must be a string provider label.`);
        }
        const normalized = key.trim().toUpperCase();
        if (normalized) out.set(normalized, value);
    }
    return out;
}

/**
 * Provider label for cross-symbol strategies' provider-mismatch guard
 * (`crossSymbolDataFetcher.getProvider`). The browser uses
 * `dataManager.getProvider` → `DataProviderRouter`, which reads browser `state`
 * (binanceMarketType) and would break the cjs config bundle if imported here.
 *
 * The browser now sends a `providerBySymbol` map with the request so the server
 * applies the SAME mismatch guard the browser does (Finding 4: cross-provider
 * parity). A symbol present in the map resolves to its real provider; a symbol
 * absent from the map falls back to the default (`binance`), mirroring the
 * browser's `DataProviderRouter.getProvider` default. This keeps browser/server
 * results aligned for mixed Binance / IBKR / local-daily / TradFi / Polymarket
 * cross-symbol runs that previously diverged silently.
 */
function resolveServerProvider(symbol: string, providerBySymbol: Map<string, string>): string {
    const normalized = symbol.trim().toUpperCase();
    return providerBySymbol.get(normalized) ?? "binance";
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function finderVitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/finder/universe-run", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleRunRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES) as unknown as FinderUniverseRequestBody);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/finder/stop", async (req: any, res: any) => {
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

        middlewares.use("/api/finder/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            sendJson(res, 200, handleStatusRequest());
        });
    };

    return {
        name: "finder-universe-server",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

// Exported for tests only. `processFinderUniverseRun` consults module-scope
// `runOwner` for cancellation, mirroring the Batch plugin pattern. The HTTP
// handlers set it before invoking the factored function; tests need a way to
// do the same without spinning up Vite.
export const __testInternals = {
    handleStopRequest,
    handleStatusRequest,
    clearServerFinderDatasetCaches,
    setRunOwnerForTests(owner: number): void {
        // Mirrors the Batch plugin: sets the lock so processFinderUniverseRun's
        // lostOwnership() check behaves. Does NOT clear runState (the HTTP
        // handler's finally clears runOwner but leaves runState as the lastRun
        // snapshot for status reattach). Use resetRunStateForTests for a full
        // wipe between tests.
        runOwner = owner;
    },
    getRunStateForTests(): FinderRunSnapshot | null {
        return runState;
    },
    resetRunStateForTests(): void {
        runOwner = RUN_OWNER_NONE;
        runState = null;
        abortController = null;
    },
};
