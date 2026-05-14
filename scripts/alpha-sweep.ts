import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { runGeneticOptimization, type GeneticOptimizerConfig } from "../lib/finder/genetic-optimizer";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { strategies } from "../lib/strategies/library";
import type {
    BacktestSettings,
    ExecutionModel,
    Strategy,
    TradeDirection,
} from "../lib/types/strategies";
import { ensureUniversalMarketData } from "./universal-market-loader";
import { toBoolean, toFinite, toPositiveInt } from "./lib/cli-args";
import { parseOhlcvDataFile } from "./lib/ohlcv-file";

type CliOptions = {
    topN: number;
    interval: string;
    bars: number;
    freshnessHours: number;
    population: number;
    generations: number;
    eliteCount: number;
    mutationRate: number;
    mutationSigma: number;
    rangePercent: number;
    minTrades: number;
    strategies: string[];
    outFile: string;
    seed: number;
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    executionModel: ExecutionModel;
    slippageBps: number;
    allowSameBarExit: boolean;
    outputDir: string;
};

type AlphaHuntResult = {
    strategyKey: string;
    elapsedMs: number;
    fitness: {
        score: number;
        netProfitPercent: number;
        sharpeRatio: number;
        stability: number;
        maxDrawdownPercent: number;
        totalTrades: number;
    };
    alphaGenome: Record<string, number>;
};

type AlphaSymbolReport = {
    rank: number;
    symbol: string;
    interval: string;
    quoteVolume: number;
    bars: number;
    dataFile: string;
    hunts: AlphaHuntResult[];
    winner: AlphaHuntResult | null;
};

const DEFAULT_STRATEGIES = ["bear_hunter_v5", "meta_harvest_v2"];

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run alpha:sweep",
        "",
        "Optional flags:",
        "  --top <n>                   default 50",
        "  --interval <value>          default 15m",
        "  --bars <n>                  default 10000",
        "  --fresh-hours <n>           default 4",
        "  --population <n>            default 100",
        "  --generations <n>           default 50",
        "  --elite <n>                 default 5",
        "  --mutation-rate <0..1>      default 0.12",
        "  --mutation-sigma <ratio>    default 0.12",
        "  --range <percent>           default 35",
        "  --min-trades <n>            default 20",
        "  --strategies <k1,k2,...>    default bear_hunter_v5,meta_harvest_v2",
        "  --out <file>                default alpha_report.json",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
    let topN = 50;
    let interval = "15m";
    let bars = 10000;
    let freshnessHours = 4;
    let population = 100;
    let generations = 50;
    let eliteCount = 5;
    let mutationRate = 0.12;
    let mutationSigma = 0.12;
    let rangePercent = 35;
    let minTrades = 20;
    let strategyKeys = [...DEFAULT_STRATEGIES];
    let outFile = path.resolve("alpha_report.json");
    let seed = 1337;
    let initialCapital = Number(CAPITAL_DEFAULTS.initialCapital);
    let positionSize = Number(CAPITAL_DEFAULTS.positionSize);
    let commission = Number(CAPITAL_DEFAULTS.commission);
    let sizingMode: "percent" | "fixed" = "percent";
    let fixedTradeAmount = Number(CAPITAL_DEFAULTS.fixedTradeAmount);
    let executionModel: ExecutionModel = "signal_close";
    let slippageBps = 0;
    let allowSameBarExit = true;
    let outputDir = path.resolve("price-data", "universal");
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") {
            return {
                help: true,
                topN,
                interval,
                bars,
                freshnessHours,
                population,
                generations,
                eliteCount,
                mutationRate,
                mutationSigma,
                rangePercent,
                minTrades,
                strategies: strategyKeys,
                outFile,
                seed,
                initialCapital,
                positionSize,
                commission,
                sizingMode,
                fixedTradeAmount,
                executionModel,
                slippageBps,
                allowSameBarExit,
                outputDir,
            };
        }
        if (arg === "--top") { topN = toPositiveInt(next, topN); i++; continue; }
        if (arg === "--interval") { interval = String(next ?? "").trim() || interval; i++; continue; }
        if (arg === "--bars") { bars = toPositiveInt(next, bars, 1000); i++; continue; }
        if (arg === "--fresh-hours") { freshnessHours = toPositiveInt(next, freshnessHours); i++; continue; }
        if (arg === "--population") { population = toPositiveInt(next, population, 10); i++; continue; }
        if (arg === "--generations") { generations = toPositiveInt(next, generations); i++; continue; }
        if (arg === "--elite") { eliteCount = toPositiveInt(next, eliteCount); i++; continue; }
        if (arg === "--mutation-rate") { mutationRate = toFinite(next, mutationRate); i++; continue; }
        if (arg === "--mutation-sigma") { mutationSigma = toFinite(next, mutationSigma); i++; continue; }
        if (arg === "--range") { rangePercent = toFinite(next, rangePercent); i++; continue; }
        if (arg === "--min-trades") { minTrades = toPositiveInt(next, minTrades, 0); i++; continue; }
        if (arg === "--strategies") {
            strategyKeys = String(next ?? "")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
            i++;
            continue;
        }
        if (arg === "--out") { outFile = path.resolve(String(next ?? "alpha_report.json")); i++; continue; }
        if (arg === "--seed") { seed = toPositiveInt(next, seed); i++; continue; }
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
        if (arg === "--slippage-bps") { slippageBps = toFinite(next, slippageBps); i++; continue; }
        if (arg === "--allow-same-bar-exit") { allowSameBarExit = toBoolean(next, allowSameBarExit); i++; continue; }
        if (arg === "--data-dir") { outputDir = path.resolve(String(next ?? outputDir)); i++; continue; }
        positional.push(arg);
    }

    // Positional fallback: alpha-sweep.ts [top] [population] [generations]
    if (positional[0]) topN = toPositiveInt(positional[0], topN);
    if (positional[1]) population = toPositiveInt(positional[1], population, 10);
    if (positional[2]) generations = toPositiveInt(positional[2], generations);

    return {
        topN,
        interval,
        bars,
        freshnessHours,
        population,
        generations,
        eliteCount,
        mutationRate: Math.max(0, Math.min(1, mutationRate)),
        mutationSigma: Math.max(0.0001, mutationSigma),
        rangePercent: Math.max(0, rangePercent),
        minTrades: Math.max(0, minTrades),
        strategies: strategyKeys.length > 0 ? strategyKeys : [...DEFAULT_STRATEGIES],
        outFile,
        seed: Math.max(1, Math.floor(seed)),
        initialCapital: Math.max(1, initialCapital),
        positionSize: Math.max(0.0001, positionSize),
        commission: Math.max(0, commission),
        sizingMode,
        fixedTradeAmount: Math.max(0, fixedTradeAmount),
        executionModel,
        slippageBps: Math.max(0, slippageBps),
        allowSameBarExit,
        outputDir,
    };
}

function inferDirection(strategy: Strategy): TradeDirection {
    const direction = strategy.metadata?.direction;
    if (direction === "short" || direction === "both" || direction === "long") return direction;
    return "long";
}

function deriveSeed(baseSeed: number, symbol: string, strategyKey: string): number {
    const key = `${symbol}|${strategyKey}`;
    let hash = baseSeed >>> 0;
    for (let i = 0; i < key.length; i++) {
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) || 1;
}

function buildGeneticConfig(options: CliOptions, seed: number): GeneticOptimizerConfig {
    return {
        populationSize: options.population,
        generations: options.generations,
        eliteCount: Math.max(1, Math.min(options.eliteCount, options.population)),
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

async function runAlphaSweep(options: CliOptions): Promise<void> {
    const selectedStrategies = options.strategies
        .map((key) => ({ key, strategy: (strategies as Record<string, Strategy>)[key] }))
        .filter((item) => Boolean(item.strategy));

    if (selectedStrategies.length === 0) {
        throw new Error("[AlphaSweep] No valid strategies provided.");
    }

    const invalid = options.strategies.filter((key) => !(key in strategies));
    if (invalid.length > 0) {
        console.warn(`[AlphaSweep] Skipping unknown strategy keys: ${invalid.join(", ")}`);
    }

    const market = await ensureUniversalMarketData({
        topN: options.topN,
        interval: options.interval,
        bars: options.bars,
        freshnessHours: options.freshnessHours,
        outputDir: options.outputDir,
    });

    if (market.datasets.length === 0) {
        throw new Error("[AlphaSweep] No market datasets available after universal loader run.");
    }

    const totalHunts = market.datasets.length * selectedStrategies.length;
    let completedHunts = 0;
    const symbolReports: AlphaSymbolReport[] = [];
    const startedAt = Date.now();

    for (const dataset of market.datasets) {
        const raw = JSON.parse(fs.readFileSync(dataset.filePath, "utf8"));
        const parsedData = parseOhlcvDataFile(raw);
        const data = trimToClosedCandles(parsedData.bars, dataset.interval);
        if (data.length < 200) {
            console.warn(`[AlphaSweep] Skipping ${dataset.symbol}: not enough closed bars (${data.length}).`);
            continue;
        }

        const hunts: AlphaHuntResult[] = [];
        for (const item of selectedStrategies) {
            const strategySeed = deriveSeed(options.seed, dataset.symbol, item.key);
            const backtestSettings = resolveBacktestSettingsFromRaw({
                tradeDirection: inferDirection(item.strategy),
                executionModel: options.executionModel,
                allowSameBarExit: options.allowSameBarExit,
                slippageBps: options.slippageBps,
            } as BacktestSettings, {
                coerceWithoutUiToggles: true,
            });
            const config = buildGeneticConfig(options, strategySeed);

            const hunt = await runGeneticOptimization({
                strategyKey: item.key,
                strategy: item.strategy,
                data,
                backtestSettings,
                config,
            });

            hunts.push({
                strategyKey: item.key,
                elapsedMs: Number(hunt.elapsedMs.toFixed(2)),
                fitness: hunt.bestGenome.fitness,
                alphaGenome: hunt.bestGenome.params,
            });

            completedHunts += 1;
            console.log(
                `[AlphaSweep] ${completedHunts}/${totalHunts} ${dataset.symbol} ${item.key} -> score=${hunt.bestGenome.fitness.score.toFixed(6)} net=${hunt.bestGenome.fitness.netProfitPercent.toFixed(2)}%`
            );
        }

        hunts.sort((a, b) => b.fitness.score - a.fitness.score);
        symbolReports.push({
            rank: dataset.rank,
            symbol: dataset.symbol,
            interval: dataset.interval,
            quoteVolume: dataset.quoteVolume,
            bars: data.length,
            dataFile: dataset.filePath,
            hunts,
            winner: hunts.length > 0 ? hunts[0] : null,
        });
    }

    symbolReports.sort((a, b) => a.rank - b.rank);
    const winnersOnly = symbolReports
        .filter((report) => report.winner !== null)
        .map((report) => ({
            rank: report.rank,
            symbol: report.symbol,
            interval: report.interval,
            strategyKey: report.winner!.strategyKey,
            score: report.winner!.fitness.score,
            netProfitPercent: report.winner!.fitness.netProfitPercent,
            sharpeRatio: report.winner!.fitness.sharpeRatio,
            maxDrawdownPercent: report.winner!.fitness.maxDrawdownPercent,
            totalTrades: report.winner!.fitness.totalTrades,
            alphaGenome: report.winner!.alphaGenome,
        }));

    const report = {
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        config: {
            topN: options.topN,
            interval: options.interval,
            bars: options.bars,
            freshnessHours: options.freshnessHours,
            strategies: selectedStrategies.map((s) => s.key),
            population: options.population,
            generations: options.generations,
            eliteCount: options.eliteCount,
            mutationRate: options.mutationRate,
            mutationSigma: options.mutationSigma,
            rangePercent: options.rangePercent,
            minTrades: options.minTrades,
        },
        market: {
            fetchedDatasets: market.datasets.length,
            fetchedNow: market.datasets.filter((d) => d.status === "fetched").length,
            reusedCached: market.datasets.filter((d) => d.status === "cached").length,
        },
        winners: winnersOnly,
        symbols: symbolReports,
    };

    fs.writeFileSync(options.outFile, JSON.stringify(report, null, 2), "utf8");
    console.log(`[AlphaSweep] Wrote report: ${options.outFile}`);
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printUsage();
        return;
    }
    await runAlphaSweep(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`alpha-sweep failed: ${message}`);
        process.exitCode = 1;
    });
}
