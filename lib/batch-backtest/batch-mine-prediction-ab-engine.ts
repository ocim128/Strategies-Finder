/**
 * Compares the stored Batch result with a replay whose long-entry signals are
 * kept only when Mine verdicts LONG on the base asset's execution bar.
 *
 * This module is server-safe: it has no DOM or lightweight-charts imports.
 */
import type { BacktestExecutionContext } from "../backtest-endpoint-contract";
import { executeBacktestFromSignals } from "../backtest-executor";
import { timeKey } from "../strategies";
import type { CapitalSettings } from "../types/backtest";
import type { BacktestResult, BacktestSettings, OHLCVData, Signal, Time } from "../types/strategies";
import {
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    runPreparedBatchSyntheticStateMiner,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticPreparedPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";
import { buildPairsByAssetIndex } from "./batch-miner-index";

export interface MineAbArmMetrics {
    netPnl: number;
    trades: number;
    winRate: number;
    profitFactor: number;
    avgTrade: number;
    maxDrawdown: number;
}

export interface MineAbPairResult {
    symbol: string;
    control: MineAbArmMetrics;
    treatment: MineAbArmMetrics | null;
    keptEntries: number;
    droppedEntries: number;
    pnlDelta: number | null;
    error?: string;
}

export interface MineAbResult {
    strategyKey: string | null;
    interval: string;
    pairs: number;
    evaluatedPairs: number;
    omittedPairs: number;
    control: MineAbArmMetrics;
    treatment: MineAbArmMetrics;
    perPair: MineAbPairResult[];
    verdict: "TREATMENT_BETTER" | "CONTROL_BETTER" | "NO_DIFFERENCE";
    reportLines: string[];
}

type VerdictAtTime = (
    asset: string,
    assetData: OHLCVData[],
    executionTime: Time,
    preparedPairs: BatchSyntheticPreparedPairArtifact[],
    interval: string,
    pairsByAsset?: ReturnType<typeof buildPairsByAssetIndex>,
) => Promise<string | null>;

type ExecuteTreatment = (
    data: OHLCVData[],
    interval: string,
    signals: Signal[],
    backtestSettings: BacktestSettings | Record<string, unknown>,
    capitalSettings: CapitalSettings | Record<string, unknown>,
    context: BacktestExecutionContext,
) => Promise<BacktestResult>;

export interface RunMineAbOptions {
    artifacts: BatchSyntheticPairArtifact[];
    targets: BatchSyntheticTargetArtifact[];
    interval: string;
    strategyKey?: string | null;
    backtestSettings: BacktestSettings | Record<string, unknown>;
    capitalSettings: CapitalSettings | Record<string, unknown>;
    useRustEnginePreference?: boolean;
    onPairProgress?: (symbol: string, donePairs: number, totalPairs: number) => void;
    shouldStop?: () => boolean;
    expectedPairs?: number;
    /** Focused-test seam; production always uses Mine. */
    verdictAtTime?: VerdictAtTime;
    /** Focused-test seam; production always uses the real backtest executor. */
    executeTreatment?: ExecuteTreatment;
}

function executionTimeForSignal(
    signal: Signal,
    data: OHLCVData[],
    indexByTime: Map<string, number>,
    executionModel: unknown,
): Time | null {
    const signalIndex = Number.isFinite(signal.barIndex)
        ? Math.trunc(signal.barIndex as number)
        : indexByTime.get(timeKey(signal.time));
    if (signalIndex === undefined) return null;
    const executionIndex = signalIndex + (executionModel === "signal_close" ? 0 : 1);
    return data[executionIndex]?.time ?? null;
}

async function mineVerdictAtTime(
    asset: string,
    assetData: OHLCVData[],
    executionTime: Time,
    preparedPairs: BatchSyntheticPreparedPairArtifact[],
    interval: string,
    pairsByAsset: ReturnType<typeof buildPairsByAssetIndex>,
): Promise<string | null> {
    const entryKey = timeKey(executionTime);
    const index = assetData.findIndex((bar) => timeKey(bar.time) === entryKey);
    if (index < 200) return null;
    const preparedTarget = prepareBatchSyntheticTargetArtifacts([{
        asset,
        symbol: `${asset}USDT`,
        data: assetData.slice(0, index + 1),
    }]);
    if (preparedTarget.length === 0) return null;
    const mined = runPreparedBatchSyntheticStateMiner({
        interval,
        targets: preparedTarget,
        artifacts: preparedPairs,
        pairsByAsset,
        options: { autoHorizons: true },
    });
    return mined.verdicts.find((row) => row.asset.toUpperCase() === asset.toUpperCase())?.verdict ?? null;
}

function metrics(result: BacktestResult): MineAbArmMetrics {
    return {
        netPnl: result.netProfit,
        trades: result.totalTrades,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        avgTrade: result.avgTrade,
        maxDrawdown: result.maxDrawdown,
    };
}

function aggregate(results: BacktestResult[]): MineAbArmMetrics {
    const trades = results.reduce((sum, result) => sum + result.totalTrades, 0);
    const wins = results.reduce((sum, result) => sum + result.winningTrades, 0);
    const netPnl = results.reduce((sum, result) => sum + result.netProfit, 0);
    let grossProfit = 0;
    let grossLoss = 0;
    for (const result of results) {
        for (const trade of result.trades) {
            if (trade.pnl > 0) grossProfit += trade.pnl;
            else if (trade.pnl < 0) grossLoss += Math.abs(trade.pnl);
        }
    }
    return {
        netPnl,
        trades,
        winRate: trades > 0 ? (wins / trades) * 100 : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
        avgTrade: trades > 0 ? netPnl / trades : 0,
        // Independent pair runs do not share a portfolio equity curve. Summing
        // their dollar drawdowns is the conservative aggregate shown here.
        maxDrawdown: results.reduce((sum, result) => sum + result.maxDrawdown, 0),
    };
}

function money(value: number): string {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function percent(value: number): string {
    return `${value.toFixed(1)}%`;
}

function number(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : value > 0 ? "inf" : "n/a";
}

function signed(value: number, digits = 1): string {
    if (!Number.isFinite(value)) return "n/a";
    return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function buildReport(
    strategyKey: string | null,
    interval: string,
    perPair: MineAbPairResult[],
    controlResults: BacktestResult[],
    treatmentResults: BacktestResult[],
    expectedPairs: number,
): MineAbResult {
    const control = aggregate(controlResults);
    const treatment = aggregate(treatmentResults);
    const pnlDelta = treatment.netPnl - control.netPnl;
    const tradeDelta = treatment.trades - control.trades;
    const pnlDeltaPct = control.netPnl !== 0 ? (pnlDelta / Math.abs(control.netPnl)) * 100 : 0;
    const tradeDeltaPct = control.trades > 0 ? (tradeDelta / control.trades) * 100 : 0;
    const verdict: MineAbResult["verdict"] = Math.abs(pnlDelta) < 1e-9
        ? "NO_DIFFERENCE"
        : pnlDelta > 0 ? "TREATMENT_BETTER" : "CONTROL_BETTER";
    const successful = perPair.filter((row) => row.treatment !== null);
    const ranked = [...successful].sort((a, b) => (b.pnlDelta ?? 0) - (a.pnlDelta ?? 0));
    const lines = [
        `MINE_AB  | strategy=${strategyKey ?? "?"} interval=${interval} pairs=${perPair.length}/${expectedPairs} direction=long`,
        "MINE_AB  | NOTE: Control = all batch trades. Treatment = only entries where Mine said LONG on the base asset's execution bar. P&L uses the original settings and real exit overlay.",
        `SUMMARY  | Control: trades=${control.trades} netPnl=${money(control.netPnl)} winRate=${percent(control.winRate)} pf=${number(control.profitFactor)} avgTrade=${money(control.avgTrade)} maxDD=${money(control.maxDrawdown)}`,
        `         | Treatment: trades=${treatment.trades} netPnl=${money(treatment.netPnl)} winRate=${percent(treatment.winRate)} pf=${number(treatment.profitFactor)} avgTrade=${money(treatment.avgTrade)} maxDD=${money(treatment.maxDrawdown)}`,
        `DELTA    | PnL: ${money(pnlDelta)} (${signed(pnlDeltaPct)}%) | Trades: ${signed(tradeDelta, 0)} (${signed(tradeDeltaPct)}%) | WinRate: ${signed(treatment.winRate - control.winRate)}pp | PF: ${signed(treatment.profitFactor - control.profitFactor, 2)}`,
        `VERDICT  | ${verdict} (${money(pnlDelta)} net, ${signed(treatment.winRate - control.winRate)}pp win rate)`,
    ];
    if (ranked.length > 0) {
        lines.push(`IMPROVED | ${ranked.slice(0, 5).map((row) => `${row.symbol}:${money(row.pnlDelta ?? 0)}`).join(" ")}`);
        lines.push(`WORSENED | ${ranked.slice(-5).reverse().map((row) => `${row.symbol}:${money(row.pnlDelta ?? 0)}`).join(" ")}`);
    }
    const failed = perPair.filter((row) => row.error);
    if (failed.length > 0) {
        lines.push(`CAVEAT   | ${failed.length} pair${failed.length === 1 ? " was" : "s were"} excluded because treatment could not be evaluated.`);
    } else if (treatment.trades < control.trades && treatment.netPnl > control.netPnl) {
        lines.push(`CAVEAT   | Treatment took ${percent((1 - treatment.trades / Math.max(1, control.trades)) * 100)} fewer trades for ${money(pnlDelta)} more P&L; Mine is cutting losers.`);
    }
    if (perPair.length < expectedPairs) {
        lines.push(`CAVEAT   | ${expectedPairs - perPair.length} artifact pair${expectedPairs - perPair.length === 1 ? " was" : "s were"} unavailable during loading and omitted.`);
    }
    return {
        strategyKey,
        interval,
        pairs: perPair.length,
        evaluatedPairs: successful.length,
        omittedPairs: Math.max(0, expectedPairs - perPair.length),
        control,
        treatment,
        perPair,
        verdict,
        reportLines: lines,
    };
}

export async function runMineAbTest(options: RunMineAbOptions): Promise<MineAbResult> {
    const preparedPairs = prepareBatchSyntheticPairArtifacts(options.artifacts);
    const pairsByAsset = buildPairsByAssetIndex(preparedPairs);
    const targetByAsset = new Map(options.targets.map((target) => [target.asset.toUpperCase(), target.data]));
    const verdict = options.verdictAtTime ?? mineVerdictAtTime;
    const replay = options.executeTreatment ?? (async (data, interval, signals, settings, capital, context) =>
        (await executeBacktestFromSignals(data, interval, signals, settings, capital, context)).result);
    const verdictCache = new Map<string, Promise<string | null>>();
    const perPair: MineAbPairResult[] = [];
    const controlResults: BacktestResult[] = [];
    const treatmentResults: BacktestResult[] = [];
    const executionModel = (options.backtestSettings as Record<string, unknown>).executionModel;

    for (const artifact of options.artifacts) {
        if (options.shouldStop?.()) break;
        const control = metrics(artifact.result);
        let keptEntries = 0;
        let droppedEntries = 0;
        // Batch signals include entries that were ignored because a position
        // was already open (and other non-tradeable attempts). Mine A/B is
        // defined over actual batch trades, so do not run the expensive Mine
        // classifier for those signals. This is usually the dominant speedup
        // on high-frequency strategies with signal-heavy output.
        const controlEntryTimes = new Set(
            artifact.result.trades
                .filter((trade) => trade.type === "long")
                .map((trade) => timeKey(trade.entryTime)),
        );
        options.onPairProgress?.(artifact.symbol, perPair.length, options.artifacts.length);
        try {
            const baseData = targetByAsset.get(artifact.baseAsset.toUpperCase());
            if (!baseData) throw new Error("base asset OHLCV unavailable");
            const indexByTime = new Map(artifact.data.map((bar, index) => [timeKey(bar.time), index]));
            const filtered: Signal[] = [];
            for (const signal of artifact.signals) {
                if (signal.type !== "buy") {
                    filtered.push(signal);
                    continue;
                }
                const executionTime = executionTimeForSignal(signal, artifact.data, indexByTime, executionModel);
                if (executionTime === null || !controlEntryTimes.has(timeKey(executionTime))) {
                    droppedEntries += 1;
                    continue;
                }
                const cacheKey = `${artifact.baseAsset.toUpperCase()}|${timeKey(executionTime)}`;
                let pendingVerdict = verdictCache.get(cacheKey);
                if (!pendingVerdict) {
                    pendingVerdict = verdict(artifact.baseAsset, baseData, executionTime, preparedPairs, options.interval, pairsByAsset);
                    verdictCache.set(cacheKey, pendingVerdict);
                }
                if (await pendingVerdict === "LONG") {
                    filtered.push(signal);
                    keptEntries += 1;
                } else {
                    droppedEntries += 1;
                }
            }
            const treatmentResult = await replay(
                artifact.data,
                options.interval,
                filtered,
                options.backtestSettings,
                options.capitalSettings,
                {
                    nowSec: Math.floor(Date.now() / 1000),
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "auto",
                    useRustEnginePreference: options.useRustEnginePreference,
                },
            );
            controlResults.push(artifact.result);
            treatmentResults.push(treatmentResult);
            perPair.push({
                symbol: artifact.symbol,
                control,
                treatment: metrics(treatmentResult),
                keptEntries,
                droppedEntries,
                pnlDelta: treatmentResult.netProfit - artifact.result.netProfit,
            });
        } catch (error) {
            perPair.push({
                symbol: artifact.symbol,
                control,
                treatment: null,
                keptEntries,
                droppedEntries,
                pnlDelta: null,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        options.onPairProgress?.(artifact.symbol, perPair.length, options.artifacts.length);
    }
    return buildReport(options.strategyKey ?? null, options.interval, perPair, controlResults, treatmentResults, options.expectedPairs ?? options.artifacts.length);
}
