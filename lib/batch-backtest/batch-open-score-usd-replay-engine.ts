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
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import { MAX_ACTIVE_BLOCK_COUNT, MAX_ACTIVE_BOOTSTRAP_SAMPLES } from "./max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    OpenScoreUsdReplayResult,
    OpenScoreUsdTarget,
    PoolSnapshotRecord,
    RunOpenScoreUsdReplayOptions,
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
    ReplayMode,
    AssetSwitchArmStatus,
    AssetSwitchPendingOrder,
    AssetSwitchOpenPosition,
    AssetSwitchTradeRecord,
    AssetSwitchArmSummary,
    AssetSwitchReplaySummary,
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

import { degreeSummary } from "./open-score-replay/statistics";
import { scanArtifacts } from "./open-score-replay/artifact-scan";
import { evaluateTargetOutcomes } from "./open-score-replay/target-outcomes";
import { aggregateHorizonResults } from "./open-score-replay/aggregation";
import { sweepScoreEvents } from "./open-score-replay/event-sweep";
import { buildCandidateViews, buildOutcomeRequests, selectAfterOutcomes } from "./open-score-replay/candidate-selection";
import type { DecisionEvent } from "./open-score-replay/internal-types";
import { buildReportLines } from "./open-score-replay/report";
import { createEmptyAssetSwitchSummary, runAssetSwitchReplay } from "./open-score-replay/asset-switch";
import { REPLAY_ARM_FIELDS } from "./open-score-replay/arm-contract";

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

    const replayMode = options.mode ?? "horizon";
    const horizons = [...new Set((options.horizons ?? []).filter((h) => Number.isFinite(h) && h >= 1).map((h) => Math.floor(h)))].sort((a, b) => a - b);
    const emptyResult = (partial: Partial<OpenScoreUsdReplayResult>): OpenScoreUsdReplayResult => ({
        mode: replayMode,
        pairs: 0, assets: 0, complete: false, omittedPairs: 0, omittedAssets: 0,
        totalEvents: 0, candidateEvents: 0, eligibleEvents: 0, horizons: [],
        latestSelections: null, degree: degreeSummary([], null),
        ...(replayMode === "asset_switch" ? { assetSwitch: createEmptyAssetSwitchSummary(options, slippageRate, commissionRate) } : {}),
        warnings, reportLines: [], ...partial,
    });
    if (replayMode === "horizon" && horizons.length === 0) {
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
        selectionCooldownBars: options.selectionCooldownBars,
        includeAllDecisionEvents: replayMode === "asset_switch",
        onPhase,
    });
    const views = candidateStage.views;
    const profitOnlyEvents = candidateStage.profitOnlyEvents;
    const candidateComparisonEvents = views.reduce(
        (count, view) => count + (view.positives.length >= 2 ? 1 : 0),
        0,
    );

    if (replayMode === "asset_switch") {
        // Position simulation consumes the candidate snapshots directly and
        // never consults fixed-horizon outcome eligibility or future returns.
        events = [];
        const switchOutcome = await runAssetSwitchReplay({
            views,
            assetNames,
            options,
            slippageRate,
            commissionRate,
            onPhase,
            shouldStop,
            pairCount,
            assetCount,
        });
        if (!switchOutcome.ok) {
            const { reportLine, pairs, assets, totalEvents: partialEvents } = switchOutcome.earlyExit;
            return emptyResult({
                reportLines: [reportLine],
                ...(pairs !== undefined ? { pairs } : {}),
                ...(assets !== undefined ? { assets } : {}),
                ...(partialEvents !== undefined ? { totalEvents: partialEvents } : {}),
            });
        }
        const assetSwitch = switchOutcome.result;
        const incompleteArms = Object.values(assetSwitch.arms).filter((arm) => arm.status === "incomplete").length;
        if (assetSwitch.coverage.missingAssets > 0) {
            warnings.push(`${assetSwitch.coverage.missingAssets} selected target dataset(s) were missing; affected switch arms are unrankable.`);
        }
        if (assetSwitch.coverage.invalidSeries > 0) {
            warnings.push(`${assetSwitch.coverage.invalidSeries} selected target dataset(s) had duplicate, nonmonotonic, or invalid normalized timestamps.`);
        }
        if (incompleteArms > 0) warnings.push(`${incompleteArms} switch arm(s) are incomplete and cannot be ranked.`);
        warnings.push("Asset-switch replay uses independent, fixed $1,000 entries; P&L is normalized research P&L, not a self-financing account return.");
        warnings.push("BOT arms remain long asset positions and use the existing bottom-ranking rules.");
        warnings.push("TOP_RAW_PROFIT and TOP_MEAN_PROFIT use full-window pair profitability and are LOOK-AHEAD RESEARCH arms.");
        warnings.push("Fixed-horizon comparisons, random-control deltas, contributor exclusions, and horizon-only Phase 0b rows do not apply to asset-switch replay.");
        const degree = degreeSummary(assetNames.map((name) => staticDegree.get(name) ?? 0), null);
        const complete = omittedPairs === 0
            && assetSwitch.coverage.missingAssets === 0
            && assetSwitch.coverage.invalidSeries === 0
            && incompleteArms === 0;
        const formatSwitchUsd = (value: number | null): string => value === null || !Number.isFinite(value)
            ? "n/a"
            : `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(2)}`;
        const reportLines = [
            `OPEN_SCORE USD | ASSET SWITCH | ${assetSwitch.semanticsVersion}`,
            `Window: ${assetSwitch.windowStartSec ?? "from first in-window decision"} to ${assetSwitch.windowEndSec}${assetSwitch.independentWindow ? " (independent window; starts flat)" : ""}`,
            `Sizing: $${assetSwitch.notionalPerEntry} fixed entry notional per arm; non-compounding; slippage ${(assetSwitch.slippageRate * 100).toFixed(4)}%; commission ${(assetSwitch.commissionRate * 100).toFixed(4)}%.`,
            `Decisions: ${totalEvents}; ordinary candidate events (pool >= 2): ${candidateComparisonEvents}; incomplete arms: ${incompleteArms}.`,
            "Per-arm performance (USD):",
            ...REPLAY_ARM_FIELDS.map((field) => {
                const arm = assetSwitch.arms[field];
                const holding = arm.openPosition
                    ? ` | holding=${arm.openPosition.asset} mark=${formatSwitchUsd(arm.openPosition.openNetPnl)}`
                    : "";
                const pending = arm.pendingOrder
                    ? ` | pending=${arm.pendingOrder.side}${arm.pendingOrder.destinationAsset ? ` ${arm.pendingOrder.destinationAsset}` : ""}`
                    : "";
                return `${field} | ${arm.status} | total=${formatSwitchUsd(arm.totalNetPnl)} | realized=${formatSwitchUsd(arm.realizedNetPnl)} | open=${formatSwitchUsd(arm.openPositionNetPnl)} | closed=${arm.completedTrades} | entries=${arm.enteredCount} | costs=$${arm.totalCosts.toFixed(2)}${holding}${pending}`;
            }),
            ...warnings.map((warning) => `Warning: ${warning}`),
        ];
        return {
            mode: "asset_switch",
            pairs: pairCount,
            assets: assetCount,
            complete,
            omittedPairs,
            omittedAssets: assetSwitch.coverage.missingAssets + assetSwitch.coverage.invalidSeries,
            totalEvents,
            candidateEvents: candidateComparisonEvents,
            eligibleEvents: 0,
            horizons: [],
            assetSwitch,
            latestSelections: null,
            degree,
            warnings,
            reportLines,
        };
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
    // Stage implementation: ./open-score-replay/target-outcomes.ts (dataset
    // resolution with the caller-owned shared cache, per-horizon outcomes, and
    // the Phase 0b diagnostic emission). The engine keeps the release points:
    // `events` above may already be an empty array when both diagnostic sinks
    // are disabled, and the engine's own binding is dropped after this stage.
    const outcomesOutcome = await evaluateTargetOutcomes({
        options,
        targetLoader,
        horizons,
        slippageRate,
        commissionRate,
        assetNames,
        assetIndexByName,
        events,
        diagnosticsEnabled,
        diagnosticAssetNames,
        diagnosticAssetIndexByName,
        poolSnapshots,
        candidateOutcomes,
        requestsByAsset,
        positiveRequestedAssets,
        totalEventCount,
        eventTimeOf,
        shouldStop,
        onPhase,
        pairCount,
        assetCount,
    });
    if (!outcomesOutcome.ok) {
        const { reportLine, pairs, assets, totalEvents } = outcomesOutcome.earlyExit;
        return emptyResult({
            reportLines: [reportLine],
            ...(pairs !== undefined ? { pairs } : {}),
            ...(assets !== undefined ? { assets } : {}),
            ...(totalEvents !== undefined ? { totalEvents } : {}),
        });
    }
    const outcomeStage = outcomesOutcome.result;
    let returnsByView = outcomeStage.returnsByView;
    const missingAssets = outcomeStage.missingAssets;
    const dataGapAssets = outcomeStage.dataGapAssets;
    const dataGapEvents = outcomeStage.dataGapEvents;
    const censoredEvents = outcomeStage.censoredEvents;
    const noDataEvents = outcomeStage.noDataEvents;


    // Post-outcome selection (gap-filtered views, BOT_* picks, latest
    // selections): stage implementation ./open-score-replay/candidate-selection.ts.
    const postSelection = await selectAfterOutcomes({
        views,
        profitOnlyEvents,
        assetNames,
        dataGapAssets,
        dataGapEvents,
        shouldStop: options.shouldStop,
        selectionCooldownBars: options.selectionCooldownBars,
        boundaryIndicesByView: outcomeStage.boundaryIndicesByView,
    });
    const gapFilteredViews = postSelection.gapFilteredViews;
    const gapFilteredProfitOnlyEvents = postSelection.gapFilteredProfitOnlyEvents;
    const botPicksByView = postSelection.botPicksByView;
    const latestSelections = postSelection.latestSelections;
    const armSelectionsByView = postSelection.armSelectionsByView;
    const armSelectionsByProfitOnly = postSelection.armSelectionsByProfitOnly;


    // --- Phase 5: aggregate ------------------------------------------------
    // Stage implementation: ./open-score-replay/aggregation.ts (per-horizon
    // series, controls, per-asset breakdowns, dominant exclusions, P&L). The
    // engine keeps the omitted-asset accounting below — the last consumer of
    // returnsByView — and the report assembly.
    const aggregation = await aggregateHorizonResults({
        options,
        horizons,
        blockCount,
        bootstrapSamples,
        views,
        gapFilteredViews,
        gapFilteredProfitOnlyEvents,
        botPicksByView,
        ...(armSelectionsByView ? { armSelectionsByView } : {}),
        ...(armSelectionsByProfitOnly ? { armSelectionsByProfitOnly } : {}),
        ...(options.selectionCooldownBars && options.selectionCooldownBars > 0
            ? { boundaryIndicesByView: outcomeStage.boundaryIndicesByView }
            : {}),
        returnsByView,
        dataGapAssets,
        assetNames,
        retainedDegree: staticDegree,
        noDataEvents,
        onPhase,
    });
    const horizonResults = aggregation.horizonResults;
    const eventDetails = aggregation.eventDetails;
    const ongoingEventDetails = aggregation.ongoingEventDetails;
    const eligibleEventsMax = aggregation.eligibleEventsMax;


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
        totalEvents, candidateEvents: candidateComparisonEvents, eligibleEvents: eligibleEventsMax, horizons: horizonResults,
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
        mode: "horizon",
        pairs: pairCount,
        assets: assetCount,
        complete,
        omittedPairs,
        omittedAssets,
        totalEvents,
        candidateEvents: candidateComparisonEvents,
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
