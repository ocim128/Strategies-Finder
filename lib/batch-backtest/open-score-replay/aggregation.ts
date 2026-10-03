/**
 * Replay stage 5 — horizon aggregation. Builds every selector arm's
 * per-horizon sample series (ordinary, profit-gated, causal, confidence,
 * z-surprise, and the inverted BOT_* twins), the leave-one-out controls,
 * per-asset breakdowns, dominant/contribution exclusions, ONGOING censored
 * picks, the overlapping-basket and $1K portfolio P&L experiments, and the
 * final numerical summaries. Floating-point accumulation order, chronological
 * block splitting, and the seeded bootstrap draws are behavior contracts.
 */
import type {
    OpenScoreUsdEventDetail,
    OpenScoreUsdEventDetailSelector,
    OpenScoreUsdOngoingEventDetail,
    OpenScoreUsdReplayResult,
    ReplayComparison,
    RunOpenScoreUsdReplayOptions,
    TopMeanPortfolioOpportunity,
} from "./types";
import type { BotViewPicks, Candidate, EventView, ProfitOnlyEvent, ReplayArmSelectionMap, ReplayPhaseCallback } from "./internal-types";
import type { ReplayArmField, SelectorName } from "./types";
import type { ViewOutcomeRecord } from "./target-outcomes";
import { tieBreakDigest } from "../max-active-research-contract";
import {
    buildAssetSelectionBreakdown,
    buildExDominantComparison,
    buildReplayComparison,
    degreeSummary,
} from "./statistics";
import { computeSelectorPnl, simulateTopMeanPortfolio } from "./pnl";
import { pickUsableMaxByAssetNames, pickUsableMinByAssetNames } from "./candidate-selection";
import { yieldLoop } from "./runtime";
import { REPLAY_ARM_FIELDS } from "./arm-contract";
import { REPLAY_ARM_TO_FINDER_ARM } from "./arm-contract";
import { RANKING_MEASUREMENT_SEMANTICS, type RankingMeasurementSummary, type RankingSkipReason } from "./types";
import type { RankingEvent, RankingPick } from "./internal-types";
import { blockBootstrapMeanCi, buildRankingTimeBlocks, meanOrNull, type RankingMeasurementWindow } from "./statistics";
import type { TargetOutcomeStageResult } from "./target-outcomes";

/** Predictor ties and equal outcomes are neutral, irrespective of tie digest. */
export function rankingPairCredit(a: RankingPick, b: RankingPick, aReturn: number, bReturn: number): number {
    return (a.key === b.key && a.secondary === b.secondary) || aReturn === bReturn ? 0.5 : aReturn > bReturn ? 1 : 0;
}

export async function aggregateRankingMeasurement(args: {
    events: readonly RankingEvent[];
    outcomes: TargetOutcomeStageResult;
    horizonBars: number;
    horizonIndex?: number;
    interval?: string;
    outcomeIndexOf?: (time: number, index: number) => number;
    shouldStop: () => boolean;
}): Promise<RankingMeasurementSummary> {
    const arms = {} as RankingMeasurementSummary["arms"];
    const hi = args.horizonIndex ?? 0;
    // Sweep and candidate timelines are chronological; sorting also supports pure fixtures.
    const order = args.events.map((event, index) => ({ event, index })).sort((a, b) => a.event.timeSec - b.event.timeSec);
    for (const field of REPLAY_ARM_FIELDS) {
        const skippedReasons: Partial<Record<RankingSkipReason, number>> = {};
        const values: number[] = [], firstValues: number[] = [];
        const windows: RankingMeasurementWindow[] = [];
        let eligibleEvents = 0, tiedComparisons = 0, soleFirstPlaceCount = 0, sharedFirstPlaceCount = 0;
        const skip = (reason: RankingSkipReason): void => { skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; };
        for (let i = 0; i < order.length; i += 1) {
            if ((i & 511) === 0) { await yieldLoop(); if (args.shouldStop()) throw new Error("OPEN_SCORE USD replay cancelled during ranking measurement."); }
            const { event, index } = order[i]!;
            const row = event.arms[field];
            if (row.reason) { skip(row.reason); continue; }
            if (row.picks.length !== 5 || new Set(row.picks.map((pick) => pick.assetIndex)).size !== 5) { skip("small_pool"); continue; }
            const outcomeIndex = args.outcomeIndexOf?.(event.timeSec, index) ?? index;
            const outcomes = args.outcomes.returnsByView[outcomeIndex];
            let reason: RankingSkipReason | undefined;
            const completed: ViewOutcomeRecord[] = [];
            for (const pick of row.picks) {
                const outcome = outcomes?.get(pick.assetIndex);
                if (args.outcomes.invalidRankingAssets?.has(pick.assetIndex)) reason ??= "invalid_price";
                else if (args.outcomes.dataGapAssets.has(pick.assetIndex) || args.outcomes.rankingGapAssetsByView?.get(outcomeIndex)?.has(pick.assetIndex)) reason ??= "data_gap";
                else if (args.outcomes.missingAssets.has(pick.assetIndex)) reason ??= "missing_target";
                else if (!outcome) reason ??= "missing_entry";
                else if (outcome.statuses[hi] !== "ok") reason ??= outcome.statuses[hi] === "right_censored" ? "right_censored" : "invalid_price";
                else if (![outcome.long[hi], outcome.entryTime, outcome.exitTimes[hi]].every(Number.isFinite)) reason ??= "invalid_price";
                else completed.push(outcome);
            }
            if (reason) { skip(reason); continue; }
            const first = completed[0]!;
            if (completed.some((outcome) => outcome.entryTime !== first.entryTime || outcome.exitTimes[hi] !== first.exitTimes[hi])) { skip("calendar_mismatch"); continue; }
            eligibleEvents += 1;
            const selectedReturn = first.long[hi]!;
            if (completed.every((outcome) => outcome.long[hi]! <= selectedReturn)) {
                if (completed.some((outcome, index) => index > 0 && outcome.long[hi] === selectedReturn)) sharedFirstPlaceCount += 1;
                else soleFirstPlaceCount += 1;
            }
            let credits = 0, firstCredits = 0;
            for (let a = 0; a < 5; a += 1) for (let b = a + 1; b < 5; b += 1) {
                const credit = rankingPairCredit(row.picks[a]!, row.picks[b]!, completed[a]!.long[hi]!, completed[b]!.long[hi]!);
                if (credit === 0.5) tiedComparisons += 1;
                credits += credit;
                if (a === 0) firstCredits += credit;
            }
            values.push(credits / 10); firstValues.push(firstCredits / 4);
            windows.push({ entryTime: first.entryTime, exitTime: first.exitTimes[hi]! });
        }
        if (args.shouldStop()) throw new Error("OPEN_SCORE USD replay cancelled during ranking measurement.");
        const { blocks, measurementWindowSec, timeBlockWidthSec, timeCoverageSec } = buildRankingTimeBlocks(values, windows, args.horizonBars, args.interval);
        const ci = await blockBootstrapMeanCi(blocks, 10_000, args.shouldStop);
        arms[field] = { eligibleEvents, scoredEvents: values.length,
            skippedEvents: Object.values(skippedReasons).reduce((sum, n) => sum + n, 0), skippedReasons,
            tiedComparisons, comparisons: values.length * 10, meanAccuracy: meanOrNull(values), top1Superiority: meanOrNull(firstValues),
            soleFirstPlaceCount, sharedFirstPlaceCount,
            soleFirstPlaceRate: values.length ? soleFirstPlaceCount / values.length : null,
            sharedFirstPlaceRate: values.length ? sharedFirstPlaceCount / values.length : null,
            ciLower: ci.lower, ciUpper: ci.upper, blockCount: blocks.length, measurementWindowSec, timeBlockWidthSec, timeCoverageSec,
            status: ci.lower !== null && ci.upper !== null ? "available" : values.length ? "insufficient_data" : "no_events" };
    }
    return { semanticsVersion: RANKING_MEASUREMENT_SEMANTICS, horizonBars: args.horizonBars, arms };
}

const ARM_EVENT_DETAIL_SELECTORS = REPLAY_ARM_TO_FINDER_ARM as Record<ReplayArmField, OpenScoreUsdEventDetailSelector>;

interface CooldownArmSeries {
    deltas: number[];
    returns: number[];
    times: number[];
    assets: string[];
    selectedCounts: Map<string, number>;
    samplesByAsset: Map<string, { returns: number[]; deltas: number[] }>;
    tieCount: number;
}

function emptyCooldownArmSeries(): CooldownArmSeries {
    return {
        deltas: [], returns: [], times: [], assets: [],
        selectedCounts: new Map(), samplesByAsset: new Map(), tieCount: 0,
    };
}

function replayArmBaseField(field: ReplayArmField): string {
    return field;
}

type AggregationInput = Parameters<typeof aggregateHorizonResults>[0];

function cooldownSourcePool(
    field: ReplayArmField,
    view: EventView | null,
    profitOnly: ProfitOnlyEvent | null,
): readonly Candidate[] {
    if (field === "topRaw" || field === "topMean" || field === "topMeanRawUnique"
        || field === "botRaw" || field === "botMean" || field === "botMeanRawUnique") {
        return view?.positives ?? [];
    }
    if (field === "topRawProfit" || field === "topMeanProfit") {
        return view?.profitPositives ?? profitOnly?.profitPositives ?? [];
    }
    if (field === "topRawProfitNowConf") {
        return view?.profitNowConfidencePositives ?? profitOnly?.profitNowConfidencePositives ?? [];
    }
    return view?.profitNowPositives ?? profitOnly?.profitNowPositives ?? [];
}

async function aggregateCooldownSelection(
    args: AggregationInput & {
        armSelectionsByView: Array<ReplayArmSelectionMap | null>;
        armSelectionsByProfitOnly: Array<ReplayArmSelectionMap | null>;
        boundaryIndicesByView?: Array<Map<number, number> | null>;
    },
): Promise<AggregationStageResult> {
    // Build only the result skeleton from empty input. The prior implementation
    // ran every legacy selector and bootstrap, then discarded those statistics
    // and recomputed them for cooldown selections.
    const base = await aggregateHorizonResults({
        ...args,
        options: { ...args.options, selectionCooldownBars: 0, includeEventDetails: false },
        views: [],
        gapFilteredViews: [],
        botPicksByView: [],
        gapFilteredProfitOnlyEvents: [],
        returnsByView: [],
        noDataEvents: new Set(),
        onPhase: () => undefined,
        armSelectionsByView: undefined,
        armSelectionsByProfitOnly: undefined,
    });
    const {
        options, horizons, blockCount, bootstrapSamples, views,
        returnsByView, assetNames, retainedDegree, onPhase,
    } = args;
    const cooldownBars = Math.max(0, Math.floor(options.selectionCooldownBars ?? 0));
    const eventDetails: OpenScoreUsdEventDetail[] = [];
    const ongoingEventDetails: OpenScoreUsdOngoingEventDetail[] = [];
    let eligibleEventsMax = 0;
    const timeline = [
        ...views.map((view, index) => ({ kind: "view" as const, index, timeSec: view.timeSec })),
        ...args.gapFilteredProfitOnlyEvents.map((event, index) => ({
            kind: "profit" as const,
            index,
            timeSec: event.timeSec,
        })),
    ].sort((left, right) => left.timeSec - right.timeSec);

    for (let hIdx = 0; hIdx < horizons.length; hIdx += 1) {
        const seriesByArm = Object.fromEntries(REPLAY_ARM_FIELDS.map((field) => [field, emptyCooldownArmSeries()])) as Record<ReplayArmField, CooldownArmSeries>;
        const portfolioOpportunities: TopMeanPortfolioOpportunity[] = [];
        const lastSelectedBoundaryByArm = new Map<ReplayArmField, Map<number, number>>(
            REPLAY_ARM_FIELDS.map((field) => [field, new Map<number, number>()]),
        );
        const activeCountsAtEvents: number[] = [];
        const topRawSelectionCounts = new Map<string, number>();
        let processedCooldownEvents = 0;
        for (const event of timeline) {
            if ((processedCooldownEvents++ & 0x1ff) === 0) {
                if (options.shouldStop?.()) throw new Error("OPEN_SCORE USD replay cancelled during cooldown aggregation.");
                if (processedCooldownEvents > 1) await yieldLoop();
            }
            const eventIndex = event.kind === "view" ? event.index : views.length + event.index;
            const selections = event.kind === "view"
                ? args.armSelectionsByView[event.index]
                : args.armSelectionsByProfitOnly[event.index];
            if (!selections) continue;
            const outcomes = returnsByView[eventIndex];
            const sourceView = event.kind === "view" ? args.gapFilteredViews[event.index] ?? null : null;
            const sourceProfitOnly = event.kind === "profit" ? args.gapFilteredProfitOnlyEvents[event.index] ?? null : null;
            const boundaryByAsset = args.boundaryIndicesByView?.[eventIndex] ?? null;
            if (event.kind === "view" && sourceView && sourceView.positives.length >= 2) {
                if (!outcomes) args.noDataEvents.add(event.index);
                else {
                    let allValid = true;
                    for (const candidate of sourceView.positives) {
                        const value = outcomes.get(candidate.assetIndex)?.long[hIdx];
                        if (value === undefined || !Number.isFinite(value)) { allValid = false; break; }
                    }
                    if (allValid) {
                        activeCountsAtEvents.push(sourceView.maxActivePairs);
                        const asset = assetNames[sourceView.topRaw]!;
                        topRawSelectionCounts.set(asset, (topRawSelectionCounts.get(asset) ?? 0) + 1);
                    }
                }
            }
            for (const field of REPLAY_ARM_FIELDS) {
                const selection = selections[field];
                if (!selection) continue;
                const previous = lastSelectedBoundaryByArm.get(field)!;
                const sourcePool = cooldownSourcePool(field, sourceView, sourceProfitOnly);
                const eligiblePool: Candidate[] = [];
                for (const candidate of sourcePool) {
                    const boundary = boundaryByAsset?.get(candidate.assetIndex);
                    const lastSelected = previous.get(candidate.assetIndex);
                    if (boundary === undefined || lastSelected === undefined
                        || boundary - lastSelected > cooldownBars) {
                        eligiblePool.push(candidate);
                    }
                }
                const selectedIndex = selection.selectedAssetIndex;
                if (selectedIndex >= 0) {
                    const selectedBoundary = boundaryByAsset?.get(selectedIndex);
                    if (selectedBoundary !== undefined) previous.set(selectedIndex, selectedBoundary);
                }
                if (selectedIndex < 0) continue;
                const selectedOutcome = outcomes?.get(selectedIndex);
                if (options.includeEventDetails && selectedOutcome?.statuses[hIdx] === "right_censored") {
                    ongoingEventDetails.push({
                        decisionTime: event.timeSec,
                        entryTime: Number.isFinite(selectedOutcome.entryTime) ? selectedOutcome.entryTime : null,
                        horizonBars: horizons[hIdx]!,
                        selector: ARM_EVENT_DETAIL_SELECTORS[field],
                        direction: "long",
                        asset: assetNames[selectedIndex]!,
                        eligibleCandidates: selection.poolSize,
                        unrealizedReturn: selectedOutcome.mtmLong[hIdx] ?? null,
                    });
                }
                // Singleton choices above still advance cooldown state, but
                // only a full eligible pool with alternatives contributes a
                // paired comparison. Unique arms keep their mean-tied subset
                // as the baseline while using the full pool for this gate.
                if (eligiblePool.length < 2 || !outcomes) continue;
                let bestMean: number | null = null;
                if (selection.control === "mean_tied_set") {
                    for (const candidate of eligiblePool) {
                        bestMean = bestMean === null ? candidate.mean : Math.max(bestMean, candidate.mean);
                    }
                    // BOT_MEAN_RAW_UNIQUE uses the lowest tied mean.
                    if (field === "botMeanRawUnique") {
                        bestMean = null;
                        for (const candidate of eligiblePool) {
                            bestMean = bestMean === null ? candidate.mean : Math.min(bestMean, candidate.mean);
                        }
                    }
                }
                let poolTotal = 0;
                let comparisonPoolSize = 0;
                let allFinite = true;
                for (const candidate of eligiblePool) {
                    if (bestMean !== null && candidate.mean !== bestMean) continue;
                    comparisonPoolSize += 1;
                    const candidateReturn = outcomes.get(candidate.assetIndex)?.long[hIdx];
                    if (candidateReturn === undefined || !Number.isFinite(candidateReturn)) {
                        allFinite = false;
                        break;
                    }
                    poolTotal += candidateReturn;
                }
                if (!allFinite || comparisonPoolSize === 0) continue;
                const selectedReturn = outcomes.get(selectedIndex)?.long[hIdx];
                if (selectedReturn === undefined || !Number.isFinite(selectedReturn)) continue;
                const controlReturn = selection.control === "mean_tied_set"
                    ? poolTotal / comparisonPoolSize
                    : (poolTotal - selectedReturn) / (eligiblePool.length - 1);
                const delta = selectedReturn - controlReturn;
                const armSeries = seriesByArm[field];
                const asset = assetNames[selectedIndex]!;
                armSeries.deltas.push(delta);
                armSeries.returns.push(selectedReturn);
                armSeries.times.push(event.timeSec);
                armSeries.assets.push(asset);
                armSeries.selectedCounts.set(asset, (armSeries.selectedCounts.get(asset) ?? 0) + 1);
                if (selection.tiedCount >= 2) armSeries.tieCount += 1;
                let samples = armSeries.samplesByAsset.get(asset);
                if (!samples) {
                    samples = { returns: [], deltas: [] };
                    armSeries.samplesByAsset.set(asset, samples);
                }
                samples.returns.push(selectedReturn);
                samples.deltas.push(delta);
                if (options.includeEventDetails) {
                    const entryTime = selectedOutcome?.entryTime;
                    const exitTime = selectedOutcome?.exitTimes[hIdx];
                    if (entryTime !== undefined && exitTime !== undefined && Number.isFinite(entryTime) && Number.isFinite(exitTime)) {
                        eventDetails.push({
                            decisionTime: event.timeSec,
                            entryTime,
                            exitTime,
                            horizonBars: horizons[hIdx]!,
                            selector: ARM_EVENT_DETAIL_SELECTORS[field],
                            direction: "long",
                            asset,
                            selectedReturn,
                            controlReturn,
                            delta,
                            eligibleCandidates: selection.poolSize,
                        });
                    }
                }
                if (field === "topMean" && selectedOutcome) {
                    const topMeanCandidate = eligiblePool.find((candidate) => candidate.assetIndex === selectedIndex);
                    if (topMeanCandidate) {
                        portfolioOpportunities.push({
                            asset,
                            decisionTime: event.timeSec,
                            entryTime: selectedOutcome.entryTime,
                            exitTime: selectedOutcome.exitTimes[hIdx]!,
                            netReturn: selectedReturn,
                            tied: selection.tiedCount >= 2,
                        });
                    }
                }
            }
        }

        const horizon = base.horizonResults[hIdx] as OpenScoreUsdReplayResult["horizons"][number] & Record<string, unknown>;
        const comparisons = {} as Record<ReplayArmField, ReplayComparison>;
        const exDominantComparisons: Partial<Record<ReplayArmField, ReplayComparison>> = {};
        const exContributorComparisons: Partial<Record<ReplayArmField, ReplayComparison>> = {};
        const contributorAssets: Partial<Record<ReplayArmField, string | null>> = {};
        const contributorEvents: Partial<Record<ReplayArmField, number>> = {};
        let topRawDominant: string | null = null;
        let topMeanDominant: string | null = null;
        for (const field of REPLAY_ARM_FIELDS) {
            const armSeries = seriesByArm[field];
            const build = (deltas: number[], returns: number[], times: number[]) =>
                buildReplayComparison(deltas, returns, times, blockCount, bootstrapSamples);
            const comparison = build(armSeries.deltas, armSeries.returns, armSeries.times);
            comparisons[field] = comparison;
            eligibleEventsMax = Math.max(eligibleEventsMax, comparison.events);
            const breakdown = buildAssetSelectionBreakdown(armSeries.selectedCounts, armSeries.samplesByAsset).byAsset;
            const baseField = replayArmBaseField(field);
            (horizon as Record<string, unknown>)[baseField] = comparison;
            (horizon as Record<string, unknown>)[`${baseField}ByAsset`] = breakdown;
            const dominantAsset = breakdown[0]?.asset ?? null;
            if (field === "topRaw") topRawDominant = dominantAsset;
            if (field === "topMean") topMeanDominant = dominantAsset;
            const exDominant = buildExDominantComparison(armSeries, dominantAsset, build);
            exDominantComparisons[field] = exDominant;
            if (field === "topRaw") {
                (horizon as Record<string, unknown>).topRawExDominant = exDominant;
                (horizon as Record<string, unknown>).dominantAsset = dominantAsset;
            } else {
                (horizon as Record<string, unknown>)[`${baseField}ExDominant`] = exDominant;
                (horizon as Record<string, unknown>)[`${baseField}DominantAsset`] = dominantAsset;
            }
            let contributorAsset: string | null = null;
            let greatestContribution = Number.NEGATIVE_INFINITY;
            const contributionSums = new Map<string, number>();
            const counts = new Map<string, number>();
            for (let i = 0; i < armSeries.assets.length; i += 1) {
                const selectedAsset = armSeries.assets[i]!;
                contributionSums.set(selectedAsset, (contributionSums.get(selectedAsset) ?? 0) + armSeries.deltas[i]!);
                counts.set(selectedAsset, (counts.get(selectedAsset) ?? 0) + 1);
            }
            for (const [selectedAsset, contribution] of contributionSums) {
                if (contribution > greatestContribution || (contribution === greatestContribution && selectedAsset < (contributorAsset ?? "~"))) {
                    contributorAsset = selectedAsset;
                    greatestContribution = contribution;
                }
            }
            const excludedCount = contributorAsset === null ? 0 : counts.get(contributorAsset) ?? 0;
            contributorAssets[field] = contributorAsset;
            contributorEvents[field] = excludedCount;
            exContributorComparisons[field] = contributorAsset === dominantAsset
                ? exDominant
                : buildExDominantComparison(armSeries, contributorAsset, build);
        }
        const topRawSeries = seriesByArm.topRaw;
        const topMeanSeries = seriesByArm.topMean;
        (horizon as Record<string, unknown>).topRawExDominant = exDominantComparisons.topRaw;
        (horizon as Record<string, unknown>).topMeanExDominant = exDominantComparisons.topMean;
        (horizon as Record<string, unknown>).topMeanDominantAsset = topMeanDominant;
        (horizon as Record<string, unknown>).dominantAsset = topRawDominant;
        (horizon as Record<string, unknown>).topMeanExTopContrib = exContributorComparisons.topMean;
        (horizon as Record<string, unknown>).topMeanTopContribAsset = contributorAssets.topMean ?? null;
        (horizon as Record<string, unknown>).armExTopContributorComparisons = exContributorComparisons;
        (horizon as Record<string, unknown>).armTopContributorAssets = contributorAssets;
        (horizon as Record<string, unknown>).armTopContributorEvents = contributorEvents;
        const topRawBreakdown = buildAssetSelectionBreakdown(topRawSeries.selectedCounts, topRawSeries.samplesByAsset);
        const selectedDegree = topRawSeries.assets.map((asset) => retainedDegree.get(asset) ?? 0);
        const topAssetShare = topRawBreakdown.totalSelected > 0
            ? topRawBreakdown.maxSelected / topRawBreakdown.totalSelected
            : null;
        const randomReturns = topMeanSeries.returns.map((selected, index) => selected - topMeanSeries.deltas[index]!);
        (horizon as Record<string, unknown>).pnl = {
            topMean: computeSelectorPnl(topMeanSeries.returns, topMeanSeries.times),
            random: computeSelectorPnl(randomReturns, topMeanSeries.times),
            topMeanPortfolio: simulateTopMeanPortfolio(portfolioOpportunities),
        };
        const candidateSelectionTotal = Array.from(topRawSelectionCounts.values()).reduce((sum, count) => sum + count, 0);
        const candidateSelectionMax = Math.max(0, ...topRawSelectionCounts.values());
        (horizon as Record<string, unknown>).candidateDegree = degreeSummary(
            activeCountsAtEvents,
            candidateSelectionTotal > 0 ? candidateSelectionMax / candidateSelectionTotal : null,
        );
        (horizon as Record<string, unknown>).selectedDegree = degreeSummary(selectedDegree, topAssetShare);
        const nRaw = comparisons.topRaw.events;
        const nMean = comparisons.topMean.events;
        (horizon as Record<string, unknown>).tieRates = {
            RAW: { events: nRaw, sameSelection: topRawSeries.tieCount, rate: nRaw > 0 ? topRawSeries.tieCount / nRaw : null },
            MEAN: { events: nMean, sameSelection: topMeanSeries.tieCount, rate: nMean > 0 ? topMeanSeries.tieCount / nMean : null },
        };
        onPhase("aggregate", `aggregated cooldown horizon ${horizons[hIdx]}`, hIdx + 1, horizons.length);
        await yieldLoop();
    }
    eventDetails.sort((left, right) => left.decisionTime - right.decisionTime
        || left.horizonBars - right.horizonBars
        || left.selector.localeCompare(right.selector));
    ongoingEventDetails.sort((left, right) => left.decisionTime - right.decisionTime
        || left.horizonBars - right.horizonBars
        || left.selector.localeCompare(right.selector));
    return {
        horizonResults: base.horizonResults,
        eventDetails,
        ongoingEventDetails,
        eligibleEventsMax,
    };
}

export interface AggregationStageResult {
    horizonResults: OpenScoreUsdReplayResult["horizons"];
    eventDetails: OpenScoreUsdEventDetail[];
    ongoingEventDetails: OpenScoreUsdOngoingEventDetail[];
    eligibleEventsMax: number;
}

export async function aggregateHorizonResults(args: {
    options: RunOpenScoreUsdReplayOptions;
    horizons: number[];
    blockCount: number;
    bootstrapSamples: number;
    /** Original views; only views.length is read (profit-only index offset). */
    views: readonly EventView[];
    gapFilteredViews: ReadonlyArray<EventView | null>;
    gapFilteredProfitOnlyEvents: readonly ProfitOnlyEvent[];
    botPicksByView: ReadonlyArray<BotViewPicks | null>;
    armSelectionsByView?: Array<ReplayArmSelectionMap | null>;
    armSelectionsByProfitOnly?: Array<ReplayArmSelectionMap | null>;
    /** Compact target candle boundaries used to replay cooldown eligibility. */
    boundaryIndicesByView?: Array<Map<number, number> | null>;
    /** Sparse per-(event, asset) outcome records; read-only here. */
    returnsByView: ReadonlyArray<ReadonlyMap<number, ViewOutcomeRecord> | null>;
    dataGapAssets: ReadonlyMap<number, unknown>;
    assetNames: readonly string[];
    /** Retained (submitted) pair degree per asset name. */
    retainedDegree: ReadonlyMap<string, number>;
    /** Engine-owned no-data event set; the ordinary-view loop appends to it. */
    noDataEvents: Set<number>;
    onPhase: ReplayPhaseCallback;
}): Promise<AggregationStageResult> {
    if (args.armSelectionsByView && args.armSelectionsByProfitOnly) {
        return aggregateCooldownSelection(args as AggregationInput & {
            armSelectionsByView: Array<ReplayArmSelectionMap | null>;
            armSelectionsByProfitOnly: Array<ReplayArmSelectionMap | null>;
            boundaryIndicesByView?: Array<Map<number, number> | null>;
        });
    }
    const {
        options, horizons, blockCount, bootstrapSamples,
        views, gapFilteredViews, gapFilteredProfitOnlyEvents, botPicksByView,
        returnsByView, dataGapAssets, assetNames, retainedDegree, noDataEvents, onPhase,
    } = args;
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
            if ((v & 0x1ff) === 0) {
                if (options.shouldStop?.()) throw new Error("OPEN_SCORE USD replay cancelled during aggregation.");
                if (v > 0) await yieldLoop();
            }
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
            selectedDegree.push(retainedDegree.get(selName) ?? 0);
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
            if ((pi & 0x1ff) === 0) {
                if (options.shouldStop?.()) throw new Error("OPEN_SCORE USD replay cancelled during aggregation.");
                if (pi > 0) await yieldLoop();
            }
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
        const buildComparison = (deltasArr: number[], topReturns: number[], times: number[]): ReplayComparison =>
            buildReplayComparison(deltasArr, topReturns, times, blockCount, bootstrapSamples);

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
        const topMeanExTopContrib = topMeanTopContribAsset === topMeanDominantAsset
            ? { ...topMeanExDominant, blockMeans: [...topMeanExDominant.blockMeans] }
            : buildExDominantComparison(topMean, topMeanTopContribAsset, buildComparison);
        const armSeries: Record<import("./types").ReplayArmField, SelectorSeries> = {
            topRawProfitNow,
            topMeanProfitNow,
            topRawProfitNowConf,
            topZ,
            topRaw,
            topMean,
            topMeanRawUnique,
            topRawProfit,
            topMeanProfit,
            botRawProfitNow,
            botMeanProfitNow,
            botZ,
            botRaw,
            botMean,
            botMeanRawUnique,
        };
        const armExTopContributorComparisons: Partial<Record<import("./types").ReplayArmField, ReplayComparison>> = {};
        const armTopContributorAssets: Partial<Record<import("./types").ReplayArmField, string | null>> = {};
        const armTopContributorEvents: Partial<Record<import("./types").ReplayArmField, number>> = {};
        for (const [arm, series] of Object.entries(armSeries) as Array<[
            import("./types").ReplayArmField,
            SelectorSeries,
        ]>) {
            let contributor: string | null = null;
            let largestContribution = Number.NEGATIVE_INFINITY;
            const contributionByAsset = new Map<string, number>();
            const eventCountByAsset = new Map<string, number>();
            for (let index = 0; index < series.assets.length; index += 1) {
                const asset = series.assets[index]!;
                contributionByAsset.set(asset, (contributionByAsset.get(asset) ?? 0) + series.deltas[index]!);
                eventCountByAsset.set(asset, (eventCountByAsset.get(asset) ?? 0) + 1);
            }
            for (const [asset, contribution] of contributionByAsset) {
                if (contribution > largestContribution || (contribution === largestContribution && asset < (contributor ?? "~"))) {
                    largestContribution = contribution;
                    contributor = asset;
                }
            }
            const excludedEvents = contributor === null ? 0 : eventCountByAsset.get(contributor) ?? 0;
            armTopContributorAssets[arm] = contributor;
            armTopContributorEvents[arm] = excludedEvents;
            armExTopContributorComparisons[arm] = arm === "topMean"
                ? topMeanExTopContrib
                : buildExDominantComparison(series, contributor, buildComparison);
        }
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
            armExTopContributorComparisons,
            armTopContributorAssets,
            armTopContributorEvents,
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
    eventDetails.sort((a, b) =>
        a.decisionTime - b.decisionTime
        || a.horizonBars - b.horizonBars
        || a.selector.localeCompare(b.selector));
    ongoingEventDetails.sort((a, b) =>
        a.decisionTime - b.decisionTime
        || a.horizonBars - b.horizonBars
        || a.asset.localeCompare(b.asset));

    return { horizonResults, eventDetails, ongoingEventDetails, eligibleEventsMax };
}
