import type { Trade } from "../../types/index";
import type { WalkForwardResult } from "../walk-forward";
import { calculateSharpeRatioFromReturns } from "../performance-metrics";

export type WalkForwardPermutationMetric =
    | "net_profit"
    | "profit_factor"
    | "expectancy"
    | "trade_sharpe";

export type WalkForwardPermutationStatus =
    | "ok"
    | "no_trades"
    | "insufficient_sample"
    | "all_zero";

export interface WalkForwardPermutationConfig {
    permutations: number;
    seed: number;
    metric: WalkForwardPermutationMetric;
    minTrades?: number;
}

export interface WalkForwardPermutationResult {
    status: WalkForwardPermutationStatus;
    metric: WalkForwardPermutationMetric;
    metricLabel: string;
    permutations: number;
    seed: number;
    tradeCount: number;
    sampleRequirement: number;
    observedValue: number | null;
    nullMean: number | null;
    nullMedian: number | null;
    pValue: number | null;
    betterOrEqualCount: number;
    interpretation: string;
    nullModel: string;
    summary: string;
}

type PermutationMetricDefinition = {
    label: string;
    format: "currency" | "ratio";
};

type PermutationTradeSample = {
    pnlMagnitude: number;
    pnlPercentMagnitude: number;
};

const DEFAULT_MIN_TRADES = 5;

const METRIC_DEFINITIONS: Record<WalkForwardPermutationMetric, PermutationMetricDefinition> = {
    net_profit: {
        label: "Net Profit",
        format: "currency",
    },
    profit_factor: {
        label: "Profit Factor",
        format: "ratio",
    },
    expectancy: {
        label: "Expectancy / Trade",
        format: "currency",
    },
    trade_sharpe: {
        label: "Trade Sharpe",
        format: "ratio",
    },
};

const NULL_MODEL_DESCRIPTION =
    "Null model: keep the realized OOS trade count, order, and absolute pnl/pnl% magnitudes fixed, then randomize each trade's sign. " +
    "This tests whether the selected OOS result could arise without directional timing edge, given the same trade opportunity sizes.";

export function runWalkForwardPermutationTest(
    result: WalkForwardResult,
    config: WalkForwardPermutationConfig
): WalkForwardPermutationResult {
    const metric = config.metric;
    const metricMeta = METRIC_DEFINITIONS[metric];
    const permutations = Math.max(1, Math.floor(config.permutations));
    const seed = (Math.trunc(config.seed) >>> 0) || 1;
    const sampleRequirement = Math.max(DEFAULT_MIN_TRADES, Math.floor(config.minTrades ?? DEFAULT_MIN_TRADES));
    const samples = extractPermutationTradeSamples(result.combinedOOSTrades.trades);
    const tradeCount = samples.length;

    if (tradeCount === 0) {
        return buildEarlyResult(
            "no_trades",
            metric,
            metricMeta.label,
            permutations,
            seed,
            tradeCount,
            sampleRequirement,
            "No OOS trades are available from the latest walk-forward result.",
            "Run Walk-Forward or Quick Analysis first, then rerun the test once OOS trades exist."
        );
    }

    if (tradeCount < sampleRequirement) {
        return buildEarlyResult(
            "insufficient_sample",
            metric,
            metricMeta.label,
            permutations,
            seed,
            tradeCount,
            sampleRequirement,
            `Only ${tradeCount} OOS trades are available. The permutation test stays conservative below ${sampleRequirement} trades.`,
            "Insufficient sample for a meaningful luck test."
        );
    }

    const hasVariation = samples.some(sample => sample.pnlMagnitude > 1e-12 || sample.pnlPercentMagnitude > 1e-12);
    if (!hasVariation) {
        return buildEarlyResult(
            "all_zero",
            metric,
            metricMeta.label,
            permutations,
            seed,
            tradeCount,
            sampleRequirement,
            "All OOS trade outcomes are effectively zero, so a luck significance test is not informative.",
            "Inconclusive because the OOS trade sample has no measurable variation."
        );
    }

    const observedValue = computeObservedMetric(metric, result);
    const random = createSeededRandom(seed);
    const nullValues = new Array<number>(permutations);
    let betterOrEqualCount = 0;

    for (let i = 0; i < permutations; i++) {
        const permutedValue = computePermutedMetric(metric, samples, random);
        nullValues[i] = permutedValue;
        if (isAtLeastAsGood(permutedValue, observedValue)) {
            betterOrEqualCount++;
        }
    }

    const pValue = (betterOrEqualCount + 1) / (permutations + 1);
    const nullMean = mean(nullValues);
    const nullMedian = median(nullValues);
    const interpretation = describePermutationEvidence(observedValue, pValue);
    const summary = buildSummary(metricMeta.label, observedValue, pValue, tradeCount);

    return {
        status: "ok",
        metric,
        metricLabel: metricMeta.label,
        permutations,
        seed,
        tradeCount,
        sampleRequirement,
        observedValue,
        nullMean,
        nullMedian,
        pValue,
        betterOrEqualCount,
        interpretation,
        nullModel: NULL_MODEL_DESCRIPTION,
        summary,
    };
}

export function formatWalkForwardPermutationMetricValue(
    metric: WalkForwardPermutationMetric,
    value: number | null
): string {
    if (value === null || Number.isNaN(value)) return "--";
    if (value === Number.POSITIVE_INFINITY) return "Inf";
    if (value === Number.NEGATIVE_INFINITY) return "-Inf";

    const format = METRIC_DEFINITIONS[metric].format;
    if (format === "currency") {
        const prefix = value >= 0 ? "+" : "";
        return `${prefix}$${value.toFixed(2)}`;
    }
    return value.toFixed(3);
}

export function formatWalkForwardPermutationPValue(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "--";
    if (value < 0.001) return value.toExponential(2);
    return value.toFixed(4);
}

function buildEarlyResult(
    status: WalkForwardPermutationStatus,
    metric: WalkForwardPermutationMetric,
    metricLabel: string,
    permutations: number,
    seed: number,
    tradeCount: number,
    sampleRequirement: number,
    interpretation: string,
    summary: string
): WalkForwardPermutationResult {
    return {
        status,
        metric,
        metricLabel,
        permutations,
        seed,
        tradeCount,
        sampleRequirement,
        observedValue: null,
        nullMean: null,
        nullMedian: null,
        pValue: null,
        betterOrEqualCount: 0,
        interpretation,
        nullModel: NULL_MODEL_DESCRIPTION,
        summary,
    };
}

function extractPermutationTradeSamples(trades: Trade[]): PermutationTradeSample[] {
    return trades
        .filter(trade => Number.isFinite(trade.pnl) && Number.isFinite(trade.pnlPercent))
        .map(trade => ({
            pnlMagnitude: Math.abs(trade.pnl),
            pnlPercentMagnitude: Math.abs(trade.pnlPercent),
        }));
}

function computeObservedMetric(metric: WalkForwardPermutationMetric, result: WalkForwardResult): number {
    if (metric === "net_profit") return result.combinedOOSTrades.netProfit;
    if (metric === "profit_factor") return result.combinedOOSTrades.profitFactor;
    if (metric === "expectancy") return result.combinedOOSTrades.expectancy;
    return calculateSharpeRatioFromReturns(result.combinedOOSTrades.trades.map(trade => trade.pnlPercent));
}

function computePermutedMetric(
    metric: WalkForwardPermutationMetric,
    samples: PermutationTradeSample[],
    random: () => number
): number {
    let signedPnlSum = 0;
    let positivePnl = 0;
    let negativePnl = 0;
    let signedReturnSum = 0;
    const signedReturns: number[] = metric === "trade_sharpe" ? new Array(samples.length) : [];

    for (let i = 0; i < samples.length; i++) {
        const sign = random() >= 0.5 ? 1 : -1;
        const signedPnl = sign * samples[i].pnlMagnitude;
        const signedReturn = sign * samples[i].pnlPercentMagnitude;

        signedPnlSum += signedPnl;
        signedReturnSum += signedReturn;
        if (signedPnl > 0) positivePnl += signedPnl;
        else if (signedPnl < 0) negativePnl += Math.abs(signedPnl);
        if (metric === "trade_sharpe") signedReturns[i] = signedReturn;
    }

    if (metric === "net_profit") return signedPnlSum;
    if (metric === "expectancy") return signedPnlSum / samples.length;
    if (metric === "profit_factor") {
        if (negativePnl <= 1e-12) return positivePnl > 0 ? Number.POSITIVE_INFINITY : 0;
        return positivePnl / negativePnl;
    }
    return calculateSharpeRatioFromReturns(signedReturns);
}

function isAtLeastAsGood(candidate: number, observed: number): boolean {
    if (candidate === observed) return true;
    if (observed === Number.POSITIVE_INFINITY) return candidate === Number.POSITIVE_INFINITY;
    return candidate > observed;
}

function createSeededRandom(seed: number): () => number {
    let state = seed || 1;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function describePermutationEvidence(observedValue: number, pValue: number): string {
    if (!Number.isFinite(observedValue) || observedValue <= 0) {
        return "Observed metric is not positive, so this run does not provide evidence against luck.";
    }
    if (pValue <= 0.01) return "Strong evidence against luck";
    if (pValue <= 0.05) return "Evidence against luck";
    if (pValue <= 0.10) return "Weak evidence";
    return "Inconclusive";
}

function buildSummary(metricLabel: string, observedValue: number, pValue: number, tradeCount: number): string {
    if (!Number.isFinite(observedValue) || observedValue <= 0) {
        return `${metricLabel} is not positive on the observed OOS sample (${tradeCount} trades). This test stays inconclusive.`;
    }
    return `${metricLabel} beat ${tradeCount} OOS trade sign-randomizations with one-sided p=${formatWalkForwardPermutationPValue(pValue)}.`;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}
