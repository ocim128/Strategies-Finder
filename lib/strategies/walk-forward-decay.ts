import { mean, sampleStdDev } from "../statistics-utils";
import type { ParameterRange, WalkForwardResult, WalkForwardWindow } from "./walk-forward";

const EPSILON = 1e-9;

export interface WalkForwardParameterDriftMetric {
    name: string;
    firstValue: number;
    latestValue: number;
    meanValue: number;
    minValue: number;
    maxValue: number;
    standardDeviation: number;
    normalizedStdDev: number;
    slopePerWindow: number;
    normalizedTrendPerWindow: number;
    trendDirection: "up" | "down" | "flat";
    driftPercentOfRange: number;
    stabilityScore: number;
}

export interface WalkForwardAlphaDecayAnalysis {
    status: "decaying" | "weakening" | "stable" | "strengthening" | "improving" | "insufficient_data";
    earlyEdge: number;
    recentEdge: number;
    recentVsEarlyDelta: number;
    edgeSlopePerWindow: number;
    confidence: number;
}

export interface WalkForwardCusumAnalysis {
    detected: boolean;
    direction: "negative_shift" | "positive_shift" | "none";
    changeWindowIndex: number | null;
    maxPositiveCusum: number;
    maxNegativeCusum: number;
    threshold: number;
}

export interface WalkForwardRollingRiskPoint {
    windowIndex: number;
    sharpe: number;
    sortino: number;
}

export interface WalkForwardHalfLifeAnalysis {
    halfLifeWindows: number | null;
    halfLifeBars: number | null;
    fitQuality: number;
    source: "rolling_sharpe" | "none";
    reason: string;
}

export interface WalkForwardRollingRiskComparison {
    comparisonWindowSize: number;
    sharpeLatestVsPeak: number | null;
    sortinoLatestVsPeak: number | null;
    sharpeRecentVsPrior: number | null;
    sortinoRecentVsPrior: number | null;
}

export interface WalkForwardDecayMonitoring {
    parameterMetrics: WalkForwardParameterDriftMetric[];
    alphaDecay: WalkForwardAlphaDecayAnalysis;
    cusum: WalkForwardCusumAnalysis;
    rollingRiskWindowSize: number;
    rollingRisk: WalkForwardRollingRiskPoint[];
    rollingComparison: WalkForwardRollingRiskComparison;
    halfLife: WalkForwardHalfLifeAnalysis;
    robustnessPenalty: number;
    robustnessPenaltyReasons: string[];
}

type RegressionSummary = {
    slope: number;
    intercept: number;
    correlation: number;
    rSquared: number;
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function calculateRegression(values: readonly number[]): RegressionSummary {
    if (values.length < 2) {
        return { slope: 0, intercept: values[0] ?? 0, correlation: 0, rSquared: 0 };
    }

    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = mean(values);
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;

    for (let index = 0; index < n; index += 1) {
        const x = index - xMean;
        const y = values[index] - yMean;
        covariance += x * y;
        varianceX += x * x;
        varianceY += y * y;
    }

    const slope = varianceX > EPSILON ? covariance / varianceX : 0;
    const intercept = yMean - slope * xMean;
    const correlation = varianceX > EPSILON && varianceY > EPSILON
        ? covariance / Math.sqrt(varianceX * varianceY)
        : 0;

    return {
        slope,
        intercept,
        correlation,
        rSquared: clamp(correlation * correlation, 0, 1),
    };
}

function getWindowSortino(window: WalkForwardWindow): number {
    const sortino = window.outOfSampleResult.performanceAnalytics?.sortinoRatio;
    if (Number.isFinite(sortino)) {
        return Number(sortino);
    }
    return Number.isFinite(window.outOfSampleResult.sharpeRatio)
        ? window.outOfSampleResult.sharpeRatio
        : 0;
}

function getWindowEdge(window: WalkForwardWindow): number {
    const sharpe = Number.isFinite(window.outOfSampleResult.sharpeRatio)
        ? window.outOfSampleResult.sharpeRatio
        : 0;
    const sortino = getWindowSortino(window);
    return (sharpe * 0.6) + (sortino * 0.4);
}

function buildParameterMetrics(
    windows: readonly WalkForwardWindow[],
    ranges: readonly ParameterRange[]
): WalkForwardParameterDriftMetric[] {
    if (windows.length === 0 || ranges.length === 0) {
        return [];
    }

    return ranges.flatMap((range) => {
        const values = windows
            .map((window) => Number(window.optimizedParams[range.name]))
            .filter((value) => Number.isFinite(value));

        if (values.length === 0) {
            return [];
        }

        const firstValue = values[0] ?? 0;
        const latestValue = values[values.length - 1] ?? firstValue;
        const meanValue = mean(values);
        const standardDeviation = sampleStdDev(values);
        const regression = calculateRegression(values);
        const rangeSpan = Math.max(EPSILON, range.max - range.min);
        const normalizedStdDev = standardDeviation / rangeSpan;
        const normalizedTrendPerWindow = regression.slope / rangeSpan;
        const driftPercentOfRange = ((latestValue - firstValue) / rangeSpan) * 100;
        const driftRate = Math.abs(regression.slope) / rangeSpan;
        const trendDirection: WalkForwardParameterDriftMetric["trendDirection"] =
            normalizedTrendPerWindow > 0.002 ? "up" : normalizedTrendPerWindow < -0.002 ? "down" : "flat";
        const stabilityScore = clamp(
            100 - (normalizedStdDev * 140) - (Math.abs(driftPercentOfRange) * 0.35) - (driftRate * 600),
            0,
            100
        );

        return [{
            name: range.name,
            firstValue,
            latestValue,
            meanValue,
            minValue: Math.min(...values),
            maxValue: Math.max(...values),
            standardDeviation,
            normalizedStdDev,
            slopePerWindow: regression.slope,
            normalizedTrendPerWindow,
            trendDirection,
            driftPercentOfRange,
            stabilityScore,
        }];
    });
}

function buildRollingRiskSeries(windows: readonly WalkForwardWindow[]): {
    rollingRiskWindowSize: number;
    rollingRisk: WalkForwardRollingRiskPoint[];
} {
    if (windows.length === 0) {
        return { rollingRiskWindowSize: 0, rollingRisk: [] };
    }

    const rollingRiskWindowSize = Math.min(5, Math.max(2, Math.floor(windows.length / 3)));
    const sharpeSeries = windows.map((window) => Number.isFinite(window.outOfSampleResult.sharpeRatio) ? window.outOfSampleResult.sharpeRatio : 0);
    const sortinoSeries = windows.map((window) => getWindowSortino(window));
    const rollingRisk: WalkForwardRollingRiskPoint[] = [];

    for (let endIndex = rollingRiskWindowSize - 1; endIndex < windows.length; endIndex += 1) {
        const sharpeSlice = sharpeSeries.slice(endIndex - rollingRiskWindowSize + 1, endIndex + 1);
        const sortinoSlice = sortinoSeries.slice(endIndex - rollingRiskWindowSize + 1, endIndex + 1);
        rollingRisk.push({
            windowIndex: windows[endIndex]?.windowIndex ?? endIndex,
            sharpe: mean(sharpeSlice),
            sortino: mean(sortinoSlice),
        });
    }

    return { rollingRiskWindowSize, rollingRisk };
}

function buildAlphaDecayAnalysis(edgeSeries: readonly number[]): WalkForwardAlphaDecayAnalysis {
    if (edgeSeries.length < 3) {
        return {
            status: "insufficient_data",
            earlyEdge: 0,
            recentEdge: 0,
            recentVsEarlyDelta: 0,
            edgeSlopePerWindow: 0,
            confidence: 0,
        };
    }

    const splitIndex = Math.max(1, Math.floor(edgeSeries.length / 2));
    const earlyEdge = mean(edgeSeries.slice(0, splitIndex));
    const recentEdge = mean(edgeSeries.slice(splitIndex));
    const recentVsEarlyDelta = recentEdge - earlyEdge;
    const regression = calculateRegression(edgeSeries);
    const edgeStdDev = sampleStdDev(edgeSeries);
    const hardDeltaThreshold = Math.max(0.2, edgeStdDev * 0.35, Math.abs(earlyEdge) * 0.18);
    const softDeltaThreshold = Math.max(0.1, edgeStdDev * 0.18, Math.abs(earlyEdge) * 0.12);
    const hardSlopeThreshold = hardDeltaThreshold / Math.max(2, edgeSeries.length - 1);
    const softSlopeThreshold = softDeltaThreshold / Math.max(2, edgeSeries.length - 1);
    const confidence = clamp(Math.abs(regression.correlation) * 100, 0, 100);

    let status: WalkForwardAlphaDecayAnalysis["status"] = "stable";
    if (regression.slope <= -hardSlopeThreshold && recentVsEarlyDelta <= -hardDeltaThreshold) {
        status = "decaying";
    } else if (regression.slope >= hardSlopeThreshold && recentVsEarlyDelta >= hardDeltaThreshold) {
        status = "improving";
    } else if (regression.slope <= -softSlopeThreshold || recentVsEarlyDelta <= -softDeltaThreshold) {
        status = "weakening";
    } else if (regression.slope >= softSlopeThreshold || recentVsEarlyDelta >= softDeltaThreshold) {
        status = "strengthening";
    }

    return {
        status,
        earlyEdge,
        recentEdge,
        recentVsEarlyDelta,
        edgeSlopePerWindow: regression.slope,
        confidence,
    };
}

function buildCusumAnalysis(edgeSeries: readonly number[], windows: readonly WalkForwardWindow[]): WalkForwardCusumAnalysis {
    if (edgeSeries.length < 4) {
        return {
            detected: false,
            direction: "none",
            changeWindowIndex: null,
            maxPositiveCusum: 0,
            maxNegativeCusum: 0,
            threshold: 0,
        };
    }

    const baselineLength = Math.max(2, Math.floor(edgeSeries.length / 3));
    const baselineSlice = edgeSeries.slice(0, baselineLength);
    const average = mean(baselineSlice);
    const standardDeviation = Math.max(sampleStdDev(baselineSlice), sampleStdDev(edgeSeries));
    if (standardDeviation <= EPSILON) {
        return {
            detected: false,
            direction: "none",
            changeWindowIndex: null,
            maxPositiveCusum: 0,
            maxNegativeCusum: 0,
            threshold: 0,
        };
    }

    const recentLength = Math.max(2, Math.floor(edgeSeries.length / 4));
    const recentSlice = edgeSeries.slice(-recentLength);
    const recentStdDev = sampleStdDev(recentSlice);
    const volatilityRatio = standardDeviation > EPSILON ? recentStdDev / standardDeviation : 1;
    const allowance = clamp(0.18 + (volatilityRatio * 0.08), 0.18, 0.32);
    const threshold = clamp(1.75 + (Math.log2(edgeSeries.length + 1) * 0.55) + (volatilityRatio * 0.6), 2.2, 6.5);
    let positiveCusum = 0;
    let negativeCusum = 0;
    let maxPositiveCusum = 0;
    let maxNegativeCusum = 0;
    let positiveIndex: number | null = null;
    let negativeIndex: number | null = null;

    for (let index = 0; index < edgeSeries.length; index += 1) {
        const normalized = (edgeSeries[index] - average) / standardDeviation;
        positiveCusum = Math.max(0, positiveCusum + normalized - allowance);
        negativeCusum = Math.min(0, negativeCusum + normalized + allowance);

        if (positiveCusum > maxPositiveCusum) {
            maxPositiveCusum = positiveCusum;
            positiveIndex = index;
        }
        if (negativeCusum < maxNegativeCusum) {
            maxNegativeCusum = negativeCusum;
            negativeIndex = index;
        }
    }

    const negativeTriggered = Math.abs(maxNegativeCusum) >= threshold;
    const positiveTriggered = maxPositiveCusum >= threshold;

    if (!negativeTriggered && !positiveTriggered) {
        return {
            detected: false,
            direction: "none",
            changeWindowIndex: null,
            maxPositiveCusum,
            maxNegativeCusum: Math.abs(maxNegativeCusum),
            threshold,
        };
    }

    const chooseNegative = Math.abs(maxNegativeCusum) >= maxPositiveCusum;
    const changeIndex = chooseNegative ? negativeIndex : positiveIndex;
    return {
        detected: true,
        direction: chooseNegative ? "negative_shift" : "positive_shift",
        changeWindowIndex: changeIndex === null ? null : (windows[changeIndex]?.windowIndex ?? changeIndex),
        maxPositiveCusum,
        maxNegativeCusum: Math.abs(maxNegativeCusum),
        threshold,
    };
}

function buildHalfLifeAnalysis(
    rollingRisk: readonly WalkForwardRollingRiskPoint[],
    windows: readonly WalkForwardWindow[]
): WalkForwardHalfLifeAnalysis {
    const positiveSharpeSeries = rollingRisk.filter((point) => point.sharpe > 0.05);
    if (positiveSharpeSeries.length < 3) {
        return {
            halfLifeWindows: null,
            halfLifeBars: null,
            fitQuality: 0,
            source: "none",
            reason: "Need at least 3 positive rolling-Sharpe points.",
        };
    }

    const baseline = positiveSharpeSeries[0]?.sharpe ?? 0;
    if (baseline <= 0.05) {
        return {
            halfLifeWindows: null,
            halfLifeBars: null,
            fitQuality: 0,
            source: "none",
            reason: "Initial rolling Sharpe is too small for a meaningful half-life estimate.",
        };
    }

    const normalizedSeries = positiveSharpeSeries
        .map((point) => point.sharpe / baseline)
        .filter((value) => Number.isFinite(value) && value > EPSILON);

    if (normalizedSeries.length < 3 || (normalizedSeries[normalizedSeries.length - 1] ?? 1) >= 0.98) {
        return {
            halfLifeWindows: null,
            halfLifeBars: null,
            fitQuality: 0,
            source: "none",
            reason: "No sustained rolling-Sharpe decay toward half the starting level.",
        };
    }

    const logSeries = normalizedSeries.map((value) => Math.log(value));
    const regression = calculateRegression(logSeries);
    if (regression.slope >= -EPSILON || regression.rSquared < 0.30) {
        return {
            halfLifeWindows: null,
            halfLifeBars: null,
            fitQuality: regression.rSquared,
            source: "none",
            reason: "Decay fit is too weak or not monotonic enough.",
        };
    }

    const averageTestBars = windows.length > 0
        ? mean(windows.map((window) => Math.max(1, window.testEnd - window.testStart)))
        : 0;
    const halfLifeWindows = Math.log(2) / -regression.slope;

    return {
        halfLifeWindows,
        halfLifeBars: averageTestBars > 0 ? halfLifeWindows * averageTestBars : null,
        fitQuality: regression.rSquared,
        source: "rolling_sharpe",
        reason: "Estimated from an exponential fit on rolling Sharpe.",
    };
}

function buildRollingRiskComparison(rollingRisk: readonly WalkForwardRollingRiskPoint[]): WalkForwardRollingRiskComparison {
    if (rollingRisk.length === 0) {
        return {
            comparisonWindowSize: 0,
            sharpeLatestVsPeak: null,
            sortinoLatestVsPeak: null,
            sharpeRecentVsPrior: null,
            sortinoRecentVsPrior: null,
        };
    }

    const comparisonWindowSize = Math.min(10, Math.max(3, Math.floor(rollingRisk.length / 4)));
    const latest = rollingRisk[rollingRisk.length - 1] ?? null;
    const peakSharpe = rollingRisk.reduce((best, point) => point.sharpe > best.sharpe ? point : best, rollingRisk[0]!);
    const peakSortino = rollingRisk.reduce((best, point) => point.sortino > best.sortino ? point : best, rollingRisk[0]!);

    let sharpeRecentVsPrior: number | null = null;
    let sortinoRecentVsPrior: number | null = null;
    if (rollingRisk.length >= comparisonWindowSize * 2) {
        const recentSlice = rollingRisk.slice(-comparisonWindowSize);
        const priorSlice = rollingRisk.slice(-(comparisonWindowSize * 2), -comparisonWindowSize);
        sharpeRecentVsPrior = mean(recentSlice.map((point) => point.sharpe)) - mean(priorSlice.map((point) => point.sharpe));
        sortinoRecentVsPrior = mean(recentSlice.map((point) => point.sortino)) - mean(priorSlice.map((point) => point.sortino));
    }

    return {
        comparisonWindowSize,
        sharpeLatestVsPeak: latest ? latest.sharpe - peakSharpe.sharpe : null,
        sortinoLatestVsPeak: latest ? latest.sortino - peakSortino.sortino : null,
        sharpeRecentVsPrior,
        sortinoRecentVsPrior,
    };
}

function calculateDecayRobustnessPenalty(
    result: WalkForwardResult,
    alphaDecay: WalkForwardAlphaDecayAnalysis,
    cusum: WalkForwardCusumAnalysis,
    rollingRisk: readonly WalkForwardRollingRiskPoint[],
    rollingComparison: WalkForwardRollingRiskComparison
): { penalty: number; reasons: string[] } {
    const reasons: string[] = [];
    let penalty = 0;
    const latestRolling = rollingRisk[rollingRisk.length - 1] ?? null;

    if (alphaDecay.status === "decaying") {
        penalty += 4;
        reasons.push("alpha decaying");
    } else if (alphaDecay.status === "weakening") {
        penalty += 2;
        reasons.push("alpha weakening");
    }

    if (cusum.direction === "negative_shift") {
        penalty += 2;
        reasons.push("negative structural shift");
    }

    if (latestRolling) {
        if (latestRolling.sharpe < 0) {
            penalty += 4;
            reasons.push("latest rolling Sharpe below 0");
        } else if (latestRolling.sharpe < 0.5) {
            penalty += 2;
            reasons.push("latest rolling Sharpe weak");
        }
    }

    if ((rollingComparison.sharpeRecentVsPrior ?? 0) <= -1) {
        penalty += 2;
        reasons.push("recent Sharpe dropped versus prior block");
    } else if ((rollingComparison.sharpeRecentVsPrior ?? 0) <= -0.4) {
        penalty += 1;
        reasons.push("recent Sharpe softened versus prior block");
    }

    if (result.parameterStability < 45 && penalty > 0) {
        penalty += 1;
        reasons.push("low parameter stability amplifies decay risk");
    }

    return {
        penalty: clamp(penalty, 0, 12),
        reasons,
    };
}

export function buildWalkForwardDecayMonitoring(
    result: WalkForwardResult,
    parameterRanges: readonly ParameterRange[]
): WalkForwardDecayMonitoring {
    const parameterMetrics = buildParameterMetrics(result.windows, parameterRanges);
    const { rollingRiskWindowSize, rollingRisk } = buildRollingRiskSeries(result.windows);
    const edgeSeries = result.windows.map((window) => getWindowEdge(window));
    const alphaDecay = buildAlphaDecayAnalysis(edgeSeries);
    const cusum = buildCusumAnalysis(edgeSeries, result.windows);
    const rollingComparison = buildRollingRiskComparison(rollingRisk);
    const halfLife = buildHalfLifeAnalysis(rollingRisk, result.windows);
    const robustnessPenalty = calculateDecayRobustnessPenalty(result, alphaDecay, cusum, rollingRisk, rollingComparison);

    return {
        parameterMetrics,
        alphaDecay,
        cusum,
        rollingRiskWindowSize,
        rollingRisk,
        rollingComparison,
        halfLife,
        robustnessPenalty: robustnessPenalty.penalty,
        robustnessPenaltyReasons: robustnessPenalty.reasons,
    };
}

export function withWalkForwardDecayMonitoring(
    result: WalkForwardResult,
    parameterRanges: readonly ParameterRange[]
): WalkForwardResult {
    const decayMonitoring = buildWalkForwardDecayMonitoring(result, parameterRanges);
    return {
        ...result,
        robustnessScore: Math.max(0, result.robustnessScore - decayMonitoring.robustnessPenalty),
        decayMonitoring,
    };
}
