import { parseTimeToUnixSeconds } from "../time-normalization";
import type { BatchSyntheticMinerOptions } from "./batch-synthetic-state-miner";
import {
    computeLifecycleOutcome,
    findLifecycleAt,
    forecastBatchSignalLifecycleAt,
} from "./batch-signal-lifecycle-forecast";
import type {
    BatchDirectionExecutionAssumptions,
    BatchDirectionForecastBenchmarks,
    BatchDirectionForecastQuality,
    BatchDirectionForecastRow,
    BatchDirectionPathMetrics,
    BatchDirectionSelectionPathResult,
    BatchSignalLifecycleAnalysis,
} from "./batch-signal-lifecycle-types";

export interface BatchSignalSelectionPathInput {
    analyses: readonly BatchSignalLifecycleAnalysis[];
    interval: string;
    execution: BatchDirectionExecutionAssumptions;
    options?: Partial<BatchSyntheticMinerOptions>;
    randomSeeds?: number;
    isCancelled?: () => boolean;
}

interface ReplayEvent {
    seconds: number;
    timeKey: string;
}

interface SelectionCandidate {
    analysis: BatchSignalLifecycleAnalysis;
    targetIndex: number;
    row: BatchDirectionForecastRow;
    score: number;
}

interface PendingFill {
    seconds: number;
    price: number;
    candidate?: SelectionCandidate;
}

interface OpenPosition {
    candidate: SelectionCandidate;
    lifecycleActivationIndex: number;
    entrySeconds: number;
    entryPrice: number;
    equityBeforeEntry: number;
    equityAfterEntry: number;
}

interface QualityAccumulator {
    percentiles: number[];
    excess: number[];
    hits: number[];
    regrets: number[];
    rankIcs: number[];
    comparable: number;
    unresolved: number;
    flatDecisions: number;
    abstentions: number;
}

interface SimulationResult {
    metrics: BatchDirectionPathMetrics;
    quality: BatchDirectionForecastQuality;
}

type Selector = (candidates: readonly SelectionCandidate[], random: () => number) => SelectionCandidate | null;

export function runBatchSignalSelectionPath(input: BatchSignalSelectionPathInput): BatchDirectionSelectionPathResult {
    const eligible = input.analyses.filter((analysis) => analysis.linkedPairCount > 0 && analysis.target.data.length > 1);
    if (eligible.length < 2) return unavailable("TARGET_COUNT", input.execution);
    if (new Set(eligible.map((analysis) => analysis.marketClock)).size !== 1) return unavailable("MIXED_MARKET_CLOCKS", input.execution);

    const overlap = resolveCommonOverlap(eligible);
    if (!overlap) return unavailable("COMMON_OVERLAP", input.execution);
    const events = buildReplayEvents(eligible, overlap.start, overlap.end);
    if (events.length < 10) return unavailable("COMMON_OVERLAP", input.execution);
    const testStartIndex = Math.max(1, Math.floor(events.length * 0.8));
    const testEvents = events.slice(testStartIndex);
    if (testEvents.length < 2) return unavailable("TEST_WINDOW", input.execution);

    const bestSelector: Selector = (candidates) => candidates[0] ?? null;
    const rawSelector: Selector = (candidates) => [...candidates]
        .sort((a, b) => b.row.agreementCount - a.row.agreementCount || a.analysis.symbol.localeCompare(b.analysis.symbol))[0] ?? null;
    const forecast = simulatePolicy(input, eligible, events, testStartIndex, "forecast", bestSelector, 1, true);
    const raw = simulatePolicy(input, eligible, events, testStartIndex, "raw", rawSelector, 1, false);

    const randomEquities: number[] = [];
    const seedCount = Math.max(1, Math.min(100, Math.floor(input.randomSeeds ?? 100)));
    for (let seed = 1; seed <= seedCount; seed += 1) {
        if (input.isCancelled?.()) break;
        const result = simulatePolicy(
            input,
            eligible,
            events,
            testStartIndex,
            "forecast",
            (candidates, random) => candidates.length > 0 ? candidates[Math.floor(random() * candidates.length)] ?? null : null,
            seed,
            false,
        );
        randomEquities.push(result.metrics.markedEquity);
    }
    randomEquities.sort((a, b) => a - b);
    const benchmarks: BatchDirectionForecastBenchmarks = {
        rawAgreement: raw.metrics,
        randomMedianEquity: quantile(randomEquities, 0.5) ?? input.execution.initialCapital,
        randomP05Equity: quantile(randomEquities, 0.05) ?? input.execution.initialCapital,
        randomP95Equity: quantile(randomEquities, 0.95) ?? input.execution.initialCapital,
        cashEquity: input.execution.initialCapital,
    };
    return { status: "OK", reasonCode: "OK", path: forecast.metrics, quality: forecast.quality, benchmarks };
}

function simulatePolicy(
    input: BatchSignalSelectionPathInput,
    analyses: readonly BatchSignalLifecycleAnalysis[],
    events: readonly ReplayEvent[],
    testStartIndex: number,
    candidateMode: "forecast" | "raw",
    selector: Selector,
    seed: number,
    collectQuality: boolean,
): SimulationResult {
    const startCapital = input.execution.initialCapital;
    const commission = Math.max(0, input.execution.commissionPercent) / 100;
    const slippage = Math.max(0, input.execution.slippageBps) / 10_000;
    const random = createRandom(seed);
    const quality = createQualityAccumulator();
    let equity = startCapital;
    let markedEquity = equity;
    let peak = equity;
    let maxDrawdown = 0;
    let position: OpenPosition | null = null;
    let pendingEntry: PendingFill | null = null;
    let pendingExit: PendingFill | null = null;
    let exposureEvents = 0;
    let turnover = 0;
    let ruin = false;
    const tradePnls: number[] = [];

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        if (input.isCancelled?.()) break;
        const event = events[eventIndex]!;
        const inTest = eventIndex >= testStartIndex;

        if (pendingExit && pendingExit.seconds === event.seconds && position) {
            const exitFill = adverseExitPrice(pendingExit.price, position.candidate.row.bias, slippage);
            const grossReturn = directionalReturn(position.entryPrice, exitFill, position.candidate.row.bias);
            equity = Math.max(0, position.equityAfterEntry * (1 + grossReturn) * (1 - commission));
            tradePnls.push(equity - position.equityBeforeEntry);
            turnover += 1;
            position = null;
            pendingExit = null;
            if (equity <= 0) ruin = true;
        }
        if (!ruin && pendingEntry && pendingEntry.seconds === event.seconds && !position && pendingEntry.candidate) {
            const candidate: SelectionCandidate = pendingEntry.candidate;
            const entryPrice = adverseEntryPrice(pendingEntry.price, candidate.row.bias, slippage);
            const afterCommission = Math.max(0, equity * (1 - commission));
            position = {
                candidate,
                lifecycleActivationIndex: findLifecycleAt(candidate.analysis.lifecycles, candidate.targetIndex)?.activationIndex ?? candidate.targetIndex,
                entrySeconds: event.seconds,
                entryPrice,
                equityBeforeEntry: equity,
                equityAfterEntry: afterCommission,
            };
            equity = afterCommission;
            turnover += 1;
            pendingEntry = null;
        }
        if (ruin) break;

        if (position) {
            if (inTest) exposureEvents += 1;
            const targetIndex = position.candidate.analysis.target.timeIndex.get(event.timeKey);
            if (targetIndex !== undefined) {
                const observation = position.candidate.analysis.timeline[targetIndex];
                const lifecycle = findLifecycleAt(position.candidate.analysis.lifecycles, targetIndex);
                const invalidated = !observation?.observable
                    || !lifecycle
                    || lifecycle.activationIndex !== position.lifecycleActivationIndex;
                if (invalidated && !pendingExit) {
                    const next = nextOpen(position.candidate.analysis, targetIndex);
                    if (next) {
                        pendingExit = next;
                        const candidates = collectCandidates(input, analyses, event, candidateMode);
                        const replacement = selector(candidates, random);
                        if (replacement) {
                            const replacementOpen = nextOpen(replacement.analysis, replacement.targetIndex);
                            if (replacementOpen?.seconds === next.seconds) {
                                pendingEntry = { ...replacementOpen, candidate: replacement };
                                if (collectQuality) recordQuality(quality, replacement, candidates);
                            }
                        }
                    }
                }
                const close = position.candidate.analysis.target.data[targetIndex]?.close;
                if (close && Number.isFinite(close)) {
                    markedEquity = Math.max(0, position.equityAfterEntry * (1 + directionalReturn(position.entryPrice, close, position.candidate.row.bias)));
                }
            }
        } else {
            markedEquity = equity;
            if (inTest && !pendingEntry) {
                const candidates = collectCandidates(input, analyses, event, candidateMode);
                if (collectQuality) quality.flatDecisions += 1;
                const selected = selector(candidates, random);
                if (!selected) {
                    if (collectQuality) quality.abstentions += 1;
                } else {
                    const entry = nextOpen(selected.analysis, selected.targetIndex);
                    if (entry) {
                        pendingEntry = { ...entry, candidate: selected };
                        if (collectQuality) recordQuality(quality, selected, candidates);
                    }
                }
            }
        }
        peak = Math.max(peak, markedEquity);
        maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - markedEquity) / peak : 0);
    }

    if (position) {
        const lastClose = lastKnownClose(position.candidate.analysis, events[events.length - 1]!.seconds);
        if (lastClose !== null) {
            markedEquity = Math.max(0, position.equityAfterEntry * (1 + directionalReturn(position.entryPrice, lastClose, position.candidate.row.bias)));
        }
    } else {
        markedEquity = equity;
    }
    const positivePnl = tradePnls.filter((value) => value > 0);
    const negativePnl = tradePnls.filter((value) => value < 0);
    const sortedPositive = tradePnls.filter((value) => value > 0).sort((a, b) => b - a);
    const totalPositive = positivePnl.reduce((sum, value) => sum + value, 0);
    const metrics: BatchDirectionPathMetrics = {
        testStartTimeKey: events[testStartIndex]?.timeKey ?? null,
        testEndTimeKey: events[events.length - 1]?.timeKey ?? null,
        startEquity: startCapital,
        realizedEquity: equity,
        markedEquity,
        realizedPnl: equity - startCapital,
        unrealizedPnl: markedEquity - equity,
        returnPct: startCapital > 0 ? ((markedEquity / startCapital) - 1) * 100 : 0,
        maxDrawdownPct: maxDrawdown * 100,
        trades: tradePnls.length,
        winRate: tradePnls.length > 0 ? positivePnl.length / tradePnls.length : null,
        profitFactor: negativePnl.length > 0
            ? totalPositive / Math.abs(negativePnl.reduce((sum, value) => sum + value, 0))
            : totalPositive > 0 ? Number.POSITIVE_INFINITY : null,
        exposurePct: Math.max(0, events.length - testStartIndex) > 0
            ? (exposureEvents / (events.length - testStartIndex)) * 100
            : 0,
        turnover,
        ruin,
        top1PnlConcentration: totalPositive > 0 ? (sortedPositive[0] ?? 0) / totalPositive : null,
        top3PnlConcentration: totalPositive > 0 ? sortedPositive.slice(0, 3).reduce((sum, value) => sum + value, 0) / totalPositive : null,
    };
    return { metrics, quality: finalizeQuality(quality, metrics.trades) };
}

function collectCandidates(
    input: BatchSignalSelectionPathInput,
    analyses: readonly BatchSignalLifecycleAnalysis[],
    event: ReplayEvent,
    mode: "forecast" | "raw",
): SelectionCandidate[] {
    const candidates: SelectionCandidate[] = [];
    for (const analysis of analyses) {
        const targetIndex = analysis.target.timeIndex.get(event.timeKey);
        if (targetIndex === undefined || targetIndex + 1 >= analysis.target.data.length) continue;
        const row = forecastBatchSignalLifecycleAt(analysis, targetIndex, input.interval, input.options, 0, false);
        if (mode === "forecast") {
            if (row.status !== "EDGE") continue;
        } else {
            if (!row.aggregateDirection || row.reasonCode === "PAIR_COVERAGE") continue;
            row.bias = row.aggregateDirection === "long" ? "UP" : "DOWN";
        }
        candidates.push({ analysis, targetIndex, row, score: forecastScore(row) });
    }
    if (mode === "forecast") candidates.sort(compareForecastCandidates);
    return candidates;
}

function recordQuality(
    quality: QualityAccumulator,
    selected: SelectionCandidate,
    candidates: readonly SelectionCandidate[],
): void {
    const outcomes = candidates.map((candidate) => ({ candidate, outcome: resolvedDirectionalOutcome(candidate) }));
    const resolved = outcomes.filter((item): item is { candidate: SelectionCandidate; outcome: number } => item.outcome !== null);
    if (resolved.length < 2) {
        quality.unresolved += 1;
        return;
    }
    const selectedOutcome = resolved.find((item) => item.candidate === selected)?.outcome;
    if (selectedOutcome === undefined) {
        quality.unresolved += 1;
        return;
    }
    const values = resolved.map((item) => item.outcome).sort((a, b) => a - b);
    const belowOrEqual = values.filter((value) => value <= selectedOutcome).length;
    quality.percentiles.push(belowOrEqual / values.length);
    quality.excess.push(selectedOutcome - (quantile(values, 0.5) ?? 0));
    quality.hits.push(selectedOutcome > 0 ? 1 : 0);
    quality.regrets.push(Math.max(...values) - selectedOutcome);
    quality.rankIcs.push(rankCorrelation(resolved.map((item) => item.candidate.score), resolved.map((item) => item.outcome)));
    quality.comparable += 1;
}

function resolvedDirectionalOutcome(candidate: SelectionCandidate): number | null {
    const lifecycle = findLifecycleAt(candidate.analysis.lifecycles, candidate.targetIndex);
    if (!lifecycle || lifecycle.invalidationIndex === null) return null;
    const outcome = computeLifecycleOutcome(candidate.analysis, candidate.targetIndex, lifecycle.invalidationIndex);
    if (!outcome) return null;
    return candidate.row.bias === "DOWN" ? -outcome.rawReturnPct : outcome.rawReturnPct;
}

function resolveCommonOverlap(analyses: readonly BatchSignalLifecycleAnalysis[]): { start: number; end: number } | null {
    let start = Number.NEGATIVE_INFINITY;
    let end = Number.POSITIVE_INFINITY;
    for (const analysis of analyses) {
        const observable = analysis.timeline.filter((entry) => entry.observable);
        const first = parseTimeToUnixSeconds(observable[0]?.timeKey ?? null);
        const last = parseTimeToUnixSeconds(observable[observable.length - 1]?.timeKey ?? null);
        if (first === null || last === null) return null;
        start = Math.max(start, first);
        end = Math.min(end, last);
    }
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function buildReplayEvents(analyses: readonly BatchSignalLifecycleAnalysis[], start: number, end: number): ReplayEvent[] {
    const bySeconds = new Map<number, string>();
    for (const analysis of analyses) {
        for (const observation of analysis.timeline) {
            const seconds = parseTimeToUnixSeconds(observation.timeKey);
            if (seconds !== null && seconds >= start && seconds <= end) bySeconds.set(seconds, observation.timeKey);
        }
    }
    return [...bySeconds.entries()].sort((a, b) => a[0] - b[0]).map(([seconds, timeKey]) => ({ seconds, timeKey }));
}

function nextOpen(analysis: BatchSignalLifecycleAnalysis, index: number): PendingFill | null {
    const next = analysis.target.data[index + 1];
    if (!next || !Number.isFinite(next.open) || next.open <= 0) return null;
    const seconds = parseTimeToUnixSeconds(next.time);
    return seconds === null ? null : { seconds, price: next.open };
}

function lastKnownClose(analysis: BatchSignalLifecycleAnalysis, seconds: number): number | null {
    for (let index = analysis.target.data.length - 1; index >= 0; index -= 1) {
        const bar = analysis.target.data[index]!;
        const time = parseTimeToUnixSeconds(bar.time);
        if (time !== null && time <= seconds && Number.isFinite(bar.close) && bar.close > 0) return bar.close;
    }
    return null;
}

function compareForecastCandidates(a: SelectionCandidate, b: SelectionCandidate): number {
    return (b.row.conservativeDirectionProbability ?? 0) - (a.row.conservativeDirectionProbability ?? 0)
        || (b.row.returnToAdverseRatio ?? Number.NEGATIVE_INFINITY) - (a.row.returnToAdverseRatio ?? Number.NEGATIVE_INFINITY)
        || (b.row.forecastDirectionReturnPct ?? Number.NEGATIVE_INFINITY) - (a.row.forecastDirectionReturnPct ?? Number.NEGATIVE_INFINITY)
        || (a.row.averageDistance ?? Number.POSITIVE_INFINITY) - (b.row.averageDistance ?? Number.POSITIVE_INFINITY)
        || a.analysis.symbol.localeCompare(b.analysis.symbol);
}

function forecastScore(row: BatchDirectionForecastRow): number {
    return (row.conservativeDirectionProbability ?? 0) * 1_000_000
        + (row.returnToAdverseRatio ?? 0) * 1_000
        + (row.forecastDirectionReturnPct ?? 0)
        - (row.averageDistance ?? 0) / 1_000;
}

function adverseEntryPrice(price: number, bias: BatchDirectionForecastRow["bias"], slippage: number): number {
    return bias === "DOWN" ? price * (1 - slippage) : price * (1 + slippage);
}

function adverseExitPrice(price: number, bias: BatchDirectionForecastRow["bias"], slippage: number): number {
    return bias === "DOWN" ? price * (1 + slippage) : price * (1 - slippage);
}

function directionalReturn(entry: number, exit: number, bias: BatchDirectionForecastRow["bias"]): number {
    if (entry <= 0) return -1;
    return bias === "DOWN" ? (entry - exit) / entry : (exit / entry) - 1;
}

function createQualityAccumulator(): QualityAccumulator {
    return { percentiles: [], excess: [], hits: [], regrets: [], rankIcs: [], comparable: 0, unresolved: 0, flatDecisions: 0, abstentions: 0 };
}

function finalizeQuality(accumulator: QualityAccumulator, trades: number): BatchDirectionForecastQuality {
    return {
        status: trades >= 12 && accumulator.comparable >= 12 ? "VALID" : "INSUFFICIENT",
        selectedReturnPercentile: mean(accumulator.percentiles),
        excessVsEligibleMedianPct: mean(accumulator.excess),
        selectionHitRate: mean(accumulator.hits),
        meanOpportunityRegretPct: mean(accumulator.regrets),
        rankIc: mean(accumulator.rankIcs),
        abstentionRate: accumulator.flatDecisions > 0 ? accumulator.abstentions / accumulator.flatDecisions : null,
        comparableDecisions: accumulator.comparable,
        excludedUnresolvedDecisions: accumulator.unresolved,
    };
}

function rankCorrelation(scores: readonly number[], outcomes: readonly number[]): number {
    if (scores.length < 2 || scores.length !== outcomes.length) return 0;
    const scoreRanks = ranks(scores);
    const outcomeRanks = ranks(outcomes);
    const scoreMean = mean(scoreRanks) ?? 0;
    const outcomeMean = mean(outcomeRanks) ?? 0;
    let numerator = 0;
    let scoreVariance = 0;
    let outcomeVariance = 0;
    for (let index = 0; index < scores.length; index += 1) {
        const a = scoreRanks[index]! - scoreMean;
        const b = outcomeRanks[index]! - outcomeMean;
        numerator += a * b;
        scoreVariance += a * a;
        outcomeVariance += b * b;
    }
    const denominator = Math.sqrt(scoreVariance * outcomeVariance);
    return denominator > 0 ? numerator / denominator : 0;
}

function ranks(values: readonly number[]): number[] {
    const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
    const result = Array<number>(values.length);
    for (let index = 0; index < ordered.length; index += 1) result[ordered[index]!.index] = index + 1;
    return result;
}

function emptyMetrics(execution: BatchDirectionExecutionAssumptions): BatchDirectionPathMetrics {
    return {
        testStartTimeKey: null,
        testEndTimeKey: null,
        startEquity: execution.initialCapital,
        realizedEquity: execution.initialCapital,
        markedEquity: execution.initialCapital,
        realizedPnl: 0,
        unrealizedPnl: 0,
        returnPct: 0,
        maxDrawdownPct: 0,
        trades: 0,
        winRate: null,
        profitFactor: null,
        exposurePct: 0,
        turnover: 0,
        ruin: false,
        top1PnlConcentration: null,
        top3PnlConcentration: null,
    };
}

function unavailable(reasonCode: string, execution: BatchDirectionExecutionAssumptions): BatchDirectionSelectionPathResult {
    const path = emptyMetrics(execution);
    return {
        status: "PATH_UNAVAILABLE",
        reasonCode,
        path,
        quality: finalizeQuality(createQualityAccumulator(), 0),
        benchmarks: { rawAgreement: path, randomMedianEquity: execution.initialCapital, randomP05Equity: execution.initialCapital, randomP95Equity: execution.initialCapital, cashEquity: execution.initialCapital },
    };
}

function createRandom(seed: number): () => number {
    let value = Math.max(1, Math.floor(seed)) >>> 0;
    return () => {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return (value >>> 0) / 0x1_0000_0000;
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
