import { isMarkedLocalStockSymbol } from "../local-daily-datasets";
import {
    buildPreparedBatchSyntheticStateTimeline,
    calibrateBatchSyntheticDistanceScales,
    measureBatchSyntheticSnapshotDistance,
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    resolveBatchSyntheticMinerOptions,
    type BatchSyntheticDirection,
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

export const LIFECYCLE_ACTIVATION_STRENGTH = 0.25;
export const LIFECYCLE_PERSISTENCE_STRENGTH = 0.10;

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
    const segmented = segmentLifecycles(target.data, timeline);
    return {
        asset: target.asset,
        symbol: target.symbol,
        marketClock: isMarkedLocalStockSymbol(target.symbol) ? "us_equities" : "continuous",
        target,
        linkedPairCount: linkedPairs.length,
        timeline,
        lifecycleDirectionByIndex: segmented.directionByIndex,
        lifecycles: segmented.lifecycles,
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
    const aggregateDirection = analysis.lifecycleDirectionByIndex[cutoffIndex] ?? null;
    const freshness = includeLiveFreshness
        ? resolveFreshness(analysis.symbol, observation.timeKey, interval, nowMs)
        : { freshness: "FRESH" as const, freshnessReason: "CUTOFF_OBSERVABLE" };
    const rowBase: BatchDirectionForecastRow = {
        ...base,
        ...freshness,
        aggregateDirection,
        asOfPrice: snapshot.close,
        agreementCount: snapshot.agreementCount,
        oppositionCount: snapshot.oppositionCount,
    };
    if (!aggregateDirection) {
        return { ...rowBase, status: "NO_ACTIVE_STATE", reasonCode: "NO_ACTIVE_STATE" };
    }

    const current = findLifecycleAt(analysis.lifecycles, cutoffIndex);
    if (!current || current.direction !== aggregateDirection) {
        return { ...rowBase, status: "INSUFFICIENT", reasonCode: "LIFECYCLE_LEFT_CENSORED" };
    }
    const age = cutoffIndex - current.activationIndex;
    const candidates: ForecastAnalog[] = [];
    for (let order = 0; order < analysis.lifecycles.length; order += 1) {
        const lifecycle = analysis.lifecycles[order]!;
        if (lifecycle.direction !== current.direction || lifecycle.invalidationIndex === null) continue;
        const exitIndex = lifecycle.invalidationIndex + 1;
        if (exitIndex > cutoffIndex) continue;
        const comparison = selectLifecycleComparisonSnapshot(lifecycle, snapshot, age);
        if (!comparison) continue;
        const decisionIndex = lifecycle.activationIndex + comparison.offset;
        const outcome = computeLifecycleOutcome(analysis, decisionIndex, lifecycle.invalidationIndex);
        if (!outcome) continue;
        candidates.push({ lifecycle, snapshot: comparison.snapshot, outcome, distance: 0, order });
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
    const classification = classifyBias(bounds.lower, bounds.upper, medianReturnPct, upMedian, downMedian, averageDistance, analogs.length, options);
    const bias = classification.bias;
    const excursionDirection = bias !== "NEUTRAL" ? bias : aggregateDirection === "long" ? "UP" : "DOWN";
    const favorable = excursionDirection === "UP" ? upMedian : downMedian;
    const adverse = excursionDirection === "UP" ? downMedian : upMedian;
    const directionReturn = bias === "DOWN" && medianReturnPct !== null ? -medianReturnPct : medianReturnPct;
    const conservativeProbability = bias === "UP" ? bounds.lower : bias === "DOWN" ? 1 - bounds.upper : null;
    const concentrationWarning = outcomeConcentration(analogs.map((analog) => analog.outcome.rawReturnPct)) > 0.5;

    const result: BatchDirectionForecastRow = {
        ...rowBase,
        bias,
        status: bias === "NEUTRAL" ? "NO_EDGE" : "EDGE",
        reasonCode: classification.reasonCode,
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
    if (includeLiveFreshness && result.status === "EDGE" && freshness.freshness !== "FRESH") {
        return {
            ...result,
            bias: "NEUTRAL",
            status: "NO_EDGE",
            reasonCode: freshness.freshness === "STALE" ? "DATA_STALE" : "DATA_TIME_UNKNOWN",
            conservativeDirectionProbability: null,
            forecastDirectionReturnPct: null,
            returnToAdverseRatio: null,
        };
    }
    return result;
}

function selectLifecycleComparisonSnapshot(
    lifecycle: BatchSignalLifecycle,
    current: BatchSyntheticStateSnapshot,
    currentAge: number,
): { snapshot: BatchSyntheticStateSnapshot; offset: number } | null {
    const currentMaturity = snapshotMaturity(current, currentAge);
    let best: { snapshot: BatchSyntheticStateSnapshot; offset: number; distance: number } | null = null;
    for (let offset = 0; offset < lifecycle.snapshots.length; offset += 1) {
        const candidate = lifecycle.snapshots[offset]!;
        const distance = Math.abs(Math.log1p(snapshotMaturity(candidate, offset)) - Math.log1p(currentMaturity));
        if (!best || distance < best.distance) best = { snapshot: candidate, offset, distance };
    }
    return best ? { snapshot: best.snapshot, offset: best.offset } : null;
}

function snapshotMaturity(snapshot: BatchSyntheticStateSnapshot, fallbackAge: number): number {
    return snapshot.medianBarsHeld !== null && Number.isFinite(snapshot.medianBarsHeld)
        ? Math.max(0, snapshot.medianBarsHeld)
        : Math.max(0, fallbackAge);
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
): { lifecycles: BatchSignalLifecycle[]; directionByIndex: Array<BatchSyntheticDirection | null> } {
    const lifecycles: BatchSignalLifecycle[] = [];
    const directionByIndex = Array<BatchSyntheticDirection | null>(timeline.length).fill(null);
    let active: BatchSignalLifecycle | null = null;
    let censoredDirection: BatchSyntheticDirection | null = null;
    let censoredSnapshot: BatchSyntheticStateSnapshot | null = null;
    let ready = false;

    for (const observation of timeline) {
        if (!observation.observable || !observation.snapshot) {
            active = null;
            censoredDirection = null;
            censoredSnapshot = null;
            ready = false;
            continue;
        }
        const signedStrength = snapshotSignedStrength(observation.snapshot);
        if (!ready) {
            if (censoredDirection === null) {
                censoredDirection = activationDirection(signedStrength);
                censoredSnapshot = censoredDirection ? observation.snapshot : null;
            }
            if (censoredDirection && persists(censoredDirection, signedStrength)) {
                if (!hasSupportingCohortReset(censoredSnapshot, observation.snapshot)) {
                    directionByIndex[observation.index] = censoredDirection;
                    censoredSnapshot = observation.snapshot;
                    continue;
                }
            }
            censoredDirection = null;
            censoredSnapshot = null;
            ready = true;
        }
        if (!active) {
            const direction = activationDirection(signedStrength);
            directionByIndex[observation.index] = direction;
            if (direction) {
                active = createLifecycle(direction, observation.index, observation.snapshot);
                lifecycles.push(active);
            }
            continue;
        }
        if (persists(active.direction, signedStrength)
            && !hasSupportingCohortReset(active.snapshots.at(-1) ?? null, observation.snapshot)) {
            directionByIndex[observation.index] = active.direction;
            active.snapshots.push(observation.snapshot);
            continue;
        }
        active.invalidationIndex = observation.index;
        active.outcome = computeOutcomeFromData(data, active.activationIndex, observation.index);
        active = null;
        const direction = activationDirection(signedStrength);
        directionByIndex[observation.index] = direction;
        if (direction) {
            active = createLifecycle(direction, observation.index, observation.snapshot);
            lifecycles.push(active);
        }
    }
    return { lifecycles, directionByIndex };
}

function hasSupportingCohortReset(
    previous: BatchSyntheticStateSnapshot | null,
    current: BatchSyntheticStateSnapshot,
): boolean {
    const previousAge = previous?.medianBarsHeld;
    const currentAge = current.medianBarsHeld;
    return previousAge !== null
        && previousAge !== undefined
        && currentAge !== null
        && Number.isFinite(previousAge)
        && Number.isFinite(currentAge)
        && currentAge < previousAge;
}

function snapshotSignedStrength(snapshot: BatchSyntheticStateSnapshot): number {
    if (!snapshot.direction || snapshot.activePeerCount <= 0) return 0;
    const magnitude = (snapshot.agreementCount - snapshot.oppositionCount) / snapshot.activePeerCount;
    return snapshot.direction === "long" ? magnitude : -magnitude;
}

function activationDirection(strength: number): BatchSyntheticDirection | null {
    if (strength >= LIFECYCLE_ACTIVATION_STRENGTH) return "long";
    if (strength <= -LIFECYCLE_ACTIVATION_STRENGTH) return "short";
    return null;
}

function persists(direction: BatchSyntheticDirection, strength: number): boolean {
    return direction === "long"
        ? strength >= LIFECYCLE_PERSISTENCE_STRENGTH
        : strength <= -LIFECYCLE_PERSISTENCE_STRENGTH;
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
): { bias: BatchDirectionForecastBias; reasonCode: string } {
    if (analogCount < options.neighborCountMin) return { bias: "NEUTRAL", reasonCode: "ANALOG_COUNT_GATE" };
    if (averageDistance === null || averageDistance > options.maxEntryDistance) return { bias: "NEUTRAL", reasonCode: "DISTANCE_GATE" };
    if (lower > 0.5) {
        if ((medianReturn ?? 0) <= 0) return { bias: "NEUTRAL", reasonCode: "RETURN_SIGN_GATE" };
        if ((upExcursion ?? 0) <= (downExcursion ?? 0) * options.minMfeMaeRatio) {
            return { bias: "NEUTRAL", reasonCode: "EXCURSION_GATE" };
        }
        return { bias: "UP", reasonCode: "EDGE_CONFIRMED" };
    }
    if (upper < 0.5) {
        if ((medianReturn ?? 0) >= 0) return { bias: "NEUTRAL", reasonCode: "RETURN_SIGN_GATE" };
        if ((downExcursion ?? 0) <= (upExcursion ?? 0) * options.minMfeMaeRatio) {
            return { bias: "NEUTRAL", reasonCode: "EXCURSION_GATE" };
        }
        return { bias: "DOWN", reasonCode: "EDGE_CONFIRMED" };
    }
    return { bias: "NEUTRAL", reasonCode: "WILSON_GATE" };
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
