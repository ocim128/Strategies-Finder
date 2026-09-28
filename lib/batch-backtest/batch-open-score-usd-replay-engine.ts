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
 * ./batch-synthetic-artifact (artifact types), and the ./open-score-replay
 * submodules (public contracts, statistics, P&L, report) only. No DOM, no
 * runtime lightweight-charts — safe for the vite cjs config bundle.
 */
import type { OHLCVData } from "../types/strategies";
import { applySlippage, timeToNumber } from "../strategies/backtest/backtest-utils";
import { findCandleGaps, type CandleGap } from "../ibkr-data/candle-gap";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import { tieBreakDigest, MAX_ACTIVE_BLOCK_COUNT, MAX_ACTIVE_BOOTSTRAP_SAMPLES } from "./max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    CandidateOutcomeStatus,
    OpenScoreUsdEventDetail,
    OpenScoreUsdEventDetailSelector,
    OpenScoreUsdLatestSelection,
    OpenScoreUsdLatestSelectionCandidate,
    OpenScoreUsdLatestSelections,
    OpenScoreUsdLatestSelectorName,
    OpenScoreUsdOngoingEventDetail,
    OpenScoreUsdReplayResult,
    OpenScoreUsdSharedOutcomeRecord,
    OpenScoreUsdTarget,
    PoolSnapshotRecord,
    ReplayComparison,
    RunOpenScoreUsdReplayOptions,
    SelectorName,
    TopMeanPortfolioOpportunity,
} from "./open-score-replay/types";


// ============================================================================
// Compatibility re-exports. The implementations live in ./open-score-replay/*
// modules; these keep every historical import path on the engine entry point
// valid. Internal stage modules import the contracts directly, never through
// this entry point.
// ============================================================================

export type {
    ReplayComparison,
    SelectorPnlSummary,
    TopMeanPortfolioOpportunity,
    TopMeanPortfolioSummary,
    DegreeSummary,
    AssetSelectionSummary,
    SelectorAgreement,
    OpenScoreUsdLatestSelectorName,
    OpenScoreUsdLatestSelectionCandidate,
    OpenScoreUsdLatestSelection,
    OpenScoreUsdLatestSelections,
    OpenScoreUsdEventDetailSelector,
    OpenScoreUsdEventDetail,
    OpenScoreUsdOngoingEventDetail,
    CandidateOutcomeStatus,
    PoolSnapshotRecord,
    CandidateOutcomeRecord,
    OpenScoreUsdReplayResult,
    SelectorName,
    OpenScoreUsdTarget,
    OpenScoreUsdSharedOutcomeRecord,
    OpenScoreUsdSharedTargetCacheEntry,
    OpenScoreUsdCapTiltWeight,
    RunOpenScoreUsdReplayOptions,
} from "./open-score-replay/types";
export {
    computeProfitNowConfidenceWeight,
    buildAssetSelectionBreakdown,
    buildExDominantComparison,
    blockBootstrapMedianCi,
} from "./open-score-replay/statistics";
export type {
    SelectorSamplesByAsset,
    SelectorExclusionSeries,
} from "./open-score-replay/statistics";
export { computeSelectorPnl, simulateTopMeanPortfolio } from "./open-score-replay/pnl";

import {
    buildAssetSelectionBreakdown,
    buildExDominantComparison,
    blockBootstrapMedianCi,
    degreeSummary,
    finiteOrNull,
    meanOrNull,
    median,
    splitIntoBlocks,
} from "./open-score-replay/statistics";
import { computeSelectorPnl, simulateTopMeanPortfolio } from "./open-score-replay/pnl";
import { scanArtifacts } from "./open-score-replay/artifact-scan";
import type { DecisionEvent, ScoreDelta } from "./open-score-replay/internal-types";
import { yieldLoop } from "./open-score-replay/runtime";
import { buildReportLines } from "./open-score-replay/report";

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
// ============================================================================
// Internal flat records (scalar, bounded by trades/events — no per-trade object
// retention beyond the compact delta stream).
// ============================================================================


// ============================================================================
// Main engine
// ============================================================================

/**
 * @param artifactLoader Async iterator yielding one artifact at a time. The
 *   engine extracts compact score deltas and releases the reference before the
 *   next load — never holds the full pair universe in memory.
 * @param targetLoader Async iterator yielding one target dataset at a time.
 *   Consumed after events are formed; each dataset is released once all event
 *   requests for that asset are consumed. Optional when
 *   `options.loadTargetDataset` supplies a lazy per-asset source instead —
 *   exactly one of the two must be available.
 */
export async function runOpenScoreUsdReplay(
    artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>,
    targetLoader: (() => AsyncIterable<OpenScoreUsdTarget>) | undefined,
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
    // Stage implementation: ./open-score-replay/artifact-scan.ts.
    const scanOutcome = await scanArtifacts({
        artifactLoader,
        shouldStop,
        onPhase,
        capTiltWeight,
        lookupMarketCap,
        capTiltActive,
        sampleFromSec: options.sampleFromSec,
        sampleToSec: options.sampleToSec,
    });
    if (!scanOutcome.ok) {
        const { reportLine, pairs, assets, totalEvents } = scanOutcome.earlyExit;
        return emptyResult({
            reportLines: [reportLine],
            ...(pairs !== undefined ? { pairs } : {}),
            ...(assets !== undefined ? { assets } : {}),
            ...(totalEvents !== undefined ? { totalEvents } : {}),
        });
    }
    const scan = scanOutcome.result;
    const { assetIndexByName, assetNames, streams, profitableStreams, pairCount, omittedPairs, capTiltCoverage, capTiltWindowCoverage, capTiltCarryInCoverage, capTiltUnknownAssets } = scan;
    /** @deprecated alias for {@link scan.retainedDegree}; use that name in new code. */
    const staticDegree = scan.retainedDegree;


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
    // Causal PROFIT_NOW vote applicability travels ON each delta
    // (ScoreDelta.voteApplied, precomputed per trade at scan time), so the
    // post-group apply below needs no per-stream state; the apply replays the
    // flat bucket range directly (event-sweep plan phase 3).
    let events: DecisionEvent[] = [];
    const sampleFrom = options.sampleFromSec;
    const sampleTo = options.sampleToSec;
    // Sweep bound (event-sweep plan phase 2): buckets are ascending, so once
    // a timestamp passes the finite inclusive sampleToSec no further event
    // can be stored — stop before applying that bucket. The pre-window
    // buckets still run to completion (starting at sampleFromSec would lose
    // carried positions and causal state), and the artifact scan, ledger,
    // static degrees, profitability flags, and cap-tilt coverage above
    // intentionally describe the full artifact and stay untouched.
    const sweepDeltaTotal = sampleTo === undefined
        ? totalDeltas
        : (() => {
            let lo = 0;
            let hi = bucketTimes.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if ((bucketTimes[mid] ?? Number.POSITIVE_INFINITY) > sampleTo) hi = mid;
                else lo = mid + 1;
            }
            // Deltas strictly before the first out-of-bounds bucket.
            return lo < bucketStart.length ? (bucketStart[lo] ?? totalDeltas) : totalDeltas;
        })();

    let popped = 0;
    for (let b = 0; b < bucketTimes.length; b += 1) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | cancelled during event sweep."] });
        const t = bucketTimes[b]!;
        if (sampleTo !== undefined && t > sampleTo) break;
        let hasEntry = false;
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
            if (d.isEntry === 1) hasEntry = true;
            popped += 1;
            // A single timestamp can contain many pair deltas. Check and yield
            // inside the timestamp group so Stop remains observable even before
            // all same-time deltas have been applied. Candidate formation still
            // waits until the group is complete below.
            if (popped % 2000 === 0) {
                // The denominator is the bounded sweep total — the same
                // bucket-boundary derivation stops the loop — so progress
                // stays monotonic and reaches 100% without claiming the
                // unvisited post-bound deltas were processed.
                onPhase("events", `merged ${popped}/${sweepDeltaTotal} deltas`, popped, sweepDeltaTotal);
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
        //
        // Event-sweep plan phase 3: replay the SAME bucket range over the
        // original ScoreDelta objects instead of the per-delta copies this
        // loop used to consume — the deltas are not mutated between passes,
        // and the second pass reads only fields the first pass never touches
        // (voteApplied/delta/isEntry/profitNowConfidenceWeight), so operation
        // order and every accumulated value are identical without the
        // per-delta object allocation.
        const bucketStartIndex = bucketStart[b]!;
        for (let i = bucketStartIndex; i < bucketEnd; i += 1) {
            const d = flatDeltas[i]!;
            if (!d.voteApplied) continue;
            profitNowRawScore[d.assetIndex]! += d.delta;
            const countDeltaNow = d.isEntry === 1 ? 1 : -1;
            const nextNow = profitNowPairCount[d.assetIndex]! + countDeltaNow;
            profitNowPairCount[d.assetIndex] = nextNow > 0 ? nextNow : 0;
            if (d.profitNowConfidenceWeight > 0) {
                profitNowConfidenceScore[d.assetIndex]! += d.delta * d.profitNowConfidenceWeight;
                const nextConfidence = profitNowConfidencePairCount[d.assetIndex]! + countDeltaNow;
                profitNowConfidencePairCount[d.assetIndex] = nextConfidence > 0 ? nextConfidence : 0;
            }
        }
        // Exit-only score changes do not create a decision event.
        if (hasEntry) {
            if ((sampleFrom === undefined || t >= sampleFrom) && (sampleTo === undefined || t <= sampleTo)) {
                events.push({
                    timeSec: t,
                    rawScore: Float64Array.from(rawScore),
                    activePairCount: Float64Array.from(activePairCount),
                    rawScoreProfit: Float64Array.from(profitRawScore),
                    activePairCountProfit: Float64Array.from(profitPairCount),
                    rawScoreProfitNow: Float64Array.from(profitNowRawScore),
                    activePairCountProfitNow: Float64Array.from(profitNowPairCount),
                    rawScoreProfitNowConf: Float64Array.from(profitNowConfidenceScore),
                    activePairCountProfitNowConf: Float64Array.from(profitNowConfidencePairCount),
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
        /**
         * TOP_Z causal z-surprise of this candidate's PROFIT_NOW raw score vs
         * the asset's own prior decision-event history. Set only on
         * profit-now pool members (computed for every asset at every event).
         */
        z?: number;
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
        /** Z-surprise causal pick, or -1 when its pool has < 2 members. */
        topZ: number;  // assetIndex
        /** Max active-pair count across positive candidates at this event. */
        maxActivePairs: number;
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
    // TOP_Z per-asset causal z-surprise state (Welford) over each asset's own
    // PROFIT_NOW raw score at PRIOR decision events. Empty history is mean 0 /
    // std 0, so with the max(std, 1)-vote denominator floor the first surprise
    // equals the raw count. Updated AFTER each event's pools are built.
    const zWelfordMean = new Float64Array(assetCount);
    const zWelfordM2 = new Float64Array(assetCount);
    const zWelfordCount = new Float64Array(assetCount);
    const zSurprise = (a: number, score: number): number => {
        const n = zWelfordCount[a]!;
        if (n <= 0) return score;
        const variance = zWelfordM2[a]! / n;
        const z = (score - zWelfordMean[a]!) / Math.max(Math.sqrt(variance), 1);
        return Number.isFinite(z) ? z : 0;
    };
    const updateZStats = (a: number, score: number): void => {
        const n = zWelfordCount[a]!;
        const mean = zWelfordMean[a]!;
        const delta = score - mean;
        const nextMean = mean + delta / (n + 1);
        zWelfordM2[a] = zWelfordM2[a]! + delta * (score - nextMean);
        zWelfordMean[a] = nextMean;
        zWelfordCount[a] = n + 1;
    };
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
            // Redundant-work plan phase 1: the ordinary literal (and its
            // adjusted/mean arithmetic) is only worth building for the
            // positive pool — non-positive assets discarded it immediately.
            // The profit pools and TOP_Z's history update below still run for
            // every asset, and the outer loop must NOT continue early:
            // profitable-pair subsets can be positive with a non-positive
            // ordinary score.
            if (raw > 0) {
                const candidate: Candidate = {
                    assetIndex: a,
                    raw,
                    adjusted: cnt > 0 ? raw / Math.sqrt(cnt) : raw,
                    mean: cnt > 0 ? raw / cnt : raw,
                    activePairs: cnt,
                };
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
                    z: zSurprise(a, rawPnlNow),
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
        // TOP_Z history update: strictly-past semantics — this event's
        // profit-now scores join each asset's history only AFTER the pools
        // above captured this event's z values.
        for (let a = 0; a < assetCount; a += 1) updateZStats(a, ev.rawScoreProfitNow[a]!);
        // Need >= 2 positive candidates for a top-vs-random comparison.
        if (positives.length >= 2) {
            // Phase 0 freeze: tie-break by the versioned FNV-1a 64 digest of
            // `MAX_ACTIVE_TIE_VERSION|tieSeed|truncatedEventTimeSec|scoringAsset`.
            // Smallest digest wins. Asset name and input order are NEVER
            // tie-breaks. On a digest collision (astronomically unlikely),
            // asset-name order keeps execution deterministic.
            const eventTimeSec = ev.timeSec;
            // Selection-aggregation plan phase 3: the digest key is only
            // (version, seed, event time, asset), so one asset's digest is
            // identical across every pickMax in this event. Lazily memoize
            // per assetIndex — the map is allocated only when a tie actually
            // requests a digest and becomes unreachable with the event, so
            // nothing is retained across events.
            let eventDigestCache: Map<number, string> | null = null;
            const digestFor = (c: Candidate): string => {
                const cached = eventDigestCache?.get(c.assetIndex);
                if (cached !== undefined) return cached;
                const digest = tieBreakDigest(eventTimeSec, assetNames[c.assetIndex]!);
                (eventDigestCache ??= new Map()).set(c.assetIndex, digest);
                return digest;
            };
            type RankKey = "raw" | "mean" | "activePairs" | "z";
            const rankValue = (candidate: Candidate, key: RankKey): number =>
                key === "z" ? candidate.z ?? Number.NEGATIVE_INFINITY : candidate[key];
            const pickMax = (candidates: readonly Candidate[], key: RankKey): { winner: Candidate; tiedCount: number } => {
                // First pass: find the max value.
                let maxValue = rankValue(candidates[0]!, key);
                for (let i = 1; i < candidates.length; i += 1) {
                    const v = rankValue(candidates[i]!, key);
                    if (v > maxValue) maxValue = v;
                }
                // Second pass: collect every candidate at the max, then pick by
                // tie-break digest. Counting at the end gives the correct tied
                // total regardless of input order.
                const tiedAtTop: Candidate[] = [];
                for (const c of candidates) {
                    if (rankValue(c, key) === maxValue) tiedAtTop.push(c);
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
            // Causal z-surprise ranking over the profit-now pool.
            const topZ = profitNowPositives.length >= 2
                ? pickMax(profitNowPositives, "z")
                : null;
            views.push({
                timeSec: ev.timeSec, positives,
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
                topZ: topZ?.winner.assetIndex ?? -1,
                maxActivePairs,
                ties: {
                    RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                    MEAN: topMean.tiedCount >= 2 ? 1 : 0,
                },
            });
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
    const emitCandidateOutcome = (row: CandidateOutcomeRecord): void | Promise<void> => {
        if (options.onCandidateOutcome) return options.onCandidateOutcome(row);
        candidateOutcomes?.push(row);
    };
    // EMA side state is compactly retained until all catalog targets have been
    // consumed so breadth can be emitted consistently for every asset at an
    // event.  0=unavailable, 1=above, 2=below.
    const emaSideByEvent = diagnosticsEnabled
        ? new Uint8Array(events.length * diagnosticAssetNames.length)
        : null;
    const emaObservedByEvent = diagnosticsEnabled ? new Uint16Array(events.length) : null;
    const emaAboveByEvent = diagnosticsEnabled ? new Uint16Array(events.length) : null;

    // Replay-efficiency plan phase 1: with BOTH diagnostic sinks disabled
    // (finder_arm), the dense ~8 x assets-per-event Float64Array snapshots
    // have no remaining consumer after view/profit-only/TOP_Z construction —
    // the gapped/missing-target backfills and pool-snapshot emission below
    // are all candidateOutcomes/poolSnapshots-guarded. Release the snapshots
    // before target loads and outcome allocation so the two largest
    // allocations never overlap. Diagnostic/archive runs keep them until the
    // existing release at the end of the outcomes phase.
    if (!diagnosticsEnabled) {
        events = [];
    }

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
    let returnsByView: Array<Map<number, {
        long: number[];
        mtmLong: (number | null)[];
        /** First bar after the decision timestamp — identical for EVERY
         * horizon of this (event, asset), so stored once, not per horizon. */
        entryTime: number;
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

    // Work list: every requested asset plus every diagnostic asset, ascending
    // by the matched name. Per-target processing is independent, so traversal
    // order cannot change results — only progress text.
    const workItems: Array<{
        name: string;
        aIdx: number | undefined;
        diagnosticIdx: number | undefined;
        requests: number[] | undefined;
    }> = [];
    const workItemNames = new Set<string>();
    const addWorkItem = (rawName: string): void => {
        const name = rawName.trim().toUpperCase();
        if (workItemNames.has(name)) return;
        workItemNames.add(name);
        const aIdx = assetIndexByName.get(name);
        workItems.push({
            name,
            aIdx,
            diagnosticIdx: diagnosticAssetIndexByName?.get(name),
            requests: aIdx === undefined ? undefined : requestsByAsset.get(aIdx),
        });
    };
    for (const aIdx of requestsByAsset.keys()) {
        const name = assetNames[aIdx];
        if (name) addWorkItem(name);
    }
    for (const name of diagnosticAssetNames) addWorkItem(name);
    workItems.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Dataset resolution (annual-reload finding). When a lazy loader is
    // injected, only assets NOT fully served by the shared target cache are
    // loaded at all — annual passes whose request sets are cached load zero
    // datasets. Without a lazy loader the streaming `targetLoader` is drained
    // up front and matched by name (prior behavior; also the test path).
    if (!options.loadTargetDataset && !targetLoader) {
        throw new Error("runOpenScoreUsdReplay requires targetLoader or loadTargetDataset");
    }
    const datasetByAsset = new Map<string, OpenScoreUsdTarget>();
    if (!options.loadTargetDataset && targetLoader) {
        for await (const target of targetLoader()) {
            if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, totalEvents, reportLines: ["OPEN_SCORE USD | cancelled during outcome evaluation."] });
            datasetByAsset.set(target.asset.trim().toUpperCase(), target);
        }
    }
    if (options.prefetchTargetDatasets) {
        options.prefetchTargetDatasets(workItems
            .filter((item) => item.diagnosticIdx !== undefined || !options.sharedTargetCache?.has(item.name))
            .map((item) => item.name));
    }
    // Window-scoped first-overlap test over cached gap intervals — identical
    // to findCandleGapOverlapping's scan, but derived from the intervals
    // captured when the dataset was first loaded.
    const firstGapOverlapping = (gapIntervals: readonly CandleGap[]): CandleGap | null => {
        for (const gap of gapIntervals) {
            if (gap.to > (options.sampleFromSec ?? Number.NEGATIVE_INFINITY)
                && gap.from < (options.sampleToSec ?? Number.POSITIVE_INFINITY)) {
                return gap;
            }
        }
        return null;
    };
    // Outcome per (decision time, target) — pure function of the dataset, so
    // the same record serves this pass and every later window's pass.
    const computeSharedOutcomeRecord = (
        data: OHLCVData[],
        times: (number | null)[],
        entryBar: number,
    ): OpenScoreUsdSharedOutcomeRecord => {
        const longReturns: number[] = [];
        const mtmLong: (number | null)[] = [];
        // Same entry bar for every horizon (entry is the first bar after
        // the decision timestamp; horizons only move the exit).
        const entryTime = times[entryBar] ?? Number.NaN;
        const exitTimes: number[] = [];
        const statuses: CandidateOutcomeStatus[] = [];
        for (const h of horizons) {
            const exitBar = entryBar + h - 1; // h bars forward, close of that bar
            if (exitBar >= data.length) {
                longReturns.push(Number.NaN);
                exitTimes.push(Number.NaN);
                statuses.push("right_censored");
                // Unrealized mark-to-market for the ONGOING detail rows:
                // entry open (slippage-adjusted) to the last available bar
                // close, same cost model as the completed path. Null when
                // either price is unusable.
                const rawOpen = data[entryBar]!.open;
                const lastClose = data[data.length - 1]!.close;
                if (
                    Number.isFinite(rawOpen) && rawOpen > 0
                    && Number.isFinite(lastClose) && lastClose > 0
                ) {
                    const mtmEntry = applySlippage(rawOpen, "buy", slippageRate);
                    const mtmExit = applySlippage(lastClose, "sell", slippageRate);
                    const mtmFees = (mtmEntry + mtmExit) * commissionRate;
                    const mtm = (mtmExit - mtmEntry - mtmFees) / mtmEntry;
                    mtmLong.push(Number.isFinite(mtm) ? mtm : null);
                } else {
                    mtmLong.push(null);
                }
                continue;
            }
            const rawOpen = data[entryBar]!.open;
            const exitClose = data[exitBar]!.close;
            if (!Number.isFinite(rawOpen) || rawOpen <= 0 || !Number.isFinite(exitClose) || exitClose <= 0) {
                longReturns.push(Number.NaN);
                mtmLong.push(null);
                exitTimes.push(Number.NaN);
                statuses.push("invalid_price");
                continue;
            }
            exitTimes.push(times[exitBar] ?? Number.NaN);
            mtmLong.push(null);
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
        return { long: longReturns, mtmLong, entryTime, exitTimes, statuses };
    };

    for (const item of workItems) {
        if (shouldStop()) return emptyResult({ pairs: pairCount, assets: assetCount, totalEvents, reportLines: ["OPEN_SCORE USD | cancelled during outcome evaluation."] });
        let data: OHLCVData[] | null = null;
        let cacheEntry = options.sharedTargetCache?.get(item.name) ?? null;
        if (item.diagnosticIdx !== undefined || !cacheEntry) {
            const loaded = options.loadTargetDataset
                ? await options.loadTargetDataset(item.name)
                : datasetByAsset.get(item.name)?.data ?? null;
            // Absent target (mode-dependent): the missing-target backfill
            // below covers it, matching the prior loader-yield semantics.
            if (loaded === null) continue;
            data = loaded;
            if (!cacheEntry) {
                cacheEntry = {
                    gapIntervals: findCandleGaps(data),
                    outcomesByEventTimeSec: new Map(),
                };
                options.sharedTargetCache?.set(item.name, cacheEntry);
            }
        }
        const aIdx = item.aIdx;
        const diagnosticIdx = item.diagnosticIdx;
        const requests = item.requests;
        const dataGap = firstGapOverlapping(cacheEntry!.gapIntervals);
        if ((!requests || requests.length === 0) && diagnosticIdx === undefined) {
            if (dataGap && aIdx !== undefined) dataGapAssets.set(aIdx, dataGap);
            continue;
        }
        targetsSeen += 1;
        if (diagnosticIdx !== undefined) diagnosticTargetsSeen?.add(diagnosticIdx);
        let times = data ? data.map((b) => timeToNumber(b.time)) : null;
        if (dataGap) {
            if (aIdx !== undefined) dataGapAssets.set(aIdx, dataGap);
            if (candidateOutcomes && diagnosticIdx !== undefined) {
                for (const event of events) {
                    const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                    for (const horizonBars of horizons) {
                        const eventId = phase0bEventId(options.interval, event.timeSec);
                        const pendingLongWrite = emitCandidateOutcome({
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
                        if (pendingLongWrite) await pendingLongWrite;
                        const pendingShortWrite = emitCandidateOutcome({
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
                        if (pendingShortWrite) await pendingShortWrite;
                    }
                }
            }
            onPhase(
                "outcomes",
                `skipped ${item.name} (data gap ${new Date(dataGap.from * 1000).toISOString()}..${new Date(dataGap.to * 1000).toISOString()})`,
                targetsSeen,
                totalTargets,
            );
            await yieldLoop();
            continue;
        }
        if (diagnosticIdx !== undefined) {
            // Diagnostic assets always resolve with a dataset above — the
            // resolver loads them before a cache entry can serve this asset.
            const diagnosticData = data!;
            const diagnosticTimes = times!;
            const requestedTimes = requests && requests.length > 0
                ? new Set(requests.map((viewIdx) => eventTimeOf(viewIdx)))
                : null;
            const ema200 = buildEma200(diagnosticData);
            let entryBar = 0;
            for (let eventIdx = 0; eventIdx < events.length; eventIdx += 1) {
                const event = events[eventIdx]!;
                while (entryBar < diagnosticTimes.length) {
                    const barTime = diagnosticTimes[entryBar];
                    if (barTime === null || barTime <= event.timeSec) entryBar += 1;
                    else break;
                }
                const resolvedEntryBar = entryBar < diagnosticTimes.length ? entryBar : -1;
                const trendBar = resolvedEntryBar - 1;
                const trendClose = trendBar >= 0 ? diagnosticData[trendBar]!.close : Number.NaN;
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
                // Selector-requested timestamps for this asset (top-mean
                // coordinator optimization plan, idea #1): their outcome
                // records are built right here from the resolved entry bar
                // and the diagnostic long results, so the request loop below
                // consumes them from the cache without repeating the entry
                // lookup or long-return computation. Only requested events
                // are cached — never every diagnostic row.
                const cacheRecord = resolvedEntryBar >= 0 && requestedTimes?.has(event.timeSec)
                    ? {
                        long: [] as number[],
                        mtmLong: [] as (number | null)[],
                        entryTime: Number.isFinite(diagnosticTimes[resolvedEntryBar]) ? diagnosticTimes[resolvedEntryBar]! : Number.NaN,
                        exitTimes: [] as number[],
                        statuses: [] as CandidateOutcomeStatus[],
                    }
                    : null;
                if (resolvedEntryBar < 0 && requestedTimes?.has(event.timeSec)) {
                    // Missing entry is the existing null cache entry —
                    // distinct from an absent cache key.
                    cacheEntry!.outcomesByEventTimeSec.set(event.timeSec, null);
                }
                const rawScore = aIdx === undefined ? 0 : event.rawScore[aIdx] ?? 0;
                const longEligible = rawScore > 0;
                const shortEligible = rawScore < 0;
                for (let hIdx = 0; hIdx < horizons.length; hIdx += 1) {
                    const horizonBars = horizons[hIdx]!;
                    const longOutcome = computeDiagnosticOutcome(
                        diagnosticData,
                        diagnosticTimes,
                        resolvedEntryBar,
                        horizonBars,
                        "long",
                        slippageRate,
                        commissionRate,
                    );
                    const shortOutcome = computeDiagnosticOutcome(
                        diagnosticData,
                        diagnosticTimes,
                        resolvedEntryBar,
                        horizonBars,
                        "short",
                        slippageRate,
                        commissionRate,
                    );
                    if (cacheRecord) {
                        // Same arithmetic, mapped into the selector record's
                        // representation (censored-before-price status
                        // precedence is identical in both builders). Censored
                        // mark-to-market uses the existing formula —
                        // diagnostic realized returns cannot supply it.
                        if (longOutcome.status === "right_censored") {
                            cacheRecord.long.push(Number.NaN);
                            cacheRecord.exitTimes.push(Number.NaN);
                            cacheRecord.statuses.push("right_censored");
                            const rawOpen = diagnosticData[resolvedEntryBar]!.open;
                            const lastClose = diagnosticData[diagnosticData.length - 1]!.close;
                            if (Number.isFinite(rawOpen) && rawOpen > 0 && Number.isFinite(lastClose) && lastClose > 0) {
                                const mtmEntry = applySlippage(rawOpen, "buy", slippageRate);
                                const mtmExit = applySlippage(lastClose, "sell", slippageRate);
                                const mtmFees = (mtmEntry + mtmExit) * commissionRate;
                                const mtm = (mtmExit - mtmEntry - mtmFees) / mtmEntry;
                                cacheRecord.mtmLong.push(Number.isFinite(mtm) ? mtm : null);
                            } else {
                                cacheRecord.mtmLong.push(null);
                            }
                        } else if (longOutcome.status === "ok") {
                            cacheRecord.long.push(longOutcome.returnValue!);
                            cacheRecord.exitTimes.push(longOutcome.exitTimeSec ?? Number.NaN);
                            cacheRecord.statuses.push("ok");
                            cacheRecord.mtmLong.push(null);
                        } else {
                            cacheRecord.long.push(Number.NaN);
                            cacheRecord.exitTimes.push(Number.NaN);
                            cacheRecord.statuses.push("invalid_price");
                            cacheRecord.mtmLong.push(null);
                        }
                    }
                    const eventId = phase0bEventId(options.interval, event.timeSec);
                    const pendingLongWrite = emitCandidateOutcome({
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
                    if (pendingLongWrite) await pendingLongWrite;
                    const pendingShortWrite = emitCandidateOutcome({
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
                    if (pendingShortWrite) await pendingShortWrite;
                }
                if (cacheRecord) {
                    cacheEntry!.outcomesByEventTimeSec.set(event.timeSec, cacheRecord);
                }
            }
        }
        if (aIdx === undefined || !requests || requests.length === 0) continue;
        for (const viewIdx of requests) {
            const eventTime = eventTimeOf(viewIdx);
            let record = cacheEntry
                ? cacheEntry.outcomesByEventTimeSec.get(eventTime)
                : undefined;
            if (record === undefined && (!data || !times)) {
                // Subset-invariant fallback: the cache was populated by a
                // narrower event set than this pass requests. Reload and
                // compute rather than misreport the event.
                const reloaded = options.loadTargetDataset
                    ? await options.loadTargetDataset(item.name)
                    : datasetByAsset.get(item.name)?.data ?? null;
                if (reloaded === null) continue;
                data = reloaded;
                times = data.map((b) => timeToNumber(b.time));
            }
            if (record === undefined) {
                // First target bar strictly after the decision timestamp.
                const entryBar = firstBarAfter(times!, eventTime);
                if (entryBar < 0) {
                    cacheEntry?.outcomesByEventTimeSec.set(eventTime, null);
                    if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                    continue;
                }
                record = computeSharedOutcomeRecord(data!, times!, entryBar);
                cacheEntry?.outcomesByEventTimeSec.set(eventTime, record);
            }
            if (!record) {
                // Cached noData marker for this decision timestamp.
                if (positiveRequestedAssets.has(aIdx)) noDataEvents.add(viewIdx);
                continue;
            }
            let perAsset = returnsByView[viewIdx];
            if (!perAsset) { perAsset = new Map(); returnsByView[viewIdx] = perAsset; }
            perAsset.set(aIdx, record);
            if (record.long.some((r) => !Number.isFinite(r))) censoredEvents.add(viewIdx);
        }
        onPhase("outcomes", `evaluated ${item.name} (${targetsSeen}/${totalTargets})`, targetsSeen, totalTargets);
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
                    const pendingLongWrite = emitCandidateOutcome({
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
                    if (pendingLongWrite) await pendingLongWrite;
                    const pendingShortWrite = emitCandidateOutcome({
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
                    if (pendingShortWrite) await pendingShortWrite;
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

    // Last consumer of the event snapshots is the pool-snapshot loop above
    // (views/candidates/outcomes already extracted their data). Release the
    // ~8 x assets-per-event payloads before the comparison/aggregation phase
    // allocates its own structures.
    events = [];

    const usableCandidates = (pool: readonly Candidate[]): Candidate[] =>
        pool.filter((candidate) => !dataGapAssets.has(candidate.assetIndex));

    type UsableRankKey = "raw" | "mean" | "activePairs" | "z";
    const usableRankValue = (candidate: Candidate, key: UsableRankKey): number =>
        key === "z" ? candidate.z ?? Number.NEGATIVE_INFINITY : candidate[key];
    const pickUsableMax = (
        pool: readonly Candidate[],
        key: UsableRankKey,
        timeSec: number,
    ): { winner: Candidate; tiedCount: number } | null => {
        if (pool.length === 0) return null;
        let maxValue = usableRankValue(pool[0]!, key);
        for (let i = 1; i < pool.length; i += 1) {
            const value = usableRankValue(pool[i]!, key);
            if (value > maxValue) maxValue = value;
        }
        const tied = pool.filter((candidate) => usableRankValue(candidate, key) === maxValue);
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

    /**
     * Inverted-rank counterpart of {@link pickUsableMax}: same pool, same
     * eligibility, same digest tie-break, but the LOWEST rank value is
     * selected. A missing z ranks as +Infinity so a z-less candidate can
     * never win a min ranking (mirror of pickUsableMax's -Infinity guard).
     */
    const usableRankValueMin = (candidate: Candidate, key: UsableRankKey): number =>
        key === "z" ? candidate.z ?? Number.POSITIVE_INFINITY : candidate[key];
    const pickUsableMin = (
        pool: readonly Candidate[],
        key: UsableRankKey,
        timeSec: number,
    ): { winner: Candidate; tiedCount: number } | null => {
        if (pool.length === 0) return null;
        let minValue = usableRankValueMin(pool[0]!, key);
        for (let i = 1; i < pool.length; i += 1) {
            const value = usableRankValueMin(pool[i]!, key);
            if (value < minValue) minValue = value;
        }
        const tied = pool.filter((candidate) => usableRankValueMin(candidate, key) === minValue);
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
    // No-gap fast path (replay-efficiency plan phase 2): with an empty gap
    // set, filtering is the identity on every pool, so the ORIGINAL EventView
    // already IS the gap-filtered view — pushing it reuses the Phase 3
    // rankings/tie digests verbatim instead of recomputing them. The
    // re-ranking loop below stays the authoritative path for any real gap.
    // Downstream is read-only over views (returnsByView keyed per view; the
    // bot/latest/bottom-side resolvers never mutate pools), so sharing the
    // reference is safe.
    const hasDataGaps = dataGapAssets.size > 0;
    const gapFilteredViews: Array<EventView | null> = [];
    if (!hasDataGaps) {
        for (const source of views) gapFilteredViews.push(source);
    }
    for (let viewIndex = hasDataGaps ? 0 : views.length; viewIndex < views.length; viewIndex += 1) {
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
        const topZ = profitNowPositives.length >= 2
            ? pickUsableMax(profitNowPositives, "z", source.timeSec)
            : null;
        let maxActivePairs = 0;
        for (const candidate of positives) {
            if (candidate.activePairs > maxActivePairs) maxActivePairs = candidate.activePairs;
        }
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
            topZ: topZ?.winner.assetIndex ?? -1,
            maxActivePairs,
            ties: {
                RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                MEAN: topMean.tiedCount >= 2 ? 1 : 0,
            },
        });
    }
    const gapFilteredProfitOnlyEvents: ProfitOnlyEvent[] = profitOnlyEvents.map((source) => ({
        ...source,
        profitPositives: usableCandidates(source.profitPositives),
        profitNowPositives: usableCandidates(source.profitNowPositives),
        profitNowConfidencePositives: usableCandidates(source.profitNowConfidencePositives),
    }));

    /**
     * Inverted (negative-control) picks per gap-filtered view: the same pools
     * and >= 2 gates as the TOP_* arms, but the LOWEST rank value is selected
     * (see {@link pickUsableMin}). BOT_MEAN_RAW_UNIQUE mirrors
     * TOP_MEAN_RAW_UNIQUE on the bottom of the ranking: bottom-mean tied set,
     * then its unique raw MINIMUM (-1 on a residual raw tie). Resolved once
     * per view, before the per-horizon aggregation, exactly like the TOP picks.
     */
    interface BotViewPicks {
        raw: number;
        mean: number;
        meanRawUnique: number;
        meanRawUniquePoolSize: number;
        rawProfitNow: number;
        meanProfitNow: number;
        z: number;
    }
    const resolveBotViewPicks = (view: EventView): BotViewPicks => {
        const botMean = pickUsableMin(view.positives, "mean", view.timeSec)!;
        const bottomMeanTied = view.positives.filter((candidate) => candidate.mean === botMean.winner.mean);
        let meanRawUnique = -1;
        let minRawInBotMeanTie = Number.POSITIVE_INFINITY;
        for (const candidate of bottomMeanTied) {
            if (candidate.raw < minRawInBotMeanTie) minRawInBotMeanTie = candidate.raw;
        }
        const botMeanRawMinRows = bottomMeanTied.filter((candidate) => candidate.raw === minRawInBotMeanTie);
        if (botMeanRawMinRows.length === 1) meanRawUnique = botMeanRawMinRows[0]!.assetIndex;
        const profitNowPicked = view.profitNowPositives.length >= 2;
        return {
            raw: pickUsableMin(view.positives, "raw", view.timeSec)!.winner.assetIndex,
            mean: botMean.winner.assetIndex,
            meanRawUnique,
            meanRawUniquePoolSize: bottomMeanTied.length,
            rawProfitNow: profitNowPicked
                ? pickUsableMin(view.profitNowPositives, "raw", view.timeSec)?.winner.assetIndex ?? -1
                : -1,
            meanProfitNow: profitNowPicked
                ? pickUsableMin(view.profitNowPositives, "mean", view.timeSec)?.winner.assetIndex ?? -1
                : -1,
            z: profitNowPicked
                ? pickUsableMin(view.profitNowPositives, "z", view.timeSec)?.winner.assetIndex ?? -1
                : -1,
        };
    };
    const botPicksByView: Array<BotViewPicks | null> = gapFilteredViews.map((view) =>
        view ? resolveBotViewPicks(view) : null);

    const latestSelections: OpenScoreUsdLatestSelections | null = (() => {
        if (!latestView) return null;

        const pick = (
            selector: OpenScoreUsdLatestSelectorName,
            direction: "long" | "short" | "none",
            pool: readonly Candidate[],
            primary: (candidate: Candidate) => number,
            primaryOrder: "max" | "min",
            secondary?: (candidate: Candidate) => number,
            secondaryOrder: "max" | "min" = "max",
        ): OpenScoreUsdLatestSelection => {
            const usablePool = usableCandidates(pool);
            // Ranked detail for the Latest-picks UI: the arm's top candidates
            // in its own ranking order, capped at 3 so the wire payload stays
            // bounded. Runs once per completed run (latest event, per arm).
            const rankTopCandidates = (): OpenScoreUsdLatestSelectionCandidate[] =>
                [...usablePool]
                    .sort((a, b) => {
                        const pa = primary(a);
                        const pb = primary(b);
                        if (pa !== pb) return primaryOrder === "max" ? pb - pa : pa - pb;
                        if (secondary) {
                            const sa = secondary(a);
                            const sb = secondary(b);
                            if (sa !== sb) return secondaryOrder === "max" ? sb - sa : sa - sb;
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
                    if (secondaryOrder === "max" ? value > bestSecondary : value < bestSecondary) {
                        bestSecondary = value;
                    }
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
                pick("TOP_Z", "long", latestView.profitNowPositives, (candidate) => candidate.z ?? Number.NEGATIVE_INFINITY, "max"),
                pick("BOT_RAW", "long", latestView.positives, (candidate) => candidate.raw, "min"),
                pick("BOT_MEAN", "long", latestView.positives, (candidate) => candidate.mean, "min"),
                pick("BOT_MEAN_RAW_UNIQUE", "long", latestView.positives, (candidate) => candidate.mean, "min", (candidate) => candidate.raw, "min"),
                pick("BOT_RAW_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.raw, "min"),
                pick("BOT_MEAN_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.mean, "min"),
                pick("BOT_Z", "long", latestView.profitNowPositives, (candidate) => candidate.z ?? Number.POSITIVE_INFINITY, "min"),
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
    // Right-censored arm selections: EVERY asset-picking arm reports its pick
    // as ONGOING with the unrealized mark-to-market return, not just TOP_MEAN.
    // A censored pick is exactly one whose realized outcome cannot exist yet,
    // so Control/Delta stay unset by design and the rows stay out of the
    // research aggregates and both copy paths.
    const appendOngoingEventDetail = (
        timeSec: number,
        perAsset: ViewReturns | null | undefined,
        hIdx: number,
        selector: OpenScoreUsdEventDetailSelector,
        selectedAssetIndex: number,
        eligibleCandidates: number,
    ): void => {
        if (!options.includeEventDetails || selectedAssetIndex < 0) return;
        const outcome = perAsset?.get(selectedAssetIndex);
        if (outcome?.statuses[hIdx] !== "right_censored") return;
        const entryTime = outcome.entryTime;
        ongoingEventDetails.push({
            decisionTime: timeSec,
            entryTime: Number.isFinite(entryTime) ? entryTime! : null,
            horizonBars: horizons[hIdx]!,
            selector,
            direction: "long",
            asset: assetNames[selectedAssetIndex]!,
            eligibleCandidates,
            unrealizedReturn: outcome.mtmLong[hIdx] ?? null,
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
        const topZ = createSeries();
        const topMeanPortfolioOpportunities: TopMeanPortfolioOpportunity[] = [];
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
        const topZSelectedByAsset = new Map<string, number>();
        const topZSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        // Inverted (negative-control) arms: series + per-asset breakdown
        // state, mirroring the TOP_* twins above.
        const botRaw = createSeries();
        const botMean = createSeries();
        const botMeanRawUnique = createSeries();
        const botRawProfitNow = createSeries();
        const botMeanProfitNow = createSeries();
        const botZ = createSeries();
        const botRawSelectedByAsset = new Map<string, number>();
        const botRawSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const botMeanSelectedByAsset = new Map<string, number>();
        const botMeanSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const botMeanRawUniqueSelectedByAsset = new Map<string, number>();
        const botMeanRawUniqueSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const botRawProfitNowSelectedByAsset = new Map<string, number>();
        const botRawProfitNowSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const botMeanProfitNowSelectedByAsset = new Map<string, number>();
        const botMeanProfitNowSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
        const botZSelectedByAsset = new Map<string, number>();
        const botZSamplesByAsset = new Map<string, { returns: number[]; deltas: number[] }>();
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
            const entryTime = outcome?.entryTime;
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
        //
        // Shared pool evaluation (top-mean coordinator optimization plan,
        // idea #2): the eligibility scan and return total are computed ONCE
        // per (event, horizon, pool) by `evaluatePool` at the call site and
        // passed in explicitly, instead of every appender call rebuilding a
        // temporary return map. The four causal appender calls over the same
        // profitNowPositives pool therefore evaluate it once.
        const evaluatePool = (
            pool: readonly Candidate[],
            perAssetOutcomes: ViewReturns,
        ): { count: number; total: number } | null => {
            // Pool uniqueness: positives arrays are built with at most one
            // candidate per asset index per event, so pool.length equals the
            // former per-appender return-map size and pool-order summation
            // matches the former Map insertion-order total bit for bit.
            if (pool.length < 2) return null;
            if (pool.some((candidate) => dataGapAssets.has(candidate.assetIndex))) return null;
            let total = 0;
            for (const c of pool) {
                const r = perAssetOutcomes.get(c.assetIndex)?.long[hIdx];
                if (r === undefined || !Number.isFinite(r)) return null;
                total += r;
            }
            return { count: pool.length, total };
        };
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
            evaluation: { count: number; total: number } | null,
        ): void => {
            // Report each pick as ONGOING before the pool gates: a pick whose
            // own horizon is incomplete is an open position even when another
            // pool member's censoring omits the event from the series.
            if (rawPick >= 0) appendOngoingEventDetail(timeSec, perAssetOutcomes, hIdx, rawSelector, rawPick, pool.length);
            if (meanPick >= 0) appendOngoingEventDetail(timeSec, perAssetOutcomes, hIdx, meanSelector, meanPick, pool.length);
            if (!evaluation || rawPick < 0 || meanPick < 0) return;
            const poolTotal = evaluation.total;
            const appendProfitSelection = (
                series: SelectorSeries,
                selector: OpenScoreUsdEventDetailSelector,
                selectedIdx: number,
                selectedByAsset: Map<string, number>,
                samplesByAsset: Map<string, { returns: number[]; deltas: number[] }>,
            ): void => {
                const selectedReturn = perAssetOutcomes.get(selectedIdx)?.long[hIdx];
                if (selectedReturn === undefined) return;
                const randomReturn = (poolTotal - selectedReturn) / (evaluation.count - 1);
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
                    evaluation.count,
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
        /**
         * Single-selection causal arm appender (TOP_RAW_PROFIT_NOW_CONF,
         * TOP_Z): one pool, one pre-resolved pick, one comparison series.
         * Eligibility mirrors appendProfitArms: pool >= 2, no data gap, every
         * pool return finite for the horizon — otherwise the event is
         * omitted, never zero-filled.
         */
        const appendSingleCausalArm = (
            timeSec: number,
            perAssetOutcomes: ViewReturns,
            pool: readonly Candidate[],
            selectedIdx: number,
            series: SelectorSeries,
            selector: OpenScoreUsdEventDetailSelector,
            selectedByAsset: Map<string, number>,
            samplesByAsset: Map<string, { returns: number[]; deltas: number[] }>,
            evaluation: { count: number; total: number } | null,
        ): void => {
            // Same ONGOING pick report as the paired profit arms: emit before
            // the pool gates so a censored pick stays visible when another
            // pool member's censoring omits the event from the series.
            if (selectedIdx >= 0) appendOngoingEventDetail(timeSec, perAssetOutcomes, hIdx, selector, selectedIdx, pool.length);
            if (!evaluation || selectedIdx < 0) return;
            const selectedReturn = perAssetOutcomes.get(selectedIdx)?.long[hIdx];
            if (selectedReturn === undefined) return;
            const poolTotal = evaluation.total;
            const randomReturn = (poolTotal - selectedReturn) / (evaluation.count - 1);
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
                evaluation.count,
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
        const appendConfidenceProfitArm = (
            timeSec: number,
            perAssetOutcomes: ViewReturns,
            pool: readonly Candidate[],
            selectedIdx: number,
            evaluation: { count: number; total: number } | null,
        ): void => appendSingleCausalArm(
            timeSec,
            perAssetOutcomes,
            pool,
            selectedIdx,
            topRawProfitNowConf,
            "TOP_RAW_PROFIT_NOW_CONF",
            topRawProfitNowConfSelectedByAsset,
            topRawProfitNowConfSamplesByAsset,
            evaluation,
        );

        for (let v = 0; v < views.length; v += 1) {
            const view = gapFilteredViews[v];
            if (!view) continue;
            const botPicks = botPicksByView[v]!;
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
            // One evaluation per (event, horizon, pool), shared by every
            // appender call over that pool: profitNowPositives is evaluated
            // once for its four causal callers.
            const profitEvaluation = evaluatePool(view.profitPositives, perAsset);
            const profitNowEvaluation = evaluatePool(view.profitNowPositives, perAsset);
            const confidenceEvaluation = evaluatePool(view.profitNowConfidencePositives, perAsset);
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
                profitEvaluation,
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
                profitNowEvaluation,
            );
            appendConfidenceProfitArm(
                view.timeSec,
                perAsset,
                view.profitNowConfidencePositives,
                view.topRawProfitNowConf,
                confidenceEvaluation,
            );
            appendSingleCausalArm(
                view.timeSec,
                perAsset,
                view.profitNowPositives,
                view.topZ,
                topZ,
                "TOP_Z",
                topZSelectedByAsset,
                topZSamplesByAsset,
                profitNowEvaluation,
            );
            // Inverted causal arms: same pools and gates, LOWEST rank wins.
            appendProfitArms(
                view.timeSec,
                perAsset,
                view.profitNowPositives,
                botPicks.rawProfitNow,
                botPicks.meanProfitNow,
                "BOT_RAW_PROFIT_NOW",
                "BOT_MEAN_PROFIT_NOW",
                botRawProfitNow,
                botMeanProfitNow,
                botRawProfitNowSelectedByAsset,
                botRawProfitNowSamplesByAsset,
                botMeanProfitNowSelectedByAsset,
                botMeanProfitNowSamplesByAsset,
                profitNowEvaluation,
            );
            appendSingleCausalArm(
                view.timeSec,
                perAsset,
                view.profitNowPositives,
                botPicks.z,
                botZ,
                "BOT_Z",
                botZSelectedByAsset,
                botZSamplesByAsset,
                profitNowEvaluation,
            );

            // Validate every positive candidate's return for this horizon
            // and accumulate the control total in the SAME traversal
            // (allocation reduction plan phase 1). view.positives is the
            // former map's insertion order, so floating-point addition order
            // is unchanged; the pool holds unique asset indices by
            // construction (one candidate per asset, built in a forward
            // asset-index loop).
            let totalReturn = 0;
            let allValid = true;
            for (const c of view.positives) {
                const arr = perAsset.get(c.assetIndex);
                const r = arr ? arr.long[hIdx] : undefined;
                if (r === undefined || !Number.isFinite(r)) {
                    allValid = false;
                    break;
                }
                totalReturn += r;
            }
            // The TOP_MEAN portfolio opportunity uses the incumbent outcome even
            // when another positive candidate makes the ordinary all-positive
            // comparison ineligible.
            const incumbentOutcome = perAsset.get(view.topMean);
            if (!allValid) {
                // The arms still made picks; report each one as ONGOING when
                // that pick's own horizon is incomplete. Another positive's
                // censoring omits the event from the series but not the pick.
                appendOngoingEventDetail(view.timeSec, perAsset, hIdx, "TOP_RAW", view.topRaw, view.positives.length);
                appendOngoingEventDetail(view.timeSec, perAsset, hIdx, "TOP_MEAN", view.topMean, view.positives.length);
                appendOngoingEventDetail(view.timeSec, perAsset, hIdx, "TOP_MEAN_RAW_UNIQUE", view.topMeanRawUnique, view.topMeanRawUniquePool.length);
                appendOngoingEventDetail(view.timeSec, perAsset, hIdx, "BOT_RAW", botPicks.raw, view.positives.length);
                appendOngoingEventDetail(view.timeSec, perAsset, hIdx, "BOT_MEAN", botPicks.mean, view.positives.length);
                appendOngoingEventDetail(view.timeSec, perAsset, hIdx, "BOT_MEAN_RAW_UNIQUE", botPicks.meanRawUnique, botPicks.meanRawUniquePoolSize);
                continue; // censored or missing -> omit from both arms
            }

            const positiveCount = view.positives.length;
            const ordinaryReturnOf = (assetIdx: number): number | undefined => {
                const arr = perAsset.get(assetIdx);
                return arr ? arr.long[hIdx] : undefined;
            };
            const randomMeanOf = (selectedIdx: number): number => {
                const selectedReturn = ordinaryReturnOf(selectedIdx);
                return selectedReturn === undefined || positiveCount < 2
                    ? Number.NaN
                    : (totalReturn - selectedReturn) / (positiveCount - 1);
            };
            const appendSelection = (series: SelectorSeries, selectedIdx: number): void => {
                const selectedReturn = ordinaryReturnOf(selectedIdx)!;
                const randomMean = randomMeanOf(selectedIdx);
                series.returns.push(selectedReturn);
                series.deltas.push(selectedReturn - randomMean);
                series.times.push(view.timeSec);
                series.assets.push(assetNames[selectedIdx]!);
            };
            const appendTopMeanRawUniqueV1Selection = (): void => {
                if (view.topMeanRawUnique < 0) return;
                const tiedReturns = view.topMeanRawUniquePool
                    .map((candidate) => ordinaryReturnOf(candidate.assetIndex))
                    .filter((value): value is number => value !== undefined && Number.isFinite(value));
                if (tiedReturns.length !== view.topMeanRawUniquePool.length || tiedReturns.length === 0) return;
                const selectedReturn = ordinaryReturnOf(view.topMeanRawUnique);
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
            const topMeanReturn = ordinaryReturnOf(view.topMean)!;
            const topMeanOutcome = incumbentOutcome!;
            appendTopMeanRawUniqueV1Selection();
            appendEventDetail(
                "TOP_RAW",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.topRaw)!,
                ordinaryReturnOf(view.topRaw)!,
                randomMeanOf(view.topRaw),
                positiveCount,
            );
            appendEventDetail(
                "TOP_MEAN",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === view.topMean)!,
                ordinaryReturnOf(view.topMean)!,
                randomMeanOf(view.topMean),
                positiveCount,
            );
            // Inverted ordinary arms: same ordinary positive pool and leave-one-out
            // control as TOP_RAW/TOP_MEAN; the LOWEST raw/mean is selected.
            appendSelection(botRaw, botPicks.raw);
            appendSelection(botMean, botPicks.mean);
            appendEventDetail(
                "BOT_RAW",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === botPicks.raw)!,
                ordinaryReturnOf(botPicks.raw)!,
                randomMeanOf(botPicks.raw),
                positiveCount,
            );
            appendEventDetail(
                "BOT_MEAN",
                "long",
                view.positives.find((candidate) => candidate.assetIndex === botPicks.mean)!,
                ordinaryReturnOf(botPicks.mean)!,
                randomMeanOf(botPicks.mean),
                positiveCount,
            );
            const botRawName = assetNames[botPicks.raw]!;
            botRawSelectedByAsset.set(botRawName, (botRawSelectedByAsset.get(botRawName) ?? 0) + 1);
            let botRawSamples = botRawSamplesByAsset.get(botRawName);
            if (!botRawSamples) {
                botRawSamples = { returns: [], deltas: [] };
                botRawSamplesByAsset.set(botRawName, botRawSamples);
            }
            botRawSamples.returns.push(botRaw.returns[botRaw.returns.length - 1]!);
            botRawSamples.deltas.push(botRaw.deltas[botRaw.deltas.length - 1]!);
            const botMeanName = assetNames[botPicks.mean]!;
            botMeanSelectedByAsset.set(botMeanName, (botMeanSelectedByAsset.get(botMeanName) ?? 0) + 1);
            let botMeanSamples = botMeanSamplesByAsset.get(botMeanName);
            if (!botMeanSamples) {
                botMeanSamples = { returns: [], deltas: [] };
                botMeanSamplesByAsset.set(botMeanName, botMeanSamples);
            }
            botMeanSamples.returns.push(botMean.returns[botMean.returns.length - 1]!);
            botMeanSamples.deltas.push(botMean.deltas[botMean.deltas.length - 1]!);
            // BOT_MEAN_RAW_UNIQUE: bottom-mean tied set -> unique raw minimum;
            // residual raw ties skipped; control = mean return of that tied
            // set (mirror of appendTopMeanRawUniqueV1Selection).
            if (botPicks.meanRawUnique >= 0) {
                const botMeanWinner = view.positives.find((candidate) => candidate.assetIndex === botPicks.mean)!;
                const botTiedPool = view.positives.filter((candidate) => candidate.mean === botMeanWinner.mean);
                const botTiedReturns = botTiedPool
                    .map((candidate) => ordinaryReturnOf(candidate.assetIndex))
                    .filter((value): value is number => value !== undefined && Number.isFinite(value));
                const botUniqueReturn = ordinaryReturnOf(botPicks.meanRawUnique);
                if (botTiedPool.length > 0 && botTiedReturns.length === botTiedPool.length && botUniqueReturn !== undefined) {
                    const botControlReturn = botTiedReturns.reduce((sum, value) => sum + value, 0) / botTiedReturns.length;
                    const botUniqueDelta = botUniqueReturn - botControlReturn;
                    botMeanRawUnique.returns.push(botUniqueReturn);
                    botMeanRawUnique.deltas.push(botUniqueDelta);
                    botMeanRawUnique.times.push(view.timeSec);
                    botMeanRawUnique.assets.push(assetNames[botPicks.meanRawUnique]!);
                    appendEventDetail(
                        "BOT_MEAN_RAW_UNIQUE",
                        "long",
                        botTiedPool.find((candidate) => candidate.assetIndex === botPicks.meanRawUnique)!,
                        botUniqueReturn,
                        botControlReturn,
                        botTiedPool.length,
                    );
                    const botUniqueName = assetNames[botPicks.meanRawUnique]!;
                    botMeanRawUniqueSelectedByAsset.set(botUniqueName, (botMeanRawUniqueSelectedByAsset.get(botUniqueName) ?? 0) + 1);
                    let botUniqueSamples = botMeanRawUniqueSamplesByAsset.get(botUniqueName);
                    if (!botUniqueSamples) {
                        botUniqueSamples = { returns: [], deltas: [] };
                        botMeanRawUniqueSamplesByAsset.set(botUniqueName, botUniqueSamples);
                    }
                    botUniqueSamples.returns.push(botUniqueReturn);
                    botUniqueSamples.deltas.push(botUniqueDelta);
                }
            }
            topMeanPortfolioOpportunities.push({
                asset: assetNames[view.topMean]!,
                decisionTime: view.timeSec,
                entryTime: topMeanOutcome.entryTime,
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
            // Same one-evaluation-per-pool sharing as the ordinary views.
            const peProfitEvaluation = evaluatePool(pe.profitPositives, perAssetProfitOnly);
            const peProfitNowEvaluation = evaluatePool(pe.profitNowPositives, perAssetProfitOnly);
            const peConfidenceEvaluation = evaluatePool(pe.profitNowConfidencePositives, perAssetProfitOnly);
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
                peProfitEvaluation,
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
                peProfitNowEvaluation,
            );
            appendConfidenceProfitArm(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitNowConfidencePositives,
                pickFromPool(pe.profitNowConfidencePositives, "raw", pe.timeSec),
                peConfidenceEvaluation,
            );
            appendSingleCausalArm(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitNowPositives,
                pickUsableMax(pe.profitNowPositives, "z", pe.timeSec)?.winner.assetIndex ?? -1,
                topZ,
                "TOP_Z",
                topZSelectedByAsset,
                topZSamplesByAsset,
                peProfitNowEvaluation,
            );
            // Inverted causal arms on profit-only events: same re-resolution
            // pattern as the TOP_* calls above, min instead of max.
            appendProfitArms(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitNowPositives,
                pickUsableMin(pe.profitNowPositives, "raw", pe.timeSec)?.winner.assetIndex ?? -1,
                pickUsableMin(pe.profitNowPositives, "mean", pe.timeSec)?.winner.assetIndex ?? -1,
                "BOT_RAW_PROFIT_NOW",
                "BOT_MEAN_PROFIT_NOW",
                botRawProfitNow,
                botMeanProfitNow,
                botRawProfitNowSelectedByAsset,
                botRawProfitNowSamplesByAsset,
                botMeanProfitNowSelectedByAsset,
                botMeanProfitNowSamplesByAsset,
                peProfitNowEvaluation,
            );
            appendSingleCausalArm(
                pe.timeSec,
                perAssetProfitOnly,
                pe.profitNowPositives,
                pickUsableMin(pe.profitNowPositives, "z", pe.timeSec)?.winner.assetIndex ?? -1,
                botZ,
                "BOT_Z",
                botZSelectedByAsset,
                botZSamplesByAsset,
                peProfitNowEvaluation,
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
            // sortedDeltas is exactly the whole-sample sorted view of
            // `blocks` (splitIntoBlocks partitions every input value exactly
            // once), so the bootstrap reuses it instead of concatenating the
            // sorted blocks and re-sorting the sample (redundant-work plan
            // phase 3).
            const { lower, upper } = blockBootstrapMedianCi(blocks, bootstrapSamples, sortedDeltas);
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
        const topZByAsset = buildAssetSelectionBreakdown(
            topZSelectedByAsset,
            topZSamplesByAsset,
        ).byAsset;
        const topZDominantAsset = topZByAsset[0]?.asset ?? null;
        const topZExDominant = buildExDominantComparison(
            topZ,
            topZDominantAsset,
            buildComparison,
        );
        const botRawByAsset = buildAssetSelectionBreakdown(
            botRawSelectedByAsset,
            botRawSamplesByAsset,
        ).byAsset;
        const botRawDominantAsset = botRawByAsset[0]?.asset ?? null;
        const botRawExDominant = buildExDominantComparison(
            botRaw,
            botRawDominantAsset,
            buildComparison,
        );
        const botMeanByAsset = buildAssetSelectionBreakdown(
            botMeanSelectedByAsset,
            botMeanSamplesByAsset,
        ).byAsset;
        const botMeanDominantAsset = botMeanByAsset[0]?.asset ?? null;
        const botMeanExDominant = buildExDominantComparison(
            botMean,
            botMeanDominantAsset,
            buildComparison,
        );
        const botMeanRawUniqueByAsset = buildAssetSelectionBreakdown(
            botMeanRawUniqueSelectedByAsset,
            botMeanRawUniqueSamplesByAsset,
        ).byAsset;
        const botMeanRawUniqueDominantAsset = botMeanRawUniqueByAsset[0]?.asset ?? null;
        const botMeanRawUniqueExDominant = buildExDominantComparison(
            botMeanRawUnique,
            botMeanRawUniqueDominantAsset,
            buildComparison,
        );
        const botRawProfitNowByAsset = buildAssetSelectionBreakdown(
            botRawProfitNowSelectedByAsset,
            botRawProfitNowSamplesByAsset,
        ).byAsset;
        const botRawProfitNowDominantAsset = botRawProfitNowByAsset[0]?.asset ?? null;
        const botRawProfitNowExDominant = buildExDominantComparison(
            botRawProfitNow,
            botRawProfitNowDominantAsset,
            buildComparison,
        );
        const botMeanProfitNowByAsset = buildAssetSelectionBreakdown(
            botMeanProfitNowSelectedByAsset,
            botMeanProfitNowSamplesByAsset,
        ).byAsset;
        const botMeanProfitNowDominantAsset = botMeanProfitNowByAsset[0]?.asset ?? null;
        const botMeanProfitNowExDominant = buildExDominantComparison(
            botMeanProfitNow,
            botMeanProfitNowDominantAsset,
            buildComparison,
        );
        const botZByAsset = buildAssetSelectionBreakdown(
            botZSelectedByAsset,
            botZSamplesByAsset,
        ).byAsset;
        const botZDominantAsset = botZByAsset[0]?.asset ?? null;
        const botZExDominant = buildExDominantComparison(
            botZ,
            botZDominantAsset,
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
        // Selection-aggregation plan phase 1: when the most-frequent and the
        // largest-contribution assets are the SAME asset (both resolved by
        // their own tie rules before this check), the filtered series are
        // identical including order, so the second full comparison (sort,
        // blocks, seeded bootstrap) would reproduce the first. Copy the
        // comparison (with a fresh blockMeans array) to keep the two result
        // fields object-independent; different identities keep independent
        // computations.
        const topMeanExTopContrib = topMeanTopContribAsset !== null && topMeanTopContribAsset === topMeanDominantAsset
            ? { ...topMeanExDominant, blockMeans: [...topMeanExDominant.blockMeans] }
            : buildExDominantComparison(topMean, topMeanTopContribAsset, buildComparison);
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
            topZ: buildComparison(topZ.deltas, topZ.returns, topZ.times),
            topZByAsset,
            topZExDominant,
            topZDominantAsset,
            botRaw: buildComparison(botRaw.deltas, botRaw.returns, botRaw.times),
            botRawByAsset,
            botRawExDominant,
            botRawDominantAsset,
            botMean: buildComparison(botMean.deltas, botMean.returns, botMean.times),
            botMeanByAsset,
            botMeanExDominant,
            botMeanDominantAsset,
            botMeanRawUnique: buildComparison(botMeanRawUnique.deltas, botMeanRawUnique.returns, botMeanRawUnique.times),
            botMeanRawUniqueByAsset,
            botMeanRawUniqueExDominant,
            botMeanRawUniqueDominantAsset,
            botRawProfitNow: buildComparison(botRawProfitNow.deltas, botRawProfitNow.returns, botRawProfitNow.times),
            botRawProfitNowByAsset,
            botRawProfitNowExDominant,
            botRawProfitNowDominantAsset,
            botMeanProfitNow: buildComparison(botMeanProfitNow.deltas, botMeanProfitNow.returns, botMeanProfitNow.times),
            botMeanProfitNowByAsset,
            botMeanProfitNowExDominant,
            botMeanProfitNowDominantAsset,
            botZ: buildComparison(botZ.deltas, botZ.returns, botZ.times),
            botZByAsset,
            botZExDominant,
            botZDominantAsset,
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
    // The loop above is the last consumer of the per-(event, asset) outcome
    // records; drop them before report assembly.
    returnsByView = [];
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
