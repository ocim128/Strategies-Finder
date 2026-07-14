/**
 * Counterfactual Timing Surface Miner — serializable, server-safe contracts.
 *
 * Pure types and resolved-option/cost-model contracts. No DOM, no chart, no
 * `lightweight-charts` transitive imports, keeping the server import-safe.
 *
 * The engine evaluates a fixed, server-controlled grid of entry delays and
 * hold horizons against reconstructed Stability subsets. Every result emitted
 * to the browser is scalar-only and labelled `evidenceScope:
 * "historical_conditional"` with `exploitEligible: false` in Phases 1–4.
 */

import type { BatchStabilityMineResult } from "./batch-stability-mine";

// ---------------------------------------------------------------------------
// Schema / decisions / reason codes (closed unions)
// ---------------------------------------------------------------------------

export const TIMING_SURFACE_SCHEMA_VERSION = 1;

/** Server-controlled entry-delay grid.  `0..3` bars. */
export const TIMING_SURFACE_DELAYS = [0, 1, 2, 3] as const;
export type TimingSurfaceDelay = (typeof TIMING_SURFACE_DELAYS)[number];

/** Fallback horizons when discovery has no qualifying closed trades. */
export const TIMING_SURFACE_FALLBACK_HORIZONS = [6, 12, 24] as const;

/**
 * Terminal action emitted per row. The actionable decisions (`ENTER_NOW`,
 * `WAIT_n`) are only emitted when the retained Stability row is still fresh
 * and actionable at completion. Delayed decisions are revalidation
 * instructions, not scheduled orders.
 */
export type TimingSurfaceDecision =
    | "ENTER_NOW"
    | "WAIT_1"
    | "WAIT_2"
    | "WAIT_3"
    | "WATCH"
    | "SKIP"
    | "INVALID";

/**
 * Closed reason-code union. UI copy must NOT parse free-form prose — every
 * outcome has a stable code.
 */
export type TimingSurfaceReasonCode =
    | "ACCEPTED_PLATEAU"
    | "ACTIONABLE_NOW"
    | "AWAITING_REVALIDATION"
    | "INSUFFICIENT_RECURRENCE"
    | "INVALID_INPUT"
    | "ISOLATED_OPTIMUM"
    | "NEGATIVE_NET_EXPECTANCY"
    | "NO_DISCOVERY_HORIZON"
    | "NO_POSITIVE_SELECTION"
    | "NO_POSITIVE_LIFT"
    | "NO_PLATEAU"
    | "NON_POSITIVE_EDGE"
    | "SOURCE_STALE"
    | "VALIDATION_FAILED";

/** Evidence scope: every Phase 1–4 result carries this label. */
export const TIMING_SURFACE_EVIDENCE_SCOPE = "historical_conditional" as const;
export type TimingSurfaceEvidenceScope = typeof TIMING_SURFACE_EVIDENCE_SCOPE;

// ---------------------------------------------------------------------------
// Cost / execution model
// ---------------------------------------------------------------------------

export type TimingSurfaceExecutionModel = "signal_close" | "next_open" | "next_close";

/**
 * Normalized cost and execution model retained server-side under the active
 * Batch fingerprint. The timing-surface endpoint accepts only fingerprint and
 * interval; the browser never overrides research thresholds, costs, Stability
 * metadata, or subset seeds.
 */
export interface TimingSurfaceCostModel {
    /** Commission percent (e.g. 0.05 = 0.05% of notional). Mirrors CapitalSettings.commission. */
    commissionPercent: number;
    /** Slippage in basis points applied adversely on entry and exit. */
    slippageBps: number;
    executionModel: TimingSurfaceExecutionModel;
}

/**
 * Server-controlled grid bounds. The endpoint exposes no tuning override.
 *
 */
export interface TimingSurfaceGates {
    /** Minimum independent episodes per rerun/cell/window metric. */
    minEpisodesPerRerunCell: number;
    /** Minimum rerun recurrence for a cell to qualify. */
    minQualifyingReruns: number;
    /** Minimum fraction of configured reruns for a cell to qualify. */
    minRecurrenceFraction: number;
    /** Fraction of validation-evaluable matching-direction reruns that must be net positive. */
    validationPositiveRerunFraction: number;
    /** Minimum plateau neighbor count. */
    plateauMinPositiveNeighbors: number;
    /** Neighbor count bounds reused from Mine Timing. */
    neighborCountMin: number;
    neighborCountMax: number;
    /** Cap on emitted cells per result (bounded NDJSON). */
    maxCellsPerResult: number;
}

export const TIMING_SURFACE_DEFAULT_GATES: Readonly<TimingSurfaceGates> = {
    minEpisodesPerRerunCell: 4,
    minQualifyingReruns: 5,
    minRecurrenceFraction: 0.1,
    validationPositiveRerunFraction: 0.6,
    plateauMinPositiveNeighbors: 2,
    neighborCountMin: 4,
    neighborCountMax: 24,
    maxCellsPerResult: 64,
};

// ---------------------------------------------------------------------------
// Cell / window / episode contracts
// ---------------------------------------------------------------------------

export type TimingSurfaceWindow = "discovery" | "selection" | "validation";

/**
 * Aggregated metrics for one (delay, horizon) cell inside one window. Per-rerun
 * metrics are computed independently and aggregated across reruns; duplicated
 * historical episodes across reruns are NEVER pooled as independent observations.
 */
export interface TimingSurfaceCellWindowMetrics {
    window: TimingSurfaceWindow;
    /** Number of reruns contributing metrics (direction matches retained Stability row). */
    evaluatedReruns: number;
    /** Number of reruns whose cell metrics passed the min-episode gate. */
    qualifyingReruns: number;
    /**
     * Number of qualifying reruns whose per-rerun median net return is POSITIVE.
     * Selection ranking and the validation gate use the
     * POSITIVE-rerun count, NOT bare coverage. Without this field the ranking
     * and 60%-positive gate would be gamed by reruns that contributed episodes
     * but lost money on average.
     */
    positiveReruns: number;
    /** Median across reruns of per-rerun median net return, in percent. */
    medianNetReturnPct: number | null;
    /** 10th percentile across reruns of per-rerun median net return, in percent. */
    p10NetReturnPct: number | null;
    /** Median across reruns of per-rerun win rate in [0,1]. */
    medianWinRate: number | null;
    /** Median across reruns of per-rerun lift over immediate entry, in percent (delayed cells only). */
    medianLiftOverImmediatePct: number | null;
    /** Total independent episodes across all contributing reruns (sum, NOT pooled for stats). */
    totalEpisodes: number;
}

/**
 * One decision row keyed by (asset, fixed Stability direction). Every row
 * includes the discovery/selection/validation sample and independent-episode
 * counts, evaluated/positive rerun counts, median and lower-percentile net
 * return, win rate, lift over immediate entry, chosen delay, horizon, plateau
 * support, `asOfTimeKey`, and revalidation bar/time when it can be computed.
 */
export interface TimingSurfaceRow {
    asset: string;
    direction: "LONG" | "SHORT";
    decision: TimingSurfaceDecision;
    reasonCodes: TimingSurfaceReasonCode[];
    /** Frozen winning cell (null when no actionable policy was chosen). */
    chosenDelay: TimingSurfaceDelay | null;
    chosenHorizon: number | null;
    /** Cell whose scalar metrics populate this row, including rejected diagnostics. */
    evidenceDelay: TimingSurfaceDelay | null;
    evidenceHorizon: number | null;
    /** Source Stability row's freshness at completion. */
    asOfTimeKey: string | null;
    /** Delayed revalidation bar (target bar index for re-run); null for delay 0 / invalid. */
    revalidationBarIndex: number | null;
    /** Stability action recomputed at completion. */
    sourceStabilityAction: "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID";
    /** Aggregate counts (selected cell). */
    discoveryEpisodes: number;
    selectionEpisodes: number;
    validationEpisodes: number;
    discoveryEvaluatedReruns: number;
    selectionEvaluatedReruns: number;
    validationEvaluatedReruns: number;
    /** Reruns that met the per-cell minimum episode count in each window. */
    discoveryQualifyingReruns: number;
    selectionQualifyingReruns: number;
    validationQualifyingReruns: number;
    /**
     * Positive-rerun counts per window. Selection ranking
     * orders by selection positive-rerun rate; the validation gate divides
     * validation positive-reruns by validation-evaluable matching-direction
     * reruns for the required 60% threshold.
     */
    discoveryPositiveReruns: number;
    selectionPositiveReruns: number;
    validationPositiveReruns: number;
    /** Median net return % across reruns for the chosen cell (selection window). */
    selectionMedianNetReturnPct: number | null;
    /** 10th percentile net return % across reruns (selection window). */
    selectionP10NetReturnPct: number | null;
    /** Lift over immediate entry % for delayed cells; null for delay 0. */
    selectionMedianLiftPct: number | null;
    validationMedianNetReturnPct: number | null;
    validationP10NetReturnPct: number | null;
    validationMedianLiftPct: number | null;
    medianWinRate: number | null;
    plateauPositiveNeighborCount: number;
    /** Source Stability row timingEdgeScore for transparency. */
    sourceTimingEdgeScore: number;
}

/**
 * Bounded scalar cell payload. MUST NOT contain raw returns, sample arrays,
 * timestamps, OHLCV, signals, trades, or equity curves.
 */
export interface TimingSurfaceRowCells {
    /** Delay values in the fixed grid. */
    delays: readonly TimingSurfaceDelay[];
    /** Unique horizon values across emitted cells (sorted ascending). */
    horizons: readonly number[];
    /** Per-cell scalar summaries, capped at `maxCellsPerResult`, including rejected diagnostic grids. */
    cells: readonly TimingSurfaceScalarCellSummary[];
}

export interface TimingSurfaceScalarCellSummary {
    delay: TimingSurfaceDelay;
    horizon: number;
    discoveryMedianNetReturnPct: number | null;
    selectionMedianNetReturnPct: number | null;
    validationMedianNetReturnPct: number | null;
    discoveryQualifyingReruns: number;
    selectionQualifyingReruns: number;
    validationQualifyingReruns: number;
}

export interface TimingSurfaceProfile {
    /** Wall time for target dataset loading (ms). */
    targetLoadMs: number;
    /** Wall time for subset index reconstruction (ms). */
    subsetReconstructionMs: number;
    /** Wall time for analog reconstruction / state snapshots (ms). */
    analogReconstructionMs: number;
    /** Wall time for the pure engine policy-grid evaluation (ms). */
    engineMs: number;
    /** Wall time for cross-rerun aggregation + gating (ms). */
    aggregationMs: number;
    /** Total eligible targets evaluated. */
    targetsEvaluated: number;
    /** Total reruns evaluated across all targets. */
    rerunsEvaluated: number;
    /** Total delay/horizon cells evaluated across all eligible targets. */
    cellsEvaluated: number;
    /** Total cells emitted across all rows. */
    cellsEmitted: number;
    /** Total analog samples checked against a window boundary. */
    boundaryCheckedSamples: number;
    /** Count of samples purged for crossing window boundaries. */
    boundaryPurgedSamples: number;
}

export interface TimingSurfaceResult {
    schemaVersion: typeof TIMING_SURFACE_SCHEMA_VERSION;
    fingerprint: string;
    interval: string;
    generatedAt: number;
    asOfTimeKey: string | null;
    /** Server-retained Stability metadata used for subset reconstruction. */
    stability: {
        reruns: number;
        subsetSize: number;
        seed: number;
        totalPairs: number;
        targetAssets: number;
    };
    /** Server-retained cost model used for evaluation. */
    costModel: TimingSurfaceCostModel;
    /** Every Phase 1–4 result carries this scope. */
    evidenceScope: TimingSurfaceEvidenceScope;
    /** Always false until Phase 5 shadow qualification matures. */
    exploitEligible: boolean;
    rows: TimingSurfaceRow[];
    /** Per-row scalar cell summaries (bounded, scalar-only). */
    rowCells: Record<string, TimingSurfaceRowCells>;
    profile: TimingSurfaceProfile;
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Engine input
// ---------------------------------------------------------------------------

export interface TimingSurfaceTargetDataset {
    asset: string;
    data: import("../types/strategies").OHLCVData[];
}

/**
 * Engine input. The engine is pure apart from yielding between bounded work
 * units so the server event loop can service Stop requests.
 */
export interface TimingSurfaceEngineInput {
    fingerprint: string;
    interval: string;
    /** Retained Stability result — source of (asset, direction, asOfTimeKey). */
    stability: BatchStabilityMineResult;
    /** Recomputed current Stability actions for each row. */
    stabilityActions: ReadonlyMap<string, "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID">;
    costModel: TimingSurfaceCostModel;
    /** Per-target prepared datasets keyed by normalized asset. */
    targets: ReadonlyMap<string, TimingSurfaceTargetDataset>;
    /**
     * Per-rerun subset reconstruction callback. Returns the artifact indexes
     * selected for rerun `runIndex` using `sampleItems(preparedPairs, subsetSize,
     * seed + runIndex)`. Kept as a callback so the engine stays pure and the
     * server owns the artifact loading path.
     */
    resolveRerunLinkedArtifacts: (
        runIndex: number,
        targetAsset: string,
    ) => TimingSurfaceLinkedArtifacts | null;
    /** Checked between bounded work units; cancellation throws TimingSurfaceCancelled. */
    lostOwnership?: () => boolean;
    /** Completion-time clock. Tests may inject a deterministic value. */
    completionNow?: () => number;
    nowMs?: number;
}

/**
 * Thrown by the engine when `lostOwnership()` returns true mid-computation.
 * The server plugin catches this and emits a cancelled `done` event.
 */
export class TimingSurfaceCancelled extends Error {
    constructor() {
        super("Timing Surface cancelled.");
        this.name = "TimingSurfaceCancelled";
    }
}

/**
 * Linked prepared artifacts for one rerun's view of one target. Server-side
 * the plugin prepares pair artifacts once; this carries the linked subset for
 * a single (rerun, target) pair.
 */
export interface TimingSurfaceLinkedArtifacts {
    /** Linked synthetic-pair artifacts (subset for this rerun) — server-only heavy data. */
    linkedArtifacts: ReadonlyArray<import("./batch-synthetic-state-miner").BatchSyntheticPreparedPairArtifact>;
}
