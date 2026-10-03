/**
 * Internal records shared between OPEN_SCORE USD replay stages: compact score
 * deltas, event snapshots, candidate views, and the stage input/result
 * contracts. Scalar and bounded by trades/events — no per-trade object
 * retention beyond the compact delta stream. Not exported through the engine
 * entry point.
 */
import type { ReplayArmField, SelectorName } from "./types";

/** Bounded phase callback shared by every replay stage. */
export type ReplayPhaseCallback = (
    phase: "scan" | "events" | "targets" | "outcomes" | "aggregate" | "switch",
    detail: string,
    completed: number,
    total: number,
) => void;

/**
 * Early exit of a bounded stage (cancellation or empty input). The engine
 * maps this to the same partial empty result the original inline path built;
 * each field is only present when the stage knows it.
 */
export interface ReplayEarlyExit {
    reportLine: string;
    pairs?: number;
    assets?: number;
    totalEvents?: number;
}

/** Stage result: either the stage's output or an early exit. */
export type StageOutcome<T> = { ok: true; result: T } | { ok: false; earlyExit: ReplayEarlyExit };

export interface ScoreDelta {
    timeSec: number;
    assetIndex: number;
    delta: number;
    /** 1 when this delta comes from a pair entry, 0 for an exit. */
    isEntry: number;
    /**
     * Share of the trade's net pnl carried by this delta: half on each exit
     * leg (full on single-leg direct markets), 0 on entries. The merge loop
     * accumulates these into the pair's realized-pnl-so-far total, which
     * drives the causal PROFIT_NOW gate.
     */
    pnlShare: number;
    /**
     * Causal PROFIT_NOW vote applicability, precomputed per trade at scan
     * time: true when the pair's pnl realized before the trade's entry was
     * strictly positive. An entry delta with true adds its vote to the
     * causal accumulators; its own exit deltas remove it. Exact for any
     * overlap pattern because the flag travels with the trade.
     */
    voteApplied: boolean;
    /**
     * Causal confidence-weighted PROFIT_NOW vote. Zero means the pair was not
     * profitable/known at this entry; the same weight is stamped on its exit.
     */
    profitNowConfidenceWeight: number;
}

export interface DecisionEvent {
    timeSec: number;
    // Snapshots are Float64Array (not number[]) purely for retention: eight
    // asset-length plain arrays per event cost ~2.4x the typed-array payload
    // and dominated replay-phase heap on large universes. Every consumer is an
    // index read, so typed arrays are behaviorally identical (including
    // out-of-bounds `undefined` under `?? 0`).
    /** Per-asset rawScore snapshot after applying all deltas at this time. */
    rawScore: Float64Array;
    activePairCount: Float64Array;
    /**
     * Profit-gated snapshots: the same accumulation restricted to deltas from
     * pairs whose pair backtest netProfit was strictly positive. Drives the
     * TOP_RAW_PROFIT / TOP_MEAN_PROFIT arms only. Look-ahead filter.
     */
    rawScoreProfit: Float64Array;
    activePairCountProfit: Float64Array;
    /**
     * Causal snapshots: restricted to deltas from pairs whose pnl realized
     * at or before this event is strictly positive. Drives the
     * TOP_RAW_PROFIT_NOW / TOP_MEAN_PROFIT_NOW arms.
     */
    rawScoreProfitNow: Float64Array;
    activePairCountProfitNow: Float64Array;
    /** Causal confidence-weighted PROFIT_NOW score snapshot. */
    rawScoreProfitNowConf: Float64Array;
    activePairCountProfitNowConf: Float64Array;
}

/** One asset-pool member at a decision event. */
export interface Candidate {
    assetIndex: number;
    raw: number;
    adjusted: number;
    mean: number;
    activePairs: number;
    /**
     * TOP_Z causal z-surprise of this candidate's PROFIT_NOW raw score vs
     * the asset's own prior decision-event history. Set only on
     * profit-now pool members (computed for every asset at every event).
     */
    z?: number;
}

/** Per-event candidate pools + pre-resolved picks (before gap filtering). */
export interface EventView {
    timeSec: number;
    /** Unique-best switch picks calculated while building the candidate pools. */
    assetSwitchPicks?: Readonly<Record<ReplayArmField, number | null>>;
    positives: Candidate[];
    /**
     * Profit-gated positives: assets whose score, counted only from
     * profitable pairs, is strictly positive. A candidate here need not
     * be in `positives` (offsetting losing-pair votes can zero its
     * unfiltered score).
     */
    profitPositives: Candidate[];
    /**
     * Causal (point-in-time) positives: assets whose score, counted only
     * from pairs whose pnl realized BEFORE this event is positive, is
     * strictly positive.
     */
    profitNowPositives: Candidate[];
    /** Causal confidence-weighted PROFIT_NOW positives. */
    profitNowConfidencePositives: Candidate[];
    topRaw: number;      // assetIndex
    topMean: number;     // assetIndex
    /** Unique raw maximum within the TOP_MEAN tied set, or -1 on a residual raw tie. */
    topMeanRawUnique: number;
    /** TOP_MEAN tied set used as the exact research control pool. */
    topMeanRawUniquePool: Candidate[];
    /** Profit-gated picks, or -1 when the profit-gated pool has < 2 members. */
    topRawProfit: number;  // assetIndex
    topMeanProfit: number; // assetIndex
    /** Causal profit picks, or -1 when the causal pool has < 2 members. */
    topRawProfitNow: number;  // assetIndex
    topMeanProfitNow: number; // assetIndex
    /** Confidence-weighted causal pick, or -1 when its pool has < 2 members. */
    topRawProfitNowConf: number;  // assetIndex
    /** Z-surprise causal pick, or -1 when its pool has < 2 members. */
    topZ: number;  // assetIndex
    /** Max active-pair count across positive candidates at this event. */
    maxActivePairs: number;
    /** Per-selector tie counts at this event (Phase 3 MAX_ACTIVE). */
    ties: Record<SelectorName, number>;
}

/** Only five members per arm/event survive switch snapshot release. */
export interface RankingPick {
    assetIndex: number;
    key: number;
    secondary: number;
}
export interface RankingEvent {
    timeSec: number;
    arms: Record<ReplayArmField, { picks: RankingPick[]; reason?: import("./types").RankingSkipReason }>;
}

/** Minimal event input needed by the path-dependent asset-switch simulator. */
export interface AssetSwitchDecision {
    timeSec: number;
    picks: Readonly<Record<ReplayArmField, number | null>>;
}

/**
 * Events with a profit pool but fewer than 2 ordinary positives. Singleton
 * pools are retained only when cooldown is enabled, because they can still
 * select an asset and advance that arm's cooldown state.
 */
export interface ProfitOnlyEvent {
    timeSec: number;
    profitPositives: Candidate[];
    profitNowPositives: Candidate[];
    profitNowConfidencePositives: Candidate[];
}

/**
 * Inverted (negative-control) picks per gap-filtered view: the same pools
 * and >= 2 gates as the TOP_* arms, but the LOWEST rank value is selected.
 * BOT_MEAN_RAW_UNIQUE mirrors TOP_MEAN_RAW_UNIQUE on the bottom of the
 * ranking: bottom-mean tied set, then its unique raw MINIMUM (-1 on a
 * residual raw tie).
 */
export interface BotViewPicks {
    raw: number;
    mean: number;
    meanRawUnique: number;
    meanRawUniquePoolSize: number;
    rawProfitNow: number;
    meanProfitNow: number;
    z: number;
}

/** Compact cooldown-resolved selector pick. Candidate pools live on the event. */
export interface ReplayArmSelection {
    selectedAssetIndex: number;
    tiedCount: number;
    /** Mean-tied baseline size for unique-only arms; otherwise eligible pool size. */
    poolSize: number;
    /** Full pool size after cooldown, before unique-only refinement. */
    eligiblePoolSize: number;
    /** TOP/BOT_MEAN_RAW_UNIQUE uses the existing tied-mean control convention. */
    control: "leave_one_out" | "mean_tied_set";
}
export type ReplayArmSelectionMap = Partial<Record<ReplayArmField, ReplayArmSelection>>;

/** Cap-tilt coverage counters (docs/open-score-cap-tilt.md). */
export interface CapTiltCoverageCounters {
    long: number;
    known: number;
    weighted: number;
    unknown: number;
}
