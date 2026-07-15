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
import type {
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

// ---------------------------------------------------------------------------
// Stream events (NDJSON, one JSON object per line)
// ---------------------------------------------------------------------------

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
    /** Present and authoritative only on the terminal snapshot. */
    terminalCandidates: FinderUniverseCandidate[] | null;
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
    return clone;
}

function stripSymbolResultScalars(symbol: FinderUniverseSymbolResult): FinderUniverseSymbolResult {
    const clone: FinderUniverseSymbolResult = { ...symbol };
    for (const key of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
        if (key in clone) {
            delete (clone as unknown as Record<string, unknown>)[key];
        }
    }
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
