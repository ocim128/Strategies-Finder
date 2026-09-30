/**
 * Public contracts for the OPEN_SCORE USD replay
 * (batch-open-score-usd-replay-engine.ts). Result/option/selector shapes,
 * Phase 0b archive row records, and the caller-owned cross-window target
 * cache. Type-only module: no runtime behavior, safe for every bundle.
 *
 * Internal stage records live in ./internal-types; stage implementations
 * import these contracts directly and never through the engine entry point.
 */
import type { OHLCVData } from "../../types/strategies";
import type { CandleGap } from "../../ibkr-data/candle-gap";
import type { ActiveCapTiltWeight, CapTiltWeight } from "../cap-tilt-contract";
import type { ReplayArmField } from "./arm-contract";

// ============================================================================
// Public types
// ============================================================================

export interface ReplayComparison {
    /** Eligible events that entered both arms. */
    events: number;
    /** Mean net USD return of the selected (top) asset. */
    topMean: number | null;
    /** Mean net USD return of this arm's comparison control. */
    randomMean: number | null;
    /**
     * Median of the per-event paired deltas (selected return minus the
     * leave-one-out pool mean). Robust to fat-tailed single events, so one
     * outlier mover cannot flip a window; `ciLower`/`ciUpper` bracket THIS
     * statistic, and `topMean - randomMean` (the mean delta) is intentionally
     * a different number.
     */
    delta: number | null;
    /** Median net USD return of the selected asset. */
    topMedian: number | null;
    /** Chronological block means of the per-event delta. */
    blockMeans: number[];
    /** Deterministic block-bootstrap 95% CI for the delta. */
    ciLower: number | null;
    ciUpper: number | null;
    /** Count of blocks whose mean delta is positive. */
    positiveBlocks: number;
    totalBlocks: number;
}

/**
 * Equal-notional event-basket P&L summary.
 *
 * `totalReturn` is the sum of per-event net returns with one unit of notional
 * per event. It is intentionally not an account return: events may overlap
 * and the series is not compounded.
 */
export interface SelectorPnlSummary {
    trades: number;
    totalReturn: number | null;
    sharpe: number | null;
    winRate: number | null;
    maxDrawdown: number | null;
}

export interface TopMeanPortfolioOpportunity {
    asset: string;
    decisionTime: number;
    entryTime: number;
    exitTime: number;
    netReturn: number;
    tied: boolean;
}

/**
 * Fixed-$1,000 TOP_MEAN portfolio simulation.
 *
 * Drawdown is calculated from realized P&L at exit timestamps. `peakCapital`
 * is the maximum concurrent accepted positions multiplied by `notionalPerTrade`;
 * no arbitrary starting bankroll or global position cap is assumed.
 */
export interface TopMeanPortfolioSummary {
    notionalPerTrade: number;
    eligibleSignals: number;
    trades: number;
    skippedTies: number;
    skippedActiveAsset: number;
    netPnl: number | null;
    averagePnl: number | null;
    winRate: number | null;
    maxRealizedDrawdown: number | null;
    peakConcurrentPositions: number;
    peakCapital: number;
    returnOnPeakCapital: number | null;
}

export interface DegreeSummary {
    min: number;
    median: number;
    max: number;
    /** Share of selected events attributable to the single most-covered asset. */
    topAssetShare: number | null;
}

export interface AssetSelectionSummary {
    asset: string;
    events: number;
    share: number;
    topMean: number | null;
    randomMean: number | null;
    delta: number | null;
}

export interface SelectorAgreement {
    events: number;
    sameSelection: number;
    rate: number | null;
}

export type OpenScoreUsdLatestSelectorName =
    | "TOP_RAW"
    | "TOP_MEAN"
    | "TOP_MEAN_RAW_UNIQUE"
    | "TOP_RAW_PROFIT_NOW"
    | "TOP_MEAN_PROFIT_NOW"
    | "TOP_RAW_PROFIT_NOW_CONF"
    | "TOP_Z"
    | "BOT_RAW"
    | "BOT_MEAN"
    | "BOT_MEAN_RAW_UNIQUE"
    | "BOT_RAW_PROFIT_NOW"
    | "BOT_MEAN_PROFIT_NOW"
    | "BOT_Z";

export interface OpenScoreUsdLatestSelectionCandidate {
    asset: string;
    score: number;
    mean: number;
    activePairs: number;
}

export interface OpenScoreUsdLatestSelection {
    selector: OpenScoreUsdLatestSelectorName;
    direction: "long" | "short" | "none";
    /** Null when the selector is tied or has fewer than two eligible assets. */
    asset: string | null;
    /** Every asset tied at the selector boundary; empty for a unique pick. */
    tiedAssets: string[];
    score: number | null;
    mean: number | null;
    activePairs: number | null;
    eligibleCandidates: number;
    reason: "selected" | "tied" | "insufficient_candidates";
    /**
     * The arm's top candidates at this event, in the arm's own ranking order
     * (max 3). Optional: absent in results produced before this field existed
     * (old persisted payloads and archives).
     */
    topCandidates?: OpenScoreUsdLatestSelectionCandidate[];
}

export interface OpenScoreUsdLatestSelections {
    /** Latest replay decision event represented by these selectors. */
    decisionTime: number;
    selections: OpenScoreUsdLatestSelection[];
}

export type OpenScoreUsdEventDetailSelector =
    | "TOP_RAW"
    | "TOP_MEAN"
    | "TOP_MEAN_RAW_UNIQUE"
    | "TOP_RAW_PROFIT"
    | "TOP_MEAN_PROFIT"
    | "TOP_RAW_PROFIT_NOW"
    | "TOP_MEAN_PROFIT_NOW"
    | "TOP_RAW_PROFIT_NOW_CONF"
    | "TOP_Z"
    | "TOP_RAW_PROFIT_W_RAT"
    | "TOP_MEAN_PROFIT_W_RAT"
    | "TOP_RAW_PROFIT_W_LIN"
    | "TOP_MEAN_PROFIT_W_LIN"
    | "TOP_RAW_PROFIT_W_TAN"
    | "TOP_MEAN_PROFIT_W_TAN"
    | "TOP_RAW_PROFIT_W_LOG"
    | "TOP_MEAN_PROFIT_W_LOG"
    | "BOT_RAW"
    | "BOT_MEAN"
    | "BOT_MEAN_RAW_UNIQUE"
    | "BOT_RAW_PROFIT_NOW"
    | "BOT_MEAN_PROFIT_NOW"
    | "BOT_Z";

export interface OpenScoreUsdEventDetail {
    decisionTime: number;
    entryTime: number;
    exitTime: number;
    horizonBars: number;
    selector: OpenScoreUsdEventDetailSelector;
    direction: "long" | "short";
    asset: string;
    selectedReturn: number;
    controlReturn: number;
    delta: number;
    eligibleCandidates: number;
}

/**
 * Scalar arm selections whose requested horizon is not complete yet. Emitted
 * for EVERY asset-picking arm (not just TOP_MEAN). `unrealizedReturn` is the
 * selected asset's mark-to-market net return at its target dataset end (same
 * slippage/commission model as a completed row); null when either price is
 * unusable. Control/Delta have no realized comparison and are intentionally
 * absent.
 */
export interface OpenScoreUsdOngoingEventDetail {
    decisionTime: number;
    entryTime: number | null;
    horizonBars: number;
    selector: OpenScoreUsdEventDetailSelector;
    direction: "long";
    asset: string;
    eligibleCandidates: number;
    unrealizedReturn?: number | null;
}

export type CandidateOutcomeStatus =
    | "ok"
    | "missing_target"
    | "missing_entry"
    | "data_gap"
    | "right_censored"
    | "invalid_price";

export interface PoolSnapshotRecord {
    eventId: string;
    decisionTimeSec: number;
    interval: string;
    poolVersion: string | null;
    asset: string;
    inPool: boolean;
    activePairCount: number;
    signedVotes: number;
    score: number | null;
    longEligible: boolean;
    shortEligible: boolean;
    ema200Above: boolean;
    breadth: number | null;
    regime: "bullish" | "bearish" | "unavailable";
}

export interface CandidateOutcomeRecord {
    eventId: string;
    decisionTimeSec: number;
    horizonBars: number;
    direction: "long" | "short";
    asset: string;
    inPool: boolean;
    eligible: boolean;
    return: number | null;
    entryTimeSec: number | null;
    exitTimeSec: number | null;
    status: CandidateOutcomeStatus;
}

export interface OpenScoreUsdReplayResult {
    /** New results always include this discriminator; absent means legacy horizon data. */
    mode?: ReplayMode;
    pairs: number;
    assets: number;
    complete: boolean;
    omittedPairs: number;
    omittedAssets: number;
    totalEvents: number;
    /** Decision events with at least two positive candidates before outcome availability. */
    candidateEvents: number;
    eligibleEvents: number;
    horizons: Array<{
        bars: number;
        topRaw: ReplayComparison;
        /** Highest rawScore / activePairCount (mean signed vote). */
        topMean: ReplayComparison;
        /**
         * TOP_MEAN_RAW_UNIQUE: form the TOP_MEAN tied set, then select its
         * unique raw-score maximum. Residual raw ties are skipped. The control
         * is the mean return of that TOP_MEAN tied set, including the selected
         * asset, matching the frozen walk-forward research contract.
         */
        topMeanRawUnique: ReplayComparison;
        /** Per-asset breakdown for TOP_MEAN_RAW_UNIQUE. */
        topMeanRawUniqueByAsset: AssetSelectionSummary[];
        /** TOP_MEAN_RAW_UNIQUE after removing its dominant asset. */
        topMeanRawUniqueExDominant: ReplayComparison;
        /** Asset excluded from TOP_MEAN_RAW_UNIQUE_EX_*. */
        topMeanRawUniqueDominantAsset: string | null;
        /**
         * Profit-gated TOP_RAW: identical raw-score ranking, but only pairs whose
         * pair backtest netProfit was strictly positive contribute votes.
         * Research-only look-ahead filter (a pair's full-window P&L is not
         * known at decision time). Fires on every event with >= 2 profit-gated
         * positives, including profit-only events with < 2 ordinary positives.
         */
        topRawProfit: ReplayComparison;
        /** Per-asset breakdown for the profit-gated TOP_RAW selector. */
        topRawProfitByAsset: AssetSelectionSummary[];
        /** Profit-gated TOP_RAW after removing its most-frequently-selected asset. */
        topRawProfitExDominant: ReplayComparison;
        /** Asset excluded from {@link topRawProfitExDominant}. */
        topRawProfitDominantAsset: string | null;
        /** Profit-gated TOP_MEAN: filtered raw score / open profitable-pair count. */
        topMeanProfit: ReplayComparison;
        /** Per-asset breakdown for the profit-gated TOP_MEAN selector. */
        topMeanProfitByAsset: AssetSelectionSummary[];
        /** Profit-gated TOP_MEAN after removing its most-frequently-selected asset. */
        topMeanProfitExDominant: ReplayComparison;
        /** Asset excluded from {@link topMeanProfitExDominant}. */
        topMeanProfitDominantAsset: string | null;
        /**
         * Causal variant of {@link topRawProfit}: the pnl filter is evaluated
         * point-in-time — a pair votes at an event only when its pnl realized
         * at or before that event is strictly positive. No look-ahead: live-
         * selectable in principle (given per-pair realized pnl tracking).
         */
        topRawProfitNow: ReplayComparison;
        /** Per-asset breakdown for the causal TOP_RAW selector. */
        topRawProfitNowByAsset: AssetSelectionSummary[];
        /** Causal TOP_RAW after removing its most-frequently-selected asset. */
        topRawProfitNowExDominant: ReplayComparison;
        /** Asset excluded from {@link topRawProfitNowExDominant}. */
        topRawProfitNowDominantAsset: string | null;
        /** Causal variant of {@link topMeanProfit}. */
        topMeanProfitNow: ReplayComparison;
        /** Per-asset breakdown for the causal TOP_MEAN selector. */
        topMeanProfitNowByAsset: AssetSelectionSummary[];
        /** Causal TOP_MEAN after removing its most-frequently-selected asset. */
        topMeanProfitNowExDominant: ReplayComparison;
        /** Asset excluded from {@link topMeanProfitNowExDominant}. */
        topMeanProfitNowDominantAsset: string | null;
        /**
         * Causal confidence-weighted variant of TOP_RAW_PROFIT_NOW. Each
         * pair's qualifying vote is weighted by the amount and consistency of
         * its realized P&L, with one-trade shrinkage. Weight is stamped at
         * pair-entry time and carried unchanged until that position exits.
         */
        topRawProfitNowConf: ReplayComparison;
        /** Per-asset breakdown for the causal confidence-weighted arm. */
        topRawProfitNowConfByAsset: AssetSelectionSummary[];
        /** Confidence-weighted arm after removing its dominant asset. */
        topRawProfitNowConfExDominant: ReplayComparison;
        /** Asset excluded from the confidence-weighted arm exclusion. */
        topRawProfitNowConfDominantAsset: string | null;
        /**
         * TOP_Z: the causal PROFIT_NOW pool ranked by each asset's
         * standardized score SURPRISE — (score − mean of the asset's own
         * profit-now scores at prior decision events) / max(std, 1), strictly
         * past (Welford, updated after each event). New information source:
         * how unusual this crowd is FOR THIS ASSET, not the absolute count.
         */
        topZ: ReplayComparison;
        /** Per-asset breakdown for the z-surprise arm. */
        topZByAsset: AssetSelectionSummary[];
        /** Z-surprise arm after removing its dominant asset. */
        topZExDominant: ReplayComparison;
        /** Asset excluded from the z-surprise arm exclusion. */
        topZDominantAsset: string | null;
        /** TOP_RAW after events selecting its most-frequent asset are removed. */
        topRawExDominant: ReplayComparison;
        dominantAsset: string | null;
        topRawByAsset: AssetSelectionSummary[];
        /**
         * TOP_MEAN after events selecting its most-frequent asset are removed.
         * Mirrors {@link topRawExDominant} for the coverage-adjusted arm: drops
         * events where TOP_MEAN picked its most-frequent asset; the remaining
         * events form the comparison.
         */
        topMeanExDominant: ReplayComparison;
        /**
         * Most-frequently-selected TOP_MEAN asset (ties by FNV-1a digest). The
         * asset excluded from {@link topMeanExDominant}.
         */
        topMeanDominantAsset: string | null;
        /** Per-asset breakdown for the TOP_MEAN selector. */
        topMeanByAsset: AssetSelectionSummary[];
        /**
         * TOP_MEAN after events selecting its single highest-TOTAL-CONTRIBUTION
         * asset are removed. "Total contribution" = Σ per-event delta for that
         * asset across the horizon (events × mean delta). Complements
         * {@link topMeanExDominant} (most frequent): a low-frequency / high-
         * per-pick asset (e.g. SNDK in the 2020-01 sample) is invisible to the
         * dominant exclusion but can be the largest single driver of the edge.
         */
        topMeanExTopContrib: ReplayComparison;
        /**
         * Highest-total-contribution TOP_MEAN asset (Σ per-event delta; ties by
         * asset name for deterministic aggregate-level ordering). The asset
         * excluded from {@link topMeanExTopContrib}.
         */
        topMeanTopContribAsset: string | null;
        /** P&L summaries for the overlapping and portfolio TOP_MEAN experiments. */
        pnl: {
            topMean: SelectorPnlSummary;
            random: SelectorPnlSummary;
            /** Fixed-$1,000 TOP_MEAN trades, skipping ties and same-asset overlap. */
            topMeanPortfolio: TopMeanPortfolioSummary;
        };
        /**
         * Inverted (negative-control) arms: the same pool, eligibility gate,
         * and FNV tie-break as their TOP_* twin, but the LOWEST rank value is
         * selected instead of the highest (still long vs USD, still leave-one-
         * out pool control). If a BOT_* arm matches its twin's edge, the edge
         * comes from positive-pool membership, not from the ranking.
         */
        botRaw: ReplayComparison;
        /** Per-asset breakdown for the inverted TOP_RAW arm. */
        botRawByAsset: AssetSelectionSummary[];
        /** Inverted TOP_RAW after removing its most-frequently-selected asset. */
        botRawExDominant: ReplayComparison;
        /** Asset excluded from {@link botRawExDominant}. */
        botRawDominantAsset: string | null;
        /** Inverted TOP_MEAN: lowest mean signed vote in the positive pool. */
        botMean: ReplayComparison;
        /** Per-asset breakdown for the inverted TOP_MEAN arm. */
        botMeanByAsset: AssetSelectionSummary[];
        /** Inverted TOP_MEAN after removing its most-frequently-selected asset. */
        botMeanExDominant: ReplayComparison;
        /** Asset excluded from {@link botMeanExDominant}. */
        botMeanDominantAsset: string | null;
        /**
         * BOT_MEAN_RAW_UNIQUE: form the BOTTOM_MEAN tied set, then select its
         * unique raw-score minimum. Residual raw ties are skipped. The control
         * is the mean return of that bottom-mean tied set, including the
         * selected asset.
         */
        botMeanRawUnique: ReplayComparison;
        /** Per-asset breakdown for the inverted TOP_MEAN_RAW_UNIQUE arm. */
        botMeanRawUniqueByAsset: AssetSelectionSummary[];
        /** BOT_MEAN_RAW_UNIQUE after removing its dominant asset. */
        botMeanRawUniqueExDominant: ReplayComparison;
        /** Asset excluded from {@link botMeanRawUniqueExDominant}. */
        botMeanRawUniqueDominantAsset: string | null;
        /** Inverted causal TOP_RAW: lowest raw score in the PROFIT_NOW pool. */
        botRawProfitNow: ReplayComparison;
        /** Per-asset breakdown for the inverted causal TOP_RAW arm. */
        botRawProfitNowByAsset: AssetSelectionSummary[];
        /** Inverted causal TOP_RAW after removing its dominant asset. */
        botRawProfitNowExDominant: ReplayComparison;
        /** Asset excluded from {@link botRawProfitNowExDominant}. */
        botRawProfitNowDominantAsset: string | null;
        /** Inverted causal TOP_MEAN: lowest mean in the PROFIT_NOW pool. */
        botMeanProfitNow: ReplayComparison;
        /** Per-asset breakdown for the inverted causal TOP_MEAN arm. */
        botMeanProfitNowByAsset: AssetSelectionSummary[];
        /** Inverted causal TOP_MEAN after removing its dominant asset. */
        botMeanProfitNowExDominant: ReplayComparison;
        /** Asset excluded from {@link botMeanProfitNowExDominant}. */
        botMeanProfitNowDominantAsset: string | null;
        /** Inverted TOP_Z: lowest per-asset z-surprise in the PROFIT_NOW pool. */
        botZ: ReplayComparison;
        /** Per-asset breakdown for the inverted z-surprise arm. */
        botZByAsset: AssetSelectionSummary[];
        /** Inverted z-surprise arm after removing its dominant asset. */
        botZExDominant: ReplayComparison;
        /** Asset excluded from {@link botZExDominant}. */
        botZDominantAsset: string | null;
        /** Active pair count at decision events (coverage at the event). */
        candidateDegree: DegreeSummary;
        /** Static pair degree of the selected TOP_RAW asset across events. */
        selectedDegree: DegreeSummary;
        /**
         * Phase 3 MAX_ACTIVE: tie count + rate for each selector (ties broken
         * by the shared FNV-1a 64 rule). Surfaces how often the deterministic
         * tie-break decided the selection — material for research transparency.
         */
        tieRates: Record<SelectorName, SelectorAgreement>;
        /** Per-arm contributor-excluded summaries, rebuilt from paired event deltas. */
        armExTopContributorComparisons?: Partial<Record<ReplayArmField, ReplayComparison>>;
        /** Largest total paired excess-return contributor and its excluded event count. */
        armTopContributorAssets?: Partial<Record<ReplayArmField, string | null>>;
        armTopContributorEvents?: Partial<Record<ReplayArmField, number>>;
    }>;
    /** Required for `mode: asset_switch`; horizon arrays remain semantically unchanged. */
    assetSwitch?: AssetSwitchReplaySummary;
    /** Latest-event selector picks used by the completed Batch result UI. */
    latestSelections: OpenScoreUsdLatestSelections | null;
    /**
     * Optional scalar rows for the coordinator's on-demand research table.
     * Never included in reportLines or either OPEN_SCORE copy path.
     */
    eventDetails?: OpenScoreUsdEventDetail[];
    /** Scalar TOP_MEAN selections omitted from completed research by censoring. */
    ongoingEventDetails?: OpenScoreUsdOngoingEventDetail[];
    /** Full-window Phase 0b diagnostics; only populated by the coordinator. */
    poolSnapshots?: PoolSnapshotRecord[];
    /** Full-window Phase 0b diagnostics; only populated by the coordinator. */
    candidateOutcomes?: CandidateOutcomeRecord[];
    degree: DegreeSummary;
    warnings: string[];
    reportLines: string[];
}

/** Phase 3 MAX_ACTIVE selector labels for tie/agreement diagnostics. */
export type SelectorName = "RAW" | "MEAN";

export interface OpenScoreUsdTarget {
    asset: string;
    symbol: string;
    data: OHLCVData[];
}

/**
 * One (decision time, target) outcome shared across replay windows
 * (annual-reload finding): outcome values are pure functions of the target
 * dataset and the decision timestamp — censoring is dataset-end based and
 * entry resolution is dataset-only — so the full-window pass can populate
 * this cache once and every annual pass is served from it without loading
 * target datasets again. Records are never mutated after caching.
 */
export interface OpenScoreUsdSharedOutcomeRecord {
    long: number[];
    mtmLong: (number | null)[];
    entryTime: number;
    exitTimes: number[];
    statuses: CandidateOutcomeStatus[];
}

export interface OpenScoreUsdSharedTargetCacheEntry {
    /** Chronological candle-gap intervals of the target dataset. */
    gapIntervals: CandleGap[];
    /**
     * Outcome per decision timestamp. `null` marks "no entry bar strictly
     * after the decision timestamp" so later passes never reload the dataset
     * to re-discover the same noData event.
     */
    outcomesByEventTimeSec: Map<number, OpenScoreUsdSharedOutcomeRecord | null>;
    /** Last target candle at or before each decision time, including right-edge events with no future entry bar. */
    boundaryIndexByEventTimeSec?: Map<number, number>;
}

/** Replay result fields represented as Finder's 15 Arm Performance selectors. */
export type { ReplayArmField } from "./arm-contract";

/** Replay contract. Omitted values at legacy read boundaries mean `horizon`. */
export type ReplayMode = "horizon" | "asset_switch";

export type AssetSwitchArmStatus = "complete" | "no_entry" | "incomplete";

export interface AssetSwitchPendingOrder {
    side: "buy" | "sell";
    destinationAsset: string | null;
    decisionTimeSec: number;
    scheduledTimeSec: number | null;
}

export interface AssetSwitchOpenPosition {
    asset: string;
    entryDecisionTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    markTimeSec: number | null;
    markPrice: number | null;
    markAgeSec: number | null;
    openNetPnl: number | null;
    entryCost: number;
    holdingDurationSec: number | null;
}

export interface AssetSwitchTradeRecord {
    arm: ReplayArmField;
    asset: string;
    decisionTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    exitTimeSec: number | null;
    exitPrice: number | null;
    holdingDurationSec: number | null;
    netPnl: number | null;
    entryCost: number;
    exitCost: number;
    status: "closed" | "open";
}

export interface AssetSwitchArmSummary {
    status: AssetSwitchArmStatus;
    /** Filled $1,000 entries; a final open position counts as entered. */
    enteredCount: number;
    completedTrades: number;
    /** Null when never entered or when data quality makes the arm unrankable. */
    realizedNetPnl: number | null;
    openPositionNetPnl: number | null;
    totalNetPnl: number | null;
    partialRealizedNetPnl: number;
    completedHoldingDurationSec: number;
    averageCompletedHoldingDurationSec: number | null;
    totalCosts: number;
    openPosition: AssetSwitchOpenPosition | null;
    pendingOrder: AssetSwitchPendingOrder | null;
    diagnosticCounts: {
        missingTarget: number;
        invalidTimestamp: number;
        invalidPrice: number;
        dataGap: number;
        staleMark: number;
        unvaluedPosition: number;
    };
}

/** Separate, path-dependent result; never represented as ReplayComparison. */
export interface AssetSwitchReplaySummary {
    semanticsVersion: "asset_switch.v1";
    decisionCount: number;
    windowStartSec: number | null;
    windowEndSec: number;
    independentWindow: boolean;
    sizing: "fixed_entry_notional_non_compounding";
    notionalPerEntry: number;
    slippageRate: number;
    commissionRate: number;
    valuation: "last_closed_candle_close_at_or_before_window_end";
    coverage: {
        requestedAssets: number;
        loadedAssets: number;
        missingAssets: number;
        invalidSeries: number;
    };
    arms: Record<ReplayArmField, AssetSwitchArmSummary>;
    /** Optional, potentially large closed/open trade rows. */
    trades?: AssetSwitchTradeRecord[];
    tradeCount?: number;
}

/** Cap-tilt weighting for OPEN_SCORE USD (docs/open-score-cap-tilt.md). */
export type OpenScoreUsdCapTiltWeight = CapTiltWeight;

export interface RunOpenScoreUsdReplayOptions {
    /** Required only for horizon mode. Omitted mode defaults to `horizon`. */
    mode?: ReplayMode;
    /** Required in horizon mode: positive bar horizons. */
    horizons?: number[];
    /** Bar interval the artifacts were produced on (echoed in the report). */
    interval?: string;
    /** Optional decision-timestamp window (unix seconds, inclusive). */
    sampleFromSec?: number;
    sampleToSec?: number;
    /** Frozen coordinator run cutoff; bounds switch fills and terminal marks. */
    evaluationCutoffSec?: number;
    /** Annual coordinator passes start flat and are explicitly independent experiments. */
    independentWindow?: boolean;
    /** Batch slippage/commission conventions applied to both arms identically. */
    slippageRate?: number;
    commissionRate?: number;
    /** Chronological blocks for block means / bootstrap. Default 10. */
    blockCount?: number;
    /** Deterministic bootstrap resamples. Default 2000. */
    bootstrapSamples?: number;
    /** Exclude the last selected candle and the next N candles for each selector arm; zero preserves legacy behavior. */
    selectionCooldownBars?: number;
    /** Include scalar per-event selector rows for the coordinator details UI. */
    includeEventDetails?: boolean;
    /** Phase 0b: emit one pool snapshot per decision event and catalog asset. */
    includePoolSnapshots?: boolean;
    /** Phase 0b: emit one directional outcome per event/horizon/catalog asset. */
    includeCandidateOutcomes?: boolean;
    /** Frozen catalog used by the Phase 0b full-catalog diagnostics. */
    catalogAssets?: readonly string[];
    /** Static registry pool provenance carried into Phase 0b rows. */
    poolVersion?: string | null;
    /** Coordinator-only sink used to keep full-scale archive rows off the heap. */
    onPoolSnapshot?: (row: PoolSnapshotRecord) => void | Promise<void>;
    /** Coordinator-only sink used to keep full-scale archive rows off the heap. */
    onCandidateOutcome?: (row: CandidateOutcomeRecord) => void | Promise<void>;
    /** Stream each finalized switch trade to an archive sink without retaining full history. */
    onAssetSwitchTrade?: (row: AssetSwitchTradeRecord) => void | Promise<void>;
    /** Phase transition + bounded-chunk progress. */
    onPhase?: (phase: "scan" | "events" | "targets" | "outcomes" | "aggregate" | "switch", detail: string, completed: number, total: number) => void;
    /** Polled between bounded chunks; return true to stop early (cancellation). */
    shouldStop?: () => boolean;
    /**
     * Cap-tilt weighting (docs/open-score-cap-tilt.md): the base leg of LONG
     * trades gets entry delta +2 (instead of +1) when the entry-time market
     * cap matches the tilt condition. similarCap2x also doubles the quote's
     * negative delta when larger/smaller cap <= 3. Absent = off. Set WITHOUT
     * `lookupMarketCap` is defensively treated as off (the route always
     * passes both or neither).
     */
    capTiltWeight?: ActiveCapTiltWeight;
    /**
     * Injected market-cap lookup (USD, as-of unix seconds). `null` result =
     * unknown cap for that symbol/date -> tilt weight falls back to 1.
     */
    lookupMarketCap?: (symbol: string, timeSec: number) => number | null;
    /**
     * Streaming target source. Optional when `loadTargetDataset` is provided;
     * exactly one of the two must be available or the outcomes phase throws.
     * When `loadTargetDataset` is set, this iterable is never consumed.
     */
    targetLoader?: () => AsyncIterable<OpenScoreUsdTarget>;
    /**
     * Lazy per-target dataset source (annual-reload finding): the outcomes
     * phase loads only the assets it actually needs — assets fully served by
     * `sharedTargetCache` are never loaded at all, so annual passes typically
     * load zero datasets. Resolve `null` = no such target (absent from the
     * replay universe, diagnostic backfill applies); resolve `[]` = load
     * failed (the caller owns failure accounting).
     */
    loadTargetDataset?: (asset: string) => Promise<OHLCVData[] | null>;
    /**
     * Optional prefetch hint with the assets the outcomes phase will need to
     * LOAD (work list minus shared-cache hits), in consumption order, so the
     * caller can overlap I/O the way a streaming loader would.
     */
    prefetchTargetDatasets?: (assets: readonly string[]) => void;
    /**
     * Cross-window shared target cache keyed by upper-cased asset name.
     * Owned by the caller for the whole replay phase: the first pass
     * populates it, later passes (whose request sets are strict subsets —
     * annual windows are time slices of the first pass's window) are served
     * from it. Entries are never mutated after insertion.
     */
    sharedTargetCache?: Map<string, OpenScoreUsdSharedTargetCacheEntry>;
}
