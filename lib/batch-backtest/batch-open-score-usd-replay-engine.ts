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
 * additionally shows an explicitly non-compounding overlapping event basket.
 * It does not reproduce a live portfolio's capital allocation, adaptive
 * exits, or execution queue.
 *
 * Score semantics (must match computeOpenTradeAssetScores in batch-row-scalars):
 *   long pair  -> base +1, quote -1 at entry; inverse deltas at exit
 *   short pair -> base -1, quote +1 at entry; inverse deltas at exit
 * rawScore[a]        = signed active-pair vote total
 * activePairCount[a] = active positive + active negative votes
 * adjustedScore[a]   = rawScore / sqrt(activePairCount)  (coverage-adjusted,
 *                      NOT a statistically calibrated z-score)
 *
 * Profit-gated variants (TOP_RAW_PROFIT / TOP_MEAN_PROFIT): the same raw/mean
 * ranking computed from deltas of pairs whose pair backtest netProfit was
 * strictly positive. A pair's full-window P&L is only known after the fact,
 * so this is a research-only look-ahead filter, not a live-selectable signal.
 *
 * Causal variants (TOP_RAW_PROFIT_NOW / TOP_MEAN_PROFIT_NOW): the same filter
 * evaluated point-in-time — a pair's votes count at an event only when its
 * P&L REALIZED AT OR BEFORE that event (summed over trades closed at or
 * is strictly positive. Uses the per-trade pnl carried on compact artifacts
 * from its introduction onward; pairs without per-trade pnl are never
 * profitable-now.
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
import { findCandleGapOverlapping, type CandleGap } from "../ibkr-data/candle-gap";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import {
    tieBreakDigest,
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
} from "./max-active-research-contract";
import type { ActiveCapTiltWeight, CapTiltWeight } from "./cap-tilt-contract";

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
    | "TOP_RAW_PROFIT_NOW_CONF";

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
    | "TOP_RAW_PROFIT_W_RAT"
    | "TOP_MEAN_PROFIT_W_RAT"
    | "TOP_RAW_PROFIT_W_LIN"
    | "TOP_MEAN_PROFIT_W_LIN"
    | "TOP_RAW_PROFIT_W_TAN"
    | "TOP_MEAN_PROFIT_W_TAN"
    | "TOP_RAW_PROFIT_W_LOG"
    | "TOP_MEAN_PROFIT_W_LOG";

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
         * Conditional-split arms: TOP_RAW's pick routed into one of two
         * sub-series based on a per-event feature computed in Phase 3. Each
         * split uses the same selection and `randomMeanOf` baseline as TOP_RAW;
         * only the *accumulator* the selected return is appended to varies.
         * Comparison-only (no per-asset breakdown / EX_dominant) — these are
         * event filters, not asset pickers.
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
export type SelectorName = "RAW" | "MEAN";

export interface OpenScoreUsdTarget {
    asset: string;
    symbol: string;
    data: OHLCVData[];
}

/** Cap-tilt weighting for OPEN_SCORE USD (docs/open-score-cap-tilt.md). */
export type OpenScoreUsdCapTiltWeight = CapTiltWeight;

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

/**
 * Causal confidence weight for a PROFIT_NOW pair vote.
 *
 * `realizedNetPnl` and `grossAbsPnl` contain only trades closed before the
 * vote's entry. The net/gross ratio rewards consistency while `n/(n+1)`
 * shrinks a one-trade winner to 0.5 and approaches 1 with more evidence.
 */
export function computeProfitNowConfidenceWeight(
    closedTradeCount: number,
    realizedNetPnl: number,
    grossAbsPnl: number,
): number {
    if (
        !Number.isFinite(closedTradeCount)
        || closedTradeCount <= 0
        || !Number.isFinite(realizedNetPnl)
        || realizedNetPnl <= 0
        || !Number.isFinite(grossAbsPnl)
        || grossAbsPnl <= 0
    ) return 0;
    const evidenceShrinkage = closedTradeCount / (closedTradeCount + 1);
    const consistency = realizedNetPnl / grossAbsPnl;
    return Math.max(0, Math.min(1, evidenceShrinkage * consistency));
}

function meanOrNull(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return finiteOrNull(s / values.length);
}

const POOL_SNAPSHOT_EMA_PERIOD = 200;

/**
 * Causal target-asset EMA used by the Phase 0b pool-snapshot diagnostics
 * (ema200Above / breadth / regime). Values before the SMA seed are NaN, so an
 * asset cannot qualify without 200 fully known closes.
 */
function buildEma200(data: readonly OHLCVData[]): number[] {
    const ema = new Array<number>(data.length).fill(Number.NaN);
    if (data.length < POOL_SNAPSHOT_EMA_PERIOD) return ema;
    let seed = 0;
    for (let i = 0; i < POOL_SNAPSHOT_EMA_PERIOD; i += 1) {
        const close = data[i]!.close;
        if (!Number.isFinite(close) || close <= 0) return ema;
        seed += close;
    }
    const seedIndex = POOL_SNAPSHOT_EMA_PERIOD - 1;
    ema[seedIndex] = seed / POOL_SNAPSHOT_EMA_PERIOD;
    const alpha = 2 / (POOL_SNAPSHOT_EMA_PERIOD + 1);
    for (let i = POOL_SNAPSHOT_EMA_PERIOD; i < data.length; i += 1) {
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
 * (TOP_RAW / TOP_MEAN / MAX_ACTIVE, plus future arms) emits for the
 * `<ARM> selected assets` report block. Returns the sorted summary plus the
 * totals used in the report header.
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
 * Deterministic block bootstrap for the MEDIAN per-event delta. Same
 * fixed-seed LCG and chronological blocks as a mean CI would use, but each
 * resample pools the RAW deltas of the sampled blocks and takes their median,
 * so the interval brackets the reported median delta rather than the mean.
 *
 * Each block is sorted ONCE; a resample then k-way-merges the chosen sorted
 * blocks only up to the middle position instead of sorting the full pooled
 * multiset every time (sorting ~3k events x 2000 resamples x ~30 comparisons
 * dominated the replay phase). The merge emits the same pooled order
 * statistics a full sort would, so results are bit-identical.
 *
 * Phase 0 freeze: a formal CI requires EXACTLY {@link MAX_ACTIVE_BLOCK_COUNT}
 * nonempty chronological blocks. Fewer blocks (incl. one) return null CI —
 * `INSUFFICIENT_DATA`, never a misleading point CI from a single block.
 */
function blockBootstrapMedianCi(blocks: readonly (readonly number[])[], resamples: number): { lower: number | null; upper: number | null } {
    const b = blocks.length;
    if (b < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    const sortedBlocks = blocks.map((blk) => [...blk].sort((x, y) => x - y));
    let seed = (Math.floor(MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0) || 0x9e3779b9;
    const next = (): number => {
        // LCG (Numerical Recipes constants), returns [0,1).
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const medians: number[] = [];
    const chosen: number[][] = new Array(b);
    const heads: number[] = new Array<number>(b).fill(0);
    for (let r = 0; r < resamples; r += 1) {
        let total = 0;
        for (let k = 0; k < b; k += 1) {
            const blk = sortedBlocks[Math.floor(next() * b)]!;
            chosen[k] = blk;
            total += blk.length;
        }
        const midLo = (total - 1) >> 1;
        const midHi = total >> 1;
        for (let k = 0; k < b; k += 1) heads[k] = 0;
        let prev = 0;
        let last = 0;
        for (let emitted = 0; emitted <= midHi; emitted += 1) {
            let minBlock = -1;
            let minValue = 0;
            for (let k = 0; k < b; k += 1) {
                const blk = chosen[k]!;
                const pos = heads[k]!;
                if (pos < blk.length) {
                    const value = blk[pos]!;
                    if (minBlock === -1 || value < minValue) { minBlock = k; minValue = value; }
                }
            }
            heads[minBlock] = heads[minBlock]! + 1;
            prev = last;
            last = minValue;
        }
        medians.push(midLo === midHi ? last : (prev + last) / 2);
    }
    medians.sort((x, y) => x - y);
    const lo = medians[Math.max(0, Math.floor(0.025 * resamples))]!;
    const hi = medians[Math.min(resamples - 1, Math.floor(0.975 * resamples))]!;
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

interface DecisionEvent {
    timeSec: number;
    /** Per-asset rawScore snapshot after applying all deltas at this time. */
    rawScore: number[];
    activePairCount: number[];
    /**
     * Profit-gated snapshots: the same accumulation restricted to deltas from
     * pairs whose pair backtest netProfit was strictly positive. Drives the
     * TOP_RAW_PROFIT / TOP_MEAN_PROFIT arms only. Look-ahead filter.
     */
    rawScoreProfit: number[];
    activePairCountProfit: number[];
    /**
     * Causal snapshots: restricted to deltas from pairs whose pnl realized
     * at or before this event is strictly positive. Drives the
     * TOP_RAW_PROFIT_NOW / TOP_MEAN_PROFIT_NOW arms.
     */
    rawScoreProfitNow: number[];
    activePairCountProfitNow: number[];
    /** Causal confidence-weighted PROFIT_NOW score snapshot. */
    rawScoreProfitNowConf: number[];
    activePairCountProfitNowConf: number[];
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
    // Cap-tilt weighting. Active only when BOTH the weight and the injected
    // lookup are present (defensive: the route always passes both or neither).
    const capTiltWeight = options.capTiltWeight ?? null;
    const lookupMarketCap = options.lookupMarketCap ?? null;
    const capTiltActive = capTiltWeight !== null && lookupMarketCap !== null;
    const slippageRate = options.slippageRate ?? 0;
    const commissionRate = options.commissionRate ?? 0;
    // Phase 0 freeze: block count and bootstrap samples default to the frozen
    // research constants. Callers may override blockCount for diagnostics, but
    // a formal CI still requires EXACTLY MAX_ACTIVE_BLOCK_COUNT nonempty blocks.
    const blockCount = Math.max(1, Math.floor(options.blockCount ?? MAX_ACTIVE_BLOCK_COUNT));
    const bootstrapSamples = Math.max(200, Math.floor(options.bootstrapSamples ?? MAX_ACTIVE_BOOTSTRAP_SAMPLES));
    const warnings: string[] = [];

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
    const streams: ScoreDelta[][] = [];
    // Index i describes streams[i]: true when that pair's full backtest
    // netProfit was strictly positive (drives the Profit-gated arms only).
    const profitableStreams: boolean[] = [];
    // Causal PROFIT_NOW per-stream pnl-known flags are pushed in lockstep
    // with `streams` (index i describes streams[i]): false when ANY trade of
    // that pair lacks a finite pnl — such pairs are never profitable-now
    // (documented fallback; a pair with mixed known/missing pnl must not
    // ride its known wins).
    const pnlKnownStreams: boolean[] = [];
    let pairCount = 0;
    let omittedPairs = 0;
    // Cap-tilt coverage counters (docs/open-score-cap-tilt.md): LONG trades
    // scanned while the tilt is active, split by whether the entry-time caps
    // were known and whether the tilt actually applied. The report line turns
    // a silently-under-covered tilted run (weights degraded to 1) visible —
    // weighting semantics are unchanged.
    const capTiltCoverage = capTiltActive ? { long: 0, known: 0, weighted: 0, unknown: 0 } : null;
    const capTiltWindowCoverage = { long: 0, known: 0, weighted: 0, unknown: 0 };
    const capTiltCarryInCoverage = { long: 0, known: 0, weighted: 0, unknown: 0 };
    const capTiltUnknownAssets = new Map<string, number>();

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
        // Causal PROFIT_NOW: decide per trade whether its vote is applied,
        // by simulating the pair's own ledger chronologically (exits at a
        // timestamp count as known before entries at that timestamp, so an
        // entry mask includes same-timestamp exits — consistent with the
        // merge's post-group rule). A trade entered while pnl-known and
        // strictly positive carries its vote until its own exit.
        const tradeVoteApplied: boolean[] = new Array(trades.length).fill(false);
        const tradeProfitNowConfidenceWeight: number[] = new Array(trades.length).fill(0);
        let streamPnlKnown = true;
        {
            const ledger: Array<{ t: number; out: boolean; idx: number }> = [];
            trades.forEach((trade, idx) => {
                const entrySec = timeToNumber(trade.entryTime);
                if (entrySec === null) return;
                ledger.push({ t: entrySec, out: false, idx });
                if (trade.exitReason === "end_of_data") return;
                const exitSec = timeToNumber(trade.exitTime);
                if (exitSec === null) return;
                ledger.push({ t: exitSec, out: true, idx });
            });
            ledger.sort((a, b) => a.t - b.t || (a.out === b.out ? 0 : a.out ? -1 : 1));
            let realized = 0;
            let grossAbsPnl = 0;
            let closedTradeCount = 0;
            for (const step of ledger) {
                const pnl = trades[step.idx]!.pnl;
                if (!Number.isFinite(pnl)) streamPnlKnown = false;
                if (step.out) {
                    if (Number.isFinite(pnl)) {
                        realized += pnl!;
                        grossAbsPnl += Math.abs(pnl!);
                        closedTradeCount += 1;
                    }
                } else {
                    tradeVoteApplied[step.idx] = streamPnlKnown && realized > 0;
                    tradeProfitNowConfidenceWeight[step.idx] = streamPnlKnown
                        ? computeProfitNowConfidenceWeight(closedTradeCount, realized, grossAbsPnl)
                        : 0;
                }
            }
        }
        let tradeIdx = -1;
        for (const trade of trades) {
            const entrySec = timeToNumber(trade.entryTime);
            const exitSec = timeToNumber(trade.exitTime);
            if (entrySec === null) continue;
            const sign = trade.type === "long" ? 1 : trade.type === "short" ? -1 : 0;
            if (sign === 0) continue;
            // Cap-tilt weight (docs/open-score-cap-tilt.md): classified ONCE
            // per LONG trade from the entry-time caps and stamped on BOTH the
            // entry and exit base deltas, so rawScore returns exactly to its
            // prior value after every round-trip (re-classifying at exit would
            // drift every accumulator). similarCap2x weights both legs;
            // other modes leave the quote unchanged. Shorts stay ±1.
            let baseWeight = 1;
            let quoteWeight = 1;
            if (sign === 1 && capTiltActive && capTiltCoverage) {
                capTiltCoverage.long += 1;
                const capBase = lookupMarketCap(artifact.baseSymbol?.trim() || base, entrySec);
                const capQuote = qi !== null
                    ? lookupMarketCap(artifact.quoteSymbol?.trim() || quote, entrySec)
                    : null;
                if (capBase !== null && capQuote !== null) {
                    capTiltCoverage.known += 1;
                    if (capTiltWeight === "smallBase2x" && capBase < capQuote) {
                        baseWeight = 2;
                        capTiltCoverage.weighted += 1;
                    } else if (capTiltWeight === "largeBase2x" && capBase > capQuote) {
                        baseWeight = 2;
                        capTiltCoverage.weighted += 1;
                    } else if (capTiltWeight === "similarCap2x"
                        && Number.isFinite(capBase) && capBase > 0
                        && Number.isFinite(capQuote) && capQuote > 0
                        && Math.max(capBase, capQuote) / Math.min(capBase, capQuote) <= 3) {
                        baseWeight = 2;
                        quoteWeight = 2;
                        capTiltCoverage.weighted += 1;
                    }
                } else {
                    capTiltCoverage.unknown += 1;
                }
                // Reconstruction scans the entire ledger, even for a bounded
                // report. Separate new entries from positions carried into
                // the window; both retain their original entry-time weight.
                const from = options.sampleFromSec ?? -Infinity;
                const to = options.sampleToSec ?? Infinity;
                const coverage = entrySec >= from && entrySec <= to
                    ? capTiltWindowCoverage
                    : entrySec < from && entrySec <= to
                        && (trade.exitReason === "end_of_data" || exitSec === null || exitSec >= from)
                        ? capTiltCarryInCoverage
                        : null;
                if (coverage) {
                    coverage.long += 1;
                    if (capBase !== null && capQuote !== null) {
                        coverage.known += 1;
                        if (baseWeight === 2) coverage.weighted += 1;
                    } else {
                        coverage.unknown += 1;
                        if (capBase === null) capTiltUnknownAssets.set(base, (capTiltUnknownAssets.get(base) ?? 0) + 1);
                        if (capQuote === null && quote) capTiltUnknownAssets.set(quote, (capTiltUnknownAssets.get(quote) ?? 0) + 1);
                    }
                }
            }
            tradeIdx += 1;
            const voteApplied = tradeVoteApplied[tradeIdx]!;
            const profitNowConfidenceWeight = tradeProfitNowConfidenceWeight[tradeIdx]!;
            // Entry deltas (long: base+1/quote-1; short: base-1/quote+1).
            stream.push({
                timeSec: entrySec,
                assetIndex: bi,
                delta: sign * baseWeight,
                isEntry: 1,
                pnlShare: 0,
                voteApplied,
                profitNowConfidenceWeight,
            });
            if (qi !== null) {
                stream.push({
                    timeSec: entrySec,
                    assetIndex: qi,
                    delta: -sign * quoteWeight,
                    isEntry: 1,
                    pnlShare: 0,
                    voteApplied,
                    profitNowConfidenceWeight,
                });
            }
            // Exit deltas are the exact inverse. end_of_data / missing exit time
            // means the position is still open at the artifact end -> no exit delta.
            if (exitSec !== null && trade.exitReason !== "end_of_data") {
                // Split the trade's realized pnl evenly across its exit legs so
                // summing every leg's share reconstructs the trade pnl exactly.
                const pnl = Number.isFinite(trade.pnl) ? trade.pnl : 0;
                const pnlShare = pnl / (qi !== null ? 2 : 1);
                stream.push({
                    timeSec: exitSec,
                    assetIndex: bi,
                    delta: -sign * baseWeight,
                    isEntry: 0,
                    pnlShare,
                    voteApplied,
                    profitNowConfidenceWeight,
                });
                if (qi !== null) {
                    stream.push({
                        timeSec: exitSec,
                        assetIndex: qi,
                        delta: sign * quoteWeight,
                        isEntry: 0,
                        pnlShare,
                        voteApplied,
                        profitNowConfidenceWeight,
                    });
                }
            }
        }
        // Sort this pair's deltas in-place (small N). One global Array.sort on
        // 1000+ pairs' worth of deltas would block the event loop and keep
        // Stop / progress from firing during the long sort.
        stream.sort(compareDeltas);
        streams.push(stream);
        // Profit-gated arms: a pair feeds the filtered accumulators only when its
        // full backtest netted strictly positive. Kept in lockstep with
        // `streams` (index i describes streams[i]).
        const pairNetProfit = artifact.result?.netProfit;
        profitableStreams.push(Number.isFinite(pairNetProfit) && pairNetProfit > 0);
        // Causal PROFIT_NOW arms: per-stream quote asset index (-1 for
        // single-leg direct markets) so the exact open-vote flags below can
        // tell a delta's base leg from its quote leg.
        pnlKnownStreams.push(streamPnlKnown);
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

    // --- Phase 2: time-bucketed merge -> decision events + candidates ------
    // The prior implementation merged streams with a binary k-way heap: that
    // is O(deltas × log2(streams)) with a cache-hostile random access per pop,
    // which dominated replay time on a 100k-pair run (hundreds of seconds).
    // Every accumulator the merge maintains is ADDITIVE within a timestamp
    // group, so delta order INSIDE a group cannot change results. Deltas are
    // therefore bucketed by decision time into one flat array (three O(deltas)
    // sequential passes) and the sweep walks buckets in ascending time order
    // with the exact same per-group semantics as the heap version. Cross-group
    // order is strict by timeSec, as before; within-group order is stream-index
    // order, which is deterministic run-to-run regardless of artifact arrival
    // order. Yields still fire after bounded pops so progress and Stop reach
    // the server mid-merge on a huge pair list.
    onPhase("events", "merging score deltas", 0, totalDeltas);
    // 1. Distinct decision times. Each stream is already sorted by timeSec, so
    // walking its equal-time runs visits each of its distinct times once.
    const timeIndex = new Map<number, number>();
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        for (let i = 0; i < stream.length; i += 1) {
            const t = stream[i]!.timeSec;
            if (i > 0 && stream[i - 1]!.timeSec === t) continue;
            if (!timeIndex.has(t)) timeIndex.set(t, timeIndex.size);
        }
        if (s % 25_000 === 24_999) await yieldLoop();
    }
    const bucketTimes = Float64Array.from([...timeIndex.keys()].sort((a, b) => a - b));
    for (let b = 0; b < bucketTimes.length; b += 1) timeIndex.set(bucketTimes[b]!, b);
    // 2. Count deltas per bucket (run-walking again, one Map lookup per run).
    const runCounts = new Uint32Array(bucketTimes.length);
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        let i = 0;
        while (i < stream.length) {
            const t = stream[i]!.timeSec;
            let j = i + 1;
            while (j < stream.length && stream[j]!.timeSec === t) j += 1;
            runCounts[timeIndex.get(t)!] += j - i;
            i = j;
        }
    }
    const bucketStart = new Uint32Array(bucketTimes.length + 1);
    for (let b = 0; b < bucketTimes.length; b += 1) {
        bucketStart[b + 1] = bucketStart[b]! + runCounts[b]!;
    }
    // 3. Place deltas into the flat, time-ordered array. Iterating streams in
    // stream-index order makes within-bucket order deterministic.
    const flatDeltas = new Array<ScoreDelta>(totalDeltas);
    const flatStreamIdx = new Uint32Array(totalDeltas);
    const placementCursor = bucketStart.slice();
    for (let s = 0; s < streams.length; s += 1) {
        const stream = streams[s]!;
        for (let i = 0; i < stream.length; i += 1) {
            const d = stream[i]!;
            const bucketIdx = timeIndex.get(d.timeSec)!;
            const slot = placementCursor[bucketIdx]!;
            flatDeltas[slot] = d;
            flatStreamIdx[slot] = s;
            placementCursor[bucketIdx] = slot + 1;
        }
    }
    // The bucketed arrays now own every delta; drop the per-stream arrays so
    // the sweep does not retain a second indexing of the delta set.
    streams.length = 0;
    timeIndex.clear();

    const rawScore = new Array<number>(assetCount).fill(0);
    const activePairCount = new Array<number>(assetCount).fill(0);
    // Profit-gated accumulators: identical bookkeeping, fed only by deltas from
    // profitable pairs. The TOP_RAW_PROFIT / TOP_MEAN_PROFIT arms read
    // these; every other arm is untouched by the filter.
    const profitRawScore = new Array<number>(assetCount).fill(0);
    const profitPairCount = new Array<number>(assetCount).fill(0);
    // Causal PROFIT_NOW accumulators: fed by deltas from pairs whose pnl
    // realized SO FAR is strictly positive, evaluated at each event (see the
    // post-group apply below).
    const profitNowRawScore = new Array<number>(assetCount).fill(0);
    const profitNowPairCount = new Array<number>(assetCount).fill(0);
    const profitNowConfidenceScore = new Array<number>(assetCount).fill(0);
    const profitNowConfidencePairCount = new Array<number>(assetCount).fill(0);
    // Running realized pnl per stream (sum of exit deltas' pnlShare popped so
    // far). Exits at the event timestamp are applied before the post-group
    // mask evaluation, so their pnl is known at that event.
    const realizedPnlByStream = new Float64Array(profitableStreams.length);
    // Deltas of the current timestamp group, replayed after the group closes
    // with per-leg open-vote flags (see the post-group apply below).
    interface GroupDelta {
        assetIndex: number;
        delta: number;
        streamIdx: number;
        isEntry: number;
        voteApplied: boolean;
        profitNowConfidenceWeight: number;
    }
    const groupDeltas: GroupDelta[] = [];
    // Causal PROFIT_NOW vote applicability travels ON each delta
    // (ScoreDelta.voteApplied, precomputed per trade at scan time), so the
    // post-group apply below needs no per-stream state.
    const events: DecisionEvent[] = [];
    const sampleFrom = options.sampleFromSec;
    const sampleTo = options.sampleToSec;

    let popped = 0;
    for (let b = 0; b < bucketTimes.length; b += 1) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
        const t = bucketTimes[b]!;
        let hasEntry = false;
        groupDeltas.length = 0;
        // Apply ALL deltas at this timestamp before forming candidates.
        const bucketEnd = bucketStart[b + 1]!;
        for (let i = bucketStart[b]!; i < bucketEnd; i += 1) {
            if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
            const d = flatDeltas[i]!;
            const streamIdx = flatStreamIdx[i]!;
            rawScore[d.assetIndex]! += d.delta;
            // activePairCount tracks currently-open pairs on this asset: an
            // entry adds a vote, an exit removes it (clamped at 0). Using
            // abs(delta) here was wrong because it incremented on BOTH entry
            // and exit, inflating the adjusted-score denominator after every
            // round-trip and corrupting TOP_ADJUSTED selection.
            const countDelta = d.isEntry === 1 ? 1 : -1;
            const next = activePairCount[d.assetIndex]! + countDelta;
            activePairCount[d.assetIndex] = next > 0 ? next : 0;
            if (d.isEntry === 0) realizedPnlByStream[streamIdx] += d.pnlShare;
            // Profit-gated mirror: only deltas from pairs whose FULL backtest
            // netted positive (static mask).
            if (profitableStreams[streamIdx]!) {
                profitRawScore[d.assetIndex]! += d.delta;
                const nextPnl = profitPairCount[d.assetIndex]! + countDelta;
                profitPairCount[d.assetIndex] = nextPnl > 0 ? nextPnl : 0;
            }
            // Buffered for the causal PROFIT_NOW apply after the group closes.
            groupDeltas.push({
                assetIndex: d.assetIndex,
                delta: d.delta,
                streamIdx,
                isEntry: d.isEntry,
                voteApplied: d.voteApplied,
                profitNowConfidenceWeight: d.profitNowConfidenceWeight,
            });
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
        // Causal PROFIT_NOW apply. Runs for EVERY timestamp group — including
        // exit-only ones that form no decision event — so the accumulators
        // stay an exact image of "open votes of pairs profitable so far".
        // (Gating this on hasEntry leaked votes: a masked pair exiting on an
        // exit-only timestamp never had its vote subtracted.) The pair's own
        // exit already updated realizedPnlByStream, so masks here are the
        // point-in-time profitability AT this event. Pairs whose realized
        // pnl-so-far is <= 0 (including those with no per-trade pnl) are
        // muted. Exits are applied before entries so a same-timestamp
        // re-entry accounts both legs of the round trip exactly.
        for (let g = 0; g < groupDeltas.length; g += 1) {
            const gd = groupDeltas[g]!;
            if (!gd.voteApplied) continue;
            profitNowRawScore[gd.assetIndex]! += gd.delta;
            const countDeltaNow = gd.isEntry === 1 ? 1 : -1;
            const nextNow = profitNowPairCount[gd.assetIndex]! + countDeltaNow;
            profitNowPairCount[gd.assetIndex] = nextNow > 0 ? nextNow : 0;
            if (gd.profitNowConfidenceWeight > 0) {
                profitNowConfidenceScore[gd.assetIndex]! += gd.delta * gd.profitNowConfidenceWeight;
                const nextConfidence = profitNowConfidencePairCount[gd.assetIndex]! + countDeltaNow;
                profitNowConfidencePairCount[gd.assetIndex] = nextConfidence > 0 ? nextConfidence : 0;
            }
        }
        // Exit-only score changes do not create a decision event.
        if (hasEntry) {
            if ((sampleFrom === undefined || t >= sampleFrom) && (sampleTo === undefined || t <= sampleTo)) {
                events.push({
                    timeSec: t,
                    rawScore: [...rawScore],
                    activePairCount: [...activePairCount],
                    rawScoreProfit: [...profitRawScore],
                    activePairCountProfit: [...profitPairCount],
                    rawScoreProfitNow: [...profitNowRawScore],
                    activePairCountProfitNow: [...profitNowPairCount],
                    rawScoreProfitNowConf: [...profitNowConfidenceScore],
                    activePairCountProfitNowConf: [...profitNowConfidencePairCount],
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
        activePairs: number;
    }
    interface EventView {
        timeSec: number;
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
        /** Max active-pair count across positive candidates at this event. */
        maxActivePairs: number;
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
    /**
     * Events with a >= 2-member profit pool (full-window or causal) but fewer
     * than 2 ordinary positives. They form no EventView (the ordinary arms
     * cannot fire there), but the profit arms are still evaluated on them so
     * the causal selector's coverage does not depend on the ordinary pool.
     */
    interface ProfitOnlyEvent {
        timeSec: number;
        profitPositives: Candidate[];
        profitNowPositives: Candidate[];
        profitNowConfidencePositives: Candidate[];
    }
    const profitOnlyEvents: ProfitOnlyEvent[] = [];
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
        const profitPositives: Candidate[] = [];
        const profitNowPositives: Candidate[] = [];
        const profitNowConfidencePositives: Candidate[] = [];
        let maxActivePairs = 0;
        for (let a = 0; a < assetCount; a += 1) {
            const raw = ev.rawScore[a]!;
            const cnt = ev.activePairCount[a]!;
            const candidate: Candidate = {
                assetIndex: a,
                raw,
                adjusted: cnt > 0 ? raw / Math.sqrt(cnt) : raw,
                mean: cnt > 0 ? raw / cnt : raw,
                activePairs: cnt,
            };
            if (raw > 0) {
                if (cnt > maxActivePairs) maxActivePairs = cnt;
                positives.push(candidate);
            }
            // Profit-gated pool: same shape, filtered scores only.
            const rawPnl = ev.rawScoreProfit[a]!;
            if (rawPnl > 0) {
                const cntPnl = ev.activePairCountProfit[a]!;
                profitPositives.push({
                    assetIndex: a,
                    raw: rawPnl,
                    adjusted: cntPnl > 0 ? rawPnl / Math.sqrt(cntPnl) : rawPnl,
                    mean: cntPnl > 0 ? rawPnl / cntPnl : rawPnl,
                    activePairs: cntPnl,
                });
            }
            // Causal pool: same shape, realized-so-far filtered scores only.
            const rawPnlNow = ev.rawScoreProfitNow[a]!;
            if (rawPnlNow > 0) {
                const cntPnlNow = ev.activePairCountProfitNow[a]!;
                profitNowPositives.push({
                    assetIndex: a,
                    raw: rawPnlNow,
                    adjusted: cntPnlNow > 0 ? rawPnlNow / Math.sqrt(cntPnlNow) : rawPnlNow,
                    mean: cntPnlNow > 0 ? rawPnlNow / cntPnlNow : rawPnlNow,
                    activePairs: cntPnlNow,
                });
            }
            // Causal confidence-weighted pool: the same entry-time causal
            // filter, but each qualifying vote carries a bounded realized-P&L
            // consistency/evidence weight.
            const rawPnlNowConf = ev.rawScoreProfitNowConf[a]!;
            if (rawPnlNowConf > 0) {
                const cntPnlNowConf = ev.activePairCountProfitNowConf[a]!;
                profitNowConfidencePositives.push({
                    assetIndex: a,
                    raw: rawPnlNowConf,
                    adjusted: cntPnlNowConf > 0 ? rawPnlNowConf / Math.sqrt(cntPnlNowConf) : rawPnlNowConf,
                    mean: cntPnlNowConf > 0 ? rawPnlNowConf / cntPnlNowConf : rawPnlNowConf,
                    activePairs: cntPnlNowConf,
                });
            }
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
            const pickMax = (candidates: readonly Candidate[], key: "raw" | "mean" | "activePairs"): { winner: Candidate; tiedCount: number } => {
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
            const topRaw = pickMax(positives, "raw");
            const topMean = pickMax(positives, "mean");
            const topMeanRawUniquePool = positives.filter((candidate) => candidate.mean === topMean.winner.mean);
            let topMeanRawUnique = -1;
            let maxRawInTopMeanTie = -Infinity;
            for (const candidate of topMeanRawUniquePool) {
                if (candidate.raw > maxRawInTopMeanTie) maxRawInTopMeanTie = candidate.raw;
            }
            const topMeanRawMaxRows = topMeanRawUniquePool.filter((candidate) => candidate.raw === maxRawInTopMeanTie);
            if (topMeanRawMaxRows.length === 1) topMeanRawUnique = topMeanRawMaxRows[0]!.assetIndex;
            // Profit-gated picks: same digest tie-break, own >= 2 pool gate.
            const topRawProfit = profitPositives.length >= 2 ? pickMax(profitPositives, "raw") : null;
            const topMeanProfit = profitPositives.length >= 2 ? pickMax(profitPositives, "mean") : null;
            // Causal picks: identical, over the point-in-time pool.
            const topRawProfitNow = profitNowPositives.length >= 2 ? pickMax(profitNowPositives, "raw") : null;
            const topMeanProfitNow = profitNowPositives.length >= 2 ? pickMax(profitNowPositives, "mean") : null;
            const topRawProfitNowConf = profitNowConfidencePositives.length >= 2
                ? pickMax(profitNowConfidencePositives, "raw")
                : null;
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
                timeSec: ev.timeSec, positives,
                profitPositives,
                profitNowPositives,
                profitNowConfidencePositives,
                topRaw: topRawIdx,
                topMean: topMean.winner.assetIndex,
                topMeanRawUnique,
                topMeanRawUniquePool,
                topRawProfit: topRawProfit?.winner.assetIndex ?? -1,
                topMeanProfit: topMeanProfit?.winner.assetIndex ?? -1,
                topRawProfitNow: topRawProfitNow?.winner.assetIndex ?? -1,
                topMeanProfitNow: topMeanProfitNow?.winner.assetIndex ?? -1,
                topRawProfitNowConf: topRawProfitNowConf?.winner.assetIndex ?? -1,
                maxActivePairs,
                hhi,
                fresh,
                streak: currentStreakLength,
                ties: {
                    RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                    MEAN: topMean.tiedCount >= 2 ? 1 : 0,
                },
            });
            lastTopRawLeaderIdx = topRawIdx;
        } else if (
            profitPositives.length >= 2
            || profitNowPositives.length >= 2
            || profitNowConfidencePositives.length >= 2
        ) {
            // Profit-arm-only event: no ordinary view, but a profit arm can
            // still fire. Pools are captured verbatim; picks are resolved in
            // Phase 5 with the same tie-break rule.
            profitOnlyEvents.push({
                timeSec: ev.timeSec,
                profitPositives,
                profitNowPositives,
                profitNowConfidencePositives,
            });
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
        // A profit-gated candidate may have a non-positive unfiltered score
        // (offsetting losing-pair votes). Add it after the positive pass so
        // the same view index cannot be appended twice for an asset.
        for (const c of views[v]!.profitPositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
        // Causal pool candidates may also have a non-positive unfiltered
        // score; tail-dedupe keeps the same view from appending twice.
        for (const c of views[v]!.profitNowPositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
        for (const c of views[v]!.profitNowConfidencePositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
    }
    // Profit-only events share the request/outcome indexes, offset after the
    // real views so every existing view index stays stable.
    const totalEventCount = views.length + profitOnlyEvents.length;
    const eventTimeOf = (idx: number): number =>
        idx < views.length ? views[idx]!.timeSec : profitOnlyEvents[idx - views.length]!.timeSec;
    const pushEventRequest = (assetIndex: number, idx: number): void => {
        let list = requestsByAsset.get(assetIndex);
        if (!list) { list = []; requestsByAsset.set(assetIndex, list); }
        if (list[list.length - 1] !== idx) list.push(idx);
    };
    for (let pi = 0; pi < profitOnlyEvents.length; pi += 1) {
        const idx = views.length + pi;
        for (const c of profitOnlyEvents[pi]!.profitPositives) pushEventRequest(c.assetIndex, idx);
        for (const c of profitOnlyEvents[pi]!.profitNowPositives) pushEventRequest(c.assetIndex, idx);
        for (const c of profitOnlyEvents[pi]!.profitNowConfidencePositives) pushEventRequest(c.assetIndex, idx);
    }

    // --- Phase 4: evaluate USD outcomes per target (load -> consume -> free) -
    // Per event-view, per horizon: net return for each candidate assetIndex.
    // Stored sparsely: only eligible-candidate assets are queried.
    const returnsByView: Array<Map<number, {
        long: number[];
        entryTimes: number[];
        exitTimes: number[];
        statuses: CandidateOutcomeStatus[];
    }> | null> = new Array(totalEventCount).fill(null);
    const missingAssets = new Set<number>();
    const dataGapAssets = new Map<number, CandleGap>();
    const dataGapEvents = new Set<number>();
    const censoredEvents = new Set<number>();
    const noDataEvents = new Set<number>();
    const latestView = views[views.length - 1] ?? null;

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
        const dataGap = findCandleGapOverlapping(
            target.data,
            options.sampleFromSec,
            options.sampleToSec,
        );
        if ((!requests || requests.length === 0) && diagnosticIdx === undefined) {
            if (dataGap && aIdx !== undefined) dataGapAssets.set(aIdx, dataGap);
            continue;
        }
        targetsSeen += 1;
        if (diagnosticIdx !== undefined) diagnosticTargetsSeen?.add(diagnosticIdx);
        const times = target.data.map((b) => timeToNumber(b.time));
        if (dataGap) {
            if (aIdx !== undefined) dataGapAssets.set(aIdx, dataGap);
            if (candidateOutcomes && diagnosticIdx !== undefined) {
                for (const event of events) {
                    const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                    for (const horizonBars of horizons) {
                        const eventId = phase0bEventId(options.interval, event.timeSec);
                        await emitCandidateOutcome({
                            eventId,
                            decisionTimeSec: event.timeSec,
                            horizonBars,
                            direction: "long",
                            asset: diagnosticAssetNames[diagnosticIdx]!,
                            inPool: true,
                            eligible: rawScore > 0,
                            return: null,
                            entryTimeSec: null,
                            exitTimeSec: null,
                            status: "data_gap",
                        });
                        await emitCandidateOutcome({
                            eventId,
                            decisionTimeSec: event.timeSec,
                            horizonBars,
                            direction: "short",
                            asset: diagnosticAssetNames[diagnosticIdx]!,
                            inPool: true,
                            eligible: rawScore < 0,
                            return: null,
                            entryTimeSec: null,
                            exitTimeSec: null,
                            status: "data_gap",
                        });
                    }
                }
            }
            onPhase(
                "outcomes",
                `skipped ${target.asset} (data gap ${new Date(dataGap.from * 1000).toISOString()}..${new Date(dataGap.to * 1000).toISOString()})`,
                targetsSeen,
                totalTargets,
            );
            await yieldLoop();
            continue;
        }
        if (diagnosticIdx !== undefined) {
            const ema200 = buildEma200(target.data);
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
            const eventTime = eventTimeOf(viewIdx);
            // First target bar strictly after the decision timestamp.
            const entryBar = firstBarAfter(times, eventTime);
            if (entryBar < 0) {
                if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                continue;
            }
            let perAsset = returnsByView[viewIdx];
            if (!perAsset) { perAsset = new Map(); returnsByView[viewIdx] = perAsset; }
            const longReturns: number[] = [];
            const entryTimes: number[] = [];
            const exitTimes: number[] = [];
            const statuses: CandidateOutcomeStatus[] = [];
            for (const h of horizons) {
                const exitBar = entryBar + h - 1; // h bars forward, close of that bar
                const entryTime = times[entryBar] ?? Number.NaN;
                if (exitBar >= target.data.length) {
                    longReturns.push(Number.NaN);
                    entryTimes.push(entryTime);
                    exitTimes.push(Number.NaN);
                    statuses.push("right_censored");
                    continue;
                }
                const rawOpen = target.data[entryBar]!.open;
                const exitClose = target.data[exitBar]!.close;
                if (!Number.isFinite(rawOpen) || rawOpen <= 0 || !Number.isFinite(exitClose) || exitClose <= 0) {
                    longReturns.push(Number.NaN);
                    entryTimes.push(entryTime);
                    exitTimes.push(Number.NaN);
                    statuses.push("invalid_price");
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
                statuses.push(Number.isFinite(netReturn) ? "ok" : "invalid_price");
            }
            perAsset.set(aIdx, {
                long: longReturns,
                entryTimes,
                exitTimes,
                statuses,
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

    const usableCandidates = (pool: readonly Candidate[]): Candidate[] =>
        pool.filter((candidate) => !dataGapAssets.has(candidate.assetIndex));

    const pickUsableMax = (
        pool: readonly Candidate[],
        key: "raw" | "mean" | "activePairs",
        timeSec: number,
    ): { winner: Candidate; tiedCount: number } | null => {
        if (pool.length === 0) return null;
        let maxValue = pool[0]![key]!;
        for (let i = 1; i < pool.length; i += 1) {
            const value = pool[i]![key]!;
            if (value > maxValue) maxValue = value;
        }
        const tied = pool.filter((candidate) => candidate[key] === maxValue);
        let winner = tied[0]!;
        if (tied.length > 1) {
            let winnerDigest = tieBreakDigest(timeSec, assetNames[winner.assetIndex]!);
            for (let i = 1; i < tied.length; i += 1) {
                const candidate = tied[i]!;
                const digest = tieBreakDigest(timeSec, assetNames[candidate.assetIndex]!);
                if (digest < winnerDigest || (digest === winnerDigest
                    && assetNames[candidate.assetIndex]! < assetNames[winner.assetIndex]!)) {
                    winner = candidate;
                    winnerDigest = digest;
                }
            }
        }
        return { winner, tiedCount: tied.length };
    };

    // Target gaps are discovered after the pair-event sweep. Rebuild the
    // candidate views once their target datasets have been inspected so a
    // gapped asset is removed from the selector pool instead of invalidating
    // an otherwise usable event.
    const gapFilteredViews: Array<EventView | null> = [];
    let gapFilteredLastTopRawLeader = -1;
    let gapFilteredStreak = 0;
    for (let viewIndex = 0; viewIndex < views.length; viewIndex += 1) {
        const source = views[viewIndex]!;
        const positives = usableCandidates(source.positives);
        if (positives.length < 2) {
            if (source.positives.some((candidate) => dataGapAssets.has(candidate.assetIndex))) {
                dataGapEvents.add(viewIndex);
            }
            gapFilteredViews.push(null);
            continue;
        }
        const profitPositives = usableCandidates(source.profitPositives);
        const profitNowPositives = usableCandidates(source.profitNowPositives);
        const profitNowConfidencePositives = usableCandidates(source.profitNowConfidencePositives);
        const topRaw = pickUsableMax(positives, "raw", source.timeSec)!;
        const topMean = pickUsableMax(positives, "mean", source.timeSec)!;
        const topMeanRawUniquePool = positives.filter((candidate) => candidate.mean === topMean.winner.mean);
        let topMeanRawUnique = -1;
        let maxRawInTopMeanTie = -Infinity;
        for (const candidate of topMeanRawUniquePool) {
            if (candidate.raw > maxRawInTopMeanTie) maxRawInTopMeanTie = candidate.raw;
        }
        const topMeanRawMaxRows = topMeanRawUniquePool.filter((candidate) => candidate.raw === maxRawInTopMeanTie);
        if (topMeanRawMaxRows.length === 1) topMeanRawUnique = topMeanRawMaxRows[0]!.assetIndex;
        const topRawProfit = profitPositives.length >= 2
            ? pickUsableMax(profitPositives, "raw", source.timeSec)
            : null;
        const topMeanProfit = profitPositives.length >= 2
            ? pickUsableMax(profitPositives, "mean", source.timeSec)
            : null;
        const topRawProfitNow = profitNowPositives.length >= 2
            ? pickUsableMax(profitNowPositives, "raw", source.timeSec)
            : null;
        const topMeanProfitNow = profitNowPositives.length >= 2
            ? pickUsableMax(profitNowPositives, "mean", source.timeSec)
            : null;
        const topRawProfitNowConf = profitNowConfidencePositives.length >= 2
            ? pickUsableMax(profitNowConfidencePositives, "raw", source.timeSec)
            : null;
        let maxActivePairs = 0;
        let rawSum = 0;
        for (const candidate of positives) {
            if (candidate.activePairs > maxActivePairs) maxActivePairs = candidate.activePairs;
            rawSum += candidate.raw;
        }
        let hhi = 0;
        for (const candidate of positives) {
            const share = candidate.raw / rawSum;
            hhi += share * share;
        }
        const fresh = topRaw.winner.assetIndex !== gapFilteredLastTopRawLeader;
        gapFilteredStreak = fresh ? 1 : gapFilteredStreak + 1;
        gapFilteredViews.push({
            ...source,
            positives,
            profitPositives,
            profitNowPositives,
            profitNowConfidencePositives,
            topRaw: topRaw.winner.assetIndex,
            topMean: topMean.winner.assetIndex,
            topMeanRawUnique,
            topMeanRawUniquePool,
            topRawProfit: topRawProfit?.winner.assetIndex ?? -1,
            topMeanProfit: topMeanProfit?.winner.assetIndex ?? -1,
            topRawProfitNow: topRawProfitNow?.winner.assetIndex ?? -1,
            topMeanProfitNow: topMeanProfitNow?.winner.assetIndex ?? -1,
            topRawProfitNowConf: topRawProfitNowConf?.winner.assetIndex ?? -1,
            maxActivePairs,
            hhi,
            fresh,
            streak: gapFilteredStreak,
            ties: {
                RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                MEAN: topMean.tiedCount >= 2 ? 1 : 0,
            },
        });
        gapFilteredLastTopRawLeader = topRaw.winner.assetIndex;
    }
    const gapFilteredProfitOnlyEvents: ProfitOnlyEvent[] = profitOnlyEvents.map((source) => ({
        ...source,
        profitPositives: usableCandidates(source.profitPositives),
        profitNowPositives: usableCandidates(source.profitNowPositives),
        profitNowConfidencePositives: usableCandidates(source.profitNowConfidencePositives),
    }));

    const latestSelections: OpenScoreUsdLatestSelections | null = (() => {
        if (!latestView) return null;

        const pick = (
            selector: OpenScoreUsdLatestSelectorName,
            direction: "long" | "short" | "none",
            pool: readonly Candidate[],
            primary: (candidate: Candidate) => number,
            primaryOrder: "max" | "min",
            secondary?: (candidate: Candidate) => number,
        ): OpenScoreUsdLatestSelection => {
            const usablePool = usableCandidates(pool);
            // Ranked detail for the Latest-picks UI: the arm's top candidates
            // in its own ranking order, capped at 3 so the wire payload stays
            // bounded. Runs once per completed run (latest event, 5 arms).
            const rankTopCandidates = (): OpenScoreUsdLatestSelectionCandidate[] =>
                [...usablePool]
                    .sort((a, b) => {
                        const pa = primary(a);
                        const pb = primary(b);
                        if (pa !== pb) return primaryOrder === "max" ? pb - pa : pa - pb;
                        if (secondary) {
                            const sa = secondary(a);
                            const sb = secondary(b);
                            if (sa !== sb) return sb - sa;
                        }
                        return assetNames[a.assetIndex]!.localeCompare(assetNames[b.assetIndex]!);
                    })
                    .slice(0, 3)
                    .map((candidate) => ({
                        asset: assetNames[candidate.assetIndex]!,
                        score: candidate.raw,
                        mean: candidate.mean,
                        activePairs: candidate.activePairs,
                    }));
            const topCandidates = rankTopCandidates();
            if (usablePool.length < 2) {
                return {
                    selector,
                    direction,
                    asset: null,
                    tiedAssets: [],
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: usablePool.length,
                    reason: "insufficient_candidates",
                    topCandidates,
                };
            }
            let bestPrimary = primary(usablePool[0]!);
            for (let i = 1; i < usablePool.length; i += 1) {
                const value = primary(usablePool[i]!);
                if (primaryOrder === "max" ? value > bestPrimary : value < bestPrimary) {
                    bestPrimary = value;
                }
            }
            let finalists = usablePool.filter((candidate) => primary(candidate) === bestPrimary);
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
                    eligibleCandidates: usablePool.length,
                    reason: "tied",
                    topCandidates,
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
                eligibleCandidates: usablePool.length,
                reason: "selected",
                topCandidates,
            };
        };

        return {
            decisionTime: latestView.timeSec,
            selections: [
                pick("TOP_RAW", "long", latestView.positives, (candidate) => candidate.raw, "max"),
                pick("TOP_MEAN", "long", latestView.positives, (candidate) => candidate.mean, "max"),
                pick("TOP_MEAN_RAW_UNIQUE", "long", latestView.positives, (candidate) => candidate.mean, "max", (candidate) => candidate.raw),
                pick("TOP_RAW_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.raw, "max"),
                pick("TOP_MEAN_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.mean, "max"),
                pick("TOP_RAW_PROFIT_NOW_CONF", "long", latestView.profitNowConfidencePositives, (candidate) => candidate.raw, "max"),
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
        const selectedOutcome = perAsset?.get(selected.assetIndex);
        if (selectedOutcome?.statuses[hIdx] !== "right_censored") return;
        const entryTime = selectedOutcome.entryTimes[hIdx];
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
        const topMean = createSeries();
        const topMeanRawUnique = createSeries();
        const topRawProfit = createSeries();
        const topMeanProfit = createSeries();
        const topRawProfitNow = createSeries();
        const topMeanProfitNow = createSeries();
        const topRawProfitNowConf = createSeries();
        const topMeanPortfolioOpportunities: TopMeanPortfolioOpportunity[] = [];
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
        const tieCounts: Record<SelectorName, number> = { RAW: 0, MEAN: 0 };
        const selectedDegree: number[] = [];
        const activeCountsAtEvents: number[] = [];
        const selectedByAsset = new Map<string, number>();
        const topRawSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // Per-asset selection map for TOP_MEAN (coverage-adjusted arm). Mirrors
        // topRawSamplesByAsset so the TOP_MEAN breakdown + EX_DOM lines can be
        // computed the same way as TOP_RAW's.
        const topMeanSelectedByAsset = new Map<string, number>();
        const topMeanSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topMeanRawUniqueSelectedByAsset = new Map<string, number>();
        const topMeanRawUniqueSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topRawProfitSelectedByAsset = new Map<string, number>();
        const topRawProfitSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topMeanProfitSelectedByAsset = new Map<string, number>();
        const topMeanProfitSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topRawProfitNowSelectedByAsset = new Map<string, number>();
        const topRawProfitNowSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topMeanProfitNowSelectedByAsset = new Map<string, number>();
        const topMeanProfitNowSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const topRawProfitNowConfSelectedByAsset = new Map<string, number>();
        const topRawProfitNowConfSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
            // Scalar event-detail emitter, hoisted to horizon scope so both the
        // ordinary views and the profit-only events can push rows.
        const pushEventDetail = (
            perAssetOutcomes: ViewReturns,
            decisionTime: number,
            selector: OpenScoreUsdEventDetailSelector,
            direction: "long" | "short",
            selected: Candidate,
            selectedReturn: number,
            controlReturn: number,
            eligibleCandidates: number,
        ): void => {
            if (!options.includeEventDetails) return;
            const outcome = perAssetOutcomes.get(selected.assetIndex);
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
                decisionTime,
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
        // Profit arms (full-window and causal): independent eligibility gates
        // over their own pools. Missing data on a gated candidate omits the
        // event from that pair of arms only (never zero-filled); missing data on
        // a non-gated positive is irrelevant. Hoisted to horizon scope so the
        // profit-only events (no ordinary view) reuse the identical logic.
        const appendProfitArms = (
            timeSec: number,
            perAssetOutcomes: ViewReturns,
            pool: readonly Candidate[],
            rawPick: number,
            meanPick: number,
            rawSelector: OpenScoreUsdEventDetailSelector,
            meanSelector: OpenScoreUsdEventDetailSelector,
            rawSeries: SelectorSeries,
            meanSeries: SelectorSeries,
            rawSelectedByAsset: Map<string, number>,
            rawSamplesByAsset: Map<string, { returns: number[]; deltas: number[] }>,
            meanSelectedByAsset: Map<string, number>,
            meanSamplesByAsset: Map<string, { returns: number[]; deltas: number[] }>,
        ): void => {
            if (pool.length < 2 || rawPick < 0 || meanPick < 0) return;
            if (pool.some((candidate) => dataGapAssets.has(candidate.assetIndex))) return;
            const poolRetByAsset = new Map<number, number>();
            let poolValid = true;
            for (const c of pool) {
                const r = perAssetOutcomes.get(c.assetIndex)?.long[hIdx];
                if (r === undefined || !Number.isFinite(r)) { poolValid = false; break; }
                poolRetByAsset.set(c.assetIndex, r);
            }
            if (!poolValid) return;
            let poolTotal = 0;
            for (const r of poolRetByAsset.values()) poolTotal += r;
            const appendProfitSelection = (
                series: SelectorSeries,
                selector: OpenScoreUsdEventDetailSelector,
                selectedIdx: number,
                selectedByAsset: Map<string, number>,
                samplesByAsset: Map<string, { returns: number[]; deltas: number[] }>,
            ): void => {
                const selectedReturn = poolRetByAsset.get(selectedIdx);
                if (selectedReturn === undefined) return;
                const randomReturn = (poolTotal - selectedReturn) / (poolRetByAsset.size - 1);
                const delta = selectedReturn - randomReturn;
                series.returns.push(selectedReturn);
                series.deltas.push(delta);
                series.times.push(timeSec);
                series.assets.push(assetNames[selectedIdx]!);
                pushEventDetail(
                    perAssetOutcomes,
                    timeSec,
                    selector,
                    "long",
                    pool.find((candidate) => candidate.assetIndex === selectedIdx)!,
                    selectedReturn,
                    randomReturn,
                    poolRetByAsset.size,
                );
                const asset = assetNames[selectedIdx]!;
                selectedByAsset.set(asset, (selectedByAsset.get(asset) ?? 0) + 1);
                let samples = samplesByAsset.get(asset);
                if (!samples) {
                    samples = { returns: [], deltas: [] };
                    samplesByAsset.set(asset, samples);
                }
                samples.returns.push(selectedReturn);
                samples.deltas.push(delta);
            };
            appendProfitSelection(rawSeries, rawSelector, rawPick, rawSelectedByAsset, rawSamplesByAsset);
            appendProfitSelection(meanSeries, meanSelector, meanPick, meanSelectedByAsset, meanSamplesByAsset);
        };
        const appendConfidenceProfitArm = (
            timeSec: number,
            perAssetOutcomes: ViewReturns,
            pool: readonly Candidate[],
            selectedIdx: number,
        ): void => {
            if (pool.length < 2 || selectedIdx < 0) return;
            if (pool.some((candidate) => dataGapAssets.has(candidate.assetIndex))) return;
            const poolRetByAsset = new Map<number, number>();
            let poolValid = true;
            for (const c of pool) {
                const r = perAssetOutcomes.get(c.assetIndex)?.long[hIdx];
                if (r === undefined || !Number.isFinite(r)) { poolValid = false; break; }
                poolRetByAsset.set(c.assetIndex, r);
            }
            if (!poolValid) return;
            const selectedReturn = poolRetByAsset.get(selectedIdx);
            if (selectedReturn === undefined) return;
            let poolTotal = 0;
            for (const r of poolRetByAsset.values()) poolTotal += r;
            const randomReturn = (poolTotal - selectedReturn) / (poolRetByAsset.size - 1);
            const delta = selectedReturn - randomReturn;
            topRawProfitNowConf.returns.push(selectedReturn);
            topRawProfitNowConf.deltas.push(delta);
            topRawProfitNowConf.times.push(timeSec);
            topRawProfitNowConf.assets.push(assetNames[selectedIdx]!);
            pushEventDetail(
                perAssetOutcomes,
                timeSec,
                "TOP_RAW_PROFIT_NOW_CONF",
                "long",
                pool.find((candidate) => candidate.assetIndex === selectedIdx)!,
                selectedReturn,
                randomReturn,
                poolRetByAsset.size,
            );
            const asset = assetNames[selectedIdx]!;
            topRawProfitNowConfSelectedByAsset.set(asset, (topRawProfitNowConfSelectedByAsset.get(asset) ?? 0) + 1);
            let samples = topRawProfitNowConfSamplesByAsset.get(asset);
            if (!samples) {
                samples = { returns: [], deltas: [] };
                topRawProfitNowConfSamplesByAsset.set(asset, samples);
            }
            samples.returns.push(selectedReturn);
            samples.deltas.push(delta);
        };

        for (let v = 0; v < views.length; v += 1) {
            const view = gapFilteredViews[v];
            if (!view) continue;
            const perAsset = returnsByView[v];
            if (!perAsset) {
                noDataEvents.add(v);
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
                pushEventDetail(perAsset, view.timeSec, selector, direction, selected, selectedReturn, controlReturn, eligibleCandidates);
            };
            // Full-window profit arms: research-only look-ahead filter.
            appendProfitArms(
                view.timeSec,
                perAsset,
                view.profitPositives,
                view.topRawProfit,
                view.topMeanProfit,
                "TOP_RAW_PROFIT",
                "TOP_MEAN_PROFIT",
                topRawProfit,
                topMeanProfit,
                topRawProfitSelectedByAsset,
                topRawProfitSamplesByAsset,
                topMeanProfitSelectedByAsset,
                topMeanProfitSamplesByAsset,
            );
            // Causal point-in-time profit arms: live-selectable in principle.
            appendProfitArms(
                view.timeSec,
                perAsset,
                view.profitNowPositives,
                view.topRawProfitNow,
                view.topMeanProfitNow,
                "TOP_RAW_PROFIT_NOW",
                "TOP_MEAN_PROFIT_NOW",
                topRawProfitNow,
                topMeanProfitNow,
                topRawProfitNowSelectedByAsset,
                topRawProfitNowSamplesByAsset,
                topMeanProfitNowSelectedByAsset,
                topMeanProfitNowSamplesByAsset,
            );
            appendConfidenceProfitArm(
                view.timeSec,
                perAsset,
                view.profitNowConfidencePositives,
                view.topRawProfitNowConf,
            );

            // Collect returns for all positives this horizon.
            const retByAsset = new Map<number, number>();
            let allValid = true;
            for (const c of view.positives) {
                const arr = perAsset.get(c.assetIndex);
                const r = arr ? arr.long[hIdx] : undefined;
                if (r === undefined || !Number.isFinite(r)) {
                    allValid = false;
                    break;
                }
                retByAsset.set(c.assetIndex, r);
            }
            // The TOP_MEAN portfolio opportunity uses the incumbent outcome even
            // when another positive candidate makes the ordinary all-positive
            // comparison ineligible.
            const incumbentOutcome = perAsset.get(view.topMean);
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
                if (view.topMeanRawUnique < 0) return;
                const tiedReturns = view.topMeanRawUniquePool
                    .map((candidate) => retByAsset.get(candidate.assetIndex))
                    .filter((value): value is number => value !== undefined && Number.isFinite(value));
                if (tiedReturns.length !== view.topMeanRawUniquePool.length || tiedReturns.length === 0) return;
                const selectedReturn = retByAsset.get(view.topMeanRawUnique);
                if (selectedReturn === undefined) return;
                const controlReturn = tiedReturns.reduce((sum, value) => sum + value, 0) / tiedReturns.length;
                const delta = selectedReturn - controlReturn;
                topMeanRawUnique.returns.push(selectedReturn);
                topMeanRawUnique.deltas.push(delta);
                topMeanRawUnique.times.push(view.timeSec);
                topMeanRawUnique.assets.push(assetNames[view.topMeanRawUnique]!);
                const asset = assetNames[view.topMeanRawUnique]!;
                topMeanRawUniqueSelectedByAsset.set(asset, (topMeanRawUniqueSelectedByAsset.get(asset) ?? 0) + 1);
                let samples = topMeanRawUniqueSamplesByAsset.get(asset);
                if (!samples) {
                    samples = { returns: [], deltas: [] };
                    topMeanRawUniqueSamplesByAsset.set(asset, samples);
                }
                samples.returns.push(selectedReturn);
                samples.deltas.push(delta);
                appendEventDetail(
                    "TOP_MEAN_RAW_UNIQUE",
                    "long",
                    view.topMeanRawUniquePool.find((candidate) => candidate.assetIndex === view.topMeanRawUnique)!,
                    selectedReturn,
                    controlReturn,
                    view.topMeanRawUniquePool.length,
                );
            };
            appendSelection(topRaw, view.topRaw);
            appendSelection(topMean, view.topMean);
            const topMeanReturn = retByAsset.get(view.topMean)!;
            const topMeanOutcome = incumbentOutcome!;
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
                "TOP_MEAN",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.topMean)!,
                retByAsset.get(view.topMean)!,
                randomMeanOf(view.topMean),
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
        }

        // Profit-arm-only events (no ordinary view): evaluate the profit arms
        // on their own pools. Picks resolve here with the same FNV-1a
        // event-time/asset tie-break the Phase 3 picker uses.
        const pickFromPool = (pool: readonly Candidate[], key: "raw" | "mean", timeSec: number): number => {
            if (pool.length < 2) return -1;
            let best = pool[0]![key]!;
            for (let i = 1; i < pool.length; i += 1) {
                const v = pool[i]![key]!;
                if (v > best) best = v;
            }
            const tied = pool.filter((c) => c[key] === best);
            let winner = tied[0]!;
            if (tied.length > 1) {
                let dW = tieBreakDigest(timeSec, assetNames[winner.assetIndex]!);
                for (let i = 1; i < tied.length; i += 1) {
                    const c = tied[i]!;
                    const dC = tieBreakDigest(timeSec, assetNames[c.assetIndex]!);
                    if (dC < dW || (dC === dW && assetNames[c.assetIndex]! < assetNames[winner.assetIndex]!)) {
                        winner = c;
                        dW = dC;
                    }
                }
            }
            return winner.assetIndex;
        };
        for (let pi = 0; pi < gapFilteredProfitOnlyEvents.length; pi += 1) {
            const pe = gapFilteredProfitOnlyEvents[pi];
            const perAssetProfitOnly = returnsByView[views.length + pi];
            if (!perAssetProfitOnly) continue;
            appendProfitArms(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitPositives,
                pickUsableMax(pe.profitPositives, "raw", pe.timeSec)?.winner.assetIndex ?? -1,
                pickUsableMax(pe.profitPositives, "mean", pe.timeSec)?.winner.assetIndex ?? -1,
                "TOP_RAW_PROFIT",
                "TOP_MEAN_PROFIT",
                topRawProfit,
                topMeanProfit,
                topRawProfitSelectedByAsset,
                topRawProfitSamplesByAsset,
                topMeanProfitSelectedByAsset,
                topMeanProfitSamplesByAsset,
            );
            appendProfitArms(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitNowPositives,
                pickUsableMax(pe.profitNowPositives, "raw", pe.timeSec)?.winner.assetIndex ?? -1,
                pickUsableMax(pe.profitNowPositives, "mean", pe.timeSec)?.winner.assetIndex ?? -1,
                "TOP_RAW_PROFIT_NOW",
                "TOP_MEAN_PROFIT_NOW",
                topRawProfitNow,
                topMeanProfitNow,
                topRawProfitNowSelectedByAsset,
                topRawProfitNowSamplesByAsset,
                topMeanProfitNowSelectedByAsset,
                topMeanProfitNowSamplesByAsset,
            );
            appendConfidenceProfitArm(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitNowConfidencePositives,
                pickFromPool(pe.profitNowConfidencePositives, "raw", pe.timeSec),
            );
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
            // The mean delta survives only as the derivation of `randomMean`;
            // the reported delta is the robust median of the paired deltas.
            const deltaMean = meanOrNull(deltasArr);
            const randomMean = topMean !== null && deltaMean !== null ? finiteOrNull(topMean - deltaMean) : null;
            const sortedTop = [...topReturns].sort((a, b) => a - b);
            const sortedDeltas = [...deltasArr].sort((a, b) => a - b);
            // Chronological blocks by event time.
            const blocks = splitIntoBlocks(deltasArr, times, blockCount);
            const blockMeans = blocks.map((blk) => blk.reduce((s, x) => s + x, 0) / blk.length);
            const { lower, upper } = blockBootstrapMedianCi(blocks, bootstrapSamples);
            return {
                events: sampleCount,
                topMean,
                randomMean,
                delta: finiteOrNull(median(sortedDeltas)),
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
        // TOP_MEAN dominant-asset exclusion: mirrors the TOP_RAW pattern for
        // the coverage-adjusted arm. The most-frequently-selected TOP_MEAN
        // asset is dropped; the remaining events form the comparison.
        const topMeanByAsset = buildAssetSelectionBreakdown(topMeanSelectedByAsset, topMeanSamplesByAsset).byAsset;
        const topMeanDominantAsset = topMeanByAsset[0]?.asset ?? null;
        const topMeanExDominant = buildExDominantComparison(topMean, topMeanDominantAsset, buildComparison);
        const topMeanRawUniqueByAsset = buildAssetSelectionBreakdown(
            topMeanRawUniqueSelectedByAsset,
            topMeanRawUniqueSamplesByAsset,
        ).byAsset;
        const topMeanRawUniqueDominantAsset = topMeanRawUniqueByAsset[0]?.asset ?? null;
        const topMeanRawUniqueExDominant = buildExDominantComparison(
            topMeanRawUnique,
            topMeanRawUniqueDominantAsset,
            buildComparison,
        );
        const topRawProfitByAsset = buildAssetSelectionBreakdown(
            topRawProfitSelectedByAsset,
            topRawProfitSamplesByAsset,
        ).byAsset;
        const topRawProfitDominantAsset = topRawProfitByAsset[0]?.asset ?? null;
        const topRawProfitExDominant = buildExDominantComparison(
            topRawProfit,
            topRawProfitDominantAsset,
            buildComparison,
        );
        const topMeanProfitByAsset = buildAssetSelectionBreakdown(
            topMeanProfitSelectedByAsset,
            topMeanProfitSamplesByAsset,
        ).byAsset;
        const topMeanProfitDominantAsset = topMeanProfitByAsset[0]?.asset ?? null;
        const topMeanProfitExDominant = buildExDominantComparison(
            topMeanProfit,
            topMeanProfitDominantAsset,
            buildComparison,
        );
        const topRawProfitNowByAsset = buildAssetSelectionBreakdown(
            topRawProfitNowSelectedByAsset,
            topRawProfitNowSamplesByAsset,
        ).byAsset;
        const topRawProfitNowDominantAsset = topRawProfitNowByAsset[0]?.asset ?? null;
        const topRawProfitNowExDominant = buildExDominantComparison(
            topRawProfitNow,
            topRawProfitNowDominantAsset,
            buildComparison,
        );
        const topMeanProfitNowByAsset = buildAssetSelectionBreakdown(
            topMeanProfitNowSelectedByAsset,
            topMeanProfitNowSamplesByAsset,
        ).byAsset;
        const topMeanProfitNowDominantAsset = topMeanProfitNowByAsset[0]?.asset ?? null;
        const topMeanProfitNowExDominant = buildExDominantComparison(
            topMeanProfitNow,
            topMeanProfitNowDominantAsset,
            buildComparison,
        );
        const topRawProfitNowConfByAsset = buildAssetSelectionBreakdown(
            topRawProfitNowConfSelectedByAsset,
            topRawProfitNowConfSamplesByAsset,
        ).byAsset;
        const topRawProfitNowConfDominantAsset = topRawProfitNowConfByAsset[0]?.asset ?? null;
        const topRawProfitNowConfExDominant = buildExDominantComparison(
            topRawProfitNowConf,
            topRawProfitNowConfDominantAsset,
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
        const topMeanPnl = computeSelectorPnl(topMean.returns, topMean.times);
        const randomPnlReturns: number[] = [];
        for (let i = 0; i < topMean.returns.length; i += 1) {
            const selected = topMean.returns[i]!;
            const delta = topMean.deltas[i]!;
            randomPnlReturns.push(selected - delta);
        }
        const randomPnl = computeSelectorPnl(randomPnlReturns, topMean.times);
        const topMeanPortfolio = simulateTopMeanPortfolio(topMeanPortfolioOpportunities);
        horizonResults.push({
            bars: horizons[hIdx]!,
            topRaw: buildComparison(topRaw.deltas, topRaw.returns, topRaw.times),
            topMean: buildComparison(topMean.deltas, topMean.returns, topMean.times),
            topMeanRawUnique: buildComparison(topMeanRawUnique.deltas, topMeanRawUnique.returns, topMeanRawUnique.times),
            topMeanRawUniqueByAsset,
            topMeanRawUniqueExDominant,
            topMeanRawUniqueDominantAsset,
            topRawProfit: buildComparison(topRawProfit.deltas, topRawProfit.returns, topRawProfit.times),
            topRawProfitByAsset,
            topRawProfitExDominant,
            topRawProfitDominantAsset,
            topMeanProfit: buildComparison(topMeanProfit.deltas, topMeanProfit.returns, topMeanProfit.times),
            topMeanProfitByAsset,
            topMeanProfitExDominant,
            topMeanProfitDominantAsset,
            topRawProfitNow: buildComparison(topRawProfitNow.deltas, topRawProfitNow.returns, topRawProfitNow.times),
            topRawProfitNowByAsset,
            topRawProfitNowExDominant,
            topRawProfitNowDominantAsset,
            topMeanProfitNow: buildComparison(topMeanProfitNow.deltas, topMeanProfitNow.returns, topMeanProfitNow.times),
            topMeanProfitNowByAsset,
            topMeanProfitNowExDominant,
            topMeanProfitNowDominantAsset,
            topRawProfitNowConf: buildComparison(
                topRawProfitNowConf.deltas,
                topRawProfitNowConf.returns,
                topRawProfitNowConf.times,
            ),
            topRawProfitNowConfByAsset,
            topRawProfitNowConfExDominant,
            topRawProfitNowConfDominantAsset,
            topRawExDominant,
            topMeanExDominant,
            topMeanDominantAsset,
            topMeanExTopContrib,
            topMeanTopContribAsset,
            dominantAsset,
            topRawByAsset,
            topMeanByAsset,
            pnl: {
                topMean: topMeanPnl,
                random: randomPnl,
                topMeanPortfolio,
            },
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
                MEAN: { events: n, sameSelection: tieCounts.MEAN, rate: n > 0 ? tieCounts.MEAN / n : null },
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
        if (!assetsWithData.has(aIdx) && !dataGapAssets.has(aIdx)) missingAssets.add(aIdx);
    }
    const omittedDataGapAssets = [...dataGapAssets.keys()]
        .filter((aIdx) => positiveRequestedAssets.has(aIdx));
    const omittedAssets = missingAssets.size + omittedDataGapAssets.length;
    if (omittedAssets > 0) {
        if (missingAssets.size > 0) {
            warnings.push(`${missingAssets.size} candidate asset(s) had no usable target dataset; their events were omitted, not zero-filled: ${[...missingAssets].map((i) => assetNames[i]).join(", ")}.`);
        }
        if (omittedDataGapAssets.length > 0) {
            warnings.push(`${omittedDataGapAssets.length} candidate asset(s) were skipped because a data gap overlapped the selected replay window; they were excluded from selector pools: ${omittedDataGapAssets.map((i) => assetNames[i]).join(", ")}.`);
        }
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
    if (dataGapEvents.size > 0) {
        warnings.push(`${dataGapEvents.size} event(s) were omitted because fewer than two usable positive candidates remained after data-gap filtering.`);
    }
    warnings.push("Stock/marked-leg datasets may carry split/corporate-action discontinuities; verify adjustment before treating this as a tradeable verdict.");
    warnings.push("P&L experiments use equal 1-unit event notional; overlapping entries are summed without compounding and are not live account returns.");
    warnings.push("TOP_MEAN_1K_PORTFOLIO uses fixed $1,000 entries, skips TOP_MEAN ties and same-asset overlap, and reports realized-only drawdown; no global bankroll cap or mark-to-market equity is assumed.");

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
        // Echo the EFFECTIVE weighting: a weight set without the lookup is
        // defensively off, and the report must not claim otherwise.
        capTilt: capTiltWeight !== null && lookupMarketCap !== null ? capTiltWeight : "off",
        capTiltCoverage,
        capTiltWindowCoverage,
        capTiltCarryInCoverage,
        capTiltUnknownAssets,
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
    capTilt: OpenScoreUsdCapTiltWeight;
    /** Present only while the tilt was active (effective weight ≠ off). */
    capTiltCoverage?: { long: number; known: number; weighted: number; unknown: number } | null;
    capTiltWindowCoverage: { long: number; known: number; weighted: number; unknown: number };
    capTiltCarryInCoverage: { long: number; known: number; weighted: number; unknown: number };
    capTiltUnknownAssets: Map<string, number>;
}): string[] {
    const lines: string[] = [];
    const status = args.complete ? "DATA_COMPLETE" : "DATA_INCOMPLETE";
    const comparisonLine = (label: string, comparison: ReplayComparison): string =>
        `${label.padEnd(14)} n=${comparison.events} top=${fmtPct(comparison.topMean)} rand=${fmtPct(comparison.randomMean)} ` +
        `deltaMed=${fmtPct(comparison.delta)} CI95=[${fmtPct(comparison.ciLower)},${fmtPct(comparison.ciUpper)}] ` +
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
    lines.push(`config | interval=${args.interval ?? "n/a"} window=${args.sampleFromSec === null ? "start" : new Date(args.sampleFromSec * 1000).toISOString().slice(0, 10)}..${args.sampleToSec === null ? "end" : new Date(args.sampleToSec * 1000).toISOString().slice(0, 10)} horizons=[${args.horizonsList.join(",")}] slippageRate=${args.slippageRate} commissionRate=${args.commissionRate} capTilt=${args.capTilt}`);
    if (args.capTilt === "smallBase2x") {
        lines.push("cap tilt | base leg of long pairs x2 when base cap < quote cap at entry; unknown caps weight 1; same weight applied at exit (round-trip neutral)");
    } else if (args.capTilt === "largeBase2x") {
        lines.push("cap tilt | base leg of long pairs x2 when base cap > quote cap at entry; unknown caps weight 1; same weight applied at exit (round-trip neutral)");
    } else if (args.capTilt === "similarCap2x") {
        lines.push("cap tilt | both legs of long pairs x2 (+2/-2) when larger/smaller entry cap <= 3; unknown or nonpositive caps weight 1; shorts unchanged; same weights applied at exit (round-trip neutral)");
    }
    if (args.capTiltCoverage) {
        const cov = args.capTiltCoverage;
        // This legacy count covers all scanned history, not the report window.
        lines.push(`cap tilt coverage | long=${cov.long} known=${cov.known} weighted=${cov.weighted} unknown=${cov.unknown}`);
        lines.push("cap tilt coverage scope | above=all historical long entries; below=report-window entries and pre-window positions still open at window start; caps classified at original entry");
        for (const [label, coverage] of [
            ["entries in window", args.capTiltWindowCoverage],
            ["carried into window", args.capTiltCarryInCoverage],
        ] as const) {
            lines.push(`cap tilt ${label} | long=${coverage.long} known=${coverage.known} weighted=${coverage.weighted} unknown=${coverage.unknown}`);
        }
        if (args.capTiltUnknownAssets.size > 0) {
            const missing = [...args.capTiltUnknownAssets].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            lines.push(`cap tilt unknown assets | window entries + carry-in, missing leg counts (a trade can count twice): ${missing.map(([asset, count]) => `${asset}=${count}`).join(", ")}`);
            lines.push("cap tilt coverage warning | unknown entry caps use weight 1; check marketcap files and first covered dates for the listed assets before comparing tilted runs");
        }
    }
    lines.push(`retained pair degree min/median/max = ${args.degree.min}/${fmtNum(args.degree.median)}/${args.degree.max}`);
    lines.push("controls | TOP_MEAN=raw/activePairs TOP_RAW_PROFIT=raw score counted only from pairs whose pair backtest netted >0 (look-ahead) TOP_MEAN_PROFIT=that raw / open profitable-pair count TOP_RAW_PROFIT_NOW=same filter using only pnl realized at or before each event (causal) TOP_MEAN_PROFIT_NOW=that raw / open realized-profitable-pair count TOP_RAW_PROFIT_NOW_CONF=causal PROFIT_NOW score weighted by realized net/gross P&L consistency with one-trade shrinkage");
    lines.push("TOP_MEAN_RAW_UNIQUE rule | TOP_MEAN tied set -> unique raw-score maximum; residual raw ties skipped; control=mean return of the TOP_MEAN tied set");
    lines.push("pnl model | OVERLAP=long selector vs same-pool random positive, every eligible event; *_1K=$1000/trade, exact selector ties skipped, one open trade per asset; deltaMed=median of per-event (selected - pool mean) deltas so one outlier mover cannot flip a window; CI95 block-bootstraps that median; selected-assets breakdown lines still report per-asset MEAN deltas");
    for (const h of args.horizons) {
        const coverageRate = args.candidateEvents > 0 ? h.topRaw.events / args.candidateEvents : 0;
        const coverageStatus = h.topRaw.events === 0
            ? "NO_USABLE_EVENTS"
            : h.topRaw.events < args.candidateEvents
                ? "PARTIAL"
                : "FULL";
        lines.push(`--- horizon ${h.bars} bar(s) | coverage=${h.topRaw.events}/${args.candidateEvents} (${(coverageRate * 100).toFixed(1)}%) ${coverageStatus} ---`);
        lines.push(comparisonLine("TOP_RAW_PROFIT_NOW", h.topRawProfitNow));
        lines.push(comparisonLine(`RAW_PROFIT_NOW_EX_${h.topRawProfitNowDominantAsset ?? "NONE"}`, h.topRawProfitNowExDominant));
        lines.push(comparisonLine("TOP_MEAN_PROFIT_NOW", h.topMeanProfitNow));
        lines.push(comparisonLine(`MEAN_PROFIT_NOW_EX_${h.topMeanProfitNowDominantAsset ?? "NONE"}`, h.topMeanProfitNowExDominant));
        lines.push(comparisonLine("TOP_RAW_PROFIT_NOW_CONF", h.topRawProfitNowConf));
        lines.push(comparisonLine(`RAW_PROFIT_NOW_CONF_EX_${h.topRawProfitNowConfDominantAsset ?? "NONE"}`, h.topRawProfitNowConfExDominant));
        lines.push(comparisonLine("TOP_RAW", h.topRaw));
        lines.push(comparisonLine("TOP_MEAN", h.topMean));
        lines.push(comparisonLine("TOP_MEAN_RAW_UNIQUE", h.topMeanRawUnique));
        lines.push(comparisonLine(`TOP_MEAN_RAW_UNIQUE_EX_${h.topMeanRawUniqueDominantAsset ?? "NONE"}`, h.topMeanRawUniqueExDominant));
        lines.push(comparisonLine("TOP_RAW_PROFIT", h.topRawProfit));
        lines.push(comparisonLine(`RAW_PROFIT_EX_${h.topRawProfitDominantAsset ?? "NONE"}`, h.topRawProfitExDominant));
        lines.push(comparisonLine("TOP_MEAN_PROFIT", h.topMeanProfit));
        lines.push(comparisonLine(`MEAN_PROFIT_EX_${h.topMeanProfitDominantAsset ?? "NONE"}`, h.topMeanProfitExDominant));
        lines.push(pnlLine("TOP_MEAN_PNL", h.pnl.topMean));
        lines.push(pnlLine("RANDOM_PNL", h.pnl.random));
        lines.push(portfolioLine("TOP_MEAN", h.pnl.topMeanPortfolio));
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
        // Per-selector tie rate.
        const tieLine = (name: string, k: keyof typeof h.tieRates): string =>
            `${name}=${h.tieRates[k].sameSelection}/${h.tieRates[k].events} (${h.tieRates[k].rate === null ? "n/a" : (h.tieRates[k].rate! * 100).toFixed(1) + "%"})`;
        const tieTokens = [
            tieLine("RAW", "RAW"),
            tieLine("MEAN", "MEAN"),
        ];
        lines.push(`tie rates | ${tieTokens.join(" ")}`);
        const assetBreakdown = h.topRawByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW selected assets = ${assetBreakdown || "n/a"}${h.topRawByAsset.length > 5 ? ` | other=${h.topRawByAsset.length - 5} assets` : ""}`);
        const topMeanBreakdown = h.topMeanByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN selected assets = ${topMeanBreakdown || "n/a"}${h.topMeanByAsset.length > 5 ? ` | other=${h.topMeanByAsset.length - 5} assets` : ""}`);
        const topMeanRawUniqueBreakdown = h.topMeanRawUniqueByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_RAW_UNIQUE selected assets = ${topMeanRawUniqueBreakdown || "n/a"}${h.topMeanRawUniqueByAsset.length > 5 ? ` | other=${h.topMeanRawUniqueByAsset.length - 5} assets` : ""}`);
        const topRawProfitBreakdown = h.topRawProfitByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW_PROFIT selected assets = ${topRawProfitBreakdown || "n/a"}${h.topRawProfitByAsset.length > 5 ? ` | other=${h.topRawProfitByAsset.length - 5} assets` : ""}`);
        const topMeanProfitBreakdown = h.topMeanProfitByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_PROFIT selected assets = ${topMeanProfitBreakdown || "n/a"}${h.topMeanProfitByAsset.length > 5 ? ` | other=${h.topMeanProfitByAsset.length - 5} assets` : ""}`);
        const topRawProfitNowBreakdown = h.topRawProfitNowByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW_PROFIT_NOW selected assets = ${topRawProfitNowBreakdown || "n/a"}${h.topRawProfitNowByAsset.length > 5 ? ` | other=${h.topRawProfitNowByAsset.length - 5} assets` : ""}`);
        const topMeanProfitNowBreakdown = h.topMeanProfitNowByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_MEAN_PROFIT_NOW selected assets = ${topMeanProfitNowBreakdown || "n/a"}${h.topMeanProfitNowByAsset.length > 5 ? ` | other=${h.topMeanProfitNowByAsset.length - 5} assets` : ""}`);
        const topRawProfitNowConfBreakdown = h.topRawProfitNowConfByAsset.slice(0, 5).map((x) =>
            `${x.asset}:n=${x.events},share=${(x.share * 100).toFixed(1)}%,delta=${fmtPct(x.delta)}`,
        ).join(" | ");
        lines.push(`TOP_RAW_PROFIT_NOW_CONF selected assets = ${topRawProfitNowConfBreakdown || "n/a"}${h.topRawProfitNowConfByAsset.length > 5 ? ` | other=${h.topRawProfitNowConfByAsset.length - 5} assets` : ""}`);
        lines.push(`active pair count at events min/median/max = ${h.candidateDegree.min}/${fmtNum(h.candidateDegree.median)}/${h.candidateDegree.max} topAssetShare=${h.candidateDegree.topAssetShare === null ? "n/a" : (h.candidateDegree.topAssetShare * 100).toFixed(1) + "%"}`);
        lines.push(`selected TOP_RAW retained degree min/median/max = ${h.selectedDegree.min}/${fmtNum(h.selectedDegree.median)}/${h.selectedDegree.max}`);
    }
    for (const w of args.warnings) lines.push(`WARN: ${w}`);
    lines.push(`elapsed=${((Date.now() - args.startedAt) / 1000).toFixed(1)}s`);
    return lines;
}
