/**
 * Stream + status contract for the server-owned Finder Symbol Universe job.
 *
 * One server job owns all selected strategies: it sequences each entry
 * strategy through `runFinderUniverseExecution(...)`, merges the scalar
 * survivors, runs the optional OOS pass, and publishes one authoritative
 * terminal candidate slice. The browser remains the control + rendering
 * layer and reattaches after a tab reload by polling
 * `GET /api/finder/status?runId=...`.
 *
 * The browser consumes stream events via `consumeNdjsonStream`
 * (lib/ndjson-stream.ts), which dispatches by mapping `event.type` to a
 * camelCase handler key (e.g. `symbol_failed` -> `onSymbolFailed`).
 *
 * CRITICAL CONTRACT: the `candidate` payload sent in `candidate` events and
 * returned in the terminal status snapshot must contain ONLY scalars (plus
 * the already-scalar `symbols` metrics array). The Finder universe runner
 * holds N full OHLCV datasets in memory during the evaluation loop; in
 * server-owned mode those stay in Node so the browser tab stays bounded
 * regardless of symbol count. The browser reconstructs a
 * `FinderUniverseCandidate[]` from the stream with no heavy arrays.
 *
 * `FinderUniverseCandidate` / `FinderUniverseSymbolResult` are already scalar
 * by design (only metrics + status + light timing meta); the server plugin
 * calls {@link toScalarCandidate} as a defensive strip so a future field added
 * to those types cannot accidentally ship an array over the wire.
 *
 * Unlike the Batch stream, the Finder stream has no Mine / artifact / TTL
 * surface — Universe has no Mine step. The `done` event carries the terminal
 * survivor count; the server holds the datasets only for the duration of the
 * run (plus the OOS pass), then releases them.
 */

import type { BatchDatasetCacheStats } from "../../batch-backtest/batch-dataset-loader-core";
import type { FinderAssetOpportunityArchiveSort } from "../finder-asset-opportunity-metrics";
import type {
    FinderAssetOpportunityDiagnostics,
    FinderAssetOpportunityResult,
    FinderDiagnostics,
    FinderUniverseCandidate,
    FinderUniverseSymbolResult,
} from "../../types/finder";
import type { StrategyParams } from "../../types/strategies";

// ---------------------------------------------------------------------------
// Job phase + run identity
// ---------------------------------------------------------------------------

/**
 * Coarse lifecycle phase of a server-owned universe job. Surfaced in
 * `progress` events and the `/status` snapshot so the browser and reattach
 * polling render the same phase. The runner-internal load/evaluate split is
 * flattened to `loading` / `evaluating`; OOS is its own phase because it
 * runs after the merged IS survivors are finalized.
 */
export type FinderJobPhase = "loading" | "evaluating" | "oos" | "done" | "cancelled" | "fatal";

/**
 * The kind of server-owned Finder job. `symbol_universe` evaluates strategies
 * across a shared universe; `asset_opportunity` searches independently per
 * asset and ranks assets by fresh-entry evidence. The discriminant is a
 * wire-level field so the status snapshot + terminal payload can distinguish
 * which terminal slice they carry.
 */
export type FinderJobKind = "symbol_universe" | "asset_opportunity" | "asset_opportunity_batch";

// ---------------------------------------------------------------------------
// Stream events (NDJSON, one JSON object per line)
// ---------------------------------------------------------------------------

/**
 * Asset Opportunity terminal totals, shared by the single `asset_done` event
 * and each `asset_batch_iteration_done` event.
 */
export interface FinderAssetOpportunityTotals {
    totalAssets: number;
    assetsWithFreshEntry: number;
    selectGradeAssets: number;
    watchGradeAssets: number;
    rejectGradeAssets: number;
    failedAssets: number;
    engineUsage?: FinderAssetOpportunityDiagnostics["engineUsage"];
}

export type FinderStreamEvent =
    | {
        type: "start";
        /** Browser-generated job id, echoed so a reload can match the run. */
        runId: string;
        totalCandidates: number;
        totalSymbols: number;
        interval: string;
        /** Ordered selected entry strategy keys for this job. */
        strategyKeys: string[];
        /** Number of selected entry strategies (=== strategyKeys.length). */
        strategyCount: number;
    }
    | {
        type: "progress";
        percent: number;
        text: string;
        status: string;
        phase: FinderJobPhase;
        /** 0-based index of the strategy currently being evaluated. */
        strategyIndex: number;
        /** Total number of strategies in the job (=== start.strategyCount). */
        strategyCount: number;
    }
    | {
        type: "candidate";
        /** Index of this candidate in the per-strategy candidate plan stream. */
        index: number;
        totalCandidates: number;
        /** Scalar survivor candidate (no OHLCV / signals / trades arrays). */
        candidate: FinderUniverseCandidate;
    }
    | { type: "symbol_failed"; symbol: string; error: string }
    | {
        type: "done";
        ok: boolean;
        cancelled: boolean;
        runId: string;
        interval: string;
        totals: {
            loadedSymbols: number;
            failedSymbols: number;
            survivors: number;
            oosRemoved: number;
        };
        summary: string;
        /**
         * Terminal, authoritative survivor slice (already sorted + sliced to
         * topN by the runner). The browser MUST adopt this on `done` instead
         * of relying only on incrementally-streamed `candidate` events,
         * because the 750ms results throttle means the final survivors may
         * never have been emitted as `candidate` events (the last flush before
         * `done` can miss late passers). Carries the same scalar-only contract.
         */
        candidates: FinderUniverseCandidate[];
        /** Terminal diagnostics for the run (engine mode, timing, bottlenecks). */
        diagnostics: FinderDiagnostics | null;
        /** Server-side loader cache counters captured at run completion. */
        cacheStats?: BatchDatasetCacheStats;
    }
    | { type: "fatal"; runId: string; error: string };

/**
 * Asset Opportunity job stream events. The discriminant on the `type` field
 * keeps them distinct from the universe events, so the same `consumeNdjsonStream`
 * dispatch maps `asset_start`/`asset_progress`/`asset_complete`/`asset_done`
 * onto camelCase handler keys without colliding with the universe handlers.
 *
 * The `asset_complete` event carries one scalar asset result (fresh entry
 * only). Assets with no fresh entry or a failure are carried in the terminal
 * `asset_done` payload's `diagnostics.failedAssets` / counts, not as
 * individual events (they are not display rows).
 */
export type FinderAssetOpportunityStreamEvent =
    | {
        type: "asset_start";
        runId: string;
        totalAssets: number;
        interval: string;
        strategyKey: string;
        strategyName: string;
        strategyKeys: string[];
        strategyNames: string[];
    }
    | {
        type: "asset_progress";
        percent: number;
        text: string;
        status: string;
        phase: FinderJobPhase;
        /** 0-based index of the asset currently being evaluated. */
        assetIndex: number;
        /** Total number of assets in the job. */
        totalAssets: number;
        /** True when the job is running its OOS pass over retained candidates. */
        oosActive: boolean;
    }
    | {
        type: "asset_complete";
        /** Scalar asset opportunity row. No OHLCV / signals / trades arrays. */
        asset: FinderAssetOpportunityResult;
        /** 0-based index of this asset in the job. */
        assetIndex: number;
        /** Total number of assets in the job. */
        totalAssets: number;
    }
    | {
        type: "asset_done";
        ok: boolean;
        cancelled: boolean;
        runId: string;
        interval: string;
        totals: FinderAssetOpportunityTotals;
        summary: string;
        /**
         * Terminal authoritative full Asset Opportunity result set, sorted by
         * the default run ordering. The browser applies topN only for display;
         * post-run re-sort must be able to rank every scalar row.
         */
        assets: FinderAssetOpportunityResult[];
        diagnostics: FinderDiagnostics | null;
        assetDiagnostics: FinderAssetOpportunityDiagnostics | null;
    }
    | { type: "asset_fatal"; runId: string; error: string };

/**
 * Asset Opportunity batch stream events. One server job owns the whole
 * holdout sweep; each iteration reuses the unchanged per-asset algorithm and
 * reports its full scalar rows on `asset_batch_iteration_done`. No event
 * carries prior iterations' rows — the browser retains only the current
 * iteration for re-sort and Apply.
 */
export type FinderAssetOpportunityBatchStreamEvent =
    | {
        type: "asset_batch_start";
        runId: string;
        startHoldoutBars: number;
        endHoldoutBars: number;
        totalIterations: number;
        totalAssets: number;
        strategyKeys: string[];
        strategyNames: string[];
        /** Always All Sorts; retained in the event for archive observability. */
        archiveSort: FinderAssetOpportunityArchiveSort | null;
    }
    | {
        type: "asset_batch_progress";
        runId: string;
        /** Current holdout value being evaluated. */
        holdoutBars: number;
        /** 0-based index of the current iteration. */
        iterationIndex: number;
        totalIterations: number;
        /** Overall job progress 0-100 (iteration + in-iteration asset progress). */
        percent: number;
        phase: FinderJobPhase;
        statusText: string;
        /** 0-100 progress within the current iteration. */
        assetProgress: number;
    }
    | {
        type: "asset_batch_iteration_done";
        runId: string;
        holdoutBars: number;
        /** 0-based index of the completed iteration. */
        iterationIndex: number;
        totalIterations: number;
        /** Full scalar Asset Opportunity rows for THIS holdout only (no prior iterations). */
        assets: FinderAssetOpportunityResult[];
        totals: FinderAssetOpportunityTotals;
        diagnostics: FinderDiagnostics | null;
        assetDiagnostics: FinderAssetOpportunityDiagnostics | null;
        /** Basename of the appended archive file. Empty results still write a block. */
        archiveFilename: string;
    }
    | {
        type: "asset_batch_done";
        ok: boolean;
        cancelled: boolean;
        runId: string;
        completedIterations: number;
        failedIterations: number;
        /** Full scalar rows of the LAST completed iteration only. */
        assets: FinderAssetOpportunityResult[];
        /** Last completed iteration's holdout and aggregate diagnostics. */
        holdoutBars: number | null;
        totals: FinderAssetOpportunityTotals | null;
        diagnostics: FinderDiagnostics | null;
        assetDiagnostics: FinderAssetOpportunityDiagnostics | null;
        summary: string;
    }
    | {
        type: "asset_batch_fatal";
        runId: string;
        error: string;
        /** Holdout that was running when the batch failed, or null. */
        holdoutBars: number | null;
        completedIterations: number;
    };

/**
 * Bounded batch status carried on the run snapshot while an
 * `asset_opportunity_batch` job is running (and retained at terminal). Counts
 * only — never per-iteration rows. The terminal view uses the existing
 * `terminalAssets` field for the last completed iteration.
 */
export interface FinderBatchStatus {
    startHoldoutBars: number;
    endHoldoutBars: number;
    currentHoldoutBars: number | null;
    /** 1-based index of the current iteration; 0 before the first. */
    currentIteration: number;
    totalIterations: number;
    completedIterations: number;
    failedIterations: number;
}

/**
 * Union of every event the Finder server can emit. The browser's
 * `consumeNdjsonStream` dispatches by the `type` field; the asset-opportunity
 * events share the same wire shape as the universe events but with distinct
 * `type` discriminants so handlers don't collide.
 */
export type AnyFinderStreamEvent =
    | FinderStreamEvent
    | FinderAssetOpportunityStreamEvent
    | FinderAssetOpportunityBatchStreamEvent;

// ---------------------------------------------------------------------------
// Status snapshot (GET /api/finder/status?runId=...)
// ---------------------------------------------------------------------------

/**
 * Shared, typed response for `GET /api/finder/status`. Replaces the prior
 * untyped introspection object so the browser reattach path and the server
 * agree on the shape.
 *
 * In-progress snapshots are SUMMARY-ONLY: they carry candidate COUNTS, never
 * the full candidate payload, so polling stays small while a large universe
 * is running. The terminal snapshot is the one place that may carry the
 * authoritative final candidate slice.
 *
 * A status response for a run id that does not match the active/last run
 * returns 404 at the HTTP layer; this type only describes a matching run.
 */
export type FinderRunStatusSnapshot = {
    ok: true;
    /** True while a job holds the owner lock. */
    running: boolean;
    /** True once the run reached a terminal snapshot (done/cancelled/fatal). */
    terminal: boolean;
    runId: string;
    startedAt: number;
    /** Completion time, set on the terminal snapshot only. */
    finishedAt: number | null;
    phase: FinderJobPhase;
    interval: string;
    /**
     * Job kind discriminator. The browser uses this to decide which terminal
     * slice (`terminalCandidates` vs `terminalAssets`) to adopt and which
     * render path to take. Older server processes that pre-date this field
     * report `symbol_universe` by default.
     */
    jobKind: FinderJobKind;
    /** Ordered selected entry strategy keys. */
    strategyKeys: string[];
    /** 0-based index of the strategy currently being evaluated. */
    strategyIndex: number;
    /** Total number of strategies in the job. */
    strategyCount: number;
    totalSymbols: number;
    progressPercent: number;
    statusText: string;
    /** Candidate count only while running; the full slice ships when terminal. */
    candidateCount: number;
    loadedSymbols: number;
    failedSymbols: number;
    cancelled: boolean;
    /** Present and authoritative only on the terminal symbol_universe snapshot. */
    terminalCandidates: FinderUniverseCandidate[] | null;
    /** Present and authoritative only on the terminal asset_opportunity snapshot. */
    terminalAssets: FinderAssetOpportunityResult[] | null;
    summary: string | null;
    /** Terminal fatal error; null for running, done, and cancelled jobs. */
    error: string | null;
    diagnostics: FinderDiagnostics | null;
    totals: {
        loadedSymbols: number;
        failedSymbols: number;
        survivors: number;
        oosRemoved: number;
    } | null;
    /**
     * Asset-opportunity-specific counts. Present on terminal asset-opportunity
     * snapshots; null for symbol_universe runs.
     */
    assetTotals: FinderAssetOpportunityTotals | null;
    /** Terminal Asset Opportunity diagnostics, retained for reload reattach. */
    assetDiagnostics?: FinderAssetOpportunityDiagnostics | null;
    /**
     * Bounded batch counts for `asset_opportunity_batch` jobs; null for other
     * kinds. Counts only, so polling stays small while the sweep runs.
     * Optional so older snapshot literals (and pre-batch servers) stay valid;
     * the server always sends it explicitly.
     */
    batch?: FinderBatchStatus | null;
};

// ---------------------------------------------------------------------------
// Scalar contract enforcement
// ---------------------------------------------------------------------------

/**
 * Names of fields that must NEVER appear on a wire candidate because they would
 * carry heavy per-bar / per-trade arrays. A defensive scan asserts none of
 * these keys leak onto a streamed candidate. `symbols` is allowed (it is a
 * scalar metrics array); `data`, `signals`, `trades`, and `equityCurve` are not.
 */
export const FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS = [
    "data",
    "signals",
    "trades",
    "equityCurve",
    "ohlcvData",
] as const;

/**
 * Defensive scalar strip for a universe candidate. The candidate type is
 * already scalar by construction; this is a belt-and-braces guard so a future
 * field that accidentally carries an array cannot reach the wire. Mirrors the
 * intent of `toScalarRow` in the Batch stream (without the per-result trade
 * stripping, which Universe candidates never carry).
 *
 * Also deep-strips any forbidden array fields that may have leaked onto the
 * per-symbol result objects.
 */
export function toScalarCandidate(candidate: FinderUniverseCandidate): FinderUniverseCandidate {
    const clone: FinderUniverseCandidate = {
        ...candidate,
        params: { ...(candidate.params as StrategyParams) },
        symbols: candidate.symbols.map(stripSymbolResultScalars),
        ...(candidate.exitStrategyParams
            ? { exitStrategyParams: { ...(candidate.exitStrategyParams as StrategyParams) } }
            : {}),
    };
    // Defensive: drop any forbidden array fields that are NOT part of the
    // candidate type but might have been attached by a future code path.
    for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
        if (key in clone) {
            delete (clone as unknown as Record<string, unknown>)[key];
        }
    }
    if (!Number.isFinite(clone.medianExitAlpha)) delete clone.medianExitAlpha;
    if (!Number.isFinite(clone.medianOosExitAlpha)) delete clone.medianOosExitAlpha;
    return clone;
}

function stripSymbolResultScalars(symbol: FinderUniverseSymbolResult): FinderUniverseSymbolResult {
    const clone: FinderUniverseSymbolResult = {
        ...symbol,
        ...(symbol.result ? { result: { ...symbol.result } } : {}),
        ...(symbol.oosResult ? { oosResult: { ...symbol.oosResult } } : {}),
    };
    for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
        if (key in clone) {
            delete (clone as unknown as Record<string, unknown>)[key];
        }
    }
    if (clone.result && !Number.isFinite(clone.result.exitAlpha)) delete clone.result.exitAlpha;
    if (clone.oosResult && !Number.isFinite(clone.oosResult.exitAlpha)) delete clone.oosResult.exitAlpha;
    return clone;
}

/**
 * Assertion that a candidate carries no forbidden array fields. Called in
 * production by the server plugin before writing each `candidate` event (and
 * before the terminal `done.candidates` slice) so a contract violation fails
 * loud at the source instead of corrupting the browser heap. The check is
 * O(forbidden-fields × symbols) per candidate — cheap relative to the
 * backtest that produced the candidate. Inlined (not a full deep-scan) because
 * the candidate type is known-scalar; the forbidden keys are the only ones
 * that could leak.
 */
export function assertCandidateIsScalar(candidate: FinderUniverseCandidate): void {
    for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
        if (key in candidate) {
            throw new Error(
                `Finder universe candidate carries forbidden array field "${key}" on the wire; ` +
                "the server must strip it before streaming. See toScalarCandidate.",
            );
        }
    }
    for (const symbol of candidate.symbols) {
        for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
            if (key in symbol) {
                throw new Error(
                    `Finder universe symbol result for ${symbol.symbol} carries forbidden array field "${key}"; ` +
                    "the server must strip it before streaming.",
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Asset Opportunity scalar contract enforcement
// ---------------------------------------------------------------------------

/**
 * Defensive scalar strip for an Asset Opportunity result. The asset type is
 * already scalar by construction (no OHLCV / signals / trades arrays on the
 * top level); `selectionResult` and `oosResult` are BacktestResult objects
 * whose `trades` and `equityCurve` fields must be emptied before the result
 * reaches the wire, since those are the heavy per-bar arrays the scalar
 * contract forbids.
 *
 * Mirrors the intent of `toScalarCandidate` for the Universe scope.
 */
export function toScalarAssetResult(asset: FinderAssetOpportunityResult): FinderAssetOpportunityResult {
    const clone: FinderAssetOpportunityResult = {
        ...asset,
        params: { ...(asset.params as StrategyParams) },
        ...(asset.exitStrategyParams ? { exitStrategyParams: { ...(asset.exitStrategyParams as StrategyParams) } } : {}),
        selectionResult: stripHeavyBacktestResultArrays(asset.selectionResult),
        ...(asset.oosResult ? { oosResult: stripHeavyBacktestResultArrays(asset.oosResult) } : {}),
        ...(asset.oosNextExitMetrics ? { oosNextExitMetrics: { ...asset.oosNextExitMetrics } } : {}),
        support: { ...asset.support },
    };
    for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
        if (key in clone) {
            delete (clone as unknown as Record<string, unknown>)[key];
        }
    }
    return clone;
}

/**
 * Strip the heavy per-bar arrays from a BacktestResult so the scalar wire
 * contract holds. Returns a shallow clone with `trades` and `equityCurve`
 * emptied; other scalar fields pass through unchanged.
 */
function stripHeavyBacktestResultArrays<T extends { trades: unknown[]; equityCurve: unknown[] }>(result: T): T {
    return {
        ...result,
        trades: [],
        equityCurve: [],
    };
}

/**
 * Assertion that an asset result carries no forbidden array fields (top level
 * or on its nested BacktestResult). Called in production by the server plugin
 * before writing each `asset_complete` event (and before the terminal
 * `asset_done.assets` slice).
 */
export function assertAssetResultIsScalar(asset: FinderAssetOpportunityResult): void {
    for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
        if (key in asset) {
            throw new Error(
                `Asset Opportunity result for ${asset.symbol} carries forbidden array field "${key}" on the wire; ` +
                "the server must strip it before streaming. See toScalarAssetResult.",
            );
        }
    }
    if (Array.isArray(asset.selectionResult.trades) && asset.selectionResult.trades.length > 0) {
        throw new Error(
            `Asset Opportunity result for ${asset.symbol} carries a non-empty selectionResult.trades array; ` +
            "the server must strip it before streaming.",
        );
    }
    if (Array.isArray(asset.selectionResult.equityCurve) && asset.selectionResult.equityCurve.length > 0) {
        throw new Error(
            `Asset Opportunity result for ${asset.symbol} carries a non-empty selectionResult.equityCurve array; ` +
            "the server must strip it before streaming.",
        );
    }
    if (asset.oosResult) {
        if (Array.isArray(asset.oosResult.trades) && asset.oosResult.trades.length > 0) {
            throw new Error(
                `Asset Opportunity result for ${asset.symbol} carries a non-empty oosResult.trades array; ` +
                "the server must strip it before streaming.",
            );
        }
        if (Array.isArray(asset.oosResult.equityCurve) && asset.oosResult.equityCurve.length > 0) {
            throw new Error(
                `Asset Opportunity result for ${asset.symbol} carries a non-empty oosResult.equityCurve array; ` +
                "the server must strip it before streaming.",
            );
        }
    }
}
