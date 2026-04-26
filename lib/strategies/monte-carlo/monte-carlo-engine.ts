import type { BacktestResult, StrategyParams, OHLCVData, Trade } from "../../types/strategies";
import type {
    ConfidenceIntervals,
    MonteCarloCoverageSummary,
    MonteCarloResult,
    MonteCarloSettings,
    MonteCarloSimulation,
    PolymarketMonteCarloInput,
    PolymarketMonteCarloTradeInput,
    RuinProbabilityMetrics,
} from "./types";
import { createSeededRandom } from "./utils";
import { calculateSharpeRatioFromEquitySamples } from "../performance-metrics";
import { mean, median, percentile, sampleStdDev } from "../../statistics-utils";

export * from "./types";

const MIN_TRADES_FOR_SIMULATION = 5;
const MAX_STORED_SIMULATIONS = 48;
const MAX_EQUITY_CURVE_POINTS = 512;
const TARGET_WORK_UNITS_PER_CHUNK = 25_000;

export interface MonteCarloProgress {
    completed: number;
    total: number;
}

export interface RunMonteCarloOptions {
    signal?: AbortSignal;
    onProgress?: (progress: MonteCarloProgress) => void;
}

interface SimulatedMetrics {
    netProfit: number;
    netProfitPercent: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    winRate: number;
    finalEquity: number;
    ruinOccurred: boolean;
    timeToRuin?: number;
    equityCurve?: number[];
}

interface ObservedMonteCarloMetrics {
    netProfit: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    successRate: number;
}

interface SimulationRunContext {
    ruinThreshold: number;
    progressChunkSize: number;
    sampleEvery: number;
    curveSampleIndices: number[];
    baseSeeds: number[];
}

interface BuildResultArgs {
    startTime: number;
    settings: MonteCarloSettings;
    inputTradeCount: number;
    inputNetProfit: number;
    inputSharpeRatio: number;
    observedMetrics: ObservedMonteCarloMetrics;
    netProfitValues: number[];
    maxDrawdownPercentValues: number[];
    sharpeRatioValues: number[];
    successRateValues: number[];
    timesToRuin: number[];
    ruinCount: number;
    sampledSimulations: MonteCarloSimulation[];
    inputSource: "chart" | "polymarket";
    successRateLabel: "Win Rate" | "Positive Trade Rate";
    polymarketSizingModel?: MonteCarloResult["polymarketSizingModel"];
    coverageSummary?: MonteCarloCoverageSummary;
    polymarketEvaluationMode?: MonteCarloResult["polymarketEvaluationMode"];
}

export async function runMonteCarloSimulation(
    backtestResult: BacktestResult,
    settings: MonteCarloSettings,
    _ohlcvData?: OHLCVData[],
    _strategyParams?: StrategyParams,
    options: RunMonteCarloOptions = {},
): Promise<MonteCarloResult> {
    const startTime = Date.now();
    const trades = backtestResult.trades;

    if (trades.length < MIN_TRADES_FOR_SIMULATION) {
        return createInsufficientSampleResult({
            inputTradeCount: trades.length,
            inputNetProfit: backtestResult.netProfit,
            inputSharpeRatio: backtestResult.sharpeRatio,
            settings,
            startTime,
            inputSource: "chart",
            successRateLabel: "Win Rate",
            errorMessage: `Insufficient trades for Monte Carlo simulation. Need at least ${MIN_TRADES_FOR_SIMULATION} trades, got ${trades.length}.`,
        });
    }

    const tradePnls = trades.map((trade) => trade.pnl);
    const tradeExitTimes = trades.map((trade) => trade.exitTime);
    const runContext = createSimulationRunContext(settings, trades.length);
    const netProfitValues = new Array<number>(settings.simulations);
    const maxDrawdownPercentValues = new Array<number>(settings.simulations);
    const sharpeRatioValues = new Array<number>(settings.simulations);
    const successRateValues = new Array<number>(settings.simulations);
    const timesToRuin: number[] = [];
    const sampledSimulations: MonteCarloSimulation[] = [];
    let ruinCount = 0;

    for (let simulationId = 0; simulationId < settings.simulations; simulationId++) {
        throwIfAborted(options.signal);

        const order = buildSimulationOrder(trades.length, runContext.baseSeeds[simulationId], settings);
        const shouldStoreSimulation =
            sampledSimulations.length < MAX_STORED_SIMULATIONS && simulationId % runContext.sampleEvery === 0;
        const metrics = simulateFixedPnlTradePath(
            order,
            tradePnls,
            tradeExitTimes,
            settings.initialCapital,
            runContext.ruinThreshold,
            shouldStoreSimulation ? runContext.curveSampleIndices : null,
        );

        netProfitValues[simulationId] = metrics.netProfit;
        maxDrawdownPercentValues[simulationId] = metrics.maxDrawdownPercent;
        sharpeRatioValues[simulationId] = metrics.sharpeRatio;
        successRateValues[simulationId] = metrics.winRate;

        if (metrics.ruinOccurred) {
            ruinCount++;
            if (typeof metrics.timeToRuin === "number") {
                timesToRuin.push(metrics.timeToRuin);
            }
        }

        if (shouldStoreSimulation) {
            sampledSimulations.push(createStoredSimulation(simulationId, metrics));
        }

        if (
            options.onProgress &&
            (simulationId + 1 === settings.simulations || (simulationId + 1) % runContext.progressChunkSize === 0)
        ) {
            options.onProgress({
                completed: simulationId + 1,
                total: settings.simulations,
            });
            await yieldToEventLoop();
        }
    }

    return buildMonteCarloResult({
        startTime,
        settings,
        inputTradeCount: trades.length,
        inputNetProfit: backtestResult.netProfit,
        inputSharpeRatio: backtestResult.sharpeRatio,
        observedMetrics: {
            netProfit: backtestResult.netProfit,
            maxDrawdownPercent: backtestResult.maxDrawdownPercent,
            sharpeRatio: backtestResult.sharpeRatio,
            successRate: backtestResult.winRate,
        },
        netProfitValues,
        maxDrawdownPercentValues,
        sharpeRatioValues,
        successRateValues,
        timesToRuin,
        ruinCount,
        sampledSimulations,
        inputSource: "chart",
        successRateLabel: "Win Rate",
    });
}

export async function runPolymarketMonteCarloSimulation(
    input: PolymarketMonteCarloInput,
    settings: MonteCarloSettings,
    options: RunMonteCarloOptions = {},
): Promise<MonteCarloResult> {
    const startTime = Date.now();
    const trades = input.trades;

    if (trades.length < MIN_TRADES_FOR_SIMULATION) {
        return createInsufficientSampleResult({
            inputTradeCount: trades.length,
            inputNetProfit: 0,
            inputSharpeRatio: 0,
            settings,
            startTime,
            inputSource: "polymarket",
            successRateLabel: "Positive Trade Rate",
            coverageSummary: input.coverageSummary,
            polymarketEvaluationMode: input.evaluationMode,
            errorMessage: `Insufficient usable Polymarket trades for Monte Carlo simulation. Need at least ${MIN_TRADES_FOR_SIMULATION}, got ${trades.length}.`,
        });
    }

    const stakePerTrade = normalizePolymarketStakePerTrade(settings.polymarketStakePerTrade);
    const tradeExitTimes = trades.map((trade) => trade.exitTime);
    const runContext = createSimulationRunContext(settings, trades.length);
    const observedMetricsFromOriginalOrder = simulatePolymarketTradePath(
        Array.from({ length: trades.length }, (_, index) => index),
        trades,
        tradeExitTimes,
        settings.initialCapital,
        runContext.ruinThreshold,
        stakePerTrade,
        null,
    );
    const netProfitValues = new Array<number>(settings.simulations);
    const maxDrawdownPercentValues = new Array<number>(settings.simulations);
    const sharpeRatioValues = new Array<number>(settings.simulations);
    const successRateValues = new Array<number>(settings.simulations);
    const timesToRuin: number[] = [];
    const sampledSimulations: MonteCarloSimulation[] = [];
    let ruinCount = 0;

    for (let simulationId = 0; simulationId < settings.simulations; simulationId++) {
        throwIfAborted(options.signal);

        const order = buildSimulationOrder(trades.length, runContext.baseSeeds[simulationId], settings);
        const shouldStoreSimulation =
            sampledSimulations.length < MAX_STORED_SIMULATIONS && simulationId % runContext.sampleEvery === 0;
        const metrics = simulatePolymarketTradePath(
            order,
            trades,
            tradeExitTimes,
            settings.initialCapital,
            runContext.ruinThreshold,
            stakePerTrade,
            shouldStoreSimulation ? runContext.curveSampleIndices : null,
        );

        netProfitValues[simulationId] = metrics.netProfit;
        maxDrawdownPercentValues[simulationId] = metrics.maxDrawdownPercent;
        sharpeRatioValues[simulationId] = metrics.sharpeRatio;
        successRateValues[simulationId] = metrics.winRate;

        if (metrics.ruinOccurred) {
            ruinCount++;
            if (typeof metrics.timeToRuin === "number") {
                timesToRuin.push(metrics.timeToRuin);
            }
        }

        if (shouldStoreSimulation) {
            sampledSimulations.push(createStoredSimulation(simulationId, metrics));
        }

        if (
            options.onProgress &&
            (simulationId + 1 === settings.simulations || (simulationId + 1) % runContext.progressChunkSize === 0)
        ) {
            options.onProgress({
                completed: simulationId + 1,
                total: settings.simulations,
            });
            await yieldToEventLoop();
        }
    }

    return buildMonteCarloResult({
        startTime,
        settings: {
            ...settings,
            polymarketStakePerTrade: stakePerTrade,
        },
        inputTradeCount: trades.length,
        inputNetProfit: observedMetricsFromOriginalOrder.netProfit,
        inputSharpeRatio: observedMetricsFromOriginalOrder.sharpeRatio,
        observedMetrics: {
            netProfit: observedMetricsFromOriginalOrder.netProfit,
            maxDrawdownPercent: observedMetricsFromOriginalOrder.maxDrawdownPercent,
            sharpeRatio: observedMetricsFromOriginalOrder.sharpeRatio,
            successRate: observedMetricsFromOriginalOrder.winRate,
        },
        netProfitValues,
        maxDrawdownPercentValues,
        sharpeRatioValues,
        successRateValues,
        timesToRuin,
        ruinCount,
        sampledSimulations,
        inputSource: "polymarket",
        successRateLabel: "Positive Trade Rate",
        polymarketSizingModel: "fixed_stake",
        coverageSummary: input.coverageSummary,
        polymarketEvaluationMode: input.evaluationMode,
    });
}

function createInsufficientSampleResult(args: {
    inputTradeCount: number;
    inputNetProfit: number;
    inputSharpeRatio: number;
    settings: MonteCarloSettings;
    startTime: number;
    inputSource: "chart" | "polymarket";
    successRateLabel: "Win Rate" | "Positive Trade Rate";
    errorMessage: string;
    coverageSummary?: MonteCarloCoverageSummary;
    polymarketEvaluationMode?: MonteCarloResult["polymarketEvaluationMode"];
}): MonteCarloResult {
    return {
        status: "insufficient_sample",
        errorMessage: args.errorMessage,
        inputSource: args.inputSource,
        successRateLabel: args.successRateLabel,
        coverageSummary: args.coverageSummary,
        polymarketEvaluationMode: args.polymarketEvaluationMode,
        settings: args.settings,
        simulationsCompleted: 0,
        inputTradeCount: args.inputTradeCount,
        inputNetProfit: args.inputNetProfit,
        inputSharpeRatio: args.inputSharpeRatio,
        simulations: [],
        metricSamples: {
            netProfitValues: [],
            maxDrawdownPercentValues: [],
            sharpeRatioValues: [],
            winRateValues: [],
        },
        ruinProbabilityMetrics: {
            ruinProbability: 0,
            expectedTradesToRuin: null,
            medianTradesToRuin: null,
            ruinRate: 0,
            maxDrawdownDistribution: {
                mean: 0,
                median: 0,
                stdDev: 0,
                percentile5: 0,
                percentile25: 0,
                percentile75: 0,
                percentile95: 0,
            },
        },
        confidenceIntervals: createEmptyConfidenceIntervals(),
        netProfitDistribution: {
            mean: 0,
            median: 0,
            stdDev: 0,
            skewness: 0,
            kurtosis: 0,
            min: 0,
            max: 0,
        },
        executionTimeMs: Date.now() - args.startTime,
        seed: args.settings.seed,
    };
}

function createSimulationRunContext(settings: MonteCarloSettings, tradeCount: number): SimulationRunContext {
    const progressChunkSize = Math.max(
        5,
        Math.min(
            settings.simulations,
            Math.max(5, Math.floor(TARGET_WORK_UNITS_PER_CHUNK / Math.max(1, tradeCount))),
        ),
    );
    const sampleEvery = Math.max(1, Math.ceil(settings.simulations / MAX_STORED_SIMULATIONS));
    const curveSampleIndices = buildCurveSampleIndices(tradeCount, MAX_EQUITY_CURVE_POINTS);
    const random = createSeededRandom(settings.seed);
    const baseSeeds = Array.from({ length: settings.simulations }, () => Math.floor(random() * 1_000_000));

    return {
        ruinThreshold: settings.initialCapital * (settings.ruinThresholdPercent / 100),
        progressChunkSize,
        sampleEvery,
        curveSampleIndices,
        baseSeeds,
    };
}

function buildMonteCarloResult(args: BuildResultArgs): MonteCarloResult {
    const confidenceIntervals = computeConfidenceIntervals(
        args.netProfitValues,
        args.maxDrawdownPercentValues,
        args.sharpeRatioValues,
        args.successRateValues,
        args.observedMetrics,
    );
    const netProfitDistribution = computeDistributionStatistics(args.netProfitValues);
    const ruinProbabilityMetrics = computeRuinProbabilityMetrics(
        args.maxDrawdownPercentValues,
        args.timesToRuin,
        args.ruinCount,
        args.settings.simulations,
    );

    return {
        status: "success",
        inputSource: args.inputSource,
        successRateLabel: args.successRateLabel,
        polymarketSizingModel: args.polymarketSizingModel,
        coverageSummary: args.coverageSummary,
        polymarketEvaluationMode: args.polymarketEvaluationMode,
        settings: args.settings,
        simulationsCompleted: args.settings.simulations,
        inputTradeCount: args.inputTradeCount,
        inputNetProfit: args.inputNetProfit,
        inputSharpeRatio: args.inputSharpeRatio,
        simulations: args.sampledSimulations,
        metricSamples: {
            netProfitValues: args.netProfitValues,
            maxDrawdownPercentValues: args.maxDrawdownPercentValues,
            sharpeRatioValues: args.sharpeRatioValues,
            winRateValues: args.successRateValues,
        },
        ruinProbabilityMetrics,
        confidenceIntervals,
        netProfitDistribution,
        executionTimeMs: Date.now() - args.startTime,
        seed: args.settings.seed,
    };
}

function buildSimulationOrder(
    tradeCount: number,
    seed: number,
    settings: MonteCarloSettings,
): number[] {
    const order = Array.from({ length: tradeCount }, (_, index) => index);

    if (!settings.enableBootstrap && !settings.enableSequenceRandomization) {
        return order;
    }

    const random = createSeededRandom(seed);

    if (settings.enableBootstrap) {
        for (let i = 0; i < tradeCount; i++) {
            order[i] = Math.floor(random() * tradeCount);
        }
    }

    if (settings.enableSequenceRandomization) {
        for (let i = order.length - 1; i > 0; i--) {
            const swapIndex = Math.floor(random() * (i + 1));
            [order[i], order[swapIndex]] = [order[swapIndex], order[i]];
        }
    }

    return order;
}

function buildCurveSampleIndices(tradeCount: number, maxPoints: number): number[] {
    if (tradeCount <= 0) {
        return [];
    }

    if (tradeCount <= maxPoints) {
        return Array.from({ length: tradeCount }, (_, index) => index);
    }

    const indices: number[] = [];
    const lastIndex = tradeCount - 1;

    for (let point = 0; point < maxPoints; point++) {
        const scaledIndex = Math.round((point / (maxPoints - 1)) * lastIndex);
        if (indices[indices.length - 1] !== scaledIndex) {
            indices.push(scaledIndex);
        }
    }

    if (indices[indices.length - 1] !== lastIndex) {
        indices.push(lastIndex);
    }

    return indices;
}

function simulateFixedPnlTradePath(
    order: readonly number[],
    tradePnls: readonly number[],
    tradeExitTimes: readonly Trade["exitTime"][],
    initialCapital: number,
    ruinThreshold: number,
    curveSampleIndices: readonly number[] | null,
): SimulatedMetrics {
    let equity = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let ruinOccurred = false;
    let timeToRuin: number | undefined;
    let winCount = 0;
    let nextCurvePoint = 0;
    const equitySamples = new Array<number>(order.length);
    const equityCurve = curveSampleIndices ? new Array<number>(curveSampleIndices.length) : undefined;

    for (let step = 0; step < order.length; step++) {
        const tradeIndex = order[step];
        const pnl = tradePnls[tradeIndex] ?? 0;

        equity += pnl;
        equitySamples[step] = equity;

        if (equityCurve && curveSampleIndices && curveSampleIndices[nextCurvePoint] === step) {
            equityCurve[nextCurvePoint] = equity;
            nextCurvePoint++;
        }

        if (equity > peak) {
            peak = equity;
        }

        const drawdown = peak - equity;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        }

        if (!ruinOccurred && equity < ruinThreshold) {
            ruinOccurred = true;
            timeToRuin = step;
        }

        if (pnl > 0) {
            winCount++;
        }
    }

    while (equityCurve && nextCurvePoint < equityCurve.length) {
        equityCurve[nextCurvePoint] = equity;
        nextCurvePoint++;
    }

    const sharpeRatio = calculateSharpeRatioFromEquitySamples(tradeExitTimes, equitySamples, equitySamples.length);
    const finalEquity = equity;
    const netProfit = finalEquity - initialCapital;

    return {
        netProfit,
        netProfitPercent: initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0,
        maxDrawdown,
        maxDrawdownPercent,
        sharpeRatio,
        winRate: order.length > 0 ? (winCount / order.length) * 100 : 0,
        finalEquity,
        ruinOccurred,
        timeToRuin,
        equityCurve,
    };
}

function simulatePolymarketTradePath(
    order: readonly number[],
    trades: readonly PolymarketMonteCarloTradeInput[],
    tradeExitTimes: readonly Trade["exitTime"][],
    initialCapital: number,
    ruinThreshold: number,
    stakePerTrade: number,
    curveSampleIndices: readonly number[] | null,
): SimulatedMetrics {
    let equity = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let ruinOccurred = false;
    let timeToRuin: number | undefined;
    let positiveTradeCount = 0;
    let nextCurvePoint = 0;
    const equitySamples = new Array<number>(order.length);
    const equityCurve = curveSampleIndices ? new Array<number>(curveSampleIndices.length) : undefined;
    for (let step = 0; step < order.length; step++) {
        const trade = trades[order[step]];
        const tradeReturn = trade && trade.entryPrice > 0 ? trade.sharePnl / trade.entryPrice : 0;
        const allocatedCapital = Math.min(stakePerTrade, Math.max(0, equity));
        const dollarPnl = allocatedCapital * tradeReturn;

        equity += dollarPnl;
        equitySamples[step] = equity;

        if (equityCurve && curveSampleIndices && curveSampleIndices[nextCurvePoint] === step) {
            equityCurve[nextCurvePoint] = equity;
            nextCurvePoint++;
        }

        if (equity > peak) {
            peak = equity;
        }

        const drawdown = peak - equity;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        }

        if (!ruinOccurred && equity < ruinThreshold) {
            ruinOccurred = true;
            timeToRuin = step;
        }

        if (dollarPnl > 0) {
            positiveTradeCount++;
        }
    }

    while (equityCurve && nextCurvePoint < equityCurve.length) {
        equityCurve[nextCurvePoint] = equity;
        nextCurvePoint++;
    }

    const sharpeRatio = calculateSharpeRatioFromEquitySamples(tradeExitTimes, equitySamples, equitySamples.length);
    const finalEquity = equity;
    const netProfit = finalEquity - initialCapital;

    return {
        netProfit,
        netProfitPercent: initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0,
        maxDrawdown,
        maxDrawdownPercent,
        sharpeRatio,
        winRate: order.length > 0 ? (positiveTradeCount / order.length) * 100 : 0,
        finalEquity,
        ruinOccurred,
        timeToRuin,
        equityCurve,
    };
}

function createStoredSimulation(simulationId: number, metrics: SimulatedMetrics): MonteCarloSimulation {
    return {
        simulationId,
        netProfit: metrics.netProfit,
        netProfitPercent: metrics.netProfitPercent,
        maxDrawdown: metrics.maxDrawdown,
        maxDrawdownPercent: metrics.maxDrawdownPercent,
        sharpeRatio: metrics.sharpeRatio,
        winRate: metrics.winRate,
        finalEquity: metrics.finalEquity,
        equityCurve: metrics.equityCurve ?? [],
        ruinOccurred: metrics.ruinOccurred,
        timeToRuin: metrics.timeToRuin,
    };
}

function normalizePolymarketStakePerTrade(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 1;
    }

    return Math.max(0.01, value);
}

function computeRuinProbabilityMetrics(
    maxDrawdownPercentValues: readonly number[],
    timesToRuin: readonly number[],
    ruinCount: number,
    totalSimulations: number,
): RuinProbabilityMetrics {
    return {
        ruinProbability: totalSimulations > 0 ? ruinCount / totalSimulations : 0,
        expectedTradesToRuin:
            timesToRuin.length > 0 ? timesToRuin.reduce((sum, value) => sum + value, 0) / timesToRuin.length : null,
        medianTradesToRuin: timesToRuin.length > 0 ? median(timesToRuin) : null,
        ruinRate: totalSimulations > 0 ? ruinCount / totalSimulations : 0,
        maxDrawdownDistribution: {
            mean: mean(maxDrawdownPercentValues),
            median: median(maxDrawdownPercentValues),
            stdDev: sampleStdDev(maxDrawdownPercentValues),
            percentile5: percentile(maxDrawdownPercentValues, 5),
            percentile25: percentile(maxDrawdownPercentValues, 25),
            percentile75: percentile(maxDrawdownPercentValues, 75),
            percentile95: percentile(maxDrawdownPercentValues, 95),
        },
    };
}

function computeConfidenceIntervals(
    netProfitValues: readonly number[],
    maxDrawdownPercentValues: readonly number[],
    sharpeRatioValues: readonly number[],
    successRateValues: readonly number[],
    observed: ObservedMonteCarloMetrics,
): ConfidenceIntervals {
    return {
        netProfit: {
            observed: observed.netProfit,
            ...computePercentiles(netProfitValues),
        },
        maxDrawdown: {
            observed: observed.maxDrawdownPercent,
            ...computePercentiles(maxDrawdownPercentValues),
        },
        sharpeRatio: {
            observed: observed.sharpeRatio,
            ...computePercentiles(sharpeRatioValues),
        },
        winRate: {
            observed: observed.successRate,
            ...computePercentiles(successRateValues),
        },
    };
}

function computePercentiles(values: readonly number[]) {
    return {
        ci50Lower: percentile(values, 25),
        ci50Upper: percentile(values, 75),
        ci90Lower: percentile(values, 5),
        ci90Upper: percentile(values, 95),
        ci95Lower: percentile(values, 2.5),
        ci95Upper: percentile(values, 97.5),
    };
}

function computeDistributionStatistics(values: readonly number[]) {
    const n = values.length;
    if (n === 0) {
        return { mean: 0, median: 0, stdDev: 0, skewness: 0, kurtosis: 0, min: 0, max: 0 };
    }

    const meanValue = mean(values);
    const medianValue = median(values);
    const stdDevValue = sampleStdDev(values);
    const sorted = [...values].sort((left, right) => left - right);

    let skewness = 0;
    let kurtosis = -3;

    if (stdDevValue > 0) {
        let m3 = 0;
        let m4 = 0;
        for (const value of values) {
            const z = (value - meanValue) / stdDevValue;
            m3 += z ** 3;
            m4 += z ** 4;
        }
        skewness = m3 / n;
        kurtosis = (m4 / n) - 3;
    }

    return {
        mean: meanValue,
        median: medianValue,
        stdDev: stdDevValue,
        skewness,
        kurtosis,
        min: sorted[0] ?? 0,
        max: sorted[n - 1] ?? 0,
    };
}

function createEmptyConfidenceIntervals(): ConfidenceIntervals {
    const empty = {
        ci50Lower: 0,
        ci50Upper: 0,
        ci90Lower: 0,
        ci90Upper: 0,
        ci95Lower: 0,
        ci95Upper: 0,
    };

    return {
        netProfit: { observed: 0, ...empty },
        maxDrawdown: { observed: 0, ...empty },
        sharpeRatio: { observed: 0, ...empty },
        winRate: { observed: 0, ...empty },
    };
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
        return;
    }

    const error = new Error("Monte Carlo simulation cancelled");
    error.name = "AbortError";
    throw error;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}
