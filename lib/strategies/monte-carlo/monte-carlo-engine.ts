import type { BacktestResult, StrategyParams, OHLCVData, Trade } from "../../types/strategies";
import type {
    ConfidenceIntervals,
    MonteCarloCoverageSummary,
    MonteCarloResult,
    MonteCarloSettings,
    MonteCarloSizingConfig,
    MonteCarloSimulation,
    PolymarketMonteCarloInput,
    PolymarketMonteCarloTradeInput,
    RuinProbabilityMetrics,
} from "./types";
import { createSeededRandom } from "./utils";
import { calculateSharpeRatioFromEquitySamples } from "../performance-metrics";
import { medianOrNull, prepareSortedStats } from "../../statistics-utils";
import { timeKey } from "../backtest/backtest-utils";
import { resolveAllocatedCapital, type SmartSizingState } from "../backtest/position-builder";
import { createKellySizingState, updateKellyState } from "../sizing/kelly-criterion";
import { createMartingaleState, updateMartingaleState } from "../sizing/martingale";
import { createOptimalFState, updateOptimalFState } from "../sizing/optimal-f";

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
    sizing?: MonteCarloSizingConfig;
}

interface ChartTradeSample {
    pnl: number;
    returnOnAllocatedCapital: number | null;
    exitTime: Trade["exitTime"];
    entryTime: Trade["entryTime"];
    entryPrice: number;
    type: Trade["type"];
    entryBarIndex: number;
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

    const sizing = options.sizing
        ? {
            ...options.sizing,
            ohlcvData: options.sizing.ohlcvData ?? _ohlcvData,
        }
        : undefined;
    const tradeSamples = createChartTradeSamples(trades, sizing);
    const tradeExitTimes = tradeSamples.map((trade) => trade.exitTime);
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
        const metrics = simulateChartTradePath(
            order,
            tradeSamples,
            tradeExitTimes,
            settings.initialCapital,
            runContext.ruinThreshold,
            sizing,
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

        const isCheckpoint =
            simulationId + 1 === settings.simulations ||
            (simulationId + 1) % runContext.progressChunkSize === 0;

        if (isCheckpoint) {
            options.onProgress?.({
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

        const isCheckpoint =
            simulationId + 1 === settings.simulations ||
            (simulationId + 1) % runContext.progressChunkSize === 0;

        if (isCheckpoint) {
            options.onProgress?.({
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

function createChartTradeSamples(
    trades: readonly Trade[],
    sizing?: MonteCarloSizingConfig,
): ChartTradeSample[] {
    const dataIndexByTime = new Map<string, number>();
    for (const [index, candle] of (sizing?.ohlcvData ?? []).entries()) {
        dataIndexByTime.set(timeKey(candle.time), index);
    }

    const commissionRate = Math.max(0, sizing?.commissionPercent ?? 0) / 100;

    return trades.map((trade) => {
        const entryValue = Math.abs(trade.size * trade.entryPrice);
        const allocatedCapital = entryValue > 0
            ? entryValue * (1 + commissionRate)
            : 0;
        const returnOnAllocatedCapital = allocatedCapital > 0
            ? trade.pnl / allocatedCapital
            : null;

        return {
            pnl: trade.pnl,
            returnOnAllocatedCapital,
            exitTime: trade.exitTime,
            entryTime: trade.entryTime,
            entryPrice: trade.entryPrice,
            type: trade.type,
            entryBarIndex: dataIndexByTime.get(timeKey(trade.entryTime)) ?? -1,
        };
    });
}

function simulateChartTradePath(
    order: readonly number[],
    tradeSamples: readonly ChartTradeSample[],
    tradeExitTimes: readonly Trade["exitTime"][],
    initialCapital: number,
    ruinThreshold: number,
    sizing: MonteCarloSizingConfig | undefined,
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
    const smartSizingState = sizing ? createMonteCarloSmartSizingState() : null;

    for (let step = 0; step < order.length; step++) {
        const tradeIndex = order[step];
        const trade = tradeSamples[tradeIndex];
        const pnl = trade
            ? resolveChartTradePnl(trade, equity, sizing, smartSizingState)
            : 0;

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

        if (trade && sizing && smartSizingState) {
            updateMonteCarloSmartSizingState(smartSizingState, sizing, trade, pnl);
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

function createMonteCarloSmartSizingState(): SmartSizingState {
    return {
        recentVelocityScores: [],
        kellyState: createKellySizingState(),
        martingaleState: createMartingaleState(),
        optimalFState: createOptimalFState(),
    };
}

function resolveChartTradePnl(
    trade: ChartTradeSample,
    equity: number,
    sizing: MonteCarloSizingConfig | undefined,
    smartSizingState: SmartSizingState | null,
): number {
    if (!sizing || !smartSizingState || trade.returnOnAllocatedCapital === null) {
        return trade.pnl;
    }

    const allocatedCapital = resolveMonteCarloAllocatedCapital(trade, equity, sizing, smartSizingState);
    if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) {
        return 0;
    }

    return allocatedCapital * trade.returnOnAllocatedCapital;
}

function resolveMonteCarloAllocatedCapital(
    trade: ChartTradeSample,
    equity: number,
    sizing: MonteCarloSizingConfig,
    smartSizingState: SmartSizingState,
): number {
    const data = sizing.ohlcvData ?? [];
    const sizingBarIndex = trade.entryBarIndex >= 0 ? trade.entryBarIndex : data.length - 1;
    const direction = trade.type === "short" ? "short" : "long";

    return resolveAllocatedCapital(
        sizing.mode,
        equity,
        sizing.positionSizePercent,
        sizing.fixedTradeAmount,
        data,
        sizingBarIndex,
        direction,
        trade.entryPrice,
        null,
        smartSizingState,
        sizing.advancedSizing,
    );
}

function updateMonteCarloSmartSizingState(
    state: SmartSizingState,
    sizing: MonteCarloSizingConfig,
    trade: ChartTradeSample,
    pnl: number,
): void {
    if (!Number.isFinite(pnl)) {
        return;
    }

    pushRecentVelocityScore(state.recentVelocityScores, estimateVelocityScore(trade, pnl));
    updateKellyState(state.kellyState ?? createKellySizingState(), { pnl, isWin: pnl > 0 });

    if (sizing.mode === "martingale" || sizing.mode === "anti_martingale") {
        updateMartingaleState(
            state.martingaleState ?? createMartingaleState(),
            { pnl, isWin: pnl > 0 },
            sizing.advancedSizing,
            sizing.mode === "anti_martingale",
        );
    }

    if (sizing.mode === "optimal_f" || sizing.mode === "secure_f") {
        updateOptimalFState(state.optimalFState ?? createOptimalFState(), pnl, sizing.advancedSizing);
    }
}

function pushRecentVelocityScore(target: number[], score: number | null, maxLength = 12): void {
    if (score === null || !Number.isFinite(score)) {
        return;
    }
    target.push(score);
    if (target.length > maxLength) {
        target.shift();
    }
}

function estimateVelocityScore(trade: ChartTradeSample, pnl: number): number | null {
    if (!Number.isFinite(pnl) || !Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) {
        return null;
    }

    if (pnl > 0) {
        return Math.abs(trade.returnOnAllocatedCapital ?? 0) >= 0.02 ? 1 : 0.35;
    }

    return Math.abs(trade.returnOnAllocatedCapital ?? 0) >= 0.02 ? -0.75 : -0.15;
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
    const stats = prepareSortedStats(maxDrawdownPercentValues);
    return {
        ruinProbability: totalSimulations > 0 ? ruinCount / totalSimulations : 0,
        expectedTradesToRuin:
            timesToRuin.length > 0 ? timesToRuin.reduce((sum, value) => sum + value, 0) / timesToRuin.length : null,
        medianTradesToRuin: medianOrNull(timesToRuin),
        ruinRate: totalSimulations > 0 ? ruinCount / totalSimulations : 0,
        maxDrawdownDistribution: {
            mean: stats.mean,
            median: stats.median,
            stdDev: stats.stdDev,
            percentile5: stats.percentile(5),
            percentile25: stats.percentile(25),
            percentile75: stats.percentile(75),
            percentile95: stats.percentile(95),
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
    const stats = prepareSortedStats(values);
    return {
        ci50Lower: stats.percentile(25),
        ci50Upper: stats.percentile(75),
        ci90Lower: stats.percentile(5),
        ci90Upper: stats.percentile(95),
        ci95Lower: stats.percentile(2.5),
        ci95Upper: stats.percentile(97.5),
    };
}

function computeDistributionStatistics(values: readonly number[]) {
    const n = values.length;
    if (n === 0) {
        return { mean: 0, median: 0, stdDev: 0, skewness: 0, kurtosis: 0, min: 0, max: 0 };
    }

    const stats = prepareSortedStats(values);

    let skewness = 0;
    let kurtosis = -3;

    if (stats.stdDev > 0) {
        let m3 = 0;
        let m4 = 0;
        for (const value of values) {
            const z = (value - stats.mean) / stats.stdDev;
            m3 += z ** 3;
            m4 += z ** 4;
        }
        skewness = m3 / n;
        kurtosis = (m4 / n) - 3;
    }

    return {
        mean: stats.mean,
        median: stats.median,
        stdDev: stats.stdDev,
        skewness,
        kurtosis,
        min: stats.min,
        max: stats.max,
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
