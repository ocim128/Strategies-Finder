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
    OpenScoreUsdEventDetailSelector,
    OpenScoreUsdEventDetail,
    OpenScoreUsdOngoingEventDetail,
    OpenScoreUsdLatestSelectorName,
    OpenScoreUsdLatestSelectionCandidate,
    OpenScoreUsdLatestSelection,
    OpenScoreUsdLatestSelections,
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
import { sweepScoreEvents } from "./open-score-replay/event-sweep";
import {
    buildCandidateViews,
    buildOutcomeRequests,
    pickUsableMaxByAssetNames,
    pickUsableMinByAssetNames,
    selectAfterOutcomes,
} from "./open-score-replay/candidate-selection";
import type { Candidate, DecisionEvent } from "./open-score-replay/internal-types";
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
    // Stage implementation: ./open-score-replay/event-sweep.ts (the bucketing
    // rationale and the exact per-group semantics are documented there). The
    // sweep consumes and clears the per-pair streams; the flat bucketed arrays
    // it builds internally become the only delta indexing.
    const sweepOutcome = await sweepScoreEvents({
        streams,
        profitableStreams,
        sampleFromSec: options.sampleFromSec,
        sampleToSec: options.sampleToSec,
        shouldStop,
        onPhase,
        pairCount,
        assetCount,
    });
    if (!sweepOutcome.ok) {
        const { reportLine, pairs, assets, totalEvents } = sweepOutcome.earlyExit;
        return emptyResult({
            reportLines: [reportLine],
            ...(pairs !== undefined ? { pairs } : {}),
            ...(assets !== undefined ? { assets } : {}),
            ...(totalEvents !== undefined ? { totalEvents } : {}),
        });
    }
    // `let` because the diagnostics/release points below drop the snapshot
    // array (events = []) exactly where the original inline path did.
    let events: DecisionEvent[] = sweepOutcome.result.events;


    const totalEvents = events.length;
    if (totalEvents === 0) {
        return emptyResult({ pairs: pairCount, assets: assetCount, reportLines: ["OPEN_SCORE USD | no decision events (no pair entries in window)."] });
    }

    // --- Phase 3: build candidate sets; collect per-asset event requests ---
    // Stage implementation: ./open-score-replay/candidate-selection.ts (pool
    // construction, FNV tie-breaks, strict-past TOP_Z history, profit-only
    // events).
    const candidateStage = await buildCandidateViews({
        events,
        totalEvents,
        assetNames,
        assetCount,
        onPhase,
    });
    const views = candidateStage.views;
    const profitOnlyEvents = candidateStage.profitOnlyEvents;


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

    const requestPlan = buildOutcomeRequests({ views, profitOnlyEvents });
    const requestsByAsset = requestPlan.requestsByAsset;
    const positiveRequestedAssets = requestPlan.positiveRequestedAssets;
    const totalEventCount = requestPlan.totalEventCount;
    const eventTimeOf = requestPlan.eventTimeOf;


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

    // Post-outcome selection (gap-filtered views, BOT_* picks, latest
    // selections): stage implementation ./open-score-replay/candidate-selection.ts.
    const postSelection = selectAfterOutcomes({ views, profitOnlyEvents, assetNames, dataGapAssets, dataGapEvents });
    const gapFilteredViews = postSelection.gapFilteredViews;
    const gapFilteredProfitOnlyEvents = postSelection.gapFilteredProfitOnlyEvents;
    const botPicksByView = postSelection.botPicksByView;
    const latestSelections = postSelection.latestSelections;


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
                pickUsableMaxByAssetNames(pe.profitPositives, "raw", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
                pickUsableMaxByAssetNames(pe.profitPositives, "mean", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
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
                pickUsableMaxByAssetNames(pe.profitNowPositives, "raw", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
                pickUsableMaxByAssetNames(pe.profitNowPositives, "mean", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
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
                pickUsableMaxByAssetNames(pe.profitNowPositives, "z", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
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
                pickUsableMinByAssetNames(pe.profitNowPositives, "raw", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
                pickUsableMinByAssetNames(pe.profitNowPositives, "mean", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
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
                pickUsableMinByAssetNames(pe.profitNowPositives, "z", pe.timeSec, assetNames)?.winner.assetIndex ?? -1,
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
