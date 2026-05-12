import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { runGeneticOptimization, type GeneticOptimizerConfig } from "../lib/finder/genetic-optimizer";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { precomputeIndicators, runBacktestCompact } from "../lib/strategies";
import { strategies } from "../lib/strategies/library";
import type {
    BacktestSettings,
    ExecutionModel,
    OHLCVData,
    Strategy,
    TradeDirection,
    TradeFilterMode,
} from "../lib/types/strategies";
import { toBoolean, toFinite, toPositiveInt } from "./lib/cli-args";
import { parseOhlcvDataFile } from "./lib/ohlcv-file";

type CliOptions = {
    strategyKey: string;
    symbol: string;
    interval: string;
    windows: number;
    trainMonths: number;
    testMonths: number;
    population: number;
    generations: number;
    eliteCount: number;
    mutationRate: number;
    mutationSigma: number;
    rangePercent: number;
    seed: number;
    minTrades: number;
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    executionModel: ExecutionModel;
    tradeFilterMode: TradeFilterMode;
    slippageBps: number;
    allowSameBarExit: boolean;
    dataDir: string;
    outFile: string;
};

type WindowResult = {
    index: number;
    seed: number;
    train: {
        bars: number;
        startTime: number;
        endTime: number;
        bestScore: number;
        bestNetProfitPercent: number;
        bestSharpeRatio: number;
        bestDrawdownPercent: number;
        alphaGenome: Record<string, number>;
    };
    test: {
        bars: number;
        startTime: number;
        endTime: number;
        startingCapital: number;
        endingCapital: number;
        netProfit: number;
        netProfitPercent: number;
        sharpeRatio: number;
        maxDrawdownPercent: number;
        totalTrades: number;
    };
};

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run hunt:walk-forward",
        "",
        "Defaults:",
        "  strategy=meta_harvest_v2 symbol=XRPUSDT interval=15m windows=12 train=6m test=1m",
        "",
        "Options:",
        "  --strategy <key>             default meta_harvest_v2",
        "  --symbol <pair>              default XRPUSDT",
        "  --interval <value>           default 15m",
        "  --windows <n>                default 12",
        "  --train-months <n>           default 6",
        "  --test-months <n>            default 1",
        "  --population <n>             default 100",
        "  --generations <n>            default 50",
        "  --elite <n>                  default 5",
        "  --mutation-rate <0..1>       default 0.12",
        "  --mutation-sigma <ratio>     default 0.12",
        "  --range <percent>            default 35",
        "  --seed <n>                   default 2026",
        "  --min-trades <n>             default 20",
        "  --out <file>                 default walk_forward_hunt.json",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
    let strategyKey = "meta_harvest_v2";
    let symbol = "XRPUSDT";
    let interval = "15m";
    let windows = 12;
    let trainMonths = 6;
    let testMonths = 1;
    let population = 100;
    let generations = 50;
    let eliteCount = 5;
    let mutationRate = 0.12;
    let mutationSigma = 0.12;
    let rangePercent = 35;
    let seed = 2026;
    let minTrades = 20;
    let initialCapital = Number(CAPITAL_DEFAULTS.initialCapital);
    let positionSize = Number(CAPITAL_DEFAULTS.positionSize);
    let commission = Number(CAPITAL_DEFAULTS.commission);
    let sizingMode: "percent" | "fixed" = "percent";
    let fixedTradeAmount = Number(CAPITAL_DEFAULTS.fixedTradeAmount);
    let executionModel: ExecutionModel = "signal_close";
    let tradeFilterMode: TradeFilterMode = "none";
    let slippageBps = 0;
    let allowSameBarExit = true;
    let dataDir = path.resolve("price-data", "universal");
    let outFile = path.resolve("walk_forward_hunt.json");
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") {
            return {
                help: true,
                strategyKey,
                symbol,
                interval,
                windows,
                trainMonths,
                testMonths,
                population,
                generations,
                eliteCount,
                mutationRate,
                mutationSigma,
                rangePercent,
                seed,
                minTrades,
                initialCapital,
                positionSize,
                commission,
                sizingMode,
                fixedTradeAmount,
                executionModel,
                tradeFilterMode,
                slippageBps,
                allowSameBarExit,
                dataDir,
                outFile,
            };
        }
        if (arg === "--strategy") { strategyKey = String(next ?? strategyKey).trim(); i++; continue; }
        if (arg === "--symbol") { symbol = String(next ?? symbol).trim().toUpperCase(); i++; continue; }
        if (arg === "--interval") { interval = String(next ?? interval).trim() || interval; i++; continue; }
        if (arg === "--windows") { windows = toPositiveInt(next, windows, 1); i++; continue; }
        if (arg === "--train-months") { trainMonths = toPositiveInt(next, trainMonths, 1); i++; continue; }
        if (arg === "--test-months") { testMonths = toPositiveInt(next, testMonths, 1); i++; continue; }
        if (arg === "--population") { population = toPositiveInt(next, population, 10); i++; continue; }
        if (arg === "--generations") { generations = toPositiveInt(next, generations, 1); i++; continue; }
        if (arg === "--elite") { eliteCount = toPositiveInt(next, eliteCount, 1); i++; continue; }
        if (arg === "--mutation-rate") { mutationRate = toFinite(next, mutationRate); i++; continue; }
        if (arg === "--mutation-sigma") { mutationSigma = toFinite(next, mutationSigma); i++; continue; }
        if (arg === "--range") { rangePercent = toFinite(next, rangePercent); i++; continue; }
        if (arg === "--seed") { seed = toPositiveInt(next, seed); i++; continue; }
        if (arg === "--min-trades") { minTrades = toPositiveInt(next, minTrades, 0); i++; continue; }
        if (arg === "--initial-capital") { initialCapital = toFinite(next, initialCapital); i++; continue; }
        if (arg === "--position-size") { positionSize = toFinite(next, positionSize); i++; continue; }
        if (arg === "--commission") { commission = toFinite(next, commission); i++; continue; }
        if (arg === "--sizing") {
            const mode = String(next ?? "").trim().toLowerCase();
            sizingMode = mode === "fixed" ? "fixed" : "percent";
            i++;
            continue;
        }
        if (arg === "--fixed-trade-amount") { fixedTradeAmount = toFinite(next, fixedTradeAmount); i++; continue; }
        if (arg === "--execution") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "signal_close" || value === "next_open" || value === "next_close") executionModel = value;
            i++;
            continue;
        }
        if (arg === "--trade-filter") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "none" || value === "close" || value === "volume" || value === "rsi" || value === "trend" || value === "adx" || value === "htf_drift") {
                tradeFilterMode = value;
            }
            i++;
            continue;
        }
        if (arg === "--slippage-bps") { slippageBps = toFinite(next, slippageBps); i++; continue; }
        if (arg === "--allow-same-bar-exit") { allowSameBarExit = toBoolean(next, allowSameBarExit); i++; continue; }
        if (arg === "--data-dir") { dataDir = path.resolve(String(next ?? dataDir)); i++; continue; }
        if (arg === "--out") { outFile = path.resolve(String(next ?? outFile)); i++; continue; }
        positional.push(arg);
    }

    // Positional fallback for shells where named flags are swallowed:
    // walk-forward-hunt.ts <strategy> <windows> <generations> <population>
    if (positional[0]) strategyKey = positional[0].trim();
    if (positional[1]) windows = toPositiveInt(positional[1], windows, 1);
    if (positional[2]) generations = toPositiveInt(positional[2], generations, 1);
    if (positional[3]) population = toPositiveInt(positional[3], population, 10);

    return {
        strategyKey,
        symbol,
        interval,
        windows,
        trainMonths,
        testMonths,
        population,
        generations,
        eliteCount: Math.max(1, Math.min(eliteCount, population)),
        mutationRate: Math.max(0, Math.min(1, mutationRate)),
        mutationSigma: Math.max(0.0001, mutationSigma),
        rangePercent: Math.max(0, rangePercent),
        seed: Math.max(1, seed),
        minTrades: Math.max(0, minTrades),
        initialCapital: Math.max(1, initialCapital),
        positionSize: Math.max(0.0001, positionSize),
        commission: Math.max(0, commission),
        sizingMode,
        fixedTradeAmount: Math.max(0, fixedTradeAmount),
        executionModel,
        tradeFilterMode,
        slippageBps: Math.max(0, slippageBps),
        allowSameBarExit,
        dataDir,
        outFile,
    };
}

function intervalToMinutes(interval: string): number {
    const value = interval.trim();
    if (value.endsWith("m")) return Math.max(1, parseInt(value.slice(0, -1), 10));
    if (value.endsWith("h")) return Math.max(1, parseInt(value.slice(0, -1), 10)) * 60;
    if (value.endsWith("d")) return Math.max(1, parseInt(value.slice(0, -1), 10)) * 24 * 60;
    if (value.endsWith("w")) return Math.max(1, parseInt(value.slice(0, -1), 10)) * 7 * 24 * 60;
    if (value.endsWith("M")) return Math.max(1, parseInt(value.slice(0, -1), 10)) * 30 * 24 * 60;
    const fallback = parseInt(value, 10);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 15;
}

function windowBars(options: CliOptions): { trainBars: number; testBars: number; totalBars: number } {
    const minutes = intervalToMinutes(options.interval);
    const barsPerDay = Math.max(1, Math.floor((24 * 60) / minutes));
    const trainBars = Math.max(200, options.trainMonths * 30 * barsPerDay);
    const testBars = Math.max(100, options.testMonths * 30 * barsPerDay);
    const totalBars = trainBars + (options.windows * testBars);
    return { trainBars, testBars, totalBars };
}

function deriveSeed(baseSeed: number, symbol: string, strategyKey: string, windowIndex: number): number {
    const key = `${symbol}|${strategyKey}|wf|${windowIndex}`;
    let hash = baseSeed >>> 0;
    for (let i = 0; i < key.length; i++) {
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) || 1;
}

function inferDirection(strategy: Strategy): TradeDirection {
    const direction = strategy.metadata?.direction;
    if (direction === "short" || direction === "both" || direction === "long") return direction;
    return "long";
}

function buildGeneticConfig(options: CliOptions, seed: number): GeneticOptimizerConfig {
    return {
        populationSize: options.population,
        generations: options.generations,
        eliteCount: options.eliteCount,
        mutationRate: options.mutationRate,
        mutationSigma: options.mutationSigma,
        rangePercent: options.rangePercent,
        seed,
        tournamentSize: 2,
        backtest: {
            initialCapital: options.initialCapital,
            positionSize: options.positionSize,
            commission: options.commission,
            sizingMode: options.sizingMode,
            fixedTradeAmount: options.fixedTradeAmount,
            minTrades: options.minTrades,
        },
    };
}

function maxDrawdownFromCurve(curve: Array<{ time: number; value: number }>, initialCapital: number): { maxDrawdown: number; maxDrawdownPercent: number } {
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    for (const point of curve) {
        if (point.value > peak) peak = point.value;
        const drawdown = peak - point.value;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        }
    }
    return { maxDrawdown, maxDrawdownPercent };
}

async function loadBars(options: CliOptions, requiredBars: number): Promise<{ bars: OHLCVData[]; source: "cache" | "fetched"; dataFile: string }> {
    fs.mkdirSync(options.dataDir, { recursive: true });
    const dataFile = path.resolve(options.dataDir, `${options.symbol}-${options.interval}.json`);
    const targetBars = Math.max(requiredBars + 256, Math.ceil(requiredBars * 1.02));
    if (fs.existsSync(dataFile)) {
        const parsed = parseOhlcvDataFile(JSON.parse(fs.readFileSync(dataFile, "utf8")));
        const closed = trimToClosedCandles(parsed.bars, options.interval);
        if (closed.length >= requiredBars) {
            return {
                bars: closed.slice(closed.length - requiredBars),
                source: "cache",
                dataFile,
            };
        }
    }

    const fetched = await fetchBinanceDataWithLimit(options.symbol, options.interval, targetBars, {
        requestDelayMs: 30,
        maxRequests: Math.ceil(targetBars / 1000) + 5,
    });
    if (!Array.isArray(fetched) || fetched.length === 0) {
        throw new Error(`[WalkForward] Failed to fetch ${options.symbol} ${options.interval} candles from Binance.`);
    }
    const payload = {
        symbol: options.symbol,
        interval: options.interval,
        provider: "Binance",
        bars: fetched.length,
        generatedAt: new Date().toISOString(),
        data: fetched.map((bar) => ({
            time: Number(bar.time),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
        })),
    };
    fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), "utf8");
    const closed = trimToClosedCandles(fetched, options.interval);
    if (closed.length < requiredBars) {
        throw new Error(
            `[WalkForward] Fetched candles still insufficient after close-trim: fetched=${fetched.length} closed=${closed.length} required=${requiredBars}.`
        );
    }
    return {
        bars: closed.slice(closed.length - requiredBars),
        source: "fetched",
        dataFile,
    };
}

async function runWalkForward(options: CliOptions): Promise<void> {
    const strategy = (strategies as Record<string, Strategy>)[options.strategyKey];
    if (!strategy) {
        const available = Object.keys(strategies).sort().join(", ");
        throw new Error(`[WalkForward] Strategy not found: ${options.strategyKey}\nAvailable: ${available}`);
    }

    const { trainBars, testBars, totalBars } = windowBars(options);
    const loaded = await loadBars(options, totalBars);
    if (loaded.bars.length < totalBars) {
        throw new Error(`[WalkForward] Insufficient bars (${loaded.bars.length}) for required rolling windows (${totalBars}).`);
    }

    const backtestSettings = resolveBacktestSettingsFromRaw({
        tradeDirection: inferDirection(strategy),
        executionModel: options.executionModel,
        tradeFilterMode: options.tradeFilterMode,
        allowSameBarExit: options.allowSameBarExit,
        slippageBps: options.slippageBps,
    } as BacktestSettings, {
        coerceWithoutUiToggles: true,
    });

    const data = loaded.bars;
    const windows: WindowResult[] = [];
    const equityCurve: Array<{ time: number; value: number }> = [];
    let capital = options.initialCapital;

    console.log(
        `[WalkForward] ${options.symbol} ${options.interval} strategy=${options.strategyKey} windows=${options.windows} trainBars=${trainBars} testBars=${testBars} source=${loaded.source}`
    );

    for (let i = 0; i < options.windows; i++) {
        const trainStart = i * testBars;
        const trainEnd = trainStart + trainBars;
        const testEnd = trainEnd + testBars;

        const trainData = data.slice(trainStart, trainEnd);
        const testData = data.slice(trainEnd, testEnd);
        if (trainData.length < trainBars || testData.length < testBars) {
            throw new Error(`[WalkForward] Window ${i + 1} missing required bars (train=${trainData.length}, test=${testData.length}).`);
        }

        const seed = deriveSeed(options.seed, options.symbol, options.strategyKey, i);
        const ga = await runGeneticOptimization({
            strategyKey: options.strategyKey,
            strategy,
            data: trainData,
            backtestSettings,
            config: buildGeneticConfig(options, seed),
        });

        const params = ga.bestGenome.params;
        const testSignals = strategy.execute(testData, params);
        const precomputed = precomputeIndicators(testData, backtestSettings);
        const testEquity = new Float64Array(testData.length);
        const testResult = runBacktestCompact(
            testData,
            testSignals,
            capital,
            options.positionSize,
            options.commission,
            backtestSettings,
            { mode: options.sizingMode, fixedTradeAmount: options.fixedTradeAmount },
            precomputed,
            testEquity
        );

        for (let j = 0; j < testData.length; j++) {
            equityCurve.push({ time: Number(testData[j].time), value: testEquity[j] });
        }

        const endingCapital = capital + testResult.netProfit;
        const windowResult: WindowResult = {
            index: i + 1,
            seed,
            train: {
                bars: trainData.length,
                startTime: Number(trainData[0].time),
                endTime: Number(trainData[trainData.length - 1].time),
                bestScore: ga.bestGenome.fitness.score,
                bestNetProfitPercent: ga.bestGenome.fitness.netProfitPercent,
                bestSharpeRatio: ga.bestGenome.fitness.sharpeRatio,
                bestDrawdownPercent: ga.bestGenome.fitness.maxDrawdownPercent,
                alphaGenome: params as Record<string, number>,
            },
            test: {
                bars: testData.length,
                startTime: Number(testData[0].time),
                endTime: Number(testData[testData.length - 1].time),
                startingCapital: capital,
                endingCapital,
                netProfit: testResult.netProfit,
                netProfitPercent: testResult.netProfitPercent,
                sharpeRatio: testResult.sharpeRatio,
                maxDrawdownPercent: testResult.maxDrawdownPercent,
                totalTrades: testResult.totalTrades,
            },
        };
        windows.push(windowResult);
        capital = endingCapital;

        console.log(
            `[WF ${windowResult.index}/${options.windows}] trainScore=${windowResult.train.bestScore.toFixed(6)} testNet=${windowResult.test.netProfitPercent.toFixed(2)}% trades=${windowResult.test.totalTrades} capital=${capital.toFixed(2)}`
        );
    }

    const totalNetProfit = capital - options.initialCapital;
    const totalNetProfitPercent = options.initialCapital > 0 ? (totalNetProfit / options.initialCapital) * 100 : 0;
    const totalTrades = windows.reduce((sum, item) => sum + item.test.totalTrades, 0);
    const positiveWindows = windows.filter((item) => item.test.netProfit > 0).length;
    const { maxDrawdown, maxDrawdownPercent } = maxDrawdownFromCurve(equityCurve, options.initialCapital);

    const report = {
        generatedAt: new Date().toISOString(),
        config: {
            strategyKey: options.strategyKey,
            symbol: options.symbol,
            interval: options.interval,
            windows: options.windows,
            trainMonths: options.trainMonths,
            testMonths: options.testMonths,
            trainBars,
            testBars,
            genetic: {
                population: options.population,
                generations: options.generations,
                eliteCount: options.eliteCount,
                mutationRate: options.mutationRate,
                mutationSigma: options.mutationSigma,
                rangePercent: options.rangePercent,
                minTrades: options.minTrades,
                seed: options.seed,
            },
            backtest: {
                initialCapital: options.initialCapital,
                positionSize: options.positionSize,
                commission: options.commission,
                sizingMode: options.sizingMode,
                fixedTradeAmount: options.fixedTradeAmount,
                executionModel: options.executionModel,
                tradeFilterMode: options.tradeFilterMode,
                slippageBps: options.slippageBps,
                allowSameBarExit: options.allowSameBarExit,
            },
        },
        data: {
            source: loaded.source,
            dataFile: loaded.dataFile,
            bars: data.length,
            range: {
                startTime: Number(data[0].time),
                endTime: Number(data[data.length - 1].time),
            },
        },
        summary: {
            initialCapital: options.initialCapital,
            finalCapital: capital,
            totalNetProfit,
            totalNetProfitPercent,
            aggregatePositive: totalNetProfit > 0,
            totalTrades,
            positiveWindows,
            negativeWindows: options.windows - positiveWindows,
            maxDrawdown,
            maxDrawdownPercent,
        },
        windows,
        equityCurve,
    };

    fs.writeFileSync(options.outFile, JSON.stringify(report, null, 2), "utf8");
    console.log(
        `[WalkForward] Completed. aggregateNet=${totalNetProfitPercent.toFixed(2)}% positive=${totalNetProfit > 0 ? "yes" : "no"} windowsPositive=${positiveWindows}/${options.windows}`
    );
    console.log(`[WalkForward] Wrote: ${options.outFile}`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    await runWalkForward(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`walk-forward-hunt failed: ${message}`);
        process.exitCode = 1;
    });
}
