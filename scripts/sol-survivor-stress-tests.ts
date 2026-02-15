import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runFinderExecution, type FinderSelectedStrategy } from "../lib/finder/finder-runner";
import { FinderParamSpace } from "../lib/finder/finder-param-space";
import { resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { strategies } from "../lib/strategies/library";
import {
    buildEntryBacktestResult,
    runBacktestCompact,
    runWalkForwardAnalysis,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Strategy,
    type StrategyParams,
    type Time,
} from "../lib/strategies";
import type { FinderOptions } from "../lib/types/finder";

type ParsedDataFile = {
    bars: OHLCVData[];
    symbol: string | null;
    interval: string | null;
};

export type SeedRun = {
    seed: number;
    passed: boolean;
    robustScore: number;
    passRate: number;
    stageCSurvivors: number;
    params: StrategyParams | null;
    result: BacktestResult | null;
    decisionReason: string;
};

export type OosBlindSeedResult = {
    seed: number;
    trainPassed: boolean;
    params: StrategyParams | null;
    blindResult: BacktestResult | null;
};

export type StressReport = {
    generatedAt: string;
    inputs: {
        dataPath: string;
        symbol: string;
        interval: string;
        strategyKey: string;
        seeds: number[];
        split: {
            trainRatio: number;
            trainBars: number;
            blindBars: number;
        };
        trading: {
            initialCapital: number;
            positionSizePercent: number;
            commissionPercent: number;
            slippageBps: number;
            rawTickSlippageBps: number;
            tickSize: number;
            referenceMedianPrice: number;
        };
        backtestSettingsOverrides?: Partial<BacktestSettings>;
    };
    oos70_30: {
        criteria: {
            minTrainSeedPasses: number;
            minBlindPositiveSeeds: number;
            minBlindMedianNetProfitPercent: number;
        };
        trainSeedPassCount: number;
        blindPositiveSeedCount: number;
        blindMedianNetProfitPercent: number;
        blindMedianMaxDrawdownPercent: number;
        blindMedianProfitFactor: number;
        blindConsensusResult: BacktestResult | null;
        seedRuns: OosBlindSeedResult[];
        verdict: "PASS" | "FAIL";
        failReasons: string[];
    };
    walkForward3m1m: {
        criteria: {
            minCombinedOOSNetProfitPercent: number;
            minWalkForwardEfficiency: number;
            minParameterStability: number;
            maxCombinedOOSDrawdownPercent: number;
        };
        optimizationWindowBars: number;
        testWindowBars: number;
        stepSizeBars: number;
        totalWindows: number;
        combinedOOS: {
            netProfitPercent: number;
            profitFactor: number;
            maxDrawdownPercent: number;
            totalTrades: number;
            winRate: number;
        };
        avgInSampleSharpe: number;
        avgOutOfSampleSharpe: number;
        walkForwardEfficiency: number;
        robustnessScore: number;
        parameterStability: number;
        parameterDrift: {
            averageChangedParamsPerWindow: number;
            changedParamRatePerWindow: number;
            perParamDistinctValues: Record<string, number>;
        };
        verdict: "PASS" | "FAIL";
        failReasons: string[];
    };
    feeSlippageSensitivity: {
        criteria: {
            minSeedPasses: number;
            minMedianNetProfitPercent: number;
            maxMedianDrawdownPercent: number;
        };
        seedPassCount: number;
        medianNetProfitPercent: number;
        medianMaxDrawdownPercent: number;
        medianProfitFactor: number;
        medianRobustScore: number;
        seedRuns: SeedRun[];
        verdict: "PASS" | "FAIL";
        failReasons: string[];
    };
    overall: {
        survivesAllThree: boolean;
        verdict: "PASS" | "FAIL";
    };
};

export interface StressTestOptions {
    dataPath: string;
    strategyKey: string;
    tickSize?: number;
    seeds?: number[];
    initialCapital?: number;
    positionSizePercent?: number;
    commissionPercent?: number;
    fixedTradeAmount?: number;
    finderMaxRuns?: number;
    finderRangePercent?: number;
    finderSteps?: number;
    finderTopN?: number;
    finderMinTrades?: number;
    walkForwardMaxCombinations?: number;
    walkForwardOptimizationWindowBars?: number;
    walkForwardTestWindowBars?: number;
    backtestSettingsOverrides?: Partial<BacktestSettings>;
    outputDir?: string;
    outputFileName?: string;
    quiet?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBar(row: unknown): OHLCVData | null {
    if (Array.isArray(row)) {
        if (row.length < 5) return null;
        const time = Number(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = row.length > 5 ? Number(row[5]) : 0;
        if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        const unix = time > 1e12 ? Math.floor(time / 1000) : Math.floor(time);
        return { time: unix as Time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    }

    if (!isObject(row)) return null;
    const rawTime = row.time ?? row.t ?? row.timestamp ?? row.date ?? row.datetime ?? row.start ?? row.openTime;
    const timeNum = Number(rawTime);
    const time = Number.isFinite(timeNum) ? (timeNum > 1e12 ? Math.floor(timeNum / 1000) : Math.floor(timeNum)) : Math.floor(Date.parse(String(rawTime || "")) / 1000);
    const open = Number(row.open ?? row.o);
    const high = Number(row.high ?? row.h);
    const low = Number(row.low ?? row.l);
    const close = Number(row.close ?? row.c);
    const volume = Number(row.volume ?? row.v ?? 0);
    if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
    return { time: time as Time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

function parseDataFile(raw: unknown): ParsedDataFile {
    let symbol: string | null = null;
    let interval: string | null = null;
    let rows: unknown[] = [];

    if (Array.isArray(raw)) {
        rows = raw;
    } else if (isObject(raw)) {
        if (typeof raw.symbol === "string" && raw.symbol.trim()) symbol = raw.symbol.trim();
        if (typeof raw.interval === "string" && raw.interval.trim()) interval = raw.interval.trim();
        if (Array.isArray(raw.data)) rows = raw.data;
        else if (Array.isArray(raw.ohlcv)) rows = raw.ohlcv;
        else if (Array.isArray(raw.candles)) rows = raw.candles;
    }

    const parsed = rows
        .map(parseBar)
        .filter((bar): bar is OHLCVData => Boolean(bar))
        .sort((a, b) => Number(a.time) - Number(b.time));

    const deduped: OHLCVData[] = [];
    for (const bar of parsed) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(bar.time)) {
            deduped[deduped.length - 1] = bar;
        } else {
            deduped.push(bar);
        }
    }
    return { bars: deduped, symbol, interval };
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile50Price(data: OHLCVData[]): number {
    return median(data.map((bar) => Number(bar.close)).filter((v) => Number.isFinite(v) && v > 0));
}

function buildFinderOptions(
    seed: number,
    config: {
        topN: number;
        steps: number;
        rangePercent: number;
        maxRuns: number;
        minTrades: number;
    }
): FinderOptions {
    return {
        mode: "robust_random_wf",
        sortPriority: ["expectancy", "profitFactor", "totalTrades", "maxDrawdownPercent", "sharpeRatio", "averageGain", "winRate", "netProfitPercent", "netProfit"],
        useAdvancedSort: false,
        robustSeed: seed,
        multiTimeframeEnabled: false,
        timeframes: [],
        topN: config.topN,
        steps: config.steps,
        rangePercent: config.rangePercent,
        maxRuns: config.maxRuns,
        tradeFilterEnabled: true,
        minTrades: config.minTrades,
        maxTrades: Number.POSITIVE_INFINITY,
    };
}

function buildBacktestSettings(
    slippageBps: number,
    overrides?: Partial<BacktestSettings>
): BacktestSettings {
    const resolved = resolveBacktestSettingsFromRaw(
        {
            tradeFilterMode: "none",
            tradeDirection: "both",
            executionModel: "next_open",
            allowSameBarExit: false,
            slippageBps,
            ...(overrides ?? {}),
        } as BacktestSettings,
        {
            captureSnapshots: false,
            coerceWithoutUiToggles: true,
        }
    );
    resolved.confirmationStrategies = [];
    resolved.confirmationStrategyParams = {};
    return resolved;
}

async function runRobustSeed(
    bars: OHLCVData[],
    symbol: string,
    interval: string,
    strategySelection: FinderSelectedStrategy[],
    settings: BacktestSettings,
    seed: number,
    initialCapital: number,
    positionSize: number,
    commission: number,
    sizingMode: "percent" | "fixed",
    fixedTradeAmount: number,
    finderConfig: {
        topN: number;
        steps: number;
        rangePercent: number;
        maxRuns: number;
        minTrades: number;
    }
): Promise<SeedRun> {
    const output = await runFinderExecution(
        {
            ohlcvData: bars,
            symbol,
            interval,
            options: buildFinderOptions(seed, finderConfig),
            settings,
            requiresTsEngine: true,
            selectedStrategies: strategySelection,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
            getFinderTimeframesForRun: () => [interval],
            loadMultiTimeframeDatasets: async () => [],
            generateParamSets: (defaultParams, options) => new FinderParamSpace().generateParamSets(defaultParams, options),
            buildRandomConfirmationParams: () => ({}),
        },
        {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            },
        }
    );

    const top = output.results[0];
    if (!top?.robustMetrics) {
        return {
            seed,
            passed: false,
            robustScore: 0,
            passRate: 0,
            stageCSurvivors: 0,
            params: null,
            result: null,
            decisionReason: "no_pass",
        };
    }

    return {
        seed,
        passed: true,
        robustScore: top.robustMetrics.robustScore,
        passRate: top.robustMetrics.passRate,
        stageCSurvivors: top.robustMetrics.stageCSurvivors,
        params: top.params,
        result: top.result,
        decisionReason: top.robustMetrics.decisionReason,
    };
}

function runBacktestFromParams(
    bars: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    settings: BacktestSettings,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number
): BacktestResult {
    const signals = strategy.execute(bars, params);
    const evaluation = strategy.evaluate?.(bars, params, signals);
    if (strategy.metadata?.role === "entry" && evaluation?.entryStats) {
        return buildEntryBacktestResult(evaluation.entryStats);
    }
    return runBacktestCompact(
        bars,
        signals,
        initialCapital,
        positionSizePercent,
        commissionPercent,
        settings,
        {
            mode: "percent",
            fixedTradeAmount: initialCapital * 0.1,
        }
    );
}

function buildConsensusParams(passed: SeedRun[]): StrategyParams | null {
    const rows = passed.filter((row) => row.passed && row.params);
    if (rows.length === 0) return null;

    const keySet = new Set<string>();
    for (const row of rows) {
        Object.keys(row.params || {}).forEach((k) => keySet.add(k));
    }

    const out: StrategyParams = {};
    for (const key of keySet) {
        const values = rows
            .map((row) => Number(row.params?.[key]))
            .filter((v) => Number.isFinite(v));
        if (values.length === 0) continue;
        out[key] = median(values);
    }
    return out;
}

function buildWalkForwardRanges(
    strategy: Strategy,
    maxCombinations: number
): Array<{ name: string; min: number; max: number; step: number }> {
    const allowed = strategy.metadata?.walkForwardParams ? new Set(strategy.metadata.walkForwardParams) : null;
    const entries = Object.entries(strategy.defaultParams).filter(([name]) => !allowed || allowed.has(name));
    const tunableCount = Math.max(1, entries.length);
    const safeMaxCombinations = Math.max(80, Math.floor(maxCombinations));
    const targetTotalIterations = Math.max(60, Math.floor(safeMaxCombinations * 0.7));
    const stepsPerParam = Math.max(2, Math.floor(Math.pow(targetTotalIterations, 1 / tunableCount)));

    const ranges: Array<{ name: string; min: number; max: number; step: number }> = [];
    for (const [name, defaultValueRaw] of entries) {
        const defaultValue = Number(defaultValueRaw);
        if (!Number.isFinite(defaultValue)) continue;

        const isToggle = /^use[A-Z]/.test(name) && (defaultValue === 0 || defaultValue === 1);
        if (isToggle) {
            ranges.push({ name, min: 0, max: 1, step: 1 });
            continue;
        }

        const isDecimal = !Number.isInteger(defaultValue) && defaultValue < 1;
        let min: number;
        let max: number;
        let step: number;

        if (isDecimal) {
            min = Math.max(0.1, defaultValue * 0.5);
            max = Math.min(1.0, defaultValue * 1.5);
            const rawStep = (max - min) / stepsPerParam;
            step = Math.max(0.05, rawStep);
        } else {
            min = Math.max(1, Math.floor(defaultValue * 0.5));
            max = Math.ceil(defaultValue * 2);
            const rawStep = (max - min) / stepsPerParam;
            step = Math.max(1, rawStep);
        }

        if (min >= max || !Number.isFinite(step) || step <= 0) continue;
        ranges.push({ name, min, max, step });
    }

    return ranges;
}

function computeParamDrift(windows: Array<{ optimizedParams: StrategyParams }>): {
    averageChangedParamsPerWindow: number;
    changedParamRatePerWindow: number;
    perParamDistinctValues: Record<string, number>;
} {
    if (windows.length === 0) {
        return {
            averageChangedParamsPerWindow: 0,
            changedParamRatePerWindow: 0,
            perParamDistinctValues: {},
        };
    }

    const allKeys = new Set<string>();
    for (const w of windows) Object.keys(w.optimizedParams || {}).forEach((k) => allKeys.add(k));
    const keys = Array.from(allKeys);
    const perParamDistinctValues: Record<string, number> = {};

    for (const key of keys) {
        const distinct = new Set<number>();
        for (const w of windows) {
            const value = Number(w.optimizedParams?.[key]);
            if (Number.isFinite(value)) distinct.add(value);
        }
        perParamDistinctValues[key] = distinct.size;
    }

    if (windows.length < 2 || keys.length === 0) {
        return {
            averageChangedParamsPerWindow: 0,
            changedParamRatePerWindow: 0,
            perParamDistinctValues,
        };
    }

    let totalChanged = 0;
    const transitions = windows.length - 1;
    for (let i = 1; i < windows.length; i++) {
        const prev = windows[i - 1].optimizedParams;
        const curr = windows[i].optimizedParams;
        for (const key of keys) {
            const a = Number(prev?.[key]);
            const b = Number(curr?.[key]);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            if (Math.abs(a - b) > 1e-9) totalChanged += 1;
        }
    }

    const averageChangedParamsPerWindow = totalChanged / transitions;
    const changedParamRatePerWindow = averageChangedParamsPerWindow / Math.max(1, keys.length);
    return {
        averageChangedParamsPerWindow,
        changedParamRatePerWindow,
        perParamDistinctValues,
    };
}

export async function runStrategyStressTests(options: StressTestOptions): Promise<{ report: StressReport; outPath: string }> {
    const dataPath = path.resolve(options.dataPath);
    const strategyKey = String(options.strategyKey || "").trim();
    const tickSizeArg = Number(options.tickSize ?? 0.01);
    const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    const parsed = parseDataFile(raw);
    const symbol = parsed.symbol || "UNKNOWN";
    const interval = parsed.interval || "UNKNOWN";
    const quiet = options.quiet === true;

    const strategy = strategies[strategyKey];
    if (!strategy) throw new Error(`Strategy not found: ${strategyKey}`);
    const strategySelection: FinderSelectedStrategy[] = [{ key: strategyKey, name: strategy.name, strategy }];

    const seeds = (options.seeds && options.seeds.length > 0) ? options.seeds : [1337, 7331, 2026, 4242, 9001];
    const initialCapital = Number.isFinite(Number(options.initialCapital)) ? Number(options.initialCapital) : 10000;
    const positionSizePercent = Number.isFinite(Number(options.positionSizePercent)) ? Number(options.positionSizePercent) : 100;
    const commissionPercent = Number.isFinite(Number(options.commissionPercent)) ? Number(options.commissionPercent) : 0.1;
    const sizingMode: "percent" | "fixed" = "percent";
    const fixedTradeAmount = Number.isFinite(Number(options.fixedTradeAmount)) ? Number(options.fixedTradeAmount) : 1000;
    const finderConfig = {
        topN: Number.isFinite(Number(options.finderTopN)) ? Math.max(1, Math.floor(Number(options.finderTopN))) : 12,
        steps: Number.isFinite(Number(options.finderSteps)) ? Math.max(1, Math.floor(Number(options.finderSteps))) : 3,
        rangePercent: Number.isFinite(Number(options.finderRangePercent)) ? Math.max(0, Number(options.finderRangePercent)) : 35,
        maxRuns: Number.isFinite(Number(options.finderMaxRuns)) ? Math.max(20, Math.floor(Number(options.finderMaxRuns))) : 120,
        minTrades: Number.isFinite(Number(options.finderMinTrades)) ? Math.max(0, Number(options.finderMinTrades)) : 40,
    };
    const walkForwardMaxCombinations = Number.isFinite(Number(options.walkForwardMaxCombinations))
        ? Math.max(80, Math.floor(Number(options.walkForwardMaxCombinations)))
        : 180;

    const closedBars = trimToClosedCandles(parsed.bars, interval);
    if (closedBars.length < 1000) throw new Error(`Not enough bars for stress tests: ${closedBars.length}`);

    const splitRatio = 0.7;
    const splitIndex = Math.max(1, Math.min(closedBars.length - 1, Math.floor(closedBars.length * splitRatio)));
    const trainBars = closedBars.slice(0, splitIndex);
    const blindBars = closedBars.slice(splitIndex);

    const tickSize = Number.isFinite(tickSizeArg) && tickSizeArg > 0 ? tickSizeArg : 0.01;
    const medianPrice = percentile50Price(closedBars);
    const rawTickSlippageBps = medianPrice > 0 ? (tickSize / medianPrice) * 10000 : 1;
    // Keep assumptions consistent with robust mode hard floor (min 1 bps).
    const tickSlippageBps = Math.max(1, rawTickSlippageBps);
    const settings = buildBacktestSettings(tickSlippageBps, options.backtestSettingsOverrides);

    if (!quiet) {
        console.log(`[stress] dataset=${symbol} ${interval} strategy=${strategyKey} bars=${closedBars.length} train=${trainBars.length} blind=${blindBars.length}`);
        console.log(`[stress] costs commission=${commissionPercent}% slippage=${tickSlippageBps.toFixed(4)}bps (rawTick=${rawTickSlippageBps.toFixed(4)}bps, tick=${tickSize} @ medianPrice=${medianPrice.toFixed(4)})`);
    }

    // Test 1: OOS 70/30 split
    const trainSeedRuns: SeedRun[] = [];
    const blindSeedRuns: OosBlindSeedResult[] = [];
    for (const seed of seeds) {
        const trainRun = await runRobustSeed(
            trainBars,
            symbol,
            interval,
            strategySelection,
            settings,
            seed,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            sizingMode,
            fixedTradeAmount,
            finderConfig
        );
        trainSeedRuns.push(trainRun);

        let blindResult: BacktestResult | null = null;
        if (trainRun.passed && trainRun.params) {
            blindResult = runBacktestFromParams(
                blindBars,
                strategy,
                trainRun.params,
                settings,
                initialCapital,
                positionSizePercent,
                commissionPercent
            );
        }
        blindSeedRuns.push({
            seed,
            trainPassed: trainRun.passed,
            params: trainRun.params,
            blindResult,
        });
    }

    const consensusParams = buildConsensusParams(trainSeedRuns);
    const blindConsensusResult = consensusParams
        ? runBacktestFromParams(
            blindBars,
            strategy,
            consensusParams,
            settings,
            initialCapital,
            positionSizePercent,
            commissionPercent
        )
        : null;

    const blindResults = blindSeedRuns
        .map((row) => row.blindResult)
        .filter((row): row is BacktestResult => Boolean(row));
    const blindPositiveSeeds = blindResults.filter((result) => result.netProfitPercent > 0).length;
    const blindMedianNetProfitPercent = median(blindResults.map((result) => result.netProfitPercent));
    const blindMedianMaxDrawdownPercent = median(blindResults.map((result) => result.maxDrawdownPercent));
    const blindMedianProfitFactor = median(blindResults.map((result) => result.profitFactor));
    const trainSeedPassCount = trainSeedRuns.filter((row) => row.passed).length;

    const oosCriteria = {
        minTrainSeedPasses: 3,
        minBlindPositiveSeeds: 3,
        minBlindMedianNetProfitPercent: 0,
    };
    const oosFailReasons: string[] = [];
    if (trainSeedPassCount < oosCriteria.minTrainSeedPasses) oosFailReasons.push("insufficient_train_seed_passes");
    if (blindPositiveSeeds < oosCriteria.minBlindPositiveSeeds) oosFailReasons.push("insufficient_blind_positive_seeds");
    if (blindMedianNetProfitPercent <= oosCriteria.minBlindMedianNetProfitPercent) oosFailReasons.push("non_positive_blind_median_net_profit");
    const oosVerdict: "PASS" | "FAIL" = oosFailReasons.length === 0 ? "PASS" : "FAIL";

    // Test 2: Walk-forward 3m train / 1m test
    const wfOptimizationWindowBars = Number.isFinite(Number(options.walkForwardOptimizationWindowBars))
        ? Math.max(100, Math.floor(Number(options.walkForwardOptimizationWindowBars)))
        : 24 * 30 * 3;
    const wfTestWindowBars = Number.isFinite(Number(options.walkForwardTestWindowBars))
        ? Math.max(50, Math.floor(Number(options.walkForwardTestWindowBars)))
        : 24 * 30;
    const wfStepBars = wfTestWindowBars;
    const wfRanges = buildWalkForwardRanges(strategy, walkForwardMaxCombinations);
    const wf = await runWalkForwardAnalysis(
        closedBars,
        strategy,
        {
            optimizationWindow: wfOptimizationWindowBars,
            testWindow: wfTestWindowBars,
            stepSize: wfStepBars,
            parameterRanges: wfRanges,
            topN: 2,
            minTrades: 5,
            maxCombinations: walkForwardMaxCombinations,
            minOOSTradesPerWindow: 1,
            minTotalOOSTrades: 40,
        },
        initialCapital,
        positionSizePercent,
        commissionPercent,
        settings,
        {
            mode: sizingMode,
            fixedTradeAmount,
        }
    );

    const wfDrift = computeParamDrift(wf.windows);
    const wfCriteria = {
        minCombinedOOSNetProfitPercent: 0,
        minWalkForwardEfficiency: 0.45,
        minParameterStability: 40,
        maxCombinedOOSDrawdownPercent: 30,
    };
    const wfFailReasons: string[] = [];
    if (wf.combinedOOSTrades.netProfitPercent <= wfCriteria.minCombinedOOSNetProfitPercent) wfFailReasons.push("non_positive_combined_oos_profit");
    if (wf.walkForwardEfficiency < wfCriteria.minWalkForwardEfficiency) wfFailReasons.push("low_walk_forward_efficiency");
    if (wf.parameterStability < wfCriteria.minParameterStability) wfFailReasons.push("low_parameter_stability");
    if (wf.combinedOOSTrades.maxDrawdownPercent > wfCriteria.maxCombinedOOSDrawdownPercent) wfFailReasons.push("high_combined_oos_drawdown");
    const wfVerdict: "PASS" | "FAIL" = wfFailReasons.length === 0 ? "PASS" : "FAIL";

    // Test 3: Fee/slippage sensitivity under requested assumptions
    const fullSeedRuns: SeedRun[] = [];
    for (const seed of seeds) {
        const run = await runRobustSeed(
            closedBars,
            symbol,
            interval,
            strategySelection,
            settings,
            seed,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            sizingMode,
            fixedTradeAmount,
            finderConfig
        );
        fullSeedRuns.push(run);
    }

    const fullPassed = fullSeedRuns.filter((row) => row.passed && row.result);
    const sensitivityPassCount = fullPassed.length;
    const sensitivityMedianNetProfitPercent = median(fullPassed.map((row) => row.result?.netProfitPercent ?? 0));
    const sensitivityMedianMaxDrawdownPercent = median(fullPassed.map((row) => row.result?.maxDrawdownPercent ?? 0));
    const sensitivityMedianProfitFactor = median(fullPassed.map((row) => row.result?.profitFactor ?? 0));
    const sensitivityMedianRobustScore = median(fullPassed.map((row) => row.robustScore));

    const sensitivityCriteria = {
        minSeedPasses: 3,
        minMedianNetProfitPercent: 0,
        maxMedianDrawdownPercent: 30,
    };
    const sensitivityFailReasons: string[] = [];
    if (sensitivityPassCount < sensitivityCriteria.minSeedPasses) sensitivityFailReasons.push("insufficient_seed_passes");
    if (sensitivityMedianNetProfitPercent <= sensitivityCriteria.minMedianNetProfitPercent) sensitivityFailReasons.push("non_positive_median_net_profit");
    if (sensitivityMedianMaxDrawdownPercent > sensitivityCriteria.maxMedianDrawdownPercent) sensitivityFailReasons.push("high_median_drawdown");
    const sensitivityVerdict: "PASS" | "FAIL" = sensitivityFailReasons.length === 0 ? "PASS" : "FAIL";

    const survivesAllThree = oosVerdict === "PASS" && wfVerdict === "PASS" && sensitivityVerdict === "PASS";

    const report: StressReport = {
        generatedAt: new Date().toISOString(),
        inputs: {
            dataPath,
            symbol,
            interval,
            strategyKey,
            seeds,
            split: {
                trainRatio: splitRatio,
                trainBars: trainBars.length,
                blindBars: blindBars.length,
            },
            trading: {
                initialCapital,
                positionSizePercent,
                commissionPercent,
                slippageBps: tickSlippageBps,
                rawTickSlippageBps,
                tickSize,
                referenceMedianPrice: medianPrice,
            },
            backtestSettingsOverrides: options.backtestSettingsOverrides ?? {},
        },
        oos70_30: {
            criteria: oosCriteria,
            trainSeedPassCount,
            blindPositiveSeedCount: blindPositiveSeeds,
            blindMedianNetProfitPercent,
            blindMedianMaxDrawdownPercent,
            blindMedianProfitFactor,
            blindConsensusResult,
            seedRuns: blindSeedRuns,
            verdict: oosVerdict,
            failReasons: oosFailReasons,
        },
        walkForward3m1m: {
            criteria: wfCriteria,
            optimizationWindowBars: wfOptimizationWindowBars,
            testWindowBars: wfTestWindowBars,
            stepSizeBars: wfStepBars,
            totalWindows: wf.totalWindows,
            combinedOOS: {
                netProfitPercent: wf.combinedOOSTrades.netProfitPercent,
                profitFactor: wf.combinedOOSTrades.profitFactor,
                maxDrawdownPercent: wf.combinedOOSTrades.maxDrawdownPercent,
                totalTrades: wf.combinedOOSTrades.totalTrades,
                winRate: wf.combinedOOSTrades.winRate,
            },
            avgInSampleSharpe: wf.avgInSampleSharpe,
            avgOutOfSampleSharpe: wf.avgOutOfSampleSharpe,
            walkForwardEfficiency: wf.walkForwardEfficiency,
            robustnessScore: wf.robustnessScore,
            parameterStability: wf.parameterStability,
            parameterDrift: wfDrift,
            verdict: wfVerdict,
            failReasons: wfFailReasons,
        },
        feeSlippageSensitivity: {
            criteria: sensitivityCriteria,
            seedPassCount: sensitivityPassCount,
            medianNetProfitPercent: sensitivityMedianNetProfitPercent,
            medianMaxDrawdownPercent: sensitivityMedianMaxDrawdownPercent,
            medianProfitFactor: sensitivityMedianProfitFactor,
            medianRobustScore: sensitivityMedianRobustScore,
            seedRuns: fullSeedRuns,
            verdict: sensitivityVerdict,
            failReasons: sensitivityFailReasons,
        },
        overall: {
            survivesAllThree,
            verdict: survivesAllThree ? "PASS" : "FAIL",
        },
    };

    const dateTag = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(options.outputDir ?? `./batch-runs/stress-tests-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });
    const safeStrategy = strategyKey.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const outPath = path.join(outDir, options.outputFileName ?? `${symbol.toLowerCase()}-${interval}-${safeStrategy}-stress.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

    if (!quiet) {
        console.log(`[stress] oos70_30=${oosVerdict} trainPass=${trainSeedPassCount}/${seeds.length} blindPositive=${blindPositiveSeeds}/${blindResults.length} blindMedianNet=${blindMedianNetProfitPercent.toFixed(2)}%`);
        console.log(`[stress] walkForward3m1m=${wfVerdict} windows=${wf.totalWindows} oosNet=${wf.combinedOOSTrades.netProfitPercent.toFixed(2)}% wfe=${wf.walkForwardEfficiency.toFixed(3)} stability=${wf.parameterStability.toFixed(1)}`);
        console.log(`[stress] feeSlippageSensitivity=${sensitivityVerdict} seedPass=${sensitivityPassCount}/${seeds.length} medianNet=${sensitivityMedianNetProfitPercent.toFixed(2)}% medianDD=${sensitivityMedianMaxDrawdownPercent.toFixed(2)}%`);
        console.log(`[stress] overall=${report.overall.verdict}`);
        console.log(`[stress] wrote ${outPath}`);
    }

    return { report, outPath };
}

async function main(): Promise<void> {
    const dataPath = process.argv[2] || "./price-data/robust-lab/SOLUSDT-1h.json";
    const tickSize = Number(process.argv[3] || "0.01");
    const strategyKey = process.argv[4] || "long_short_harvest";
    const outputDir = process.argv[5];
    const finderMaxRuns = Number(process.argv[6] || "120");
    const walkForwardMaxCombinations = Number(process.argv[7] || "180");

    await runStrategyStressTests({
        dataPath,
        strategyKey,
        tickSize,
        outputDir,
        finderMaxRuns,
        walkForwardMaxCombinations,
        quiet: false,
    });
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`sol-survivor-stress-tests failed: ${message}`);
        process.exitCode = 1;
    });
}
