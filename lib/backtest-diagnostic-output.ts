import type { UiBacktestEndpointSnapshot } from "./backtest-endpoint-copy";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { BacktestResult, BacktestSettings, Time, Trade } from "./types/strategies";

export type BacktestDiagnosticSeverity = "info" | "warning";

export interface BacktestDiagnosticWarning {
    code: string;
    severity: BacktestDiagnosticSeverity;
    message: string;
}

export interface BacktestDiagnosticCountRow {
    key: string;
    count: number;
    pct: number;
}

export interface BacktestDiagnosticOutput {
    schema: "backtest.diagnostics.v1";
    generatedAtIso: string;
    run: {
        source?: string;
        symbol?: string;
        interval?: string;
        strategyKey?: string;
        engineUsed?: string;
        executionModel?: string;
        tradeDirection?: string;
        candleCount?: number;
        firstCandleTimeSec: number | null;
        lastCandleTimeSec: number | null;
        totalTrades: number;
        winRate: number;
        netProfit: number;
        blockRange?: { from: number; to: number } | null;
    };
    chartExits: {
        counts: Record<string, number>;
        top: BacktestDiagnosticCountRow[];
        signalTrades: number;
        nonSignalTrades: number;
    };
    exitControl: {
        requestedDisableSignalExits: boolean | null;
        requestedExitStrategyOverrideEnabled: boolean | null;
        requestedExitStrategyKey: string;
        requestedExitStrategyParamKeys: string[];
        executor: BacktestResult["exitControlDiagnostics"] | null;
        engineInputSignals: number | null;
        enginePreparedSignals: number | null;
        engineSignalExitOrders: number | null;
    };
    engineDiagnostics?: BacktestResult["diagnostics"];
    warnings: BacktestDiagnosticWarning[];
    recommendations: string[];
}

export interface BuildBacktestDiagnosticOutputInput {
    result: BacktestResult;
    snapshot?: UiBacktestEndpointSnapshot | null;
    resultSource?: string;
    generatedAtIso?: string;
    maxExamples?: number;
}

function incrementCount(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function toCountRows(counts: Record<string, number>, total: number): BacktestDiagnosticCountRow[] {
    const denominator = Math.max(1, total);
    return Object.entries(counts)
        .map(([key, count]) => ({
            key,
            count,
            pct: Number(((count / denominator) * 100).toFixed(2)),
        }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function timeToDiagnosticSeconds(time: Time | null | undefined): number | null {
    if (time === null || time === undefined) {
        return null;
    }
    return parseTimeToUnixSeconds(time);
}

function buildChartExitDiagnostics(trades: readonly Trade[]): BacktestDiagnosticOutput["chartExits"] {
    const counts: Record<string, number> = {};
    for (const trade of trades) {
        incrementCount(counts, trade.exitReason ?? "unknown");
    }

    const signalTrades = counts.signal ?? 0;
    return {
        counts,
        top: toCountRows(counts, trades.length),
        signalTrades,
        nonSignalTrades: Math.max(0, trades.length - signalTrades),
    };
}

function buildExitControlDiagnostics(
    result: BacktestResult,
    settings: BacktestSettings | undefined
): BacktestDiagnosticOutput["exitControl"] {
    const requestedExitStrategyKey = typeof settings?.exitStrategyKey === "string"
        ? settings.exitStrategyKey.trim()
        : "";
    const requestedExitStrategyParams = settings?.exitStrategyParams;
    const requestedExitStrategyParamKeys = requestedExitStrategyParams
        && typeof requestedExitStrategyParams === "object"
        && !Array.isArray(requestedExitStrategyParams)
        ? Object.keys(requestedExitStrategyParams).sort()
        : [];
    return {
        requestedDisableSignalExits: settings ? settings.disableSignalExits === true : null,
        requestedExitStrategyOverrideEnabled: settings ? settings.exitStrategyOverrideEnabled === true : null,
        requestedExitStrategyKey,
        requestedExitStrategyParamKeys,
        executor: result.exitControlDiagnostics ?? null,
        engineInputSignals: result.diagnostics?.counts.inputSignals ?? null,
        enginePreparedSignals: result.diagnostics?.counts.preparedSignals ?? null,
        engineSignalExitOrders: result.diagnostics?.counts.signalExitOrders ?? null,
    };
}

export function buildBacktestDiagnosticOutput(
    input: BuildBacktestDiagnosticOutputInput
): BacktestDiagnosticOutput {
    const { result, snapshot } = input;
    const settings = snapshot?.backtestSettings;
    const chartExits = buildChartExitDiagnostics(result.trades);
    const exitControl = buildExitControlDiagnostics(result, settings);

    return {
        schema: "backtest.diagnostics.v1",
        generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
        run: {
            source: input.resultSource,
            symbol: snapshot?.symbol ?? result.marketContext?.symbol,
            interval: snapshot?.interval ?? result.marketContext?.interval,
            strategyKey: snapshot?.strategyKey,
            engineUsed: snapshot?.engineUsed,
            executionModel: settings?.executionModel,
            tradeDirection: settings?.tradeDirection,
            candleCount: result.marketContext?.candleCount,
            firstCandleTimeSec: timeToDiagnosticSeconds(result.marketContext?.firstCandleTime ?? null),
            lastCandleTimeSec: timeToDiagnosticSeconds(result.marketContext?.lastCandleTime ?? null),
            totalTrades: result.totalTrades,
            winRate: result.winRate,
            netProfit: result.netProfit,
            blockRange: snapshot?.blockRange,
        },
        chartExits,
        exitControl,
        engineDiagnostics: result.diagnostics,
        warnings: [],
        recommendations: [],
    };
}
