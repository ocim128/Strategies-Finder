import { computeEdgeStatistics } from "./strategies/backtest/edge-statistics";
import type { BacktestResult, OHLCVData } from "./types/strategies";

const edgeAnalysisInputs = new WeakMap<BacktestResult, OHLCVData[]>();
const edgeAnalysisInFlight = new WeakMap<BacktestResult, Promise<BacktestResult["edgeStatistics"]>>();

function shouldTrackEdgeAnalysis(result: BacktestResult): boolean {
    return result.trades.length >= 3;
}

export function registerBacktestEdgeAnalysisInput(
    result: BacktestResult,
    backtestData: OHLCVData[]
): void {
    if (!shouldTrackEdgeAnalysis(result)) {
        edgeAnalysisInputs.delete(result);
        return;
    }

    edgeAnalysisInputs.set(result, backtestData);
}

export function transferBacktestEdgeAnalysisInput(
    source: BacktestResult,
    target: BacktestResult
): void {
    if (source === target) {
        return;
    }

    const input = edgeAnalysisInputs.get(source);
    if (input) {
        edgeAnalysisInputs.set(target, input);
    }

    if (!target.edgeStatistics && source.edgeStatistics) {
        target.edgeStatistics = source.edgeStatistics;
    }
}

export function canComputeBacktestEdgeAnalysis(result: BacktestResult): boolean {
    return Boolean(result.edgeStatistics) || edgeAnalysisInputs.has(result);
}

export async function ensureBacktestEdgeAnalysis(
    result: BacktestResult
): Promise<BacktestResult["edgeStatistics"]> {
    if (result.edgeStatistics) {
        return result.edgeStatistics;
    }

    if (!shouldTrackEdgeAnalysis(result)) {
        return undefined;
    }

    const existing = edgeAnalysisInFlight.get(result);
    if (existing) {
        return existing;
    }

    const backtestData = edgeAnalysisInputs.get(result);
    if (!backtestData) {
        return undefined;
    }

    const computePromise = new Promise<BacktestResult["edgeStatistics"]>((resolve) => {
        setTimeout(() => {
            const computed = computeEdgeStatistics(result, backtestData);
            result.edgeStatistics = computed;
            resolve(computed);
        }, 0);
    }).finally(() => {
        edgeAnalysisInFlight.delete(result);
    });

    edgeAnalysisInFlight.set(result, computePromise);
    return computePromise;
}
