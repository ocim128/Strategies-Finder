import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { runGeneticOptimization, type GeneticOptimizerConfig } from "../lib/finder/genetic-optimizer";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { strategies } from "../lib/strategies/library";
import { ensureUniversalMarketData } from "./universal-market-loader";
import { parseArgs as parseVerifyArgs, runVerification as runVerifyAlphaReport } from "./verify-alpha";
import type {
    BacktestSettings,
    ExecutionModel,
    Strategy,
    TradeDirection,
    TradeFilterMode,
} from "../lib/types/strategies";
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
    seedsPerPair: number;
    baseSeed: number;
    outFile: string;
    verifiedOutFile: string;
    autoVerify: boolean;
    verifyMaxCandidates: number;
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
};

type SeedRun = {
    seed: number;
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

type AggregatedFitness = {
    robustScore: number;
    medianScore: number;
    medianNetProfitPercent: number;
    medianSharpeRatio: number;
    medianMaxDrawdownPercent: number;
    medianTotalTrades: number;
    worstMaxDrawdownPercent: number;
};

type HuntResult = {
    strategyKey: string;
    elapsedMs: number;
    seeds: number[];
    seedRuns: SeedRun[];
    aggregate: AggregatedFitness;
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

type SymbolReport = {
    rank: number;
    symbol: string;
    interval: string;
    quoteVolume: number;
    bars: number;
    dataFile: string;
    hunts: HuntResult[];
    winner: HuntResult | null;
};

const DEFAULT_STRATEGIES = ["bear_hunter_v5", "meta_harvest_v2"];

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run hunt:massive",
        "",
        "Optional flags:",
        "  --top <n>                    default 20",
        "  --interval <value>           default 15m",
        "  --bars <n>                   default 10000",
        "  --fresh-hours <n>            default 4",
        "  --population <n>             default 100",
        "  --generations <n>            default 50",
        "  --elite <n>                  default 5",
        "  --mutation-rate <0..1>       default 0.12",
        "  --mutation-sigma <ratio>     default 0.12",
        "  --range <percent>            default 35",
        "  --min-trades <n>             default 20",
        "  --strategies <k1,k2,...>     default bear_hunter_v5,meta_harvest_v2",
        "  --seeds <n>                  default 5",
        "  --seed <n>                   default 2026",
        "  --out <file>                 default alpha_report.json",
        "  --verified-out <file>        default verified_alpha.json",
        "  --no-verify                  skip automatic verify:alpha",
        "  --verify-max-candidates <n>  pass-through to verify:alpha",
        "",
        "Positional fallback:",
        "  hunt:massive [top] [generations] [seeds]",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
    let topN = 20;
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
    let seedsPerPair = 5;
    let baseSeed = 2026;
    let outFile = path.resolve("alpha_report.json");
    let verifiedOutFile = path.resolve("verified_alpha.json");
    let autoVerify = true;
    let verifyMaxCandidates = 0;
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
                seedsPerPair,
                baseSeed,
                outFile,
                verifiedOutFile,
                autoVerify,
                verifyMaxCandidates,
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
        if (arg === "--seeds") { seedsPerPair = toPositiveInt(next, seedsPerPair); i++; continue; }
        if (arg === "--seed") { baseSeed = toPositiveInt(next, baseSeed); i++; continue; }
        if (arg === "--out") { outFile = path.resolve(String(next ?? "alpha_report.json")); i++; continue; }
        if (arg === "--verified-out") { verifiedOutFile = path.resolve(String(next ?? "verified_alpha.json")); i++; continue; }
        if (arg === "--no-verify") { autoVerify = false; continue; }
        if (arg === "--auto-verify") { autoVerify = toBoolean(next, autoVerify); i++; continue; }
        if (arg === "--verify-max-candidates") { verifyMaxCandidates = toPositiveInt(next, verifyMaxCandidates, 0); i++; continue; }
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
        positional.push(arg);
    }

    if (positional[0]) topN = toPositiveInt(positional[0], topN);
    if (positional[1]) generations = toPositiveInt(positional[1], generations);
    if (positional[2]) seedsPerPair = toPositiveInt(positional[2], seedsPerPair);

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
        seedsPerPair: Math.max(1, seedsPerPair),
        baseSeed: Math.max(1, Math.floor(baseSeed)),
        outFile,
        verifiedOutFile,
        autoVerify,
        verifyMaxCandidates: Math.max(0, verifyMaxCandidates),
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
    };
}

function inferDirection(strategy: Strategy): TradeDirection {
    const direction = strategy.metadata?.direction;
    if (direction === "short" || direction === "both" || direction === "long") return direction;
    return "long";
}

function hashString(baseSeed: number, value: string): number {
    let hash = baseSeed >>> 0;
    for (let i = 0; i < value.length; i++) {
        hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    }
    return hash >>> 0;
}

function nextSeed(state: number): number {
    let x = state || 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
}

function buildPairSeeds(baseSeed: number, symbol: string, strategyKey: string, count: number): number[] {
    const seen = new Set<number>();
    const seeds: number[] = [];
    let state = hashString(baseSeed, `${symbol}|${strategyKey}|massive`);

    while (seeds.length < count) {
        state = nextSeed(state);
        const candidate = (state % 2147483646) + 1;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        seeds.push(candidate);
    }
    return seeds;
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

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateSeedRuns(seedRuns: SeedRun[]): AggregatedFitness {
    const scoreSeries = seedRuns.map((run) => run.fitness.score).filter(Number.isFinite);
    const netSeries = seedRuns.map((run) => run.fitness.netProfitPercent).filter(Number.isFinite);
    const sharpeSeries = seedRuns.map((run) => run.fitness.sharpeRatio).filter(Number.isFinite);
    const ddSeries = seedRuns.map((run) => run.fitness.maxDrawdownPercent).filter(Number.isFinite);
    const tradeSeries = seedRuns.map((run) => run.fitness.totalTrades).filter(Number.isFinite);

    const medianScore = median(scoreSeries);
    const medianNetProfitPercent = median(netSeries);
    const medianSharpeRatio = median(sharpeSeries);
    const medianMaxDrawdownPercent = median(ddSeries);
    const medianTotalTrades = median(tradeSeries);
    const worstMaxDrawdownPercent = ddSeries.length > 0 ? Math.max(...ddSeries) : 0;
    const stability = 1 / (1 + (medianMaxDrawdownPercent / 25));
    const robustScore =
        medianNetProfitPercent > 0 && medianSharpeRatio > 0
            ? (medianNetProfitPercent / 100) * medianSharpeRatio * stability
            : medianScore - Math.abs(Math.min(0, medianNetProfitPercent / 100)) * 0.25;

    return {
        robustScore,
        medianScore,
        medianNetProfitPercent,
        medianSharpeRatio,
        medianMaxDrawdownPercent,
        medianTotalTrades,
        worstMaxDrawdownPercent,
    };
}

function pickRepresentativeRun(seedRuns: SeedRun[], aggregate: AggregatedFitness): SeedRun {
    if (seedRuns.length === 1) return seedRuns[0];

    let best = seedRuns[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const run of seedRuns) {
        const distance =
            Math.abs(run.fitness.score - aggregate.medianScore) +
            Math.abs(run.fitness.netProfitPercent - aggregate.medianNetProfitPercent) * 0.02 +
            Math.abs(run.fitness.maxDrawdownPercent - aggregate.medianMaxDrawdownPercent) * 0.02;
        if (distance < bestDistance) {
            best = run;
            bestDistance = distance;
        }
    }
    return best;
}

function toHuntResult(strategyKey: string, seeds: number[], seedRuns: SeedRun[]): HuntResult {
    const aggregate = aggregateSeedRuns(seedRuns);
    const representative = pickRepresentativeRun(seedRuns, aggregate);
    return {
        strategyKey,
        elapsedMs: Number(seedRuns.reduce((acc, run) => acc + run.elapsedMs, 0).toFixed(2)),
        seeds,
        seedRuns,
        aggregate,
        fitness: {
            score: aggregate.robustScore,
            netProfitPercent: aggregate.medianNetProfitPercent,
            sharpeRatio: aggregate.medianSharpeRatio,
            stability: 1 / (1 + (aggregate.medianMaxDrawdownPercent / 25)),
            maxDrawdownPercent: aggregate.medianMaxDrawdownPercent,
            totalTrades: aggregate.medianTotalTrades,
        },
        alphaGenome: representative.alphaGenome,
    };
}

async function runVerifyAlpha(options: CliOptions): Promise<void> {
    const verifyArgs = [
        "--in",
        options.outFile,
        "--out",
        options.verifiedOutFile,
        "--verify-seeds",
        "5",
        "--min-pass-count",
        "4",
    ];

    if (options.verifyMaxCandidates > 0) {
        verifyArgs.push("--max-candidates", String(options.verifyMaxCandidates));
    }

    const parsed = parseVerifyArgs(verifyArgs);
    if (parsed.help) {
        throw new Error("[MassiveSweep] verify:alpha argument parsing returned help mode.");
    }

    await runVerifyAlphaReport(parsed);
}

async function runMassiveSweep(options: CliOptions): Promise<void> {
    const selectedStrategies = options.strategies
        .map((key) => ({ key, strategy: (strategies as Record<string, Strategy>)[key] }))
        .filter((item) => Boolean(item.strategy));

    if (selectedStrategies.length === 0) {
        throw new Error("[MassiveSweep] No valid strategy keys were provided.");
    }

    const invalid = options.strategies.filter((key) => !(key in strategies));
    if (invalid.length > 0) {
        console.warn(`[MassiveSweep] Skipping unknown strategy keys: ${invalid.join(", ")}`);
    }

    const market = await ensureUniversalMarketData({
        topN: options.topN,
        interval: options.interval,
        bars: options.bars,
        freshnessHours: options.freshnessHours,
        outputDir: options.dataDir,
    });

    if (market.datasets.length === 0) {
        throw new Error("[MassiveSweep] No market datasets are available after data load.");
    }

    const huntsPerDataset = selectedStrategies.length;
    const totalSeedRuns = market.datasets.length * huntsPerDataset * options.seedsPerPair;
    let completedSeedRuns = 0;
    const symbolReports: SymbolReport[] = [];
    const startedAt = Date.now();

    for (const dataset of market.datasets) {
        const raw = JSON.parse(fs.readFileSync(dataset.filePath, "utf8"));
        const parsedData = parseOhlcvDataFile(raw);
        const data = trimToClosedCandles(parsedData.bars, dataset.interval);
        if (data.length < 300) {
            console.warn(`[MassiveSweep] Skipping ${dataset.symbol}: insufficient closed bars (${data.length}).`);
            continue;
        }

        const hunts: HuntResult[] = [];

        for (const item of selectedStrategies) {
            const settings = resolveBacktestSettingsFromRaw({
                tradeDirection: inferDirection(item.strategy),
                executionModel: options.executionModel,
                tradeFilterMode: options.tradeFilterMode,
                allowSameBarExit: options.allowSameBarExit,
                slippageBps: options.slippageBps,
            } as BacktestSettings, {
                coerceWithoutUiToggles: true,
            });

            const seeds = buildPairSeeds(options.baseSeed, dataset.symbol, item.key, options.seedsPerPair);
            const seedRuns: SeedRun[] = [];

            for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
                const seed = seeds[seedIndex];
                const config = buildGeneticConfig(options, seed);
                const outcome = await runGeneticOptimization({
                    strategyKey: item.key,
                    strategy: item.strategy,
                    data,
                    backtestSettings: settings,
                    config,
                });

                const run: SeedRun = {
                    seed,
                    elapsedMs: Number(outcome.elapsedMs.toFixed(2)),
                    fitness: {
                        score: outcome.bestGenome.fitness.score,
                        netProfitPercent: outcome.bestGenome.fitness.netProfitPercent,
                        sharpeRatio: outcome.bestGenome.fitness.sharpeRatio,
                        stability: outcome.bestGenome.fitness.stability,
                        maxDrawdownPercent: outcome.bestGenome.fitness.maxDrawdownPercent,
                        totalTrades: outcome.bestGenome.fitness.totalTrades,
                    },
                    alphaGenome: outcome.bestGenome.params,
                };
                seedRuns.push(run);

                completedSeedRuns += 1;
                console.log(
                    `[MassiveSweep] ${completedSeedRuns}/${totalSeedRuns} ${dataset.symbol} ${item.key} seed=${seed} score=${run.fitness.score.toFixed(6)} net=${run.fitness.netProfitPercent.toFixed(2)}%`
                );
            }

            hunts.push(toHuntResult(item.key, seeds, seedRuns));
        }

        hunts.sort((a, b) => b.aggregate.robustScore - a.aggregate.robustScore);
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

    const winners = symbolReports
        .filter((report) => report.winner !== null)
        .map((report) => ({
            rank: report.rank,
            symbol: report.symbol,
            interval: report.interval,
            strategyKey: report.winner!.strategyKey,
            score: report.winner!.aggregate.robustScore,
            netProfitPercent: report.winner!.aggregate.medianNetProfitPercent,
            sharpeRatio: report.winner!.aggregate.medianSharpeRatio,
            maxDrawdownPercent: report.winner!.aggregate.medianMaxDrawdownPercent,
            totalTrades: report.winner!.aggregate.medianTotalTrades,
            alphaGenome: report.winner!.alphaGenome,
            seeds: report.winner!.seeds,
        }));

    const report = {
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        config: {
            mode: "massive",
            topN: options.topN,
            interval: options.interval,
            bars: options.bars,
            freshnessHours: options.freshnessHours,
            strategies: selectedStrategies.map((item) => item.key),
            population: options.population,
            generations: options.generations,
            eliteCount: options.eliteCount,
            mutationRate: options.mutationRate,
            mutationSigma: options.mutationSigma,
            rangePercent: options.rangePercent,
            minTrades: options.minTrades,
            seedsPerPair: options.seedsPerPair,
            baseSeed: options.baseSeed,
            executionModel: options.executionModel,
            tradeFilterMode: options.tradeFilterMode,
            slippageBps: options.slippageBps,
            allowSameBarExit: options.allowSameBarExit,
        },
        market: {
            requestedTopN: options.topN,
            loadedDatasets: market.datasets.length,
            fetchedNow: market.datasets.filter((item) => item.status === "fetched").length,
            reusedCached: market.datasets.filter((item) => item.status === "cached").length,
            interval: options.interval,
            barsPerDataset: options.bars,
        },
        winners,
        symbols: symbolReports,
    };

    fs.writeFileSync(options.outFile, JSON.stringify(report, null, 2), "utf8");
    console.log(`[MassiveSweep] Wrote alpha report: ${options.outFile}`);

    if (options.autoVerify) {
        console.log("[MassiveSweep] Running verify:alpha...");
        await runVerifyAlpha(options);
        console.log(`[MassiveSweep] Wrote verified report: ${options.verifiedOutFile}`);
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    await runMassiveSweep(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`massive-alpha-sweep failed: ${message}`);
        process.exitCode = 1;
    });
}
