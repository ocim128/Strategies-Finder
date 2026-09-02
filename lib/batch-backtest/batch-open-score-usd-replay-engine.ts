/**
 * OPEN_SCORE USD Replay — event-level selector study.
 *
 * Research question (v1, event-level only): at historical synthetic-pair
 * decision events, did selecting the asset with the highest positive
 * OPEN_SCORE and trading that asset vs USD beat selecting another
 * positive-score asset at random (same decision event)?
 *
 * Scope boundary: this is an equal-notional, fixed-horizon USD trade study.
 * It answers whether the top-score choice has better conditional forward
 * return than another positive candidate at the same event. Its P&L section
 * additionally shows an explicitly non-compounding overlapping event basket
 * and a same-event long-top/short-rank-2 hedge. It does not reproduce a live
 * portfolio's capital allocation, adaptive exits, or execution queue.
 *
 * Score semantics (must match computeOpenTradeAssetScores in batch-row-scalars):
 *   long pair  -> base +1, quote -1 at entry; inverse deltas at exit
 *   short pair -> base -1, quote +1 at entry; inverse deltas at exit
 * rawScore[a]        = signed active-pair vote total
 * activePairCount[a] = active positive + active negative votes
 * adjustedScore[a]   = rawScore / sqrt(activePairCount)  (coverage-adjusted,
 *                      NOT a statistically calibrated z-score)
 *
 * Timing (conservative causal rule): the score is updated with ALL entries and
 * exits at a timestamp before candidates are formed (a fixture proves a
 * same-timestamp exit/entry cannot leak a later target bar's price). The USD
 * entry is the first target-asset bar strictly AFTER the decision timestamp,
 * filled at that bar's open. Exit-only score changes do NOT create an event.
 *
 * Eligibility: an event is eligible only when it has >= 2 positive candidates
 * and every candidate has valid target data for the horizon. If a winner has
 * missing data, the event is omitted from BOTH arms — never substitute a
 * different winner after seeing data availability. Right-censored events near
 * the target end are excluded; a missing target is counted, never zero-filled.
 *
 * Pure leaf: imports ../types/strategies (type-only Time is erased),
 * ../strategies/backtest/backtest-utils (timeKey/timeToNumber/applySlippage),
 * and ./batch-synthetic-state-miner (artifact types) only. No DOM, no runtime
 * lightweight-charts — safe for the vite cjs config bundle.
 */
import type { OHLCVData } from "../types/strategies";
import { applySlippage, timeToNumber } from "../strategies/backtest/backtest-utils";
import { parseIntervalSeconds } from "../interval-utils";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import {
    tieBreakDigest,
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
} from "./max-active-research-contract";

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
    /** topMean - randomMean. */
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

export interface SelectorAgreement {
    events: number;
    sameSelection: number;
    rate: number | null;
}

export interface AssetSelectionSummary {
    asset: string;
    events: number;
    share: number;
    topMean: number | null;
    randomMean: number | null;
    delta: number | null;
}

export type OpenScoreUsdLatestSelectorName =
    | "TOP_RAW"
    | "TOP_MEAN"
    | "TOP_MEAN_RAW_UNIQUE_V1"
    | "TOP_MEAN_TREND"
    | "REGIME_MEAN"
    | "MAX_ACTIVE"
    | "MAX_SUBMITTED";

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
}

export interface OpenScoreUsdLatestSelections {
    /** Latest replay decision event represented by these selectors. */
    decisionTime: number;
    ema200ObservedAssets: number;
    ema200AssetsAbove: number;
    ema200Breadth: number | null;
    regime: "bullish" | "bearish" | "unavailable";
    selections: OpenScoreUsdLatestSelection[];
}

export type OpenScoreUsdEventDetailSelector =
    | "TOP_RAW"
    | "TOP_ADJUSTED"
    | "TOP_MEAN"
    | "TOP_MEAN_RAW_UNIQUE_V1"
    | "TOP_MEAN_TREND"
    | "REGIME_MEAN"
    | "ACCELERATING"
    | "MAX_ACTIVE"
    | "MAX_SUBMITTED"
    | "MAX_RETAINED"
    | "MAX_ACTIVE_REVERSION"
    | "BOTTOM_MEAN";

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

/** Scalar TOP_MEAN selections whose requested horizon is not complete yet. */
export interface OpenScoreUsdOngoingEventDetail {
    decisionTime: number;
    entryTime: number | null;
    horizonBars: number;
    selector: "TOP_MEAN";
    direction: "long";
    asset: string;
    eligibleCandidates: number;
}

export type CandidateOutcomeStatus =
    | "ok"
    | "missing_target"
    | "missing_entry"
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
        topAdjusted: ReplayComparison;
        /** Highest rawScore / activePairCount (mean signed vote). */
        topMean: ReplayComparison;
        /**
         * TOP_MEAN_RAW_UNIQUE_V1: form the TOP_MEAN tied set, then select its
         * unique raw-score maximum. Residual raw ties are skipped. The control
         * is the mean return of that TOP_MEAN tied set, including the selected
         * asset, matching the frozen walk-forward research contract.
         */
        topMeanRawUniqueV1: ReplayComparison;
        /** Per-asset breakdown for TOP_MEAN_RAW_UNIQUE_V1. */
        topMeanRawUniqueV1ByAsset: AssetSelectionSummary[];
        /** TOP_MEAN_RAW_UNIQUE_V1 after removing its dominant asset. */
        topMeanRawUniqueV1ExDominant: ReplayComparison;
        /** Asset excluded from TOP_MEAN_RAW_UNIQUE_V1_EX_*. */
        topMeanRawUniqueV1DominantAsset: string | null;
        /** TOP_RAW using only score deltas from the current and prior five bars. */
        topRaw6Bar: ReplayComparison;
        /** TOP_MEAN using only score deltas from the current and prior five bars. */
        topMean6Bar: ReplayComparison;
        /**
         * Long-side trend filter: require target-universe EMA200 breadth above
         * 50%, keep positive-score assets above their own target EMA200, then
         * maximize TOP_MEAN and use active-pair count as the first tie-break.
         */
        topMeanTrend: ReplayComparison;
        /** Per-asset breakdown for TOP_MEAN_TREND. */
        topMeanTrendByAsset: AssetSelectionSummary[];
        /** TOP_MEAN_TREND after removing its most-frequently-selected asset. */
        topMeanTrendExDominant: ReplayComparison;
        /** Asset excluded from {@link topMeanTrendExDominant}. */
        topMeanTrendDominantAsset: string | null;
        /**
         * Direction-switching selector: TOP_MEAN_TREND long when EMA200
         * breadth is above 50%; BOTTOM_MEAN short below that threshold.
         */
        regimeMean: ReplayComparison;
        /** Per-direction/asset breakdown for REGIME_MEAN. */
        regimeMeanByAsset: AssetSelectionSummary[];
        /** REGIME_MEAN after removing its dominant direction/asset selection. */
        regimeMeanExDominant: ReplayComparison;
        /** Direction/asset excluded from {@link regimeMeanExDominant}. */
        regimeMeanDominantAsset: string | null;
        /** Same-event return difference: TOP_MEAN versus TOP_RAW. */
        topMeanVsRaw: ReplayComparison;
        /** TOP_MEAN rank 1 versus rank 2 among positive candidates. */
        topMeanVsRank2: ReplayComparison;
        /** Reversion selector: most-open negative-score asset, shorted vs USD. */
        maxActiveReversion: ReplayComparison;
        /** Per-asset breakdown for the reversion selector. */
        maxActiveReversionByAsset: AssetSelectionSummary[];
        /**
         * Reversion selector after events selecting its most-frequent asset
         * are removed. Mirrors {@link maxActiveExDominant} for the short side:
         * drops events where MAX_ACTIVE_REVERSION picked its most-frequent
         * asset; the remaining events form the comparison.
         */
        maxActiveReversionExDominant: ReplayComparison;
        /**
         * Most-frequently-selected MAX_ACTIVE_REVERSION asset (ties by FNV-1a
         * digest). The asset excluded from {@link maxActiveReversionExDominant}.
         */
        maxActiveReversionDominantAsset: string | null;
        /** Control: positive candidate covered by the most currently-open pairs. */
        maxActive: ReplayComparison;
        /** Control: positive candidate with the highest submitted pair-list degree. */
        maxStatic: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: positive candidate with the highest SUBMITTED
         * pair-list degree (the canonical Batch request). Same selector as
         * {@link maxStatic} (renamed per the plan); kept alongside for
         * backward compat with existing tests.
         */
        maxSubmitted: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: positive candidate with the highest RETAINED
         * artifact degree (computed from successfully loaded artifacts,
         * counting both legs of every canonical artifact regardless of trades).
         */
        maxRetained: ReplayComparison;
        /** TOP_RAW after events selecting its most-frequent asset are removed. */
        topRawExDominant: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: dominant-asset exclusion for MAX_ACTIVE (the
         * research hypothesis). Drops events where MAX_ACTIVE picked its
         * most-frequent asset; the remaining events form the comparison.
         */
        maxActiveExDominant: ReplayComparison;
        /**
         * Phase 3 MAX_ACTIVE: most-frequently-selected MAX_ACTIVE asset
         * (ties by FNV-1a digest). The asset excluded from `maxActiveExDominant`.
         */
        maxActiveDominantAsset: string | null;
        /** Phase 3 MAX_ACTIVE: per-asset MAX_ACTIVE selection breakdown. */
        maxActiveByAsset: AssetSelectionSummary[];
        dominantAsset: string | null;
        rawAdjustedAgreement: SelectorAgreement;
        /**
         * Phase 3 MAX_ACTIVE: same-event return difference between MAX_ACTIVE
         * and MAX_SUBMITTED, only on events where the two selectors pick
         * different assets. `events === 0` means the selectors never disagreed
         * on this horizon.
         */
        activeVsSubmitted: ReplayComparison;
        /** Same-event return difference: MAX_ACTIVE vs MAX_RETAINED. */
        activeVsRetained: ReplayComparison;
        /** Same-event return difference: MAX_ACTIVE vs TOP_RAW. */
        activeVsRaw: ReplayComparison;
        /** Same-event return difference: MAX_ACTIVE vs TOP_MEAN. */
        activeVsMean: ReplayComparison;
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
        /**
         * Inverted TOP_MEAN: the negative-score candidate with the LOWEST mean
         * (most-negative rawScore/activePairs), evaluated as a short USD trade.
         * Mirrors {@link topMean} on the short side: where TOP_MEAN picks the
         * highest mean positive, BOTTOM_MEAN picks the lowest mean negative.
         * Eligibility mirrors MAX_ACTIVE_REVERSION (>= 2 negatives, every
         * negative short return finite).
         */
        bottomMean: ReplayComparison;
        /** Per-asset breakdown for the BOTTOM_MEAN selector (short side). */
        bottomMeanByAsset: AssetSelectionSummary[];
        /**
         * BOTTOM_MEAN after events selecting its most-frequent asset are
         * removed. Mirrors {@link maxActiveReversionExDominant} for the
         * lowest-mean selector.
         */
        bottomMeanExDominant: ReplayComparison;
        /**
         * Most-frequently-selected BOTTOM_MEAN asset (ties by FNV-1a digest).
         * The asset excluded from {@link bottomMeanExDominant}.
         */
        bottomMeanDominantAsset: string | null;
        /** P&L summaries for the overlapping and hedged TOP_MEAN experiments. */
        pnl: {
            topMean: SelectorPnlSummary;
            random: SelectorPnlSummary;
            topMeanHedge: SelectorPnlSummary;
            /** Fixed-$1,000 TOP_MEAN trades, skipping ties and same-asset overlap. */
            topMeanPortfolio: TopMeanPortfolioSummary;
            /** Overlapping event-basket P&L for TOP_MEAN_TREND. */
            topMeanTrend: SelectorPnlSummary;
            /** Fixed-$1,000 executable portfolio for TOP_MEAN_TREND. */
            topMeanTrendPortfolio: TopMeanPortfolioSummary;
            /** Overlapping event-basket P&L for REGIME_MEAN. */
            regimeMean: SelectorPnlSummary;
            /** Fixed-$1,000 executable portfolio for REGIME_MEAN. */
            regimeMeanPortfolio: TopMeanPortfolioSummary;
            /**
             * ACCELERATING overlapping-basket PNL: equal 1-unit notional on
             * every ACCELERATING-eligible event's selected asset. Non-compounding.
             */
            accelerating: SelectorPnlSummary;
            /** Matching basket over the ACCELERATING random control series. */
            acceleratingRandom: SelectorPnlSummary;
        };
        /**
         * ACCELERATING selector: highest fresh-entry-flow/activePairs candidate
         * vs the mean of the OTHER accelerating candidates at the same event.
         * Eligibility is independent of the shared positive-side gate. Events
         * with < 2 accelerating candidates contribute 0 events to this arm.
         */
        accelerating: ReplayComparison;
        /**
         * Conditional-split arms: TOP_RAW's pick routed into one of two
         * sub-series based on a per-event feature computed in Phase 3. Each
         * split uses the same selection and `randomMeanOf` baseline as TOP_RAW;
         * only the *accumulator* the selected return is appended to varies.
         * Comparison-only (no per-asset breakdown / EX_dominant) per the
         * ACCELERATING precedent — these are event filters, not asset pickers.
         */
        /**
         * Rank freshness split: TOP_RAW's pick is FRESH when it differs from
         * the previous view's TOP_RAW leader, STALE when it is the same.
         */
        topRawFresh: ReplayComparison;
        topRawStale: ReplayComparison;
        /**
         * Streak-length refinement of STALE. A view's streak is the count of
         * consecutive views (ending at this one) in which the same asset led
         * TOP_RAW; STALE events are streak ≥ 2. STALE_SHORT and STALE_LONG
         * partition STALE events at the median streak length across all STALE
         * views — SHORT = `[2, median]`, LONG = `> median`. Tests whether the
         * STALE edge grows with streak (continuation) or fades (crowding).
         */
        topRawStaleShort: ReplayComparison;
        topRawStaleLong: ReplayComparison;
        /**
         * Concentration split: events where the cross-sectional HHI of
         * positive scores is above the median (DOMINANT — one signal leads) vs
         * at/below (SPREAD — scores dispersed).
         */
        topRawDominant: ReplayComparison;
        topRawSpread: ReplayComparison;
        /**
         * Active-pair regime split: events where maxActivePairs across
         * positive candidates is above (HI_PAIRS) or at/below (LO_PAIRS) the
         * median across all views.
         */
        topRawHiPairs: ReplayComparison;
        topRawLoPairs: ReplayComparison;
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
    }>;
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
export type SelectorName = "RAW" | "ADJUSTED" | "MEAN" | "ACTIVE" | "SUBMITTED" | "RETAINED" | "REVERSION" | "BOTTOM";

export interface OpenScoreUsdTarget {
    asset: string;
    symbol: string;
    data: OHLCVData[];
}

export interface RunOpenScoreUsdReplayOptions {
    /** Required in v1: positive bar horizons. Must be non-empty. */
    horizons: number[];
    /** Bar interval the artifacts were produced on (echoed in the report). */
    interval?: string;
    /** Optional decision-timestamp window (unix seconds, inclusive). */
    sampleFromSec?: number;
    sampleToSec?: number;
    /** Batch slippage/commission conventions applied to both arms identically. */
    slippageRate?: number;
    commissionRate?: number;
    /** Chronological blocks for block means / bootstrap. Default 10. */
    blockCount?: number;
    /** Deterministic bootstrap resamples. Default 2000. */
    bootstrapSamples?: number;
    /**
     * Phase 3 MAX_ACTIVE: submitted scoring-asset degree map from the
     * canonical Batch request. Drives the MAX_SUBMITTED selector. When
     * absent, MAX_SUBMITTED mirrors MAX_STATIC (which counts every leg of
     * every artifact as submitted) so old callers keep working.
     */
    submittedDegreeByAsset?: Record<string, number>;
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
    /** Phase transition + bounded-chunk progress. */
    onPhase?: (phase: "scan" | "events" | "targets" | "outcomes" | "aggregate", detail: string, completed: number, total: number) => void;
    /** Polled between bounded chunks; return true to stop early (cancellation). */
    shouldStop?: () => boolean;
}

// ============================================================================
// Small stat helpers (NaN/Infinity never cross the wire — they serialize to
// null, so every public metric is number | null and finite-guarded).
// ============================================================================

function median(sorted: readonly number[]): number {
    const n = sorted.length;
    if (n === 0) return Number.NaN;
    const mid = n >> 1;
    return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function finiteOrNull(x: number): number | null {
    return Number.isFinite(x) ? x : null;
}

function meanOrNull(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return finiteOrNull(s / values.length);
}

const TOP_MEAN_TREND_EMA_PERIOD = 200;

/**
 * Causal target-asset EMA used by TOP_MEAN_TREND. Values before the SMA seed
 * are NaN, so a candidate cannot qualify without 200 fully known closes.
 */
function buildEma200(data: readonly OHLCVData[]): number[] {
    const ema = new Array<number>(data.length).fill(Number.NaN);
    if (data.length < TOP_MEAN_TREND_EMA_PERIOD) return ema;
    let seed = 0;
    for (let i = 0; i < TOP_MEAN_TREND_EMA_PERIOD; i += 1) {
        const close = data[i]!.close;
        if (!Number.isFinite(close) || close <= 0) return ema;
        seed += close;
    }
    const seedIndex = TOP_MEAN_TREND_EMA_PERIOD - 1;
    ema[seedIndex] = seed / TOP_MEAN_TREND_EMA_PERIOD;
    const alpha = 2 / (TOP_MEAN_TREND_EMA_PERIOD + 1);
    for (let i = TOP_MEAN_TREND_EMA_PERIOD; i < data.length; i += 1) {
        const close = data[i]!.close;
        if (!Number.isFinite(close) || close <= 0) continue;
        ema[i] = close * alpha + ema[i - 1]! * (1 - alpha);
    }
    return ema;
}

function phase0bEventId(interval: string | undefined, decisionTimeSec: number): string {
    return `${interval ?? ""}:${decisionTimeSec}`;
}

interface DiagnosticDirectionalOutcome {
    returnValue: number | null;
    entryTimeSec: number | null;
    exitTimeSec: number | null;
    status: CandidateOutcomeStatus;
}

function computeDiagnosticOutcome(
    data: readonly OHLCVData[],
    times: readonly (number | null)[],
    entryBar: number,
    horizonBars: number,
    direction: "long" | "short",
    slippageRate: number,
    commissionRate: number,
): DiagnosticDirectionalOutcome {
    if (entryBar < 0) {
        return { returnValue: null, entryTimeSec: null, exitTimeSec: null, status: "missing_entry" };
    }
    const entryTimeSec = Number.isFinite(times[entryBar]) ? times[entryBar] : null;
    const exitBar = entryBar + horizonBars - 1;
    if (exitBar >= data.length) {
        return { returnValue: null, entryTimeSec, exitTimeSec: null, status: "right_censored" };
    }
    const exitTimeSec = Number.isFinite(times[exitBar]) ? times[exitBar] : null;
    const rawOpen = data[entryBar]?.open;
    const exitClose = data[exitBar]?.close;
    if (
        !Number.isFinite(rawOpen)
        || rawOpen <= 0
        || !Number.isFinite(exitClose)
        || exitClose <= 0
    ) {
        return { returnValue: null, entryTimeSec, exitTimeSec, status: "invalid_price" };
    }
    if (direction === "long") {
        const entryPrice = applySlippage(rawOpen, "buy", slippageRate);
        const exitPrice = applySlippage(exitClose, "sell", slippageRate);
        const fees = (entryPrice + exitPrice) * commissionRate;
        const returnValue = (exitPrice - entryPrice - fees) / entryPrice;
        return Number.isFinite(returnValue)
            ? { returnValue, entryTimeSec, exitTimeSec, status: "ok" }
            : { returnValue: null, entryTimeSec, exitTimeSec, status: "invalid_price" };
    }
    const entryPrice = applySlippage(rawOpen, "sell", slippageRate);
    const exitPrice = applySlippage(exitClose, "buy", slippageRate);
    const fees = (entryPrice + exitPrice) * commissionRate;
    const returnValue = (entryPrice - exitPrice - fees) / entryPrice;
    return Number.isFinite(returnValue)
        ? { returnValue, entryTimeSec, exitTimeSec, status: "ok" }
        : { returnValue: null, entryTimeSec, exitTimeSec, status: "invalid_price" };
}

/**
 * Shape of a per-selector sample map (returns + deltas accumulated per asset
 * across the events the selector chose that asset). Used by both the per-asset
 * breakdown builder and the dominant-asset exclusion helper below.
 */
export type SelectorSamplesByAsset = Map<string, { returns: number[]; deltas: number[] }>;

/**
 * Shape of a per-selector event series consumed by the dominant-asset
 * exclusion helper: parallel arrays of (delta, selectedReturn, timeSec,
 * assetName) per eligible event.
 */
export interface SelectorExclusionSeries {
    readonly deltas: readonly number[];
    readonly returns: readonly number[];
    readonly times: readonly number[];
    readonly assets: readonly string[];
}

/**
 * Build the per-asset selection breakdown that every asset-picking arm
 * (TOP_RAW / TOP_MEAN / MAX_ACTIVE / MAX_ACTIVE_REVERSION / BOTTOM_MEAN, plus
 * future arms) emits for the `<ARM> selected assets` report block. Returns
 * the sorted summary plus the totals used in the report header.
 *
 * Sort order: events desc, then asset name asc — same rule the six prior
 * copy-pasted blocks used. `maxSelected` is computed by iterating the
 * values directly instead of `Math.max(0, ...map.values())`, which would
 * risk `Maximum call stack size exceeded` on the documented 124k-pair scale.
 */
export function buildAssetSelectionBreakdown(
    selectedByAsset: Map<string, number>,
    samplesByAsset: SelectorSamplesByAsset,
): {
    byAsset: AssetSelectionSummary[];
    totalSelected: number;
    maxSelected: number;
} {
    let totalSelected = 0;
    let maxSelected = 0;
    for (const v of selectedByAsset.values()) {
        totalSelected += v;
        if (v > maxSelected) maxSelected = v;
    }
    const byAsset: AssetSelectionSummary[] = [...selectedByAsset.entries()]
        .map(([asset, events]) => {
            const samples = samplesByAsset.get(asset)!;
            const selectedMean = meanOrNull(samples.returns);
            const delta = meanOrNull(samples.deltas);
            return {
                asset,
                events,
                share: totalSelected > 0 ? events / totalSelected : 0,
                topMean: selectedMean,
                randomMean: selectedMean !== null && delta !== null ? finiteOrNull(selectedMean - delta) : null,
                delta,
            };
        })
        .sort((a, b) => b.events - a.events || a.asset.localeCompare(b.asset));
    return { byAsset, totalSelected, maxSelected };
}

/**
 * Compute the `<ARM>_EX_<dominant>` comparison: drop events whose selected
 * asset equals `dominantAsset`, then build a `ReplayComparison` over the
 * surviving series. This is the concentration-vs-broad-based diagnostic every
 * asset-picking arm ships alongside its `selected assets` breakdown.
 *
 * Module-level so the breakdown/exclusion logic is unit-testable; previously
 * it was inlined six times inside a 1300-line function. The `buildComparison`
 * callback is injected because it closes over per-horizon `blockCount` and
 * `bootstrapSamples` parameters.
 */
export function buildExDominantComparison(
    series: SelectorExclusionSeries,
    dominantAsset: string | null,
    buildComparison: (deltas: number[], returns: number[], times: number[]) => ReplayComparison,
): ReplayComparison {
    const nonDominantIndexes: number[] = [];
    for (let i = 0; i < series.assets.length; i += 1) {
        if (series.assets[i] !== dominantAsset) nonDominantIndexes.push(i);
    }
    return buildComparison(
        nonDominantIndexes.map((i) => series.deltas[i]!),
        nonDominantIndexes.map((i) => series.returns[i]!),
        nonDominantIndexes.map((i) => series.times[i]!),
    );
}

/**
 * Summarize a fixed-notional selector event series as overlapping basket P&L.
 * Non-finite returns are omitted rather than converted to zero. Drawdown is
 * calculated on the chronological, non-compounded cumulative return curve.
 */
export function computeSelectorPnl(
    returns: readonly number[],
    times: readonly number[],
): SelectorPnlSummary {
    const points: Array<{ value: number; time: number; index: number }> = [];
    for (let i = 0; i < returns.length; i += 1) {
        const value = returns[i]!;
        if (!Number.isFinite(value)) continue;
        const rawTime = times[i];
        points.push({ value, time: Number.isFinite(rawTime) ? rawTime! : i, index: i });
    }
    points.sort((a, b) => a.time - b.time || a.index - b.index);
    if (points.length === 0) {
        return { trades: 0, totalReturn: null, sharpe: null, winRate: null, maxDrawdown: null };
    }

    let totalReturn = 0;
    let wins = 0;
    let mean = 0;
    for (const point of points) {
        totalReturn += point.value;
        if (point.value > 0) wins += 1;
        mean += point.value;
    }
    mean /= points.length;
    let variance = 0;
    for (const point of points) variance += (point.value - mean) ** 2;
    const stdDev = points.length > 1 ? Math.sqrt(variance / (points.length - 1)) : 0;

    let curve = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const point of points) {
        curve += point.value;
        if (curve > peak) peak = curve;
        const drawdown = peak - curve;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
        trades: points.length,
        totalReturn: finiteOrNull(totalReturn),
        sharpe: finiteOrNull(stdDev > 1e-12 ? mean / stdDev : 0),
        winRate: finiteOrNull(wins / points.length),
        maxDrawdown: finiteOrNull(maxDrawdown),
    };
}

export function simulateTopMeanPortfolio(
    opportunities: readonly TopMeanPortfolioOpportunity[],
): TopMeanPortfolioSummary {
    const notional = 1_000;
    const ordered = opportunities
        .map((opportunity, index) => ({ opportunity, index }))
        .filter(({ opportunity }) =>
            Number.isFinite(opportunity.decisionTime)
            && Number.isFinite(opportunity.entryTime)
            && Number.isFinite(opportunity.exitTime)
            && opportunity.exitTime >= opportunity.entryTime
            && Number.isFinite(opportunity.netReturn))
        .sort((a, b) =>
            a.opportunity.decisionTime - b.opportunity.decisionTime
            || a.index - b.index);

    const activeUntilByAsset = new Map<string, number>();
    const accepted: Array<TopMeanPortfolioOpportunity & { pnl: number; index: number }> = [];
    let skippedTies = 0;
    let skippedActiveAsset = 0;

    for (const { opportunity, index } of ordered) {
        if (opportunity.tied) {
            skippedTies += 1;
            continue;
        }
        const activeUntil = activeUntilByAsset.get(opportunity.asset);
        // Exit occurs at the bar close. A new entry at that same bar's open
        // still overlaps, so it is accepted only when the prior exit is earlier.
        if (activeUntil !== undefined && activeUntil >= opportunity.entryTime) {
            skippedActiveAsset += 1;
            continue;
        }
        activeUntilByAsset.set(opportunity.asset, opportunity.exitTime);
        accepted.push({ ...opportunity, pnl: opportunity.netReturn * notional, index });
    }

    const capitalEvents: Array<{ time: number; delta: number; index: number }> = [];
    for (const trade of accepted) {
        capitalEvents.push({ time: trade.entryTime, delta: 1, index: trade.index });
        capitalEvents.push({ time: trade.exitTime, delta: -1, index: trade.index });
    }
    capitalEvents.sort((a, b) =>
        a.time - b.time
        // An exit is at the close while an entry is at the open, so entries at
        // the same timestamp consume capital before close-time exits release it.
        || b.delta - a.delta
        || a.index - b.index);
    let concurrent = 0;
    let peakConcurrentPositions = 0;
    for (const event of capitalEvents) {
        concurrent += event.delta;
        if (concurrent > peakConcurrentPositions) peakConcurrentPositions = concurrent;
    }

    const realized = [...accepted].sort((a, b) => a.exitTime - b.exitTime || a.index - b.index);
    let netPnl = 0;
    let wins = 0;
    let curve = 0;
    let peak = 0;
    let maxRealizedDrawdown = 0;
    for (const trade of realized) {
        netPnl += trade.pnl;
        if (trade.pnl > 0) wins += 1;
        curve += trade.pnl;
        if (curve > peak) peak = curve;
        const drawdown = peak - curve;
        if (drawdown > maxRealizedDrawdown) maxRealizedDrawdown = drawdown;
    }

    const trades = accepted.length;
    const peakCapital = peakConcurrentPositions * notional;
    return {
        notionalPerTrade: notional,
        eligibleSignals: ordered.length,
        trades,
        skippedTies,
        skippedActiveAsset,
        netPnl: trades > 0 ? finiteOrNull(netPnl) : null,
        averagePnl: trades > 0 ? finiteOrNull(netPnl / trades) : null,
        winRate: trades > 0 ? finiteOrNull(wins / trades) : null,
        maxRealizedDrawdown: trades > 0 ? finiteOrNull(maxRealizedDrawdown) : null,
        peakConcurrentPositions,
        peakCapital,
        returnOnPeakCapital: peakCapital > 0 ? finiteOrNull(netPnl / peakCapital) : null,
    };
}

/**
 * Deterministic block bootstrap over chronological block means. Resamples
 * blocks with replacement using a fixed-seed LCG (init from the versioned
 * `MAX_ACTIVE_BOOTSTRAP_SEED`) so the CI is reproducible run-to-run.
 *
 * Phase 0 freeze: a formal CI requires EXACTLY {@link MAX_ACTIVE_BLOCK_COUNT}
 * nonempty chronological blocks. Fewer blocks (incl. one) return null CI —
 * `INSUFFICIENT_DATA`, never a misleading point CI from a single block.
 */
function blockBootstrapCi(blockMeans: readonly number[], resamples: number): { lower: number | null; upper: number | null } {
    const b = blockMeans.length;
    if (b < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    let seed = (Math.floor(MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0) || 0x9e3779b9;
    const next = (): number => {
        // LCG (Numerical Recipes constants), returns [0,1).
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const means: number[] = [];
    for (let r = 0; r < resamples; r += 1) {
        let s = 0;
        for (let k = 0; k < b; k += 1) s += blockMeans[Math.floor(next() * b)]!;
        means.push(s / b);
    }
    means.sort((x, y) => x - y);
    const lo = means[Math.max(0, Math.floor(0.025 * resamples))]!;
    const hi = means[Math.min(resamples - 1, Math.floor(0.975 * resamples))]!;
    return { lower: finiteOrNull(lo), upper: finiteOrNull(hi) };
}

function degreeSummary(degrees: readonly number[], topAssetShare: number | null): DegreeSummary {
    if (degrees.length === 0) return { min: 0, median: 0, max: 0, topAssetShare: null };
    const sorted = [...degrees].sort((a, b) => a - b);
    return {
        min: sorted[0]!,
        median: median(sorted),
        max: sorted[sorted.length - 1]!,
        topAssetShare,
    };
}

// ============================================================================
// Internal flat records (scalar, bounded by trades/events — no per-trade object
// retention beyond the compact delta stream).
// ============================================================================

interface ScoreDelta {
    timeSec: number;
    assetIndex: number;
    delta: number;
    /** 1 when this delta comes from a pair entry, 0 for an exit. */
    isEntry: number;
}

interface DecisionEvent {
    timeSec: number;
    /** Per-asset rawScore snapshot after applying all deltas at this time. */
    rawScore: number[];
    /** Signed score changes inside the six-bar causal score window. */
    recentRawScore: number[] | null;
    activePairCount: number[];
    /**
     * Per-asset signed ENTRY flow summed across this timestamp group only
     * (entry deltas, not exits). Drives the ACCELERATING selector: fresh
     * bullish/bearish flow per active pair, reset to zero at each timestamp.
     * Snapshotted after the full group is applied — never a partial state.
     */
    entryFlow: number[];
}

// ============================================================================
// Main engine
// ============================================================================

/**
 * @param artifactLoader Async iterator yielding one artifact at a time. The
 *   engine extracts compact score deltas and releases the reference before the
 *   next load — never holds the full pair universe in memory.
 * @param targetLoader Async iterator yielding one target dataset at a time.
 *   Consumed after events are formed; each dataset is released once all event
 *   requests for that asset are consumed.
 */
export async function runOpenScoreUsdReplay(
    artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>,
    targetLoader: () => AsyncIterable<OpenScoreUsdTarget>,
    options: RunOpenScoreUsdReplayOptions,
): Promise<OpenScoreUsdReplayResult> {
    const startedAt = Date.now();
    const shouldStop = options.shouldStop ?? (() => false);
    const onPhase = options.onPhase ?? (() => undefined);
    const slippageRate = options.slippageRate ?? 0;
    const commissionRate = options.commissionRate ?? 0;
    // Phase 0 freeze: block count and bootstrap samples default to the frozen
    // research constants. Callers may override blockCount for diagnostics, but
    // a formal CI still requires EXACTLY MAX_ACTIVE_BLOCK_COUNT nonempty blocks.
    const blockCount = Math.max(1, Math.floor(options.blockCount ?? MAX_ACTIVE_BLOCK_COUNT));
    const bootstrapSamples = Math.max(200, Math.floor(options.bootstrapSamples ?? MAX_ACTIVE_BOOTSTRAP_SAMPLES));
    const warnings: string[] = [];
    const scoreLookbackBars = 6;
    const intervalSeconds = options.interval ? parseIntervalSeconds(options.interval) : null;
    // Six bars ending at the current event span the current timestamp plus the
    // five preceding bar intervals. Batch always supplies `interval`; callers
    // without one keep the existing selectors and receive empty 6-bar arms.
    const recentScoreWindowSeconds = intervalSeconds === null
        ? null
        : (scoreLookbackBars - 1) * intervalSeconds;

    const horizons = [...new Set(options.horizons.filter((h) => Number.isFinite(h) && h >= 1).map((h) => Math.floor(h)))].sort((a, b) => a - b);
    const emptyResult = (partial: Partial<OpenScoreUsdReplayResult>): OpenScoreUsdReplayResult => ({
        pairs: 0, assets: 0, complete: false, omittedPairs: 0, omittedAssets: 0,
        totalEvents: 0, candidateEvents: 0, eligibleEvents: 0, horizons: [],
        latestSelections: null, degree: degreeSummary([], null),
        warnings, reportLines: [], ...partial,
    });
    if (horizons.length === 0) {
        return emptyResult({ reportLines: ["OPEN_SCORE USD | no valid horizons supplied (required in v1)."] });
    }

    // --- Phase 1: scan artifacts -> compact per-pair delta streams ----------
    // Per-pair streams (not one global object array) so the Phase 2 merge can
    // interleave yields + progress and Stop stays responsive on huge pair
    // lists. Each pair's deltas are sorted in-place (small, fast) right after
    // the pair is loaded — never one global Array.sort blocking the loop.
    onPhase("scan", "scanning pair artifacts", 0, 0);
    const assetIndexByName = new Map<string, number>();
    const assetNames: string[] = [];
    // `retainedDegree` counts BOTH legs of every successfully loaded artifact
    // (the engine reads them from disk; this is what the plan calls RETAINED
    // degree, NOT submitted). The old name `staticDegree` is kept as an alias
    // so existing tests compile; the report labels this selector MAX_RETAINED.
    const retainedDegree = new Map<string, number>();
    /** @deprecated alias for {@link retainedDegree}; use that name in new code. */
    const staticDegree = retainedDegree;
    // Phase 3 MAX_ACTIVE: SUBMITTED degree comes from the canonical Batch
    // request (the user's textarea). When absent, fall back to the retained
    // degree map so MAX_SUBMITTED mirrors MAX_RETAINED for old callers.
    const submittedDegreeInput = options.submittedDegreeByAsset ?? null;
    const submittedDegree = new Map<string, number>();
    if (submittedDegreeInput) {
        for (const [k, v] of Object.entries(submittedDegreeInput)) {
            if (Number.isFinite(v) && v >= 0) submittedDegree.set(k, v);
        }
    }
    const streams: ScoreDelta[][] = [];
    let pairCount = 0;
    let omittedPairs = 0;

    const assetIndex = (name: string): number => {
        let idx = assetIndexByName.get(name);
        if (idx === undefined) {
            idx = assetNames.length;
            assetIndexByName.set(name, idx);
            assetNames.push(name);
        }
        return idx;
    };

    for await (const artifact of artifactLoader()) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, reportLines: ["OPEN_SCORE USD | cancelled during artifact scan."] });
        pairCount += 1;
        const base = artifact.baseAsset?.trim().toUpperCase();
        const quote = artifact.quoteAsset?.trim().toUpperCase();
        // Static pair degree describes the SUBMITTED pair list (the actual
        // workflow's coverage bias), so it must count every leg of every pair
        // regardless of whether the pair produced trades. Counting only pairs
        // that traded understated coverage and hid the pair-balance answer.
        if (base) staticDegree.set(base, (staticDegree.get(base) ?? 0) + 1);
        if (quote && quote !== base) staticDegree.set(quote, (staticDegree.get(quote) ?? 0) + 1);
        if (!base || (quote && base === quote)) {
            omittedPairs += 1;
            continue;
        }
        const bi = assetIndex(base);
        const qi = quote ? assetIndex(quote) : null;
        const trades = artifact.result?.trades ?? [];
        if (trades.length === 0) {
            omittedPairs += 1;
            continue;
        }
        const stream: ScoreDelta[] = [];
        for (const trade of trades) {
            const entrySec = timeToNumber(trade.entryTime);
            const exitSec = timeToNumber(trade.exitTime);
            if (entrySec === null) continue;
            const sign = trade.type === "long" ? 1 : trade.type === "short" ? -1 : 0;
            if (sign === 0) continue;
            // Entry deltas (long: base+1/quote-1; short: base-1/quote+1).
            stream.push({ timeSec: entrySec, assetIndex: bi, delta: sign, isEntry: 1 });
            if (qi !== null) {
                stream.push({ timeSec: entrySec, assetIndex: qi, delta: -sign, isEntry: 1 });
            }
            // Exit deltas are the exact inverse. end_of_data / missing exit time
            // means the position is still open at the artifact end -> no exit delta.
            if (exitSec !== null && trade.exitReason !== "end_of_data") {
                stream.push({ timeSec: exitSec, assetIndex: bi, delta: -sign, isEntry: 0 });
                if (qi !== null) {
                    stream.push({ timeSec: exitSec, assetIndex: qi, delta: sign, isEntry: 0 });
                }
            }
        }
        // Sort this pair's deltas in-place (small N). One global Array.sort on
        // 1000+ pairs' worth of deltas would block the event loop and keep
        // Stop / progress from firing during the long sort.
        stream.sort(compareDeltas);
        streams.push(stream);
        if (pairCount % 25 === 0) {
            onPhase("scan", `scanned ${pairCount} pairs`, pairCount, 0);
            await yieldLoop();
        }
    }

    const assetCount = assetNames.length;
    const totalDeltas = streams.reduce((s, st) => s + st.length, 0);
    if (pairCount === 0 || totalDeltas === 0) {
        return emptyResult({ pairs: pairCount, reportLines: ["OPEN_SCORE USD | no trade deltas reconstructed from artifacts."] });
    }

    // --- Phase 2: k-way merge -> decision events + candidates ---------------
    // Binary min-heap over (timeSec, assetIndex, isEntry, streamIdx, offset)
    // pops deltas in global timestamp order. The heap is bounded by #streams,
    // not #deltas; yields fire after bounded pops so progress and Stop reach
    // the server mid-merge on a huge pair list.
    onPhase("events", "merging score deltas", 0, totalDeltas);
    const rawScore = new Array<number>(assetCount).fill(0);
    const activePairCount = new Array<number>(assetCount).fill(0);
    const recentRawScore = new Array<number>(assetCount).fill(0);
    const recentScoreGroups: Array<{ timeSec: number; deltas: Array<{ assetIndex: number; delta: number }> }> = [];
    let recentScoreGroupOffset = 0;
    const events: DecisionEvent[] = [];
    const sampleFrom = options.sampleFromSec;
    const sampleTo = options.sampleToSec;

    const heap = new KWayMergeHeap(streams);
    let popped = 0;
    // ACCELERATING entry-flow accumulator: per-asset signed sum of THIS
    // timestamp's entry deltas only. Reset at the start of each timestamp
    // group; snapshotted into the DecisionEvent after the group is applied.
    const entryFlowAcc = new Array<number>(assetCount).fill(0);
    while (!heap.empty) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
        const t = heap.peekTime();
        let hasEntry = false;
        const groupRecentDeltas: Array<{ assetIndex: number; delta: number }> = [];
        // Reset entry-flow accumulator for this timestamp group.
        for (let a = 0; a < assetCount; a += 1) entryFlowAcc[a] = 0;
        // Apply ALL deltas at this timestamp before forming candidates.
        while (!heap.empty && heap.peekTime() === t) {
            if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
            const d = heap.pop()!;
            rawScore[d.assetIndex]! += d.delta;
            if (recentScoreWindowSeconds !== null) {
                recentRawScore[d.assetIndex]! += d.delta;
                groupRecentDeltas.push({ assetIndex: d.assetIndex, delta: d.delta });
            }
            // ACCELERATING: accumulate entry-only signed flow. Exits do NOT
            // create acceleration — an exit-only score improvement is not
            // treated as new bullish information (per the plan).
            if (d.isEntry === 1) entryFlowAcc[d.assetIndex]! += d.delta;
            // activePairCount tracks currently-open pairs on this asset: an
            // entry adds a vote, an exit removes it (clamped at 0). Using
            // abs(delta) here was wrong because it incremented on BOTH entry
            // and exit, inflating the adjusted-score denominator after every
            // round-trip and corrupting TOP_ADJUSTED selection.
            const countDelta = d.isEntry === 1 ? 1 : -1;
            const next = activePairCount[d.assetIndex]! + countDelta;
            activePairCount[d.assetIndex] = next > 0 ? next : 0;
            if (d.isEntry === 1) hasEntry = true;
            popped += 1;
            // A single timestamp can contain many pair deltas. Check and yield
            // inside the timestamp group so Stop remains observable even before
            // all same-time deltas have been applied. Candidate formation still
            // waits until the group is complete below.
            if (popped % 2000 === 0) {
                onPhase("events", `merged ${popped}/${totalDeltas} deltas`, popped, totalDeltas);
                await yieldLoop();
            }
        }
        if (recentScoreWindowSeconds !== null) {
            recentScoreGroups.push({ timeSec: t, deltas: groupRecentDeltas });
            const cutoff = t - recentScoreWindowSeconds;
            while (
                recentScoreGroupOffset < recentScoreGroups.length
                && recentScoreGroups[recentScoreGroupOffset]!.timeSec < cutoff
            ) {
                const expired = recentScoreGroups[recentScoreGroupOffset]!;
                for (const d of expired.deltas) recentRawScore[d.assetIndex]! -= d.delta;
                recentScoreGroupOffset += 1;
            }
        }
        // Exit-only score changes do not create a decision event.
        if (hasEntry) {
            if ((sampleFrom === undefined || t >= sampleFrom) && (sampleTo === undefined || t <= sampleTo)) {
                events.push({
                    timeSec: t,
                    rawScore: [...rawScore],
                    recentRawScore: recentScoreWindowSeconds === null ? null : [...recentRawScore],
                    activePairCount: [...activePairCount],
                    entryFlow: [...entryFlowAcc],
                });
            }
        }
    }

    const totalEvents = events.length;
    if (totalEvents === 0) {
        return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | no decision events (no pair entries in window)."] });
    }

    // --- Phase 3: build candidate sets; collect per-asset event requests ---
    onPhase("targets", "forming candidates", 0, totalEvents);
    interface Candidate {
        assetIndex: number;
        raw: number;
        adjusted: number;
        mean: number;
        recentRaw: number;
        recentMean: number;
        activePairs: number;
        staticPairs: number;     // RETAINED artifact degree (legacy name; counts every loaded artifact leg).
        submittedPairs: number;  // SUBMITTED degree from the canonical Batch request.
        /**
         * ACCELERATING: fresh signed entry flow this timestamp divided by
         * max(1, activePairs). Positive only when the asset received net
         * positive entry flow at this event.
         */
        acceleration: number;
    }
    interface EventView {
        timeSec: number;
        positives: Candidate[];
        recentPositives: Candidate[];
        negatives: Candidate[];
        topRaw: number;      // assetIndex
        topAdjusted: number; // assetIndex
        topMean: number;     // assetIndex
        /** Unique raw maximum within the TOP_MEAN tied set, or -1 on a residual raw tie. */
        topMeanRawUniqueV1: number;
        /** TOP_MEAN tied set used as the exact research control pool. */
        topMeanRawUniqueV1Pool: Candidate[];
        topRaw6Bar: number;  // assetIndex
        topMean6Bar: number; // assetIndex
        topMeanRank2: number; // assetIndex
        maxActive: number;   // assetIndex
        maxStatic: number;   // assetIndex (alias for maxRetained — legacy)
        maxSubmitted: number; // assetIndex (Phase 3: from server's submittedDegreeByAsset)
        /** Max active-pair count across positive candidates at this event. */
        maxActivePairs: number;
        /** Most-open negative-score candidate, or -1 when unavailable. */
        maxActiveReversion: number;
        /** Lowest-mean negative-score candidate, or -1 when unavailable. */
        bottomMean: number;
        /**
         * ACCELERATING pool: positive-score candidates with fresh positive
         * entry flow. Stored on the view so Phase 5 can resolve forward returns
         * for ONLY these assets under its own eligibility gate (independent
         * from the shared all-positives gate).
         */
        acceleratingPool: Candidate[];
        /** Highest-acceleration candidate, or -1 when pool has < 2 members. */
        accelerating: number;
        /**
         * Cross-sectional concentration of positive raw scores, measured as the
         * Herfindahl–Hirschman index of each positive's share of total raw
         * (Σ (raw_i / Σraw)²). High HHI = one dominant signal; low = spread.
         */
        hhi: number;
        /**
         * Freshness: true when TOP_RAW's leader differs from the previous
         * view's TOP_RAW leader. The first view is always fresh.
         */
        fresh: boolean;
        /**
         * TOP_RAW leader streak length at this view: count of consecutive
         * views (ending here) with the same leader. Always 1 for FRESH views;
         * ≥ 2 for STALE views. Used by the STALE_SHORT / STALE_LONG split.
         */
        streak: number;
        /** Per-selector tie counts at this event (Phase 3 MAX_ACTIVE). */
        ties: Record<SelectorName, number>;
    }
    const views: EventView[] = [];
    // Rank Freshness: previous view's TOP_RAW leader (assetIndex). Updated
    // only when a view is actually pushed, so it tracks the previous *view's*
    // leader, not the previous *event's* (events without ≥2 positives do not
    // form a view and do not affect freshness).
    let lastTopRawLeaderIdx = -1;
    // Length of the current TOP_RAW leader streak (consecutive views with the
    // same leader). Reset to 1 on a fresh leader; incremented on a repeat.
    let currentStreakLength = 0;
    for (let e = 0; e < events.length; e += 1) {
        const ev = events[e]!;
        const positives: Candidate[] = [];
        const recentPositives: Candidate[] = [];
        const negatives: Candidate[] = [];
        let maxActivePairs = 0;
        for (let a = 0; a < assetCount; a += 1) {
            const raw = ev.rawScore[a]!;
            const cnt = ev.activePairCount[a]!;
            const recentRaw = ev.recentRawScore?.[a] ?? 0;
            const recentMean = cnt > 0 ? recentRaw / cnt : recentRaw;
            // ACCELERATING: fresh entry flow this timestamp / max(1, activePairs).
            // entryFlow is signed (long leg +1, short leg -1); acceleration > 0
            // means the asset received net positive entry flow at this event.
            const flow = ev.entryFlow[a]!;
            const acceleration = flow / (cnt > 0 ? cnt : 1);
            const candidate: Candidate = {
                assetIndex: a,
                raw,
                adjusted: cnt > 0 ? raw / Math.sqrt(cnt) : raw,
                mean: cnt > 0 ? raw / cnt : raw,
                recentRaw,
                recentMean,
                activePairs: cnt,
                staticPairs: retainedDegree.get(assetNames[a]!) ?? 0,
                submittedPairs: submittedDegree.size > 0
                    ? (submittedDegree.get(assetNames[a]!) ?? 0)
                    : (retainedDegree.get(assetNames[a]!) ?? 0),
                acceleration,
            };
            if (raw > 0) {
                if (cnt > maxActivePairs) maxActivePairs = cnt;
                positives.push(candidate);
            } else if (raw < 0) {
                negatives.push(candidate);
            }
            if (recentRaw > 0) recentPositives.push(candidate);
        }
        // Need >= 2 positive candidates for a top-vs-random comparison.
        if (positives.length >= 2) {
            // Phase 0 freeze: tie-break by the versioned FNV-1a 64 digest of
            // `MAX_ACTIVE_TIE_VERSION|tieSeed|truncatedEventTimeSec|scoringAsset`.
            // Smallest digest wins. Asset name and input order are NEVER
            // tie-breaks. On a digest collision (astronomically unlikely),
            // asset-name order keeps execution deterministic.
            const eventTimeSec = ev.timeSec;
            const digestFor = (c: Candidate): string => tieBreakDigest(eventTimeSec, assetNames[c.assetIndex]!);
            const pickMax = (candidates: readonly Candidate[], key: "raw" | "adjusted" | "mean" | "recentRaw" | "recentMean" | "activePairs" | "staticPairs" | "submittedPairs" | "acceleration"): { winner: Candidate; tiedCount: number } => {
                // First pass: find the max value.
                let maxValue = candidates[0]![key]!;
                for (let i = 1; i < candidates.length; i += 1) {
                    const v = candidates[i]![key]!;
                    if (v > maxValue) maxValue = v;
                }
                // Second pass: collect every candidate at the max, then pick by
                // tie-break digest. Counting at the end gives the correct tied
                // total regardless of input order.
                const tiedAtTop: Candidate[] = [];
                for (const c of candidates) {
                    if (c[key] === maxValue) tiedAtTop.push(c);
                }
                let winner = tiedAtTop[0]!;
                if (tiedAtTop.length > 1) {
                    // Precompute every tied candidate's digest ONCE and track the
                    // current winner's digest alongside the winner itself. The
                    // prior loop recomputed `digestFor(winner)` on every
                    // iteration — O(k) TextEncoder.encode + FNV hashes per tie
                    // event instead of O(1) lookup, and pickMax runs 6–7× per
                    // event across every event (Phase 3 hot path).
                    const digests = tiedAtTop.map(digestFor);
                    let dW = digests[0]!;
                    for (let i = 1; i < tiedAtTop.length; i += 1) {
                        const c = tiedAtTop[i]!;
                        const dC = digests[i]!;
                        if (dC < dW) { winner = c; dW = dC; }
                        else if (dC === dW) {
                            // Tie-digest collision. Asset name is the final
                            // deterministic fallback (collision is astronomically
                            // unlikely; no longer surfaced as a verdict flag —
                            // no consumer ever read it).
                            if (assetNames[c.assetIndex]! < assetNames[winner.assetIndex]!) { winner = c; dW = dC; }
                        }
                    }
                }
                return { winner, tiedCount: tiedAtTop.length };
            };
            // pickMin mirrors pickMax but selects the LOWEST value on `key`
            // (used by BOTTOM_MEAN: lowest mean = most-negative rawScore/activePairs
            // among negatives). Tie-break is the same FNV-1a digest rule so the
            // selector family stays deterministic and consistent.
            const pickMin = (candidates: readonly Candidate[], key: "mean" | "raw" | "adjusted" | "recentRaw" | "recentMean" | "activePairs" | "staticPairs" | "submittedPairs" | "acceleration"): { winner: Candidate; tiedCount: number } => {
                let minValue = candidates[0]![key]!;
                for (let i = 1; i < candidates.length; i += 1) {
                    const v = candidates[i]![key]!;
                    if (v < minValue) minValue = v;
                }
                const tiedAtBottom: Candidate[] = [];
                for (const c of candidates) {
                    if (c[key] === minValue) tiedAtBottom.push(c);
                }
                let winner = tiedAtBottom[0]!;
                if (tiedAtBottom.length > 1) {
                    const digests = tiedAtBottom.map(digestFor);
                    let dW = digests[0]!;
                    for (let i = 1; i < tiedAtBottom.length; i += 1) {
                        const c = tiedAtBottom[i]!;
                        const dC = digests[i]!;
                        if (dC < dW) { winner = c; dW = dC; }
                        else if (dC === dW) {
                            if (assetNames[c.assetIndex]! < assetNames[winner.assetIndex]!) { winner = c; dW = dC; }
                        }
                    }
                }
                return { winner, tiedCount: tiedAtBottom.length };
            };
            const topRaw = pickMax(positives, "raw");
            const topAdjusted = pickMax(positives, "adjusted");
            const topMean = pickMax(positives, "mean");
            const topMeanRawUniqueV1Pool = positives.filter((candidate) => candidate.mean === topMean.winner.mean);
            let topMeanRawUniqueV1 = -1;
            let maxRawInTopMeanTie = -Infinity;
            for (const candidate of topMeanRawUniqueV1Pool) {
                if (candidate.raw > maxRawInTopMeanTie) maxRawInTopMeanTie = candidate.raw;
            }
            const topMeanRawMaxRows = topMeanRawUniqueV1Pool.filter((candidate) => candidate.raw === maxRawInTopMeanTie);
            if (topMeanRawMaxRows.length === 1) topMeanRawUniqueV1 = topMeanRawMaxRows[0]!.assetIndex;
            const topRaw6Bar = recentPositives.length >= 2 ? pickMax(recentPositives, "recentRaw") : null;
            const topMean6Bar = recentPositives.length >= 2 ? pickMax(recentPositives, "recentMean") : null;
            const meanRanked = [...positives].sort((a, b) => {
                if (a.mean !== b.mean) return b.mean - a.mean;
                const aDigest = digestFor(a);
                const bDigest = digestFor(b);
                return aDigest < bDigest ? -1 : aDigest > bDigest ? 1 : assetNames[a.assetIndex]!.localeCompare(assetNames[b.assetIndex]!);
            });
            const maxActive = pickMax(positives, "activePairs");
            const maxStatic = pickMax(positives, "staticPairs");
            const maxSubmitted = pickMax(positives, "submittedPairs");
            const maxActiveReversion = negatives.length >= 2 ? pickMax(negatives, "activePairs") : null;
            // BOTTOM_MEAN: lowest-mean negative candidate. Mirrors MAX_ACTIVE_REVERSION's
            // `negatives.length >= 2` gate so both short-side selectors share the same
            // eligibility rule (AGENTS.md: independent gates, no direction mixing).
            const bottomMean = negatives.length >= 2 ? pickMin(negatives, "mean") : null;
            // ACCELERATING: positive-score candidates with fresh positive entry
            // flow (acceleration > 0). Pool is a strict subset of positives;
            // needs >= 2 to support a top-vs-random accelerating comparison.
            // Eligibility is INDEPENDENT from the shared positive-side gate
            // (plan risk #4): missing data on a non-accelerating positive must
            // not suppress a valid ACCELERATING event.
            const acceleratingPool = positives.filter((c) => c.acceleration > 0);
            const accelerating = acceleratingPool.length >= 2 ? pickMax(acceleratingPool, "acceleration") : null;
            // --- Conditional-split features (Phase 3) -------------------------
            const topRawIdx = topRaw.winner.assetIndex;
            // Cross-sectional HHI of positive raw scores. raw > 0 is guaranteed
            // for every positive, so rawSum > 0 and shares are well-defined.
            let rawSum = 0;
            for (const c of positives) rawSum += c.raw;
            let hhi = 0;
            for (const c of positives) {
                const share = c.raw / rawSum;
                hhi += share * share;
            }
            // Rank freshness: leader differs from previous view's leader. The
            // first view (lastTopRawLeaderIdx === -1) is always fresh.
            const fresh = topRawIdx !== lastTopRawLeaderIdx;
            // Streak length: 1 on a fresh leader (including the first view),
            // otherwise previous streak + 1. Computed BEFORE updating
            // lastTopRawLeaderIdx below so the streak recorded on this view
            // includes itself.
            currentStreakLength = fresh ? 1 : currentStreakLength + 1;
            views.push({
                timeSec: ev.timeSec, positives, negatives,
                recentPositives,
                topRaw: topRawIdx,
                topAdjusted: topAdjusted.winner.assetIndex,
                topMean: topMean.winner.assetIndex,
                topMeanRawUniqueV1,
                topMeanRawUniqueV1Pool,
                topRaw6Bar: topRaw6Bar?.winner.assetIndex ?? -1,
                topMean6Bar: topMean6Bar?.winner.assetIndex ?? -1,
                topMeanRank2: meanRanked[1]!.assetIndex,
                maxActive: maxActive.winner.assetIndex,
                maxStatic: maxStatic.winner.assetIndex,
                maxSubmitted: maxSubmitted.winner.assetIndex,
                maxActivePairs,
                maxActiveReversion: maxActiveReversion?.winner.assetIndex ?? -1,
                bottomMean: bottomMean?.winner.assetIndex ?? -1,
                acceleratingPool,
                accelerating: accelerating?.winner.assetIndex ?? -1,
                hhi,
                fresh,
                streak: currentStreakLength,
                ties: {
                    RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                    ADJUSTED: topAdjusted.tiedCount >= 2 ? 1 : 0,
                    MEAN: topMean.tiedCount >= 2 ? 1 : 0,
                    ACTIVE: maxActive.tiedCount >= 2 ? 1 : 0,
                    SUBMITTED: maxSubmitted.tiedCount >= 2 ? 1 : 0,
                    RETAINED: maxStatic.tiedCount >= 2 ? 1 : 0,
                    REVERSION: maxActiveReversion && maxActiveReversion.tiedCount >= 2 ? 1 : 0,
                    BOTTOM: bottomMean && bottomMean.tiedCount >= 2 ? 1 : 0,
                },
            });
            lastTopRawLeaderIdx = topRawIdx;
        }
        if (e % 1000 === 0) {
            onPhase("targets", `formed candidates for ${e}/${totalEvents} events`, e, totalEvents);
            await yieldLoop();
        }
    }

    const includePoolSnapshots = options.includePoolSnapshots === true;
    const includeCandidateOutcomes = options.includeCandidateOutcomes === true;
    const diagnosticsEnabled = includePoolSnapshots || includeCandidateOutcomes;
    const diagnosticAssetNames = diagnosticsEnabled
        ? (() => {
            const seen = new Set<string>();
            const names: string[] = [];
            for (const rawName of options.catalogAssets ?? assetNames) {
                const name = rawName.trim().toUpperCase();
                if (!name || seen.has(name)) continue;
                seen.add(name);
                names.push(name);
            }
            return names;
        })()
        : [];
    const diagnosticAssetIndexByName = diagnosticsEnabled ? new Map<string, number>() : null;
    if (diagnosticAssetIndexByName) {
        for (let i = 0; i < diagnosticAssetNames.length; i += 1) {
            diagnosticAssetIndexByName.set(diagnosticAssetNames[i]!, i);
        }
    }
    const poolSnapshots = includePoolSnapshots ? [] as PoolSnapshotRecord[] : undefined;
    const candidateOutcomes = includeCandidateOutcomes ? [] as CandidateOutcomeRecord[] : undefined;
    const emitPoolSnapshot = async (row: PoolSnapshotRecord): Promise<void> => {
        if (options.onPoolSnapshot) await options.onPoolSnapshot(row);
        else poolSnapshots?.push(row);
    };
    const emitCandidateOutcome = async (row: CandidateOutcomeRecord): Promise<void> => {
        if (options.onCandidateOutcome) await options.onCandidateOutcome(row);
        else candidateOutcomes?.push(row);
    };
    // EMA side state is compactly retained until all catalog targets have been
    // consumed so breadth can be emitted consistently for every asset at an
    // event.  0=unavailable, 1=above, 2=below.
    const emaSideByEvent = diagnosticsEnabled
        ? new Uint8Array(events.length * diagnosticAssetNames.length)
        : null;
    const emaObservedByEvent = diagnosticsEnabled ? new Uint16Array(events.length) : null;
    const emaAboveByEvent = diagnosticsEnabled ? new Uint16Array(events.length) : null;

    // Conditional-split thresholds: medians of the per-view features. Computed
    // once across ALL views (horizon-independent) so every horizon splits at
    // the same cut. median() requires a sorted input; the source arrays are
    // untouched, so a sorted copy is made for each. With < 2 views the median
    // is NaN and every `> NaN` check is false — all events fall into the
    // SPREAD/LO_PAIRS branch, which is the documented behaviour. The streak
    // median is computed over STALE views only (streak >= 2); with < 2 STALE
    // views every STALE event falls into STALE_SHORT.
    const splitThresholds = (() => {
        const hhis = views.map((v) => v.hhi).sort((a, b) => a - b);
        const pairs = views.map((v) => v.maxActivePairs).sort((a, b) => a - b);
        const streaks = views.filter((v) => v.streak >= 2).map((v) => v.streak).sort((a, b) => a - b);
        return { hhi: median(hhis), pairs: median(pairs), streak: median(streaks) };
    })();
    // Group requested event indexes by asset so each target dataset is loaded
    // once, consumed, and released.
    const requestsByAsset = new Map<number, number[]>();
    const positiveRequestedAssets = new Set<number>();
    for (let v = 0; v < views.length; v += 1) {
        for (const c of views[v]!.positives) {
            positiveRequestedAssets.add(c.assetIndex);
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            list.push(v);
        }
        for (const c of views[v]!.negatives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            // No dedupe needed: each `v` is unique (outer loop counter) and
            // each candidate's `assetIndex` is unique within a view's
            // negatives array (the candidate loop above iterates each
            // assetIndex exactly once). The previous `list.includes(v)` was
            // O(N²) defensiveness over a uniqueness invariant that already
            // holds — the positives branch never needed it for the same reason.
            list.push(v);
        }
        // A recent-score candidate may have non-positive all-history score.
        // Add it after the normal positive/negative passes so the same view
        // index cannot be appended twice for an asset.
        for (const c of views[v]!.recentPositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
    }

    // --- Phase 4: evaluate USD outcomes per target (load -> consume -> free) -
    // Per event-view, per horizon: net return for each candidate assetIndex.
    // Stored sparsely: only eligible-candidate assets are queried.
    const returnsByView: Array<Map<number, {
        long: number[];
        short: number[];
        entryTimes: number[];
        exitTimes: number[];
        aboveEma200: boolean;
        belowEma200: boolean;
    }> | null> = new Array(views.length).fill(null);
    const missingAssets = new Set<number>();
    const censoredEvents = new Set<number>();
    const noDataEvents = new Set<number>();
    const latestView = views[views.length - 1] ?? null;
    const latestCandidateAssets = new Set<number>(
        latestView
            ? [...latestView.positives, ...latestView.negatives].map((candidate) => candidate.assetIndex)
            : [],
    );
    const latestEma200SideByAsset = new Map<number, "above" | "below">();

    let targetsSeen = 0;
    const diagnosticTargetsSeen = diagnosticsEnabled ? new Set<number>() : null;
    const totalTargets = diagnosticsEnabled ? diagnosticAssetNames.length : requestsByAsset.size;
    onPhase("outcomes", "evaluating USD outcomes", 0, totalTargets);
    for await (const target of targetLoader()) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, totalEvents, reportLines: ["OPEN_SCORE USD | cancelled during outcome evaluation."] });
        const targetAsset = target.asset.trim().toUpperCase();
        const aIdx = assetIndexByName.get(targetAsset);
        const diagnosticIdx = diagnosticAssetIndexByName?.get(targetAsset);
        const requests = aIdx === undefined ? undefined : requestsByAsset.get(aIdx);
        if ((!requests || requests.length === 0) && diagnosticIdx === undefined) continue;
        targetsSeen += 1;
        if (diagnosticIdx !== undefined) diagnosticTargetsSeen?.add(diagnosticIdx);
        const times = target.data.map((b) => timeToNumber(b.time));
        const ema200 = buildEma200(target.data);
        if (latestView && aIdx !== undefined && latestCandidateAssets.has(aIdx)) {
            const nextBar = firstBarAfter(times, latestView.timeSec);
            const lastKnownBar = nextBar < 0 ? target.data.length - 1 : nextBar - 1;
            const close = lastKnownBar >= 0 ? target.data[lastKnownBar]!.close : Number.NaN;
            const ema = lastKnownBar >= 0 ? ema200[lastKnownBar]! : Number.NaN;
            if (Number.isFinite(close) && Number.isFinite(ema)) {
                if (close > ema) latestEma200SideByAsset.set(aIdx, "above");
                else if (close < ema) latestEma200SideByAsset.set(aIdx, "below");
            }
        }
        if (diagnosticIdx !== undefined) {
            let entryBar = 0;
            for (let eventIdx = 0; eventIdx < events.length; eventIdx += 1) {
                const event = events[eventIdx]!;
                while (entryBar < times.length) {
                    const barTime = times[entryBar];
                    if (barTime === null || barTime <= event.timeSec) entryBar += 1;
                    else break;
                }
                const resolvedEntryBar = entryBar < times.length ? entryBar : -1;
                const trendBar = resolvedEntryBar - 1;
                const trendClose = trendBar >= 0 ? target.data[trendBar]!.close : Number.NaN;
                const trendEma = trendBar >= 0 ? ema200[trendBar]! : Number.NaN;
                const emaSide = Number.isFinite(trendClose) && Number.isFinite(trendEma)
                    ? trendClose > trendEma ? 1 : trendClose < trendEma ? 2 : 0
                    : 0;
                if (emaSideByEvent && emaObservedByEvent && emaAboveByEvent && emaSide !== 0) {
                    const stateOffset = eventIdx * diagnosticAssetNames.length + diagnosticIdx;
                    emaSideByEvent[stateOffset] = emaSide;
                    emaObservedByEvent[eventIdx] += 1;
                    if (emaSide === 1) emaAboveByEvent[eventIdx] += 1;
                }
                if (!candidateOutcomes) continue;
                const rawScore = aIdx === undefined ? 0 : events[eventIdx]!.rawScore[aIdx] ?? 0;
                const longEligible = rawScore > 0;
                const shortEligible = rawScore < 0;
                for (let hIdx = 0; hIdx < horizons.length; hIdx += 1) {
                    const horizonBars = horizons[hIdx]!;
                    const longOutcome = computeDiagnosticOutcome(
                        target.data,
                        times,
                        resolvedEntryBar,
                        horizonBars,
                        "long",
                        slippageRate,
                        commissionRate,
                    );
                    const shortOutcome = computeDiagnosticOutcome(
                        target.data,
                        times,
                        resolvedEntryBar,
                        horizonBars,
                        "short",
                        slippageRate,
                        commissionRate,
                    );
                    const eventId = phase0bEventId(options.interval, event.timeSec);
                    await emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "long",
                        asset: diagnosticAssetNames[diagnosticIdx]!,
                        inPool: true,
                        eligible: longEligible,
                        return: longOutcome.returnValue,
                        entryTimeSec: longOutcome.entryTimeSec,
                        exitTimeSec: longOutcome.exitTimeSec,
                        status: longOutcome.status,
                    });
                    await emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "short",
                        asset: diagnosticAssetNames[diagnosticIdx]!,
                        inPool: true,
                        eligible: shortEligible,
                        return: shortOutcome.returnValue,
                        entryTimeSec: shortOutcome.entryTimeSec,
                        exitTimeSec: shortOutcome.exitTimeSec,
                        status: shortOutcome.status,
                    });
                }
            }
        }
        if (aIdx === undefined || !requests || requests.length === 0) continue;
        for (const viewIdx of requests) {
            const view = views[viewIdx]!;
            // First target bar strictly after the decision timestamp.
            const entryBar = firstBarAfter(times, view.timeSec);
            if (entryBar < 0) {
                if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                continue;
            }
            let perAsset = returnsByView[viewIdx];
            if (!perAsset) { perAsset = new Map(); returnsByView[viewIdx] = perAsset; }
            const longReturns: number[] = [];
            const shortReturns: number[] = [];
            const entryTimes: number[] = [];
            const exitTimes: number[] = [];
            const trendBar = entryBar - 1;
            const trendClose = trendBar >= 0 ? target.data[trendBar]!.close : Number.NaN;
            const trendEma = trendBar >= 0 ? ema200[trendBar]! : Number.NaN;
            const aboveEma200 = Number.isFinite(trendClose)
                && Number.isFinite(trendEma)
                && trendClose > trendEma;
            const belowEma200 = Number.isFinite(trendClose)
                && Number.isFinite(trendEma)
                && trendClose < trendEma;
            for (const h of horizons) {
                const exitBar = entryBar + h - 1; // h bars forward, close of that bar
                const entryTime = times[entryBar] ?? Number.NaN;
                if (exitBar >= target.data.length) {
                    longReturns.push(Number.NaN);
                    shortReturns.push(Number.NaN);
                    entryTimes.push(entryTime);
                    exitTimes.push(Number.NaN);
                    continue;
                }
                const rawOpen = target.data[entryBar]!.open;
                const exitClose = target.data[exitBar]!.close;
                if (!Number.isFinite(rawOpen) || rawOpen <= 0 || !Number.isFinite(exitClose) || exitClose <= 0) {
                    longReturns.push(Number.NaN);
                    shortReturns.push(Number.NaN);
                    entryTimes.push(entryTime);
                    exitTimes.push(Number.NaN);
                    continue;
                }
                entryTimes.push(entryTime);
                exitTimes.push(times[exitBar] ?? Number.NaN);
            // Long USD trade: buy at next bar open (slippage up), sell at
            // horizon close (slippage down), round-trip commission. Commission
            // is applied canonically (matches position-stats.ts): entryValue*rate
            // + exitValue*rate for a 1-unit notional. This is NOT a flat drag
            // off gross return — it varies with price level.
            const entryPrice = applySlippage(rawOpen, "buy", slippageRate);
            const exitPrice = applySlippage(exitClose, "sell", slippageRate);
            // size = 1 unit of the asset; entryValue=entryPrice, exitValue=exitPrice.
                const fees = (entryPrice + exitPrice) * commissionRate;
                const netReturn = (exitPrice - entryPrice - fees) / entryPrice;
                longReturns.push(Number.isFinite(netReturn) ? netReturn : Number.NaN);
                const shortEntryPrice = applySlippage(rawOpen, "sell", slippageRate);
                const shortExitPrice = applySlippage(exitClose, "buy", slippageRate);
                const shortFees = (shortEntryPrice + shortExitPrice) * commissionRate;
                const shortReturn = (shortEntryPrice - shortExitPrice - shortFees) / shortEntryPrice;
                shortReturns.push(Number.isFinite(shortReturn) ? shortReturn : Number.NaN);
            }
            perAsset.set(aIdx, {
                long: longReturns,
                short: shortReturns,
                entryTimes,
                exitTimes,
                aboveEma200,
                belowEma200,
            });
            if (longReturns.some((r) => !Number.isFinite(r))) censoredEvents.add(viewIdx);
        }
        onPhase("outcomes", `evaluated ${target.asset} (${targetsSeen}/${totalTargets})`, targetsSeen, totalTargets);
        await yieldLoop();
        // target OHLCV reference released here (goes out of scope next iteration).
    }

    if (candidateOutcomes) {
        for (let diagnosticIdx = 0; diagnosticIdx < diagnosticAssetNames.length; diagnosticIdx += 1) {
            if (diagnosticTargetsSeen?.has(diagnosticIdx)) continue;
            const asset = diagnosticAssetNames[diagnosticIdx]!;
            const aIdx = assetIndexByName.get(asset);
            for (const event of events) {
                const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                for (const horizonBars of horizons) {
                    const eventId = phase0bEventId(options.interval, event.timeSec);
                    await emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "long",
                        asset,
                        inPool: true,
                        eligible: rawScore > 0,
                        return: null,
                        entryTimeSec: null,
                        exitTimeSec: null,
                        status: "missing_target",
                    });
                    await emitCandidateOutcome({
                        eventId,
                        decisionTimeSec: event.timeSec,
                        horizonBars,
                        direction: "short",
                        asset,
                        inPool: true,
                        eligible: rawScore < 0,
                        return: null,
                        entryTimeSec: null,
                        exitTimeSec: null,
                        status: "missing_target",
                    });
                }
            }
        }
    }

    if (poolSnapshots) {
        const interval = options.interval ?? "";
        const poolVersion = options.poolVersion ?? null;
        for (let eventIdx = 0; eventIdx < events.length; eventIdx += 1) {
            const event = events[eventIdx]!;
            const observed = emaObservedByEvent?.[eventIdx] ?? 0;
            const above = emaAboveByEvent?.[eventIdx] ?? 0;
            const breadth = observed > 0 ? above / observed : null;
            const regime: PoolSnapshotRecord["regime"] = observed >= 2
                ? above / observed > 0.5 ? "bullish" : "bearish"
                : "unavailable";
            const eventId = phase0bEventId(options.interval, event.timeSec);
            for (let diagnosticIdx = 0; diagnosticIdx < diagnosticAssetNames.length; diagnosticIdx += 1) {
                const asset = diagnosticAssetNames[diagnosticIdx]!;
                const aIdx = assetIndexByName.get(asset);
                const activeCount = aIdx === undefined ? 0 : event.activePairCount[aIdx] ?? 0;
                const signedVotes = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                await emitPoolSnapshot({
                    eventId,
                    decisionTimeSec: event.timeSec,
                    interval,
                    poolVersion,
                    asset,
                    inPool: true,
                    activePairCount: activeCount,
                    signedVotes,
                    score: activeCount > 0 ? signedVotes / activeCount : null,
                    longEligible: signedVotes > 0,
                    shortEligible: signedVotes < 0,
                    ema200Above: emaSideByEvent?.[eventIdx * diagnosticAssetNames.length + diagnosticIdx] === 1,
                    breadth,
                    regime,
                });
            }
        }
    }

    const latestSelections: OpenScoreUsdLatestSelections | null = (() => {
        if (!latestView) return null;

        let ema200AssetsAbove = 0;
        for (const side of latestEma200SideByAsset.values()) {
            if (side === "above") ema200AssetsAbove += 1;
        }
        const ema200ObservedAssets = latestEma200SideByAsset.size;
        const ema200Breadth = ema200ObservedAssets > 0
            ? ema200AssetsAbove / ema200ObservedAssets
            : null;
        const hasBreadth = ema200ObservedAssets >= 2;
        const bullish = hasBreadth && ema200AssetsAbove / ema200ObservedAssets > 0.5;

        const pick = (
            selector: OpenScoreUsdLatestSelectorName,
            direction: "long" | "short" | "none",
            pool: readonly Candidate[],
            primary: (candidate: Candidate) => number,
            primaryOrder: "max" | "min",
            secondary?: (candidate: Candidate) => number,
        ): OpenScoreUsdLatestSelection => {
            if (pool.length < 2) {
                return {
                    selector,
                    direction,
                    asset: null,
                    tiedAssets: [],
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: pool.length,
                    reason: "insufficient_candidates",
                };
            }
            let bestPrimary = primary(pool[0]!);
            for (let i = 1; i < pool.length; i += 1) {
                const value = primary(pool[i]!);
                if (primaryOrder === "max" ? value > bestPrimary : value < bestPrimary) {
                    bestPrimary = value;
                }
            }
            let finalists = pool.filter((candidate) => primary(candidate) === bestPrimary);
            if (secondary && finalists.length > 1) {
                let bestSecondary = secondary(finalists[0]!);
                for (let i = 1; i < finalists.length; i += 1) {
                    const value = secondary(finalists[i]!);
                    if (value > bestSecondary) bestSecondary = value;
                }
                finalists = finalists.filter((candidate) => secondary(candidate) === bestSecondary);
            }
            if (finalists.length !== 1) {
                return {
                    selector,
                    direction,
                    asset: null,
                    tiedAssets: finalists.map((candidate) => assetNames[candidate.assetIndex]!).sort(),
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: pool.length,
                    reason: "tied",
                };
            }
            const selected = finalists[0]!;
            return {
                selector,
                direction,
                asset: assetNames[selected.assetIndex]!,
                tiedAssets: [],
                score: selected.raw,
                mean: selected.mean,
                activePairs: selected.activePairs,
                eligibleCandidates: pool.length,
                reason: "selected",
            };
        };

        const trendPool = bullish
            ? latestView.positives.filter((candidate) => latestEma200SideByAsset.get(candidate.assetIndex) === "above")
            : [];
        const regimePool = !hasBreadth
            ? []
            : bullish
                ? trendPool
                : latestView.negatives.filter((candidate) => latestEma200SideByAsset.get(candidate.assetIndex) === "below");

        return {
            decisionTime: latestView.timeSec,
            ema200ObservedAssets,
            ema200AssetsAbove,
            ema200Breadth,
            regime: !hasBreadth ? "unavailable" : bullish ? "bullish" : "bearish",
            selections: [
                pick("TOP_RAW", "long", latestView.positives, (candidate) => candidate.raw, "max"),
                pick("TOP_MEAN", "long", latestView.positives, (candidate) => candidate.mean, "max"),
                pick("TOP_MEAN_RAW_UNIQUE_V1", "long", latestView.positives, (candidate) => candidate.mean, "max", (candidate) => candidate.raw),
                pick("TOP_MEAN_TREND", "long", trendPool, (candidate) => candidate.mean, "max", (candidate) => candidate.activePairs),
                pick(
                    "REGIME_MEAN",
                    !hasBreadth ? "none" : bullish ? "long" : "short",
                    regimePool,
                    (candidate) => candidate.mean,
                    bullish ? "max" : "min",
                    (candidate) => candidate.activePairs,
                ),
                pick("MAX_ACTIVE", "long", latestView.positives, (candidate) => candidate.activePairs, "max"),
                pick("MAX_SUBMITTED", "long", latestView.positives, (candidate) => candidate.submittedPairs, "max"),
            ],
        };
    })();

    // --- Phase 5: aggregate ------------------------------------------------
    onPhase("aggregate", "aggregating statistics", 0, horizons.length);

    // Determine, per horizon, which views are eligible: every candidate has a
    // finite return for that horizon, for both the treatment winner and all
    // other positives (the control). If the winner has missing data, omit the
    // event from BOTH arms — never substitute a different winner.
    const horizonResults: OpenScoreUsdReplayResult["horizons"] = [];
    const eventDetails: OpenScoreUsdEventDetail[] = [];
    const ongoingEventDetails: OpenScoreUsdOngoingEventDetail[] = [];
    type ViewReturns = NonNullable<(typeof returnsByView)[number]>;
    const appendOngoingTopMeanEventDetail = (
        view: EventView,
        perAsset: ViewReturns | null | undefined,
        hIdx: number,
    ): void => {
        if (!options.includeEventDetails || view.positives.length < 2) return;
        const selected = view.positives.find((candidate) => candidate.assetIndex === view.topMean);
        if (!selected) return;
        const entryTime = perAsset?.get(selected.assetIndex)?.entryTimes[hIdx];
        ongoingEventDetails.push({
            decisionTime: view.timeSec,
            entryTime: Number.isFinite(entryTime) ? entryTime! : null,
            horizonBars: horizons[hIdx]!,
            selector: "TOP_MEAN",
            direction: "long",
            asset: assetNames[selected.assetIndex]!,
            eligibleCandidates: view.positives.length,
        });
    };
    let eligibleEventsMax = 0;
    for (let hIdx = 0; hIdx < horizons.length; hIdx += 1) {
        interface SelectorSeries {
            deltas: number[];
            returns: number[];
            times: number[];
            assets: string[];
        }
        const createSeries = (): SelectorSeries => ({ deltas: [], returns: [], times: [], assets: [] });
        const topRaw = createSeries();
        const topAdjusted = createSeries();
        const topMean = createSeries();
        const topMeanRawUniqueV1 = createSeries();
        const topRaw6Bar = createSeries();
        const topMean6Bar = createSeries();
        const topMeanTrend = createSeries();
        const regimeMean = createSeries();
        const topMeanVsRaw = createSeries();
        const topMeanVsRank2 = createSeries();
        const topMeanHedge = createSeries();
        const topMeanPortfolioOpportunities: TopMeanPortfolioOpportunity[] = [];
        const topMeanTrendPortfolioOpportunities: TopMeanPortfolioOpportunity[] = [];
        const regimeMeanPortfolioOpportunities: TopMeanPortfolioOpportunity[] = [];
        const maxActiveReversion = createSeries();
        const bottomMean = createSeries();
        const maxActive = createSeries();
        const maxStatic = createSeries();
        const maxSubmitted = createSeries();
        // ACCELERATING: highest-acceleration candidate vs the mean of the OTHER
        // accelerating candidates at the same event. Independent eligibility
        // gate (plan risk #4) — resolved BEFORE the shared positive-side
        // `if (!allValid) continue`, so missing data on a non-accelerating
        // positive does not suppress a valid ACCELERATING event.
        const accelerating = createSeries();
        // ACCELERATING random control: the per-event mean of the OTHER
        // accelerating candidates. Stored as a parallel series so a matching
        // overlapping-basket PNL can be computed for the control.
        const acceleratingRandom = createSeries();
        // Phase 3 MAX_ACTIVE pairwise deltas: same-event return differences
        // between MAX_ACTIVE and the other selector, ONLY on events where
        // they pick different assets. Build them as parallel arrays so the
        // buildComparison() helper can derive block means and a CI.
        const activeVsSubmitted = createSeries();
        const activeVsRetained = createSeries();
        const activeVsRaw = createSeries();
        const activeVsMean = createSeries();
        // Conditional-split sub-series: TOP_RAW's pick routed into one of two
        // accumulators per feature. Reuse the same `appendSelection` closure
        // (defined per view below) so the selection / randomMean baseline is
        // identical to TOP_RAW's — only the destination series varies.
        const topRawFresh = createSeries();
        const topRawStale = createSeries();
        // Streak-length refinement of STALE: SHORT (streak ∈ [2, median]) vs
        // LONG (streak > median). Only STALE events are routed here, so the
        // two counts sum to topRawStale.events.
        const topRawStaleShort = createSeries();
        const topRawStaleLong = createSeries();
        const topRawDominant = createSeries();
        const topRawSpread = createSeries();
        const topRawHiPairs = createSeries();
        const topRawLoPairs = createSeries();
        // Phase 3 MAX_ACTIVE tie counters per selector.
        const tieCounts: Record<SelectorName, number> = { RAW: 0, ADJUSTED: 0, MEAN: 0, ACTIVE: 0, SUBMITTED: 0, RETAINED: 0, REVERSION: 0, BOTTOM: 0 };
        const selectedDegree: number[] = [];
        const activeCountsAtEvents: number[] = [];
        const selectedByAsset = new Map<string, number>();
        const topRawSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // Per-asset selection map for TOP_MEAN (coverage-adjusted arm). Mirrors
        // topRawSamplesByAsset so the TOP_MEAN breakdown + EX_DOM lines can be
        // computed the same way as TOP_RAW's.
        const topMeanSelectedByAsset = new Map<string, number>();
        const topMeanSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topMeanRawUniqueV1SelectedByAsset = new Map<string, number>();
        const topMeanRawUniqueV1SamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topMeanTrendSelectedByAsset = new Map<string, number>();
        const topMeanTrendSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const regimeMeanSelectedByAsset = new Map<string, number>();
        const regimeMeanSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // Phase 3 MAX_ACTIVE: parallel per-asset selection map for MAX_ACTIVE.
        const activeSelectedByAsset = new Map<string, number>();
        const maxActiveSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const reversionSelectedByAsset = new Map<string, number>();
        const maxActiveReversionSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // BOTTOM_MEAN per-asset selection (short side). Mirrors
        // maxActiveReversionSamplesByAsset so BOTTOM_MEAN ships with the same
        // dominant-asset exclusion + breakdown the other short-side selector has.
        const bottomSelectedByAsset = new Map<string, number>();
        const bottomMeanSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        let rawAdjustedSame = 0;

        for (let v = 0; v < views.length; v += 1) {
            const view = views[v]!;
            const perAsset = returnsByView[v];
            if (!perAsset) {
                noDataEvents.add(v);
                for (let pendingHIdx = 0; pendingHIdx < horizons.length; pendingHIdx += 1) {
                    appendOngoingTopMeanEventDetail(view, perAsset, pendingHIdx);
                }
                continue;
            }
            const appendEventDetail = (
                selector: OpenScoreUsdEventDetailSelector,
                direction: "long" | "short",
                selected: Candidate,
                selectedReturn: number,
                controlReturn: number,
                eligibleCandidates: number,
            ): void => {
                if (!options.includeEventDetails) return;
                const outcome = perAsset.get(selected.assetIndex);
                const entryTime = outcome?.entryTimes[hIdx];
                const exitTime = outcome?.exitTimes[hIdx];
                if (
                    entryTime === undefined
                    || exitTime === undefined
                    || !Number.isFinite(entryTime)
                    || !Number.isFinite(exitTime)
                ) {
                    return;
                }
                eventDetails.push({
                    decisionTime: view.timeSec,
                    entryTime,
                    exitTime,
                    horizonBars: horizons[hIdx]!,
                    selector,
                    direction,
                    asset: assetNames[selected.assetIndex]!,
                    selectedReturn,
                    controlReturn,
                    delta: selectedReturn - controlReturn,
                    eligibleCandidates,
                });
            };

            // Independent gate: require a broad target uptrend, then let only
            // candidates above their own causal EMA200 enter this selector and
            // its same-pool random control.
            const trendPool = view.positives.filter((c) => perAsset.get(c.assetIndex)?.aboveEma200 === true);
            let assetsAboveEma200 = 0;
            let assetsWithEma200 = 0;
            for (const outcome of perAsset.values()) {
                if (outcome.aboveEma200 || outcome.belowEma200) assetsWithEma200 += 1;
                if (outcome.aboveEma200) assetsAboveEma200 += 1;
            }
            const broadUptrend = assetsWithEma200 >= 2 && assetsAboveEma200 / assetsWithEma200 > 0.5;
            const regimePool = broadUptrend
                ? trendPool
                : view.negatives.filter((c) => perAsset.get(c.assetIndex)?.belowEma200 === true);
            if (regimePool.length >= 2) {
                const regimeRetByAsset = new Map<number, number>();
                let regimeValid = true;
                for (const c of regimePool) {
                    const outcome = perAsset.get(c.assetIndex);
                    const r = broadUptrend ? outcome?.long[hIdx] : outcome?.short[hIdx];
                    if (r === undefined || !Number.isFinite(r)) { regimeValid = false; break; }
                    regimeRetByAsset.set(c.assetIndex, r);
                }
                if (regimeValid) {
                    const ranked = [...regimePool].sort((a, b) => {
                        if (a.mean !== b.mean) return broadUptrend ? b.mean - a.mean : a.mean - b.mean;
                        if (a.activePairs !== b.activePairs) return b.activePairs - a.activePairs;
                        const aDigest = tieBreakDigest(view.timeSec, assetNames[a.assetIndex]!);
                        const bDigest = tieBreakDigest(view.timeSec, assetNames[b.assetIndex]!);
                        return aDigest < bDigest
                            ? -1
                            : aDigest > bDigest
                                ? 1
                                : assetNames[a.assetIndex]!.localeCompare(assetNames[b.assetIndex]!);
                    });
                    const selected = ranked[0]!;
                    const selectedReturn = regimeRetByAsset.get(selected.assetIndex)!;
                    let regimeTotal = 0;
                    for (const r of regimeRetByAsset.values()) regimeTotal += r;
                    const randomReturn = (regimeTotal - selectedReturn) / (regimeRetByAsset.size - 1);
                    const delta = selectedReturn - randomReturn;
                    const asset = assetNames[selected.assetIndex]!;
                    const selection = `${broadUptrend ? "LONG" : "SHORT"} ${asset}`;
                    regimeMean.returns.push(selectedReturn);
                    regimeMean.deltas.push(delta);
                    regimeMean.times.push(view.timeSec);
                    regimeMean.assets.push(selection);
                    appendEventDetail(
                        "REGIME_MEAN",
                        broadUptrend ? "long" : "short",
                        selected,
                        selectedReturn,
                        randomReturn,
                        regimeRetByAsset.size,
                    );
                    regimeMeanSelectedByAsset.set(selection, (regimeMeanSelectedByAsset.get(selection) ?? 0) + 1);
                    let samples = regimeMeanSamplesByAsset.get(selection);
                    if (!samples) {
                        samples = { returns: [], deltas: [] };
                        regimeMeanSamplesByAsset.set(selection, samples);
                    }
                    samples.returns.push(selectedReturn);
                    samples.deltas.push(delta);
                    const outcome = perAsset.get(selected.assetIndex)!;
                    const tied = ranked.length > 1
                        && ranked[1]!.mean === selected.mean
                        && ranked[1]!.activePairs === selected.activePairs;
                    regimeMeanPortfolioOpportunities.push({
                        asset,
                        decisionTime: view.timeSec,
                        entryTime: outcome.entryTimes[hIdx]!,
                        exitTime: outcome.exitTimes[hIdx]!,
                        netReturn: selectedReturn,
                        tied,
                    });
                }
            }
            if (broadUptrend && trendPool.length >= 2) {
                const trendRetByAsset = new Map<number, number>();
                let trendValid = true;
                for (const c of trendPool) {
                    const outcome = perAsset.get(c.assetIndex);
                    const r = outcome?.long[hIdx];
                    if (r === undefined || !Number.isFinite(r)) { trendValid = false; break; }
                    trendRetByAsset.set(c.assetIndex, r);
                }
                if (trendValid) {
                    const ranked = [...trendPool].sort((a, b) => {
                        if (a.mean !== b.mean) return b.mean - a.mean;
                        if (a.activePairs !== b.activePairs) return b.activePairs - a.activePairs;
                        const aDigest = tieBreakDigest(view.timeSec, assetNames[a.assetIndex]!);
                        const bDigest = tieBreakDigest(view.timeSec, assetNames[b.assetIndex]!);
                        return aDigest < bDigest
                            ? -1
                            : aDigest > bDigest
                                ? 1
                                : assetNames[a.assetIndex]!.localeCompare(assetNames[b.assetIndex]!);
                    });
                    const selected = ranked[0]!;
                    const selectedReturn = trendRetByAsset.get(selected.assetIndex)!;
                    let trendTotal = 0;
                    for (const r of trendRetByAsset.values()) trendTotal += r;
                    const randomReturn = (trendTotal - selectedReturn) / (trendRetByAsset.size - 1);
                    const delta = selectedReturn - randomReturn;
                    const asset = assetNames[selected.assetIndex]!;
                    topMeanTrend.returns.push(selectedReturn);
                    topMeanTrend.deltas.push(delta);
                    topMeanTrend.times.push(view.timeSec);
                    topMeanTrend.assets.push(asset);
                    appendEventDetail(
                        "TOP_MEAN_TREND",
                        "long",
                        selected,
                        selectedReturn,
                        randomReturn,
                        trendRetByAsset.size,
                    );
                    topMeanTrendSelectedByAsset.set(asset, (topMeanTrendSelectedByAsset.get(asset) ?? 0) + 1);
                    let samples = topMeanTrendSamplesByAsset.get(asset);
                    if (!samples) {
                        samples = { returns: [], deltas: [] };
                        topMeanTrendSamplesByAsset.set(asset, samples);
                    }
                    samples.returns.push(selectedReturn);
                    samples.deltas.push(delta);
                    const outcome = perAsset.get(selected.assetIndex)!;
                    const tied = ranked.length > 1
                        && ranked[1]!.mean === selected.mean
                        && ranked[1]!.activePairs === selected.activePairs;
                    topMeanTrendPortfolioOpportunities.push({
                        asset,
                        decisionTime: view.timeSec,
                        entryTime: outcome.entryTimes[hIdx]!,
                        exitTime: outcome.exitTimes[hIdx]!,
                        netReturn: selectedReturn,
                        tied,
                    });
                }
            }

            // ACCELERATING aggregation — INDEPENDENT eligibility gate (plan risk
            // #4). Resolved BEFORE the shared positive-side `allValid` check so
            // that missing data on a non-accelerating positive does not suppress
            // a valid ACCELERATING event. Reads forward long returns for the
            // accelerating pool ONLY; non-finite returns omit the event from
            // this arm (never zero-filled).
            if (view.acceleratingPool.length >= 2 && view.accelerating >= 0) {
                const accRetByAsset = new Map<number, number>();
                let accValid = true;
                for (const c of view.acceleratingPool) {
                    const arr = perAsset.get(c.assetIndex);
                    const r = arr ? arr.long[hIdx] : undefined;
                    if (r === undefined || !Number.isFinite(r)) { accValid = false; break; }
                    accRetByAsset.set(c.assetIndex, r);
                }
                if (accValid) {
                    let accTotal = 0;
                    for (const r of accRetByAsset.values()) accTotal += r;
                    const accSelected = accRetByAsset.get(view.accelerating)!;
                    const accRandomMean = (accTotal - accSelected) / (accRetByAsset.size - 1);
                    accelerating.returns.push(accSelected);
                    accelerating.deltas.push(accSelected - accRandomMean);
                    accelerating.times.push(view.timeSec);
                    accelerating.assets.push(assetNames[view.accelerating]!);
                    // Parallel random-control series for the matching PNL basket.
                    acceleratingRandom.returns.push(accRandomMean);
                    acceleratingRandom.deltas.push(0); // control has no delta-vs-self
                    acceleratingRandom.times.push(view.timeSec);
                    acceleratingRandom.assets.push("ACCEL_RANDOM");
                    const selected = view.acceleratingPool.find(
                        (candidate) => candidate.assetIndex === view.accelerating,
                    )!;
                    appendEventDetail(
                        "ACCELERATING",
                        "long",
                        selected,
                        accSelected,
                        accRandomMean,
                        accRetByAsset.size,
                    );
                }
            }

            // Six-bar score arms use the same decision events but an
            // independent target-data gate. The pool is restricted to
            // assets with positive signed score change in the current and
            // preceding five bars; the random control is the other members of
            // that recent-score pool.
            if (view.recentPositives.length >= 2 && view.topRaw6Bar >= 0 && view.topMean6Bar >= 0) {
                const recentRetByAsset = new Map<number, number>();
                let recentValid = true;
                for (const c of view.recentPositives) {
                    const r = perAsset.get(c.assetIndex)?.long[hIdx];
                    if (r === undefined || !Number.isFinite(r)) { recentValid = false; break; }
                    recentRetByAsset.set(c.assetIndex, r);
                }
                if (recentValid) {
                    let recentTotalReturn = 0;
                    for (const r of recentRetByAsset.values()) recentTotalReturn += r;
                    const appendRecentSelection = (series: SelectorSeries, selectedIdx: number): void => {
                        const selectedReturn = recentRetByAsset.get(selectedIdx);
                        if (selectedReturn === undefined) return;
                        const randomReturn = (recentTotalReturn - selectedReturn) / (recentRetByAsset.size - 1);
                        series.returns.push(selectedReturn);
                        series.deltas.push(selectedReturn - randomReturn);
                        series.times.push(view.timeSec);
                        series.assets.push(assetNames[selectedIdx]!);
                    };
                    appendRecentSelection(topRaw6Bar, view.topRaw6Bar);
                    appendRecentSelection(topMean6Bar, view.topMean6Bar);
                }
            }

            // Collect returns for all positives this horizon.
            const retByAsset = new Map<number, number>();
            const shortByAsset = new Map<number, number>();
            let allValid = true;
            for (const c of view.positives) {
                const arr = perAsset.get(c.assetIndex);
                const r = arr ? arr.long[hIdx] : undefined;
                const shortReturn = arr ? arr.short[hIdx] : undefined;
                if (r === undefined || !Number.isFinite(r) || shortReturn === undefined || !Number.isFinite(shortReturn)) {
                    allValid = false;
                    break;
                }
                retByAsset.set(c.assetIndex, r);
                shortByAsset.set(c.assetIndex, shortReturn);
            }
            if (!allValid) {
                appendOngoingTopMeanEventDetail(view, perAsset, hIdx);
                continue; // censored or missing -> omit from both arms
            }

            let totalReturn = 0;
            for (const r of retByAsset.values()) totalReturn += r;
            const randomMeanOf = (selectedIdx: number): number => {
                const selectedReturn = retByAsset.get(selectedIdx);
                return selectedReturn === undefined || retByAsset.size < 2
                    ? Number.NaN
                    : (totalReturn - selectedReturn) / (retByAsset.size - 1);
            };
            const appendSelection = (series: SelectorSeries, selectedIdx: number): void => {
                const selectedReturn = retByAsset.get(selectedIdx)!;
                const randomMean = randomMeanOf(selectedIdx);
                series.returns.push(selectedReturn);
                series.deltas.push(selectedReturn - randomMean);
                series.times.push(view.timeSec);
                series.assets.push(assetNames[selectedIdx]!);
            };
            const appendTopMeanRawUniqueV1Selection = (): void => {
                if (view.topMeanRawUniqueV1 < 0) return;
                const tiedReturns = view.topMeanRawUniqueV1Pool
                    .map((candidate) => retByAsset.get(candidate.assetIndex))
                    .filter((value): value is number => value !== undefined && Number.isFinite(value));
                if (tiedReturns.length !== view.topMeanRawUniqueV1Pool.length || tiedReturns.length === 0) return;
                const selectedReturn = retByAsset.get(view.topMeanRawUniqueV1);
                if (selectedReturn === undefined) return;
                const controlReturn = tiedReturns.reduce((sum, value) => sum + value, 0) / tiedReturns.length;
                const delta = selectedReturn - controlReturn;
                topMeanRawUniqueV1.returns.push(selectedReturn);
                topMeanRawUniqueV1.deltas.push(delta);
                topMeanRawUniqueV1.times.push(view.timeSec);
                topMeanRawUniqueV1.assets.push(assetNames[view.topMeanRawUniqueV1]!);
                const asset = assetNames[view.topMeanRawUniqueV1]!;
                topMeanRawUniqueV1SelectedByAsset.set(asset, (topMeanRawUniqueV1SelectedByAsset.get(asset) ?? 0) + 1);
                let samples = topMeanRawUniqueV1SamplesByAsset.get(asset);
                if (!samples) {
                    samples = { returns: [], deltas: [] };
                    topMeanRawUniqueV1SamplesByAsset.set(asset, samples);
                }
                samples.returns.push(selectedReturn);
                samples.deltas.push(delta);
                appendEventDetail(
                    "TOP_MEAN_RAW_UNIQUE_V1",
                    "long",
                    view.topMeanRawUniqueV1Pool.find((candidate) => candidate.assetIndex === view.topMeanRawUniqueV1)!,
                    selectedReturn,
                    controlReturn,
                    view.topMeanRawUniqueV1Pool.length,
                );
            };
            const appendPairwise = (series: SelectorSeries, aIdx: number, bIdx: number): void => {
                // Only on events where the two selectors pick DIFFERENT assets.
                if (aIdx === bIdx) return;
                const aReturn = retByAsset.get(aIdx);
                const bReturn = retByAsset.get(bIdx);
                if (aReturn === undefined || bReturn === undefined) return;
                // The "delta" is the difference in selected-asset return. The
                // "return" stored is MAX_ACTIVE's return so topMean = active's
                // mean in the comparison report.
                series.returns.push(aReturn);
                series.deltas.push(aReturn - bReturn);
                series.times.push(view.timeSec);
                series.assets.push(assetNames[aIdx]!);
            };

            appendSelection(topRaw, view.topRaw);
            appendSelection(topAdjusted, view.topAdjusted);
            appendSelection(topMean, view.topMean);
            appendTopMeanRawUniqueV1Selection();
            appendEventDetail(
                "TOP_RAW",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.topRaw)!,
                retByAsset.get(view.topRaw)!,
                randomMeanOf(view.topRaw),
                retByAsset.size,
            );
            appendEventDetail(
                "TOP_ADJUSTED",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.topAdjusted)!,
                retByAsset.get(view.topAdjusted)!,
                randomMeanOf(view.topAdjusted),
                retByAsset.size,
            );
            appendEventDetail(
                "TOP_MEAN",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.topMean)!,
                retByAsset.get(view.topMean)!,
                randomMeanOf(view.topMean),
                retByAsset.size,
            );
            const rawReturn = retByAsset.get(view.topRaw)!;
            const meanReturn = retByAsset.get(view.topMean)!;
            topMeanVsRaw.returns.push(meanReturn);
            topMeanVsRaw.deltas.push(meanReturn - rawReturn);
            topMeanVsRaw.times.push(view.timeSec);
            topMeanVsRaw.assets.push(assetNames[view.topMean]!);
            appendPairwise(topMeanVsRank2, view.topMean, view.topMeanRank2);
            appendSelection(maxActive, view.maxActive);
            appendSelection(maxStatic, view.maxStatic);
            appendSelection(maxSubmitted, view.maxSubmitted);
            appendEventDetail(
                "MAX_ACTIVE",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.maxActive)!,
                retByAsset.get(view.maxActive)!,
                randomMeanOf(view.maxActive),
                retByAsset.size,
            );
            appendEventDetail(
                "MAX_RETAINED",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.maxStatic)!,
                retByAsset.get(view.maxStatic)!,
                randomMeanOf(view.maxStatic),
                retByAsset.size,
            );
            appendEventDetail(
                "MAX_SUBMITTED",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.maxSubmitted)!,
                retByAsset.get(view.maxSubmitted)!,
                randomMeanOf(view.maxSubmitted),
                retByAsset.size,
            );
            // Conditional-split routing: TOP_RAW's selected return into one of
            // two sub-series per feature. The split threshold comes from the
            // horizon-independent `splitThresholds` computed after Phase 3.
            // `> threshold` (strict) on DOMINANT/HI_PAIRS so equal-to-median
            // events fall into the SPREAD/LO_PAIRS branch, matching the field
            // docstrings.
            if (view.fresh) appendSelection(topRawFresh, view.topRaw);
            else {
                appendSelection(topRawStale, view.topRaw);
                // Streak-length refinement of STALE. `>` (strict) on LONG so
                // streak-equal-to-median events fall into SHORT, matching the
                // field docstring (`[2, median]` vs `> median`).
                if (view.streak > splitThresholds.streak) appendSelection(topRawStaleLong, view.topRaw);
                else appendSelection(topRawStaleShort, view.topRaw);
            }
            if (view.hhi > splitThresholds.hhi) appendSelection(topRawDominant, view.topRaw);
            else appendSelection(topRawSpread, view.topRaw);
            if (view.maxActivePairs > splitThresholds.pairs) appendSelection(topRawHiPairs, view.topRaw);
            else appendSelection(topRawLoPairs, view.topRaw);
            // Pairwise: MAX_ACTIVE vs each control, only on differing-selection events.
            appendPairwise(activeVsSubmitted, view.maxActive, view.maxSubmitted);
            appendPairwise(activeVsRetained, view.maxActive, view.maxStatic);
            appendPairwise(activeVsRaw, view.maxActive, view.topRaw);
            appendPairwise(activeVsMean, view.maxActive, view.topMean);
            const topMeanReturn = retByAsset.get(view.topMean)!;
            const rank2ShortReturn = shortByAsset.get(view.topMeanRank2)!;
            topMeanHedge.returns.push(topMeanReturn + rank2ShortReturn);
            topMeanHedge.times.push(view.timeSec);
            topMeanHedge.assets.push(assetNames[view.topMean]!);
            const topMeanOutcome = perAsset.get(view.topMean)!;
            topMeanPortfolioOpportunities.push({
                asset: assetNames[view.topMean]!,
                decisionTime: view.timeSec,
                entryTime: topMeanOutcome.entryTimes[hIdx]!,
                exitTime: topMeanOutcome.exitTimes[hIdx]!,
                netReturn: topMeanReturn,
                tied: view.ties.MEAN === 1,
            });
            // Accumulate tie counts.
            (Object.keys(view.ties) as Array<SelectorName>).forEach((k) => {
                tieCounts[k] += view.ties[k];
            });
            if (view.topRaw === view.topAdjusted) rawAdjustedSame += 1;
            // candidateDegree reports ACTIVE PAIR COUNT at decision events
            // (per the plan), NOT the count of positive candidates. The
            // previous `view.positives.length` understated coverage and hid
            // the pair-balance question.
            activeCountsAtEvents.push(view.maxActivePairs);
            const selName = assetNames[view.topRaw]!;
            selectedByAsset.set(selName, (selectedByAsset.get(selName) ?? 0) + 1);
            let assetSamples = topRawSamplesByAsset.get(selName);
            if (!assetSamples) {
                assetSamples = { returns: [], deltas: [] };
                topRawSamplesByAsset.set(selName, assetSamples);
            }
            assetSamples.returns.push(topRaw.returns[topRaw.returns.length - 1]!);
            assetSamples.deltas.push(topRaw.deltas[topRaw.deltas.length - 1]!);
            // Phase 3 MAX_ACTIVE: separately track the MAX_ACTIVE winner's per-
            // asset selection counts so the dominant-asset exclusion measures
            // MAX_ACTIVE (the research hypothesis), NOT TOP_RAW.
            const activeSelName = assetNames[view.maxActive]!;
            activeSelectedByAsset.set(activeSelName, (activeSelectedByAsset.get(activeSelName) ?? 0) + 1);
            let activeSamples = maxActiveSamplesByAsset.get(activeSelName);
            if (!activeSamples) {
                activeSamples = { returns: [], deltas: [] };
                maxActiveSamplesByAsset.set(activeSelName, activeSamples);
            }
            activeSamples.returns.push(maxActive.returns[maxActive.returns.length - 1]!);
            activeSamples.deltas.push(maxActive.deltas[maxActive.deltas.length - 1]!);
            // TOP_MEAN per-asset samples (mirrors TOP_RAW and MAX_ACTIVE
            // accumulation). Lets the report surface which assets TOP_MEAN
            // actually picks and whether its edge survives dropping the
            // dominant one.
            const meanSelName = assetNames[view.topMean]!;
            topMeanSelectedByAsset.set(meanSelName, (topMeanSelectedByAsset.get(meanSelName) ?? 0) + 1);
            let meanSamples = topMeanSamplesByAsset.get(meanSelName);
            if (!meanSamples) {
                meanSamples = { returns: [], deltas: [] };
                topMeanSamplesByAsset.set(meanSelName, meanSamples);
            }
            meanSamples.returns.push(topMean.returns[topMean.returns.length - 1]!);
            meanSamples.deltas.push(topMean.deltas[topMean.deltas.length - 1]!);
            // selectedDegree = static pair degree of the TOP_RAW winner. This
            // was collected but never surfaced; the report now exposes it so
            // coverage bias on the actually-selected asset is visible.
            selectedDegree.push(staticDegree.get(selName) ?? 0);

            // Reversion selector: use the same event and candidate universe,
            // but select the most-open NEGATIVE-score asset and evaluate a
            // short asset/USD trade. Its random baseline is another negative
            // candidate from that event.
            if (view.negatives.length >= 2 && view.maxActiveReversion >= 0) {
                const shortByAsset = new Map<number, number>();
                let shortValid = true;
                for (const c of view.negatives) {
                    const arr = perAsset.get(c.assetIndex);
                    const r = arr ? arr.short[hIdx] : undefined;
                    if (r === undefined || !Number.isFinite(r)) { shortValid = false; break; }
                    shortByAsset.set(c.assetIndex, r);
                }
                if (shortValid) {
                    let shortTotal = 0;
                    for (const r of shortByAsset.values()) shortTotal += r;
                    const selectedReturn = shortByAsset.get(view.maxActiveReversion)!;
                    const randomReturn = (shortTotal - selectedReturn) / (shortByAsset.size - 1);
                    const delta = selectedReturn - randomReturn;
                    maxActiveReversion.returns.push(selectedReturn);
                    maxActiveReversion.deltas.push(delta);
                    maxActiveReversion.times.push(view.timeSec);
                    maxActiveReversion.assets.push(assetNames[view.maxActiveReversion]!);
                    appendEventDetail(
                        "MAX_ACTIVE_REVERSION",
                        "short",
                        view.negatives.find((candidate) => candidate.assetIndex === view.maxActiveReversion)!,
                        selectedReturn,
                        randomReturn,
                        shortByAsset.size,
                    );
                    const asset = assetNames[view.maxActiveReversion]!;
                    reversionSelectedByAsset.set(asset, (reversionSelectedByAsset.get(asset) ?? 0) + 1);
                    let samples = maxActiveReversionSamplesByAsset.get(asset);
                    if (!samples) {
                        samples = { returns: [], deltas: [] };
                        maxActiveReversionSamplesByAsset.set(asset, samples);
                    }
                    samples.returns.push(selectedReturn);
                    samples.deltas.push(delta);
                }
            }

            // BOTTOM_MEAN selector: same negative pool and short-USD trade as
            // MAX_ACTIVE_REVERSION, but picks the LOWEST-mean negative candidate
            // (most-negative rawScore/activePairs). Independent gate: mirrors
            // MAX_ACTIVE_REVERSION's (>= 2 negatives, every short return finite).
            if (view.negatives.length >= 2 && view.bottomMean >= 0) {
                const shortByAsset = new Map<number, number>();
                let shortValid = true;
                for (const c of view.negatives) {
                    const arr = perAsset.get(c.assetIndex);
                    const r = arr ? arr.short[hIdx] : undefined;
                    if (r === undefined || !Number.isFinite(r)) { shortValid = false; break; }
                    shortByAsset.set(c.assetIndex, r);
                }
                if (shortValid) {
                    let shortTotal = 0;
                    for (const r of shortByAsset.values()) shortTotal += r;
                    const selectedReturn = shortByAsset.get(view.bottomMean)!;
                    const randomReturn = (shortTotal - selectedReturn) / (shortByAsset.size - 1);
                    const delta = selectedReturn - randomReturn;
                    bottomMean.returns.push(selectedReturn);
                    bottomMean.deltas.push(delta);
                    bottomMean.times.push(view.timeSec);
                    bottomMean.assets.push(assetNames[view.bottomMean]!);
                    appendEventDetail(
                        "BOTTOM_MEAN",
                        "short",
                        view.negatives.find((candidate) => candidate.assetIndex === view.bottomMean)!,
                        selectedReturn,
                        randomReturn,
                        shortByAsset.size,
                    );
                    const asset = assetNames[view.bottomMean]!;
                    bottomSelectedByAsset.set(asset, (bottomSelectedByAsset.get(asset) ?? 0) + 1);
                    let samples = bottomMeanSamplesByAsset.get(asset);
                    if (!samples) {
                        samples = { returns: [], deltas: [] };
                        bottomMeanSamplesByAsset.set(asset, samples);
                    }
                    samples.returns.push(selectedReturn);
                    samples.deltas.push(delta);
                }
            }
        }

        const n = topRaw.deltas.length;
        eligibleEventsMax = Math.max(eligibleEventsMax, n);
        const buildComparison = (deltasArr: number[], topReturns: number[], times: number[]): ReplayComparison => {
            const sampleCount = deltasArr.length;
            if (sampleCount === 0) {
                return {
                    events: 0, topMean: null, randomMean: null, delta: null, topMedian: null,
                    blockMeans: [], ciLower: null, ciUpper: null, positiveBlocks: 0, totalBlocks: 0,
                };
            }
            const topMean = meanOrNull(topReturns);
            const deltaMean = meanOrNull(deltasArr);
            const randomMean = topMean !== null && deltaMean !== null ? finiteOrNull(topMean - deltaMean) : null;
            const sortedTop = [...topReturns].sort((a, b) => a - b);
            // Chronological blocks by event time.
            const blocks = splitIntoBlocks(deltasArr, times, blockCount);
            const blockMeans = blocks.map((blk) => blk.reduce((s, x) => s + x, 0) / blk.length);
            const { lower, upper } = blockBootstrapCi(blockMeans, bootstrapSamples);
            return {
                events: sampleCount,
                topMean,
                randomMean,
                delta: deltaMean,
                topMedian: finiteOrNull(median(sortedTop)),
                blockMeans,
                ciLower: lower,
                ciUpper: upper,
                positiveBlocks: blockMeans.filter((m) => m > 0).length,
                totalBlocks: blockMeans.length,
            };
        };

        // ---- Phase 5 horizon aggregation: per-asset breakdowns + dominant
        // exclusions for every asset-picking arm. Each arm produces:
        //   * `<ARM> selected assets` — per-asset events/mean/delta table
        //   * `<ARM>_EX_<dominant>` — same series minus the most-selected
        //     asset, to separate concentration-driven edges from broad-based
        // both flow through `buildAssetSelectionBreakdown` +
        // `buildExDominantComparison` so a new arm adds one helper call, not a
        // 30-line copy-paste block. TOP_RAW's maxSelected is read off the
        // breakdown result instead of `Math.max(...spread)`.
        const topRawBreakdown = buildAssetSelectionBreakdown(selectedByAsset, topRawSamplesByAsset);
        const totalSelected = topRawBreakdown.totalSelected;
        const maxSelected = topRawBreakdown.maxSelected;
        const topRawByAsset = topRawBreakdown.byAsset;
        const dominantAsset = topRawByAsset[0]?.asset ?? null;
        const topRawExDominant = buildExDominantComparison(topRaw, dominantAsset, buildComparison);
        // Phase 3 MAX_ACTIVE: dominant-asset exclusion measures MAX_ACTIVE
        // (the research hypothesis), NOT TOP_RAW. The most-frequently-selected
        // MAX_ACTIVE asset (ties by FNV-1a digest) is dropped; the remaining
        // events form the `maxActiveExDominant` comparison.
        const maxActiveByAsset = buildAssetSelectionBreakdown(activeSelectedByAsset, maxActiveSamplesByAsset).byAsset;
        const maxActiveReversionByAsset = buildAssetSelectionBreakdown(
            reversionSelectedByAsset,
            maxActiveReversionSamplesByAsset,
        ).byAsset;
        const maxActiveDominantAsset = maxActiveByAsset[0]?.asset ?? null;
        const maxActiveExDominant = buildExDominantComparison(maxActive, maxActiveDominantAsset, buildComparison);
        // TOP_MEAN dominant-asset exclusion: mirrors maxActiveExDominant for
        // the coverage-adjusted arm. The most-frequently-selected TOP_MEAN
        // asset is dropped; the remaining events form the comparison.
        const topMeanByAsset = buildAssetSelectionBreakdown(topMeanSelectedByAsset, topMeanSamplesByAsset).byAsset;
        const topMeanDominantAsset = topMeanByAsset[0]?.asset ?? null;
        const topMeanExDominant = buildExDominantComparison(topMean, topMeanDominantAsset, buildComparison);
        const topMeanRawUniqueV1ByAsset = buildAssetSelectionBreakdown(
            topMeanRawUniqueV1SelectedByAsset,
            topMeanRawUniqueV1SamplesByAsset,
        ).byAsset;
        const topMeanRawUniqueV1DominantAsset = topMeanRawUniqueV1ByAsset[0]?.asset ?? null;
        const topMeanRawUniqueV1ExDominant = buildExDominantComparison(
            topMeanRawUniqueV1,
            topMeanRawUniqueV1DominantAsset,
            buildComparison,
        );
        const topMeanTrendByAsset = buildAssetSelectionBreakdown(
            topMeanTrendSelectedByAsset,
            topMeanTrendSamplesByAsset,
        ).byAsset;
        const topMeanTrendDominantAsset = topMeanTrendByAsset[0]?.asset ?? null;
        const topMeanTrendExDominant = buildExDominantComparison(
            topMeanTrend,
            topMeanTrendDominantAsset,
            buildComparison,
        );
        const regimeMeanByAsset = buildAssetSelectionBreakdown(
            regimeMeanSelectedByAsset,
            regimeMeanSamplesByAsset,
        ).byAsset;
        const regimeMeanDominantAsset = regimeMeanByAsset[0]?.asset ?? null;
        const regimeMeanExDominant = buildExDominantComparison(
            regimeMean,
            regimeMeanDominantAsset,
            buildComparison,
        );
        // TOP_MEAN top-contribution exclusion: drop events selecting the asset
        // with the largest Σ per-event delta (events × mean delta), NOT the most
        // frequent. A low-frequency / high-per-pick asset (e.g. SNDK in the
        // 2020-01 sample) is invisible to topMeanExDominant but can be the
        // single largest driver of the horizon's edge. Tie-break: asset name
        // (deterministic aggregate ordering; per-event tie-break digests do not
        // apply to a horizon-level total).
        let topMeanTopContribAsset: string | null = null;
        let topMeanTopContribTotal = -Infinity;
        for (const [asset, samples] of topMeanSamplesByAsset.entries()) {
            let sum = 0;
            for (const d of samples.deltas) sum += d;
            if (sum > topMeanTopContribTotal || (sum === topMeanTopContribTotal && asset < (topMeanTopContribAsset ?? "~"))) {
                topMeanTopContribTotal = sum;
                topMeanTopContribAsset = asset;
            }
        }
        const topMeanExTopContrib = buildExDominantComparison(topMean, topMeanTopContribAsset, buildComparison);
        // Reversion dominant-asset exclusion: mirrors maxActiveExDominant for
        // the short side. The most-frequently-selected MAX_ACTIVE_REVERSION
        // asset (ties already resolved by FNV-1a digest in pickMax) is dropped;
        // the remaining events form the comparison. Reads the same
        // maxActiveReversion series the long side reads for maxActive.
        const maxActiveReversionDominantAsset = maxActiveReversionByAsset[0]?.asset ?? null;
        const maxActiveReversionExDominant = buildExDominantComparison(
            maxActiveReversion,
            maxActiveReversionDominantAsset,
            buildComparison,
        );
        // BOTTOM_MEAN byAsset + dominant-asset exclusion: mirror the
        // maxActiveReversion block for the lowest-mean selector. Same short
        // side, same eligibility, same per-asset breakdown shape — the only
        // difference is the selection rule (lowest mean vs most open pairs).
        const bottomMeanByAsset = buildAssetSelectionBreakdown(bottomSelectedByAsset, bottomMeanSamplesByAsset).byAsset;
        const bottomMeanDominantAsset = bottomMeanByAsset[0]?.asset ?? null;
        const bottomMeanExDominant = buildExDominantComparison(bottomMean, bottomMeanDominantAsset, buildComparison);
        // `maxRetained` is a documented backwards-compat alias for `maxStatic`
        // (identical selector on identical arrays). Compute the 10k-sample block
        // bootstrap ONCE and reuse the result for both fields — the prior
        // duplicate `buildComparison(maxStatic.deltas, ...)` burned 10k LCG
        // iterations + one sort + one 10k-element allocation per horizon.
        const maxStaticComparison = buildComparison(maxStatic.deltas, maxStatic.returns, maxStatic.times);
        const topMeanPnl = computeSelectorPnl(topMean.returns, topMean.times);
        const randomPnlReturns: number[] = [];
        for (let i = 0; i < topMean.returns.length; i += 1) {
            const selected = topMean.returns[i]!;
            const delta = topMean.deltas[i]!;
            randomPnlReturns.push(selected - delta);
        }
        const randomPnl = computeSelectorPnl(randomPnlReturns, topMean.times);
        const topMeanHedgePnl = computeSelectorPnl(topMeanHedge.returns, topMeanHedge.times);
        const topMeanPortfolio = simulateTopMeanPortfolio(topMeanPortfolioOpportunities);
        const topMeanTrendPnl = computeSelectorPnl(topMeanTrend.returns, topMeanTrend.times);
        const topMeanTrendPortfolio = simulateTopMeanPortfolio(topMeanTrendPortfolioOpportunities);
        const regimeMeanPnl = computeSelectorPnl(regimeMean.returns, regimeMean.times);
        const regimeMeanPortfolio = simulateTopMeanPortfolio(regimeMeanPortfolioOpportunities);
        const acceleratingComparison = buildComparison(accelerating.deltas, accelerating.returns, accelerating.times);
        const acceleratingPnl = computeSelectorPnl(accelerating.returns, accelerating.times);
        const acceleratingRandomPnl = computeSelectorPnl(acceleratingRandom.returns, acceleratingRandom.times);
        horizonResults.push({
            bars: horizons[hIdx]!,
            topRaw: buildComparison(topRaw.deltas, topRaw.returns, topRaw.times),
            topAdjusted: buildComparison(topAdjusted.deltas, topAdjusted.returns, topAdjusted.times),
            topMean: buildComparison(topMean.deltas, topMean.returns, topMean.times),
            topMeanRawUniqueV1: buildComparison(topMeanRawUniqueV1.deltas, topMeanRawUniqueV1.returns, topMeanRawUniqueV1.times),
            topMeanRawUniqueV1ByAsset,
            topMeanRawUniqueV1ExDominant,
            topMeanRawUniqueV1DominantAsset,
            topRaw6Bar: buildComparison(topRaw6Bar.deltas, topRaw6Bar.returns, topRaw6Bar.times),
            topMean6Bar: buildComparison(topMean6Bar.deltas, topMean6Bar.returns, topMean6Bar.times),
            topMeanTrend: buildComparison(topMeanTrend.deltas, topMeanTrend.returns, topMeanTrend.times),
            topMeanTrendByAsset,
            topMeanTrendExDominant,
            topMeanTrendDominantAsset,
            regimeMean: buildComparison(regimeMean.deltas, regimeMean.returns, regimeMean.times),
            regimeMeanByAsset,
            regimeMeanExDominant,
            regimeMeanDominantAsset,
            topMeanVsRaw: buildComparison(topMeanVsRaw.deltas, topMeanVsRaw.returns, topMeanVsRaw.times),
            topMeanVsRank2: buildComparison(topMeanVsRank2.deltas, topMeanVsRank2.returns, topMeanVsRank2.times),
            maxActiveReversion: buildComparison(maxActiveReversion.deltas, maxActiveReversion.returns, maxActiveReversion.times),
            maxActiveReversionByAsset,
            maxActiveReversionExDominant,
            maxActiveReversionDominantAsset,
            maxActive: buildComparison(maxActive.deltas, maxActive.returns, maxActive.times),
            maxStatic: maxStaticComparison,
            maxSubmitted: buildComparison(maxSubmitted.deltas, maxSubmitted.returns, maxSubmitted.times),
            maxRetained: maxStaticComparison,
            topRawExDominant,
            topMeanExDominant,
            topMeanDominantAsset,
            topMeanExTopContrib,
            topMeanTopContribAsset,
            bottomMean: buildComparison(bottomMean.deltas, bottomMean.returns, bottomMean.times),
            bottomMeanByAsset,
            bottomMeanExDominant,
            bottomMeanDominantAsset,
            maxActiveExDominant,
            maxActiveDominantAsset,
            maxActiveByAsset,
            dominantAsset,
            rawAdjustedAgreement: {
                events: n,
                sameSelection: rawAdjustedSame,
                rate: n > 0 ? rawAdjustedSame / n : null,
            },
            activeVsSubmitted: buildComparison(activeVsSubmitted.deltas, activeVsSubmitted.returns, activeVsSubmitted.times),
            activeVsRetained: buildComparison(activeVsRetained.deltas, activeVsRetained.returns, activeVsRetained.times),
            activeVsRaw: buildComparison(activeVsRaw.deltas, activeVsRaw.returns, activeVsRaw.times),
            activeVsMean: buildComparison(activeVsMean.deltas, activeVsMean.returns, activeVsMean.times),
            topRawByAsset,
            topMeanByAsset,
            pnl: {
                topMean: topMeanPnl,
                random: randomPnl,
                topMeanHedge: topMeanHedgePnl,
                topMeanPortfolio,
                topMeanTrend: topMeanTrendPnl,
                topMeanTrendPortfolio,
                regimeMean: regimeMeanPnl,
                regimeMeanPortfolio,
                accelerating: acceleratingPnl,
                acceleratingRandom: acceleratingRandomPnl,
            },
            accelerating: acceleratingComparison,
            // Conditional-split comparisons: TOP_RAW's pick on each subset of
            // events defined by the per-view feature split.
            topRawFresh: buildComparison(topRawFresh.deltas, topRawFresh.returns, topRawFresh.times),
            topRawStale: buildComparison(topRawStale.deltas, topRawStale.returns, topRawStale.times),
            topRawStaleShort: buildComparison(topRawStaleShort.deltas, topRawStaleShort.returns, topRawStaleShort.times),
            topRawStaleLong: buildComparison(topRawStaleLong.deltas, topRawStaleLong.returns, topRawStaleLong.times),
            topRawDominant: buildComparison(topRawDominant.deltas, topRawDominant.returns, topRawDominant.times),
            topRawSpread: buildComparison(topRawSpread.deltas, topRawSpread.returns, topRawSpread.times),
            topRawHiPairs: buildComparison(topRawHiPairs.deltas, topRawHiPairs.returns, topRawHiPairs.times),
            topRawLoPairs: buildComparison(topRawLoPairs.deltas, topRawLoPairs.returns, topRawLoPairs.times),
            candidateDegree: degreeSummary(activeCountsAtEvents, totalSelected > 0 ? maxSelected / totalSelected : null),
            selectedDegree: degreeSummary(selectedDegree, totalSelected > 0 ? maxSelected / totalSelected : null),
            tieRates: {
                RAW: { events: n, sameSelection: tieCounts.RAW, rate: n > 0 ? tieCounts.RAW / n : null },
                ADJUSTED: { events: n, sameSelection: tieCounts.ADJUSTED, rate: n > 0 ? tieCounts.ADJUSTED / n : null },
                MEAN: { events: n, sameSelection: tieCounts.MEAN, rate: n > 0 ? tieCounts.MEAN / n : null },
                ACTIVE: { events: n, sameSelection: tieCounts.ACTIVE, rate: n > 0 ? tieCounts.ACTIVE / n : null },
                SUBMITTED: { events: n, sameSelection: tieCounts.SUBMITTED, rate: n > 0 ? tieCounts.SUBMITTED / n : null },
                RETAINED: { events: n, sameSelection: tieCounts.RETAINED, rate: n > 0 ? tieCounts.RETAINED / n : null },
                // Reversion's denominator is the reversion-eligible event count
                // (events with >= 2 negative candidates), NOT the positive-side n.
                REVERSION: {
                    events: maxActiveReversion.deltas.length,
                    sameSelection: tieCounts.REVERSION,
                    rate: maxActiveReversion.deltas.length > 0 ? tieCounts.REVERSION / maxActiveReversion.deltas.length : null,
                },
                // BOTTOM_MEAN shares MAX_ACTIVE_REVERSION's eligibility basis.
                BOTTOM: {
                    events: bottomMean.deltas.length,
                    sameSelection: tieCounts.BOTTOM,
                    rate: bottomMean.deltas.length > 0 ? tieCounts.BOTTOM / bottomMean.deltas.length : null,
                },
            },
        });
        onPhase("aggregate", `aggregated horizon ${horizons[hIdx]}`, hIdx + 1, horizons.length);
        await yieldLoop();
    }
    eventDetails.sort((a, b) =>
        a.decisionTime - b.decisionTime
        || a.horizonBars - b.horizonBars
        || a.selector.localeCompare(b.selector));
    ongoingEventDetails.sort((a, b) =>
        a.decisionTime - b.decisionTime
        || a.horizonBars - b.horizonBars
        || a.asset.localeCompare(b.asset));

    // Count omitted assets (requested but with no usable dataset at all).
    const assetsWithData = new Set<number>();
    for (const m of returnsByView.values()) {
        if (m) for (const k of m.keys()) {
            if (positiveRequestedAssets.has(k)) assetsWithData.add(k);
        }
    }
    for (const aIdx of positiveRequestedAssets) {
        if (!assetsWithData.has(aIdx)) missingAssets.add(aIdx);
    }
    const omittedAssets = missingAssets.size;
    if (omittedAssets > 0) {
        warnings.push(`${omittedAssets} candidate asset(s) had no usable target dataset; their events were omitted, not zero-filled: ${[...missingAssets].map((i) => assetNames[i]).join(", ")}.`);
    }
    if (noDataEvents.size > 0) {
        // noDataEvents were tracked but never surfaced — add the warning so a
        // missing target on one asset is visible as an omitted event count
        // rather than silently disappearing from the eligible total.
        warnings.push(`${noDataEvents.size} event(s) had no target bar strictly after the decision timestamp for at least one candidate; those events were omitted, not zero-filled.`);
    }
    if (censoredEvents.size > 0) {
        warnings.push(`${censoredEvents.size} event(s) were right-censored near a target dataset end for at least one horizon and excluded from that horizon.`);
    }
    // Reversion selector structural-empty check: if the negative pool never
    // produced >= 2 candidates at any event (e.g., a long-only pair universe),
    // every horizon's MAX_ACTIVE_REVERSION line shows events=0 with no
    // explanation. Surface a single warning so the empty reversion line is
    // interpretable instead of looking like a bug.
    if (totalEvents > 0 && horizonResults.length > 0) {
        const anyReversionEvents = horizonResults.some((h) => h.maxActiveReversion.events > 0);
        if (!anyReversionEvents) {
            warnings.push("Reversion selector contributed 0 events across all horizons; the pair universe did not produce enough negative-score assets at any decision event.");
        }
    }
    // ACCELERATING structural-empty check: if no event ever produced >= 2
    // positive-score candidates with fresh positive entry flow, every horizon's
    // ACCELERATING line shows events=0. Surface a single warning so the empty
    // line is interpretable (it means no fresh-flow co-occurrence, not a bug).
    if (totalEvents > 0 && horizonResults.length > 0) {
        const anyAcceleratingEvents = horizonResults.some((h) => h.accelerating.events > 0);
        if (!anyAcceleratingEvents) {
            warnings.push("Accelerating selector contributed 0 events across all horizons; no decision event had >= 2 positive-score assets with fresh positive entry flow.");
        }
    }
    if (totalEvents > 0 && horizonResults.length > 0) {
        const anyTrendEvents = horizonResults.some((h) => h.topMeanTrend.events > 0);
        if (!anyTrendEvents) {
            warnings.push("TOP_MEAN_TREND contributed 0 events across all horizons; no decision event had at least two positive-score assets above their causal target EMA200.");
        }
        const anyRegimeEvents = horizonResults.some((h) => h.regimeMean.events > 0);
        if (!anyRegimeEvents) {
            warnings.push("REGIME_MEAN contributed 0 events across all horizons; neither market-breadth direction produced at least two EMA200-qualified candidates.");
        }
    }
    if (recentScoreWindowSeconds === null) {
        warnings.push("TOP_RAW_6BAR and TOP_MEAN_6BAR require a valid run interval; their report arms are empty when interval is omitted or invalid.");
    }
    warnings.push("Stock/marked-leg datasets may carry split/corporate-action discontinuities; verify adjustment before treating this as a tradeable verdict.");
    warnings.push("P&L experiments use equal 1-unit event notional; overlapping entries are summed without compounding and are not live account returns.");
    warnings.push("TOP_MEAN_1K_PORTFOLIO uses fixed $1,000 entries, skips TOP_MEAN ties and same-asset overlap, and reports realized-only drawdown; no global bankroll cap or mark-to-market equity is assumed.");
    warnings.push("TOP_MEAN_TREND and REGIME_MEAN use only target closes known before entry; the entry bar and all later prices are excluded from EMA200 qualification and breadth.");

    const complete = omittedPairs === 0 && omittedAssets === 0;
    const staticDegrees = assetNames.map((n) => staticDegree.get(n) ?? 0);
    const degree = degreeSummary(staticDegrees, null);

    const reportLines = buildReportLines({
        pairs: pairCount, assets: assetCount, complete, omittedPairs, omittedAssets,
        totalEvents, candidateEvents: views.length, eligibleEvents: eligibleEventsMax, horizons: horizonResults,
        degree, warnings, startedAt, horizonsList: horizons,
        interval: options.interval ?? null,
        sampleFromSec: options.sampleFromSec ?? null,
        sampleToSec: options.sampleToSec ?? null,
        slippageRate, commissionRate,
    });

    return {
        pairs: pairCount,
        assets: assetCount,
        complete,
        omittedPairs,
        omittedAssets,
        totalEvents,
        candidateEvents: views.length,
        eligibleEvents: eligibleEventsMax,
        horizons: horizonResults,
        latestSelections,
        ...(options.includeEventDetails ? { eventDetails } : {}),
        ...(options.includeEventDetails ? { ongoingEventDetails } : {}),
        ...(includePoolSnapshots ? { poolSnapshots: poolSnapshots ?? [] } : {}),
        ...(includeCandidateOutcomes ? { candidateOutcomes: candidateOutcomes ?? [] } : {}),
        degree,
        warnings,
        reportLines,
    };
}

// ============================================================================
// Internals
// ============================================================================

function yieldLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Comparator for ScoreDelta: (time, assetIndex, isEntry DESC). Entries before
 * exits at the same (time, asset) so the post-execution score reflects the new
 * position before any same-timestamp exit netting.
 */
function compareDeltas(a: ScoreDelta, b: ScoreDelta): number {
    return a.timeSec - b.timeSec
        || a.assetIndex - b.assetIndex
        || b.isEntry - a.isEntry;
}

/**
 * Binary min-heap k-way merge over per-pair delta streams. Bounded by
 * #streams (one heap slot per stream head), not #deltas — so a 1000+ pair run
 * with hundreds of thousands of deltas still has a small working set.
 *
 * Ties at the head of multiple streams are broken by stream index so the merge
 * order is deterministic run-to-run regardless of artifact arrival order.
 */
class KWayMergeHeap {
    private readonly streams: readonly ScoreDelta[][];
    /** Heap of stream indexes, keyed by the head delta's compareDeltas rank. */
    private readonly heap: number[] = [];
    /** Current read offset in each stream. */
    private readonly offsets: Int32Array;
    constructor(streams: readonly ScoreDelta[][]) {
        this.streams = streams;
        this.offsets = new Int32Array(streams.length);
        for (let s = 0; s < streams.length; s += 1) {
            if (streams[s]!.length > 0) this.heap.push(s);
        }
        // Heapify bottom-up.
        for (let i = (this.heap.length >> 1) - 1; i >= 0; i -= 1) this.siftDown(i);
    }
    get empty(): boolean { return this.heap.length === 0; }
    peekTime(): number {
        const s = this.heap[0]!;
        return this.streams[s]![this.offsets[s]!]!.timeSec;
    }
    pop(): ScoreDelta | undefined {
        if (this.heap.length === 0) return undefined;
        const s = this.heap[0]!;
        const off = this.offsets[s]!;
        const d = this.streams[s]![off]!;
        const next = off + 1;
        this.offsets[s] = next;
        if (next >= this.streams[s]!.length) {
            // Stream exhausted: swap head with tail and shrink.
            const last = this.heap.length - 1;
            this.heap[0] = this.heap[last]!;
            this.heap.pop();
            if (this.heap.length > 0) this.siftDown(0);
        } else {
            this.siftDown(0);
        }
        return d;
    }
    private less(a: number, b: number): boolean {
        const sa = this.streams[a]![this.offsets[a]!]!;
        const sb = this.streams[b]![this.offsets[b]!]!;
        const cmp = compareDeltas(sa, sb);
        // Stable tie-break on stream index -> deterministic regardless of
        // artifact arrival order.
        return cmp < 0 || (cmp === 0 && a < b);
    }
    private siftDown(root: number): void {
        const n = this.heap.length;
        while (true) {
            let smallest = root;
            const l = (root << 1) + 1;
            const r = (root << 1) + 2;
            if (l < n && this.less(this.heap[l]!, this.heap[smallest]!)) smallest = l;
            if (r < n && this.less(this.heap[r]!, this.heap[smallest]!)) smallest = r;
            if (smallest === root) return;
            const tmp = this.heap[root]!;
            this.heap[root] = this.heap[smallest]!;
            this.heap[smallest] = tmp;
            root = smallest;
        }
    }
}

/** Binary search: index of the first bar with time strictly greater than t, or -1. */
function firstBarAfter(times: readonly (number | null)[], t: number): number {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = times[mid];
        if (v === null) { lo = mid + 1; continue; }
        if (v > t) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
}

/**
 * Split values into chronological blocks by their event times. Phase 0 freeze:
 * boundaries are `floor(block*n/k)..floor((block+1)*n/k)` for `k=blockCount`
 * (NOT `ceil(n/k)`), so each block is count-balanced and the partition covers
 * every index exactly once. Empty blocks are omitted; if any are omitted, the
 * block-bootstrap CI returns null (formal `INSUFFICIENT_DATA`).
 */
function splitIntoBlocks(values: readonly number[], times: readonly number[], blockCount: number): number[][] {
    const n = values.length;
    if (n === 0) return [];
    const order = times.map((_, i) => i).sort((a, b) => times[a]! - times[b]!);
    const k = Math.max(1, Math.min(blockCount, n));
    const blocks: number[][] = [];
    for (let b = 0; b < k; b += 1) {
        const start = Math.floor((b * n) / k);
        const end = Math.floor(((b + 1) * n) / k);
        if (end <= start) continue;
        const slice: number[] = [];
        for (let i = start; i < end; i += 1) slice.push(values[order[i]!]!);
        if (slice.length > 0) blocks.push(slice);
    }
    return blocks;
}

const fmtPct = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const fmtNum = (x: number | null): string => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
const fmtUsd = (x: number | null): string => (x === null || !Number.isFinite(x)
    ? "n/a"
    : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);

function buildReportLines(args: {
    pairs: number; assets: number; complete: boolean; omittedPairs: number; omittedAssets: number;
    totalEvents: number; candidateEvents: number; eligibleEvents: number; horizons: OpenScoreUsdReplayResult["horizons"];
    degree: DegreeSummary; warnings: string[]; startedAt: number; horizonsList: number[];
    interval: string | null; sampleFromSec: number | null; sampleToSec: number | null;
    slippageRate: number; commissionRate: number;
}): string[] {
    const lines: string[] = [];
    const status = args.complete ? "DATA_COMPLETE" : "DATA_INCOMPLETE";
    const comparisonLine = (label: string, comparison: ReplayComparison): string =>
        `${label.padEnd(14)} n=${comparison.events} top=${fmtPct(comparison.topMean)} rand=${fmtPct(comparison.randomMean)} ` +
        `delta=${fmtPct(comparison.delta)} CI95=[${fmtPct(comparison.ciLower)},${fmtPct(comparison.ciUpper)}] ` +
        `+blocks=${comparison.positiveBlocks}/${comparison.totalBlocks}`;
    const pnlLine = (label: string, summary: SelectorPnlSummary): string => {
        const average = summary.trades > 0 && summary.totalReturn !== null
            ? summary.totalReturn / summary.trades
            : null;
        return `${label.padEnd(20)} trades=${summary.trades} avg/trade=${fmtPct(average)} ` +
            `sharpe=${fmtNum(summary.sharpe)} winRate=${summary.winRate === null ? "n/a" : (summary.winRate * 100).toFixed(1) + "%"}`;
    };
    const portfolioLine = (label: string, summary: TopMeanPortfolioSummary): string =>
        `${label}_1K_PORTFOLIO trades=${summary.trades}/${summary.eligibleSignals} ` +
        `pnl=${fmtUsd(summary.netPnl)} avg=${fmtUsd(summary.averagePnl)} ` +
        `winRate=${summary.winRate === null ? "n/a" : (summary.winRate * 100).toFixed(1) + "%"} ` +
        `realizedMaxDD=${fmtUsd(summary.maxRealizedDrawdown)} peakPos=${summary.peakConcurrentPositions} ` +
        `peakCapital=${fmtUsd(summary.peakCapital)} return/peak=${fmtPct(summary.returnOnPeakCapital)} ` +
        `skippedTie=${summary.skippedTies} skippedActive=${summary.skippedActiveAsset}`;
    lines.push(`OPEN_SCORE USD | ${status} | pairs=${args.pairs} assets=${args.assets} events=${args.totalEvents} comparable=${args.candidateEvents} eligible=${args.eligibleEvents}`);
    lines.push(`config | interval=${args.interval ?? "n/a"} window=${args.sampleFromSec === null ? "start" : new Date(args.sampleFromSec * 1000).toISOString().slice(0, 10)}..${args.sampleToSec === null ? "end" : new Date(args.sampleToSec * 1000).toISOString().slice(0, 10)} horizons=[${args.horizonsList.join(",")}] slippageRate=${args.slippageRate} commissionRate=${args.commissionRate}`);
    lines.push(`retained pair degree min/median/max = ${args.degree.min}/${fmtNum(args.degree.median)}/${args.degree.max}`);
    lines.push("controls | TOP_MEAN=raw/activePairs TOP_RAW_6BAR=signed score changes in current+prior 5 bars TOP_MEAN_6BAR=TOP_RAW_6BAR/activePairs TOP_MEAN_TREND=target EMA200 breadth>50%, then prior close>EMA200, TOP_MEAN, activePairs tie-break REGIME_MEAN=TOP_MEAN_TREND long above 50% breadth, BOTTOM_MEAN short below MAX_ACTIVE=most open pairs MAX_ACTIVE_REVERSION=most open pairs among negative-score assets, shorted vs USD MAX_SUBMITTED=most submitted pairs MAX_RETAINED=most loaded artifacts");
    lines.push("TOP_MEAN_RAW_UNIQUE_V1 rule | TOP_MEAN tied set -> unique raw-score maximum; residual raw ties skipped; control=mean return of the TOP_MEAN tied set");
    lines.push("pnl model | OVERLAP=long selector vs same-pool random positive, every eligible event; HEDGE=long TOP_MEAN rank1 + short rank2; *_1K=$1000/trade, exact selector ties skipped, one open trade per asset; ACCELERATING=positive entry flow per active pair, exit-only changes excluded");
    for (const h of args.horizons) {
        const coverageRate = args.candidateEvents > 0 ? h.topRaw.events / args.candidateEvents : 0;
        const coverageStatus = h.topRaw.events === 0
            ? "NO_USABLE_EVENTS"
            : h.topRaw.events < args.candidateEvents
                ? "PARTIAL"
                : "FULL";
        lines.push(`--- horizon ${h.bars} bar(s) | coverage=${h.topRaw.events}/${args.candidateEvents} (${(coverageRate * 100).toFixed(1)}%) ${coverageStatus} ---`);
        lines.push(comparisonLine("TOP_RAW", h.topRaw));
        lines.push(comparisonLine("TOP_ADJUSTED", h.topAdjusted));
        lines.push(comparisonLine("TOP_MEAN", h.topMean));
        lines.push(comparisonLine("TOP_MEAN_RAW_UNIQUE_V1", h.topMeanRawUniqueV1));
        lines.push(comparisonLine(`TOP_MEAN_RAW_UNIQUE_V1_EX_${h.topMeanRawUniqueV1DominantAsset ?? "NONE"}`, h.topMeanRawUniqueV1ExDominant));
        lines.push(comparisonLine("TOP_RAW_6BAR", h.topRaw6Bar));
        lines.push(comparisonLine("TOP_MEAN_6BAR", h.topMean6Bar));
        lines.push(comparisonLine("TOP_MEAN_TREND", h.topMeanTrend));
        lines.push(pnlLine("TOP_MEAN_TREND_PNL", h.pnl.topMeanTrend));
        lines.push(portfolioLine("TOP_MEAN_TREND", h.pnl.topMeanTrendPortfolio));
        lines.push(comparisonLine(`TREND_EX_${h.topMeanTrendDominantAsset ?? "NONE"}`, h.topMeanTrendExDominant));
        lines.push(comparisonLine("REGIME_MEAN", h.regimeMean));
        lines.push(pnlLine("REGIME_MEAN_PNL", h.pnl.regimeMean));
        lines.push(portfolioLine("REGIME_MEAN", h.pnl.regimeMeanPortfolio));
        lines.push(comparisonLine(`REGIME_EX_${h.regimeMeanDominantAsset ?? "NONE"}`, h.regimeMeanExDominant));
        lines.push(comparisonLine("TOP_MEAN_VS_RAW", h.topMeanVsRaw));
        lines.push(`TOP_MEAN_VS_RAW_WF deltaByBlock=[${h.topMeanVsRaw.blockMeans.map(fmtPct).join(",")}]`);
        lines.push(comparisonLine("TOP_MEAN_VS_RANK2", h.topMeanVsRank2));
        lines.push(pnlLine("TOP_MEAN_PNL", h.pnl.topMean));
        lines.push(pnlLine("RANDOM_PNL", h.pnl.random));
        lines.push(pnlLine("TOP_MEAN_HEDGE_PNL", h.pnl.topMeanHedge));
        lines.push(portfolioLine("TOP_MEAN", h.pnl.topMeanPortfolio));
        // ACCELERATING arm: comparison + overlapping PNL + matching random
        // control. All three are unconditional so they ride both Copy paths.
        lines.push(comparisonLine("ACCELERATING", h.accelerating));
        lines.push(pnlLine("ACCELERATING_PNL", h.pnl.accelerating));
        lines.push(pnlLine("ACCELERATING_RANDOM_PNL", h.pnl.acceleratingRandom));
        lines.push(comparisonLine("MAX_ACTIVE", h.maxActive));
        lines.push(comparisonLine("MAX_ACTIVE_REVERSION", h.maxActiveReversion));
        lines.push(comparisonLine(`REVERSION_EX_${h.maxActiveReversionDominantAsset ?? "NONE"}`, h.maxActiveReversionExDominant));
        lines.push(comparisonLine("BOTTOM_MEAN", h.bottomMean));
        lines.push(comparisonLine(`BOTTOM_EX_${h.bottomMeanDominantAsset ?? "NONE"}`, h.bottomMeanExDominant));
        lines.push(comparisonLine("MAX_SUBMITTED", h.maxSubmitted));
        if (h.maxRetained.events !== h.maxSubmitted.events || h.maxRetained.delta !== h.maxSubmitted.delta) {
            lines.push(comparisonLine("MAX_RETAINED", h.maxRetained));
        }
        // Conditional-split arms (event filters on TOP_RAW's pick).
        // Each split is TOP_RAW's pick restricted to a per-event-feature subset.
        lines.push(comparisonLine("RAW_FRESH", h.topRawFresh));
        lines.push(comparisonLine("RAW_STALE", h.topRawStale));
        lines.push(comparisonLine("RAW_STALE_SHORT", h.topRawStaleShort));
        lines.push(comparisonLine("RAW_STALE_LONG", h.topRawStaleLong));
        lines.push(comparisonLine("RAW_DOMINANT", h.topRawDominant));
        lines.push(comparisonLine("RAW_SPREAD", h.topRawSpread));
        lines.push(comparisonLine("RAW_HI_PAIRS", h.topRawHiPairs));
        lines.push(comparisonLine("RAW_LO_PAIRS", h.topRawLoPairs));
        lines.push(comparisonLine(`RAW_EX_${h.dominantAsset ?? "NONE"}`, h.topRawExDominant));
        lines.push(comparisonLine(`MEAN_EX_${h.topMeanDominantAsset ?? "NONE"}`, h.topMeanExDominant));
        lines.push(comparisonLine(`MEAN_EX_TOPCONTRIB_${h.topMeanTopContribAsset ?? "NONE"}`, h.topMeanExTopContrib));
        lines.push(comparisonLine(`ACTIVE_EX_${h.maxActiveDominantAsset ?? "NONE"}`, h.maxActiveExDominant));
        // Phase 3 MAX_ACTIVE: pairwise same-event deltas (only differing-selection events).
        lines.push(comparisonLine("ACTIVE_VS_SUB", h.activeVsSubmitted));
        if (h.activeVsRetained.events !== h.activeVsSubmitted.events || h.activeVsRetained.delta !== h.activeVsSubmitted.delta) {
            lines.push(comparisonLine("ACTIVE_VS_RET", h.activeVsRetained));
        }
        lines.push(comparisonLine("ACTIVE_VS_RAW", h.activeVsRaw));
        lines.push(comparisonLine("ACTIVE_VS_MEAN", h.activeVsMean));
        lines.push(`RAW/ADJUSTED agreement = ${h.rawAdjustedAgreement.sameSelection}/${h.rawAdjustedAgreement.events} (${h.rawAdjustedAgreement.rate === null ? "n/a" : (h.rawAdjustedAgreement.rate * 100).toFixed(1) + "%"})`);
        // Phase 3 MAX_ACTIVE: per-selector tie rate.
        const tieLine = (name: string, k: keyof typeof h.tieRates): string =>
            `${name}=${h.tieRates[k].sameSelection}/${h.tieRates[k].events} (${h.tieRates[k].rate === null ? "n/a" : (h.tieRates[k].rate! * 100).toFixed(1) + "%"})`;
        const tieTokens = [
            tieLine("RAW", "RAW"),
            tieLine("ADJ", "ADJUSTED"),
            tieLine("MEAN", "MEAN"),
            tieLine("ACTIVE", "ACTIVE"),
            tieLine("SUB", "SUBMITTED"),
        ];
        if (h.tieRates.RETAINED.sameSelection !== h.tieRates.SUBMITTED.sameSelection || h.tieRates.RETAINED.events !== h.tieRates.SUBMITTED.events) {
            tieTokens.push(tieLine("RET", "RETAINED"));
        }
        tieTokens.push(tieLine("REV", "REVERSION"));
        tieTokens.push(tieLine("BOT", "BOTTOM"));
        lines.push(`tie rates | ${tieTokens.join(" ")}`);
        const assetBreakdown = h.topRawByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW selected assets = ${assetBreakdown || "n/a"}${h.topRawByAsset.length > 5 ? ` | other=${h.topRawByAsset.length - 5} assets` : ""}`);
        const topMeanBreakdown = h.topMeanByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN selected assets = ${topMeanBreakdown || "n/a"}${h.topMeanByAsset.length > 5 ? ` | other=${h.topMeanByAsset.length - 5} assets` : ""}`);
        const topMeanRawUniqueV1Breakdown = h.topMeanRawUniqueV1ByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_RAW_UNIQUE_V1 selected assets = ${topMeanRawUniqueV1Breakdown || "n/a"}${h.topMeanRawUniqueV1ByAsset.length > 5 ? ` | other=${h.topMeanRawUniqueV1ByAsset.length - 5} assets` : ""}`);
        const topMeanTrendBreakdown = h.topMeanTrendByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_TREND selected assets = ${topMeanTrendBreakdown || "n/a"}${h.topMeanTrendByAsset.length > 5 ? ` | other=${h.topMeanTrendByAsset.length - 5} assets` : ""}`);
        const regimeMeanBreakdown = h.regimeMeanByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`REGIME_MEAN selected assets = ${regimeMeanBreakdown || "n/a"}${h.regimeMeanByAsset.length > 5 ? ` | other=${h.regimeMeanByAsset.length - 5} assets` : ""}`);
        const maxActiveBreakdown = h.maxActiveByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`MAX_ACTIVE selected assets = ${maxActiveBreakdown || "n/a"}${h.maxActiveByAsset.length > 5 ? ` | other=${h.maxActiveByAsset.length - 5} assets` : ""}`);
        const maxActiveReversionBreakdown = h.maxActiveReversionByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`MAX_ACTIVE_REVERSION selected assets (short USD) = ${maxActiveReversionBreakdown || "n/a"}${h.maxActiveReversionByAsset.length > 5 ? ` | other=${h.maxActiveReversionByAsset.length - 5} assets` : ""}`);
        const bottomMeanBreakdown = h.bottomMeanByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`BOTTOM_MEAN selected assets (short USD) = ${bottomMeanBreakdown || "n/a"}${h.bottomMeanByAsset.length > 5 ? ` | other=${h.bottomMeanByAsset.length - 5} assets` : ""}`);
        lines.push(`active pair count at events min/median/max = ${h.candidateDegree.min}/${fmtNum(h.candidateDegree.median)}/${h.candidateDegree.max} topAssetShare=${h.candidateDegree.topAssetShare === null ? "n/a" : (h.candidateDegree.topAssetShare * 100).toFixed(1) + "%"}`);
        lines.push(`selected TOP_RAW retained degree min/median/max = ${h.selectedDegree.min}/${fmtNum(h.selectedDegree.median)}/${h.selectedDegree.max}`);
    }
    for (const w of args.warnings) lines.push(`WARN: ${w}`);
    lines.push(`elapsed=${((Date.now() - args.startedAt) / 1000).toFixed(1)}s`);
    return lines;
}
