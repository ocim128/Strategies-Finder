import { isMarkedLocalStockSymbol } from "../local-daily-datasets";
import {
    buildPreparedBatchSyntheticStateTimeline,
    calibrateBatchSyntheticDistanceScales,
    measureBatchSyntheticSnapshotDistance,
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    resolveBatchSyntheticMinerOptions,
    type BatchSyntheticMinerOptions,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticStateSnapshot,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";
import {
    computeStabilityDataLagBars,
    STABILITY_DATA_STALE_THRESHOLD_BARS,
} from "./miner-verdict-format-helpers";
import type {
    BatchDirectionForecastBias,
    BatchDirectionForecastRow,
    BatchSignalLifecycle,
    BatchSignalLifecycleAnalysis,
    BatchSignalLifecycleOutcome,
} from "./batch-signal-lifecycle-types";

export interface BatchSignalLifecycleForecastInput {
    interval: string;
    targets: readonly BatchSyntheticTargetArtifact[];
    artifacts: readonly BatchSyntheticPairArtifact[];
    options?: Partial<BatchSyntheticMinerOptions>;
    nowMs?: number;
}

interface ForecastAnalog {
    lifecycle: BatchSignalLifecycle;
    snapshot: BatchSyntheticStateSnapshot;
    outcome: BatchSignalLifecycleOutcome;
    distance: number;
    order: number;
}

export function buildBatchSignalLifecycleAnalyses(
    input: Omit<BatchSignalLifecycleForecastInput, "nowMs">,
): BatchSignalLifecycleAnalysis[] {
    return input.targets.map((target) => buildBatchSignalLifecycleAnalysis(target, input.artifacts, input.options));
}

export function buildBatchSignalLifecycleAnalysis(
    targetArtifact: BatchSyntheticTargetArtifact,
    artifacts: readonly BatchSyntheticPairArtifact[],
    rawOptions?: Partial<BatchSyntheticMinerOptions>,
): BatchSignalLifecycleAnalysis {
    const target = prepareBatchSyntheticTargetArtifacts([targetArtifact])[0];
    if (!target) throw new Error(`Target ${targetArtifact.symbol || targetArtifact.asset} has no candles.`);
    const linkedPairs = prepareBatchSyntheticPairArtifacts(artifacts)
        .filter((pair) => pair.baseAsset === target.asset || pair.quoteAsset === target.asset);
    const timeline = buildPreparedBatchSyntheticStateTimeline(target, linkedPairs, resolveBatchSyntheticMinerOptions(rawOptions));
    return {
        asset: target.asset,
        symbol: target.symbol,
        marketClock: isMarkedLocalStockSymbol(target.symbol) ? "us_equities" : "continuous",
        target,
        linkedPairCount: linkedPairs.length,
        timeline,
        lifecycles: segmentLifecycles(target.data, timeline),
    };
}

export function runBatchSignalLifecycleForecast(
    input: BatchSignalLifecycleForecastInput,
): { analyses: BatchSignalLifecycleAnalysis[]; rows: BatchDirectionForecastRow[] } {
    const analyses = buildBatchSignalLifecycleAnalyses(input);
    const options = resolveBatchSyntheticMinerOptions(input.options);
    return {
        analyses,
        rows: analyses.map((analysis) => forecastBatchSignalLifecycleAt(
            analysis,
            analysis.target.data.length - 1,
            input.interval,
            options,
            input.nowMs ?? Date.now(),
            true,
        )),
    };
}

export function forecastBatchSignalLifecycleAt(
    analysis: BatchSignalLifecycleAnalysis,
    cutoffIndex: number,
    interval: string,
    rawOptions?: Partial<BatchSyntheticMinerOptions>,
    nowMs = Date.now(),
    includeLiveFreshness = false,
): BatchDirectionForecastRow {
    const options = resolveBatchSyntheticMinerOptions(rawOptions);
    const observation = analysis.timeline[cutoffIndex];
    const base = createBaseRow(analysis, observation?.timeKey ?? null, observation?.index ?? null);
    if (!observation || !observation.observable || !observation.snapshot) {
        return { ...base, status: "INSUFFICIENT", reasonCode: "PAIR_COVERAGE" };
    }
    const snapshot = observation.snapshot;
    const freshness = includeLiveFreshness
        ? resolveFreshness(analysis.symbol, observation.timeKey, interval, nowMs)
        : { freshness: "FRESH" as const, freshnessReason: "CUTOFF_OBSERVABLE" };
    const rowBase: BatchDirectionForecastRow = {
        ...base,
        ...freshness,
        aggregateDirection: snapshot.direction,
        asOfPrice: snapshot.close,
        agreementCount: snapshot.agreementCount,
        oppositionCount: snapshot.oppositionCount,
    };
    if (!snapshot.direction) {
        return { ...rowBase, status: "NO_ACTIVE_STATE", reasonCode: "NO_ACTIVE_STATE" };
    }

    const current = findLifecycleAt(analysis.lifecycles, cutoffIndex);
    if (!current || current.direction !== snapshot.direction) {
        return { ...rowBase, status: "INSUFFICIENT", reasonCode: "LIFECYCLE_LEFT_CENSORED" };
    }
    const age = cutoffIndex - current.activationIndex;
    const candidates: ForecastAnalog[] = [];
    for (let order = 0; order < analysis.lifecycles.length; order += 1) {
        const lifecycle = analysis.lifecycles[order]!;
        if (lifecycle.direction !== current.direction || lifecycle.invalidationIndex === null) continue;
        const exitIndex = lifecycle.invalidationIndex + 1;
        if (exitIndex > cutoffIndex || lifecycle.snapshots.length <= age) continue;
        const decisionIndex = lifecycle.activationIndex + age;
        const outcome = computeLifecycleOutcome(analysis, decisionIndex, lifecycle.invalidationIndex);
        if (!outcome) continue;
        candidates.push({ lifecycle, snapshot: lifecycle.snapshots[age]!, outcome, distance: 0, order });
    }

    if (candidates.length < options.minSamples) {
        return {
            ...rowBase,
            lifecycleAge: age,
            candidateCount: candidates.length,
            status: "INSUFFICIENT",
            reasonCode: "LIFECYCLE_SAMPLES",
        };
    }

    const scales = calibrateBatchSyntheticDistanceScales(candidates.map((candidate) => candidate.snapshot));
    for (const candidate of candidates) {
        candidate.distance = measureBatchSyntheticSnapshotDistance(snapshot, candidate.snapshot, scales);
    }
    const analogCount = Math.min(
        options.neighborCountMax,
        Math.max(options.neighborCountMin, Math.ceil(Math.sqrt(candidates.length))),
    );
    const analogs = selectNearestAnalogs(candidates, analogCount);
    const returns = analogs.map((analog) => analog.outcome.rawReturnPct).sort(numberAscending);
    const upExcursions = analogs.map((analog) => analog.outcome.maxUpPct).sort(numberAscending);
    const downExcursions = analogs.map((analog) => analog.outcome.maxDownPct).sort(numberAscending);
    const positive = returns.filter((value) => value > 0).length;
    const probabilityPositive = positive / Math.max(1, returns.length);
    const bounds = wilsonBounds(positive, returns.length);
    const medianReturnPct = quantile(returns, 0.5);
    const upMedian = quantile(upExcursions, 0.5);
    const downMedian = quantile(downExcursions, 0.5);
    const averageDistance = mean(analogs.map((analog) => analog.distance));
    const bias = classifyBias(bounds.lower, bounds.upper, medianReturnPct, upMedian, downMedian, averageDistance, analogs.length, options);
    const favorable = bias === "UP" ? upMedian : bias === "DOWN" ? downMedian : null;
    const adverse = bias === "UP" ? downMedian : bias === "DOWN" ? upMedian : null;
    const directionReturn = bias === "DOWN" && medianReturnPct !== null ? -medianReturnPct : medianReturnPct;
    const conservativeProbability = bias === "UP" ? bounds.lower : bias === "DOWN" ? 1 - bounds.upper : null;
    const concentrationWarning = outcomeConcentration(analogs.map((analog) => analog.outcome.rawReturnPct)) > 0.5;

    return {
        ...rowBase,
        bias,
        status: bias === "NEUTRAL" ? "NO_EDGE" : "EDGE",
        reasonCode: bias === "NEUTRAL" ? "EDGE_GATES" : "EDGE_CONFIRMED",
        lifecycleAge: age,
        candidateCount: candidates.length,
        analogCount: analogs.length,
        probabilityPositive,
        probabilityLower: bounds.lower,
        probabilityUpper: bounds.upper,
        medianReturnPct,
        q1ReturnPct: quantile(returns, 0.25),
        q3ReturnPct: quantile(returns, 0.75),
        medianFavorableExcursionPct: favorable,
        medianAdverseExcursionPct: adverse,
        averageDistance,
        concentrationWarning,
        conservativeDirectionProbability: conservativeProbability,
        forecastDirectionReturnPct: directionReturn,
        returnToAdverseRatio: directionReturn !== null && adverse !== null && adverse > 0
            ? directionReturn / adverse
            : null,
    };
}

export function createTargetUnavailableForecastRow(asset: string, symbol: string, reasonCode: string): BatchDirectionForecastRow {
    return {
        ...emptyRow(asset, symbol),
        status: "TARGET_UNAVAILABLE",
        reasonCode,
    };
}

function segmentLifecycles(
    data: BatchSignalLifecycleAnalysis["target"]["data"],
    timeline: BatchSignalLifecycleAnalysis["timeline"],
): BatchSignalLifecycle[] {
    const lifecycles: BatchSignalLifecycle[] = [];
    let active: BatchSignalLifecycle | null = null;
    let ready = false;

    for (const observation of timeline) {
        if (!observation.observable || !observation.snapshot) {
            active = null;
            ready = false;
            continue;
        }
        const direction = observation.snapshot.direction;
        if (!ready) {
            if (direction === null) ready = true;
            continue;
        }
        if (!active) {
            if (direction) {
                active = createLifecycle(direction, observation.index, observation.snapshot);
                lifecycles.push(active);
            }
            continue;
        }
        if (direction === active.direction) {
            active.snapshots.push(observation.snapshot);
            continue;
        }
        active.invalidationIndex = observation.index;
        active.outcome = computeOutcomeFromData(data, active.activationIndex, observation.index);
        active = null;
        if (direction) {
            active = createLifecycle(direction, observation.index, observation.snapshot);
            lifecycles.push(active);
        }
    }
    return lifecycles;
}

function createLifecycle(
    direction: BatchSignalLifecycle["direction"],
    activationIndex: number,
    snapshot: BatchSyntheticStateSnapshot,
): BatchSignalLifecycle {
    return { direction, activationIndex, invalidationIndex: null, snapshots: [snapshot], outcome: null };
}

export function computeLifecycleOutcome(
    analysis: BatchSignalLifecycleAnalysis,
    decisionIndex: number,
    invalidationIndex: number,
): BatchSignalLifecycleOutcome | null {
    return computeOutcomeFromData(analysis.target.data, decisionIndex, invalidationIndex);
}

function computeOutcomeFromData(
    data: BatchSignalLifecycleAnalysis["target"]["data"],
    decisionIndex: number,
    invalidationIndex: number,
): BatchSignalLifecycleOutcome | null {
    const entryIndex = decisionIndex + 1;
    const exitIndex = invalidationIndex + 1;
    const entryPrice = data[entryIndex]?.open;
    const exitPrice = data[exitIndex]?.open;
    if (!isPositiveFinite(entryPrice) || !isPositiveFinite(exitPrice) || exitIndex <= entryIndex) return null;
    let maxHigh = entryPrice;
    let minLow = entryPrice;
    for (let index = entryIndex; index < exitIndex; index += 1) {
        const bar = data[index];
        if (!bar) continue;
        if (Number.isFinite(bar.high)) maxHigh = Math.max(maxHigh, bar.high);
        if (Number.isFinite(bar.low)) minLow = Math.min(minLow, bar.low);
    }
    return {
        entryIndex,
        exitIndex,
        entryPrice,
        exitPrice,
        rawReturnPct: ((exitPrice / entryPrice) - 1) * 100,
        maxUpPct: Math.max(0, ((maxHigh / entryPrice) - 1) * 100),
        maxDownPct: Math.max(0, (1 - (minLow / entryPrice)) * 100),
    };
}

export function findLifecycleAt(
    lifecycles: readonly BatchSignalLifecycle[],
    index: number,
): BatchSignalLifecycle | null {
    for (let i = lifecycles.length - 1; i >= 0; i -= 1) {
        const lifecycle = lifecycles[i]!;
        if (lifecycle.activationIndex > index) continue;
        if (lifecycle.invalidationIndex === null || lifecycle.invalidationIndex > index) return lifecycle;
        return null;
    }
    return null;
}

function classifyBias(
    lower: number,
    upper: number,
    medianReturn: number | null,
    upExcursion: number | null,
    downExcursion: number | null,
    averageDistance: number | null,
    analogCount: number,
    options: BatchSyntheticMinerOptions,
): BatchDirectionForecastBias {
    if (analogCount < options.neighborCountMin || averageDistance === null || averageDistance > options.maxEntryDistance) return "NEUTRAL";
    if (lower > 0.5 && (medianReturn ?? 0) > 0 && (upExcursion ?? 0) > (downExcursion ?? 0) * options.minMfeMaeRatio) return "UP";
    if (upper < 0.5 && (medianReturn ?? 0) < 0 && (downExcursion ?? 0) > (upExcursion ?? 0) * options.minMfeMaeRatio) return "DOWN";
    return "NEUTRAL";
}

function selectNearestAnalogs(candidates: readonly ForecastAnalog[], count: number): ForecastAnalog[] {
    if (count <= 0) return [];
    const heap: ForecastAnalog[] = [];
    for (const candidate of candidates) {
        if (!Number.isFinite(candidate.distance)) continue;
        if (heap.length < count) {
            heap.push(candidate);
            siftWorstUp(heap, heap.length - 1);
        } else if (compareAnalogs(candidate, heap[0]!) < 0) {
            heap[0] = candidate;
            siftWorstDown(heap, 0);
        }
    }
    return heap.sort(compareAnalogs);
}

function compareAnalogs(a: ForecastAnalog, b: ForecastAnalog): number {
    return a.distance - b.distance || a.order - b.order;
}

function siftWorstUp(heap: ForecastAnalog[], startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compareAnalogs(heap[parent]!, heap[index]!) >= 0) return;
        [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
        index = parent;
    }
}

function siftWorstDown(heap: ForecastAnalog[], startIndex: number): void {
    let index = startIndex;
    while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) return;
        const right = left + 1;
        let worst = left;
        if (right < heap.length && compareAnalogs(heap[right]!, heap[left]!) > 0) worst = right;
        if (compareAnalogs(heap[index]!, heap[worst]!) >= 0) return;
        [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
        index = worst;
    }
}

function createBaseRow(
    analysis: BatchSignalLifecycleAnalysis,
    asOfTimeKey: string | null,
    asOfIndex: number | null,
): BatchDirectionForecastRow {
    return {
        ...emptyRow(analysis.asset, analysis.symbol),
        asOfTimeKey,
        asOfPrice: asOfIndex === null ? null : analysis.target.data[asOfIndex]?.close ?? null,
    };
}

function emptyRow(asset: string, symbol: string): BatchDirectionForecastRow {
    return {
        asset,
        symbol,
        aggregateDirection: null,
        asOfTimeKey: null,
        asOfPrice: null,
        bias: "NEUTRAL",
        status: "INSUFFICIENT",
        reasonCode: "INSUFFICIENT",
        freshness: "UNKNOWN",
        freshnessReason: "NOT_EVALUATED",
        lifecycleAge: null,
        agreementCount: 0,
        oppositionCount: 0,
        candidateCount: 0,
        analogCount: 0,
        probabilityPositive: null,
        probabilityLower: null,
        probabilityUpper: null,
        medianReturnPct: null,
        q1ReturnPct: null,
        q3ReturnPct: null,
        medianFavorableExcursionPct: null,
        medianAdverseExcursionPct: null,
        averageDistance: null,
        concentrationWarning: false,
        conservativeDirectionProbability: null,
        forecastDirectionReturnPct: null,
        returnToAdverseRatio: null,
    };
}

function resolveFreshness(symbol: string, asOfTimeKey: string, interval: string, nowMs: number): Pick<BatchDirectionForecastRow, "freshness" | "freshnessReason"> {
    const lag = computeStabilityDataLagBars(asOfTimeKey, interval, nowMs, isMarkedLocalStockSymbol(symbol) ? "us_equities" : "continuous");
    if (lag === null) return { freshness: "UNKNOWN", freshnessReason: "DATA_TIME_UNKNOWN" };
    if (lag > STABILITY_DATA_STALE_THRESHOLD_BARS) return { freshness: "STALE", freshnessReason: "DATA_LAG" };
    return { freshness: "FRESH", freshnessReason: "DATA_CURRENT" };
}

function wilsonBounds(successes: number, total: number): { lower: number; upper: number } {
    if (total <= 0) return { lower: 0, upper: 1 };
    const z = 1.96;
    const p = successes / total;
    const denominator = 1 + (z * z) / total;
    const center = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return {
        lower: Math.max(0, (center - margin) / denominator),
        upper: Math.min(1, (center + margin) / denominator),
    };
}

function quantile(sorted: readonly number[], probability: number): number | null {
    if (sorted.length === 0) return null;
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower] ?? null;
    const weight = index - lower;
    return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function mean(values: readonly number[]): number | null {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function outcomeConcentration(values: readonly number[]): number {
    const absolute = values.map(Math.abs);
    const total = absolute.reduce((sum, value) => sum + value, 0);
    return total > 0 ? Math.max(...absolute) / total : 0;
}

function numberAscending(a: number, b: number): number {
    return a - b;
}

function isPositiveFinite(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value > 0;
}
