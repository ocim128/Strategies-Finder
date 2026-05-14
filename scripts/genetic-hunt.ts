import fs from "node:fs";
import path from "node:path";

import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import { runGeneticOptimization, type GeneticOptimizerConfig } from "../lib/finder/genetic-optimizer";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { CAPITAL_DEFAULTS, resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { strategies } from "../lib/strategies/library";
import type {
    BacktestSettings,
    ExecutionModel,
    OHLCVData,
    Strategy,
    TradeDirection,
} from "../lib/types/strategies";
import { toBoolean, toFinite, toPositiveInt } from "./lib/cli-args";
import { parseOhlcvDataFile, type ParsedOhlcvDataFile } from "./lib/ohlcv-file";

type CliOptions = {
    strategyKey: string;
    symbol: string;
    interval: string;
    dataPath?: string;
    bars: number;
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
    tradeDirection?: TradeDirection;
    executionModel: ExecutionModel;
    slippageBps: number;
    allowSameBarExit: boolean;
};

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run genetic:hunt -- --strategy <key> --symbol <symbol> --interval <interval>",
        "",
        "Example:",
        "  npm run genetic:hunt -- --strategy bear_hunter_v5 --symbol SOLUSDT --interval 15m",
        "",
        "Options:",
        "  --data <path>",
        "  --bars <n> (default: 8000)",
        "  --population <n> (default: 100)",
        "  --generations <n> (default: 50)",
        "  --elite <n> (default: 5)",
        "  --mutation-rate <0..1> (default: 0.12)",
        "  --mutation-sigma <ratio> (default: 0.12)",
        "  --range <percent> (default: 35)",
        "  --seed <int> (default: 1337)",
        "  --min-trades <n> (default: 20)",
        "  --initial-capital <n> (default: 10000)",
        "  --position-size <n> (default: 100)",
        "  --commission <percent> (default: 0.1)",
        "  --sizing <percent|fixed> (default: percent)",
        "  --fixed-trade-amount <n> (default: 1000)",
        "  --direction <long|short|both|combined>",
        "  --execution <signal_close|next_open|next_close> (default: signal_close)",
        "  --slippage-bps <n> (default: 0)",
        "  --allow-same-bar-exit <true|false> (default: true)",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
    let strategyKey = "";
    let symbol = "";
    let interval = "";
    let dataPath: string | undefined;
    let bars = 8000;
    let population = 100;
    let generations = 50;
    let eliteCount = 5;
    let mutationRate = 0.12;
    let mutationSigma = 0.12;
    let rangePercent = 35;
    let seed = 1337;
    let minTrades = 20;
    let initialCapital = Number(CAPITAL_DEFAULTS.initialCapital);
    let positionSize = Number(CAPITAL_DEFAULTS.positionSize);
    let commission = Number(CAPITAL_DEFAULTS.commission);
    let sizingMode: "percent" | "fixed" = "percent";
    let fixedTradeAmount = Number(CAPITAL_DEFAULTS.fixedTradeAmount);
    let tradeDirection: TradeDirection | undefined;
    let executionModel: ExecutionModel = "signal_close";
    let slippageBps = 0;
    let allowSameBarExit = true;
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
                bars,
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
                slippageBps,
                allowSameBarExit,
            };
        }
        if (arg === "--strategy") { strategyKey = String(next ?? "").trim(); i++; continue; }
        if (arg === "--symbol") { symbol = String(next ?? "").trim().toUpperCase(); i++; continue; }
        if (arg === "--interval") { interval = String(next ?? "").trim(); i++; continue; }
        if (arg === "--data") { dataPath = String(next ?? "").trim(); i++; continue; }
        if (arg === "--bars") { bars = toPositiveInt(next, bars, 500); i++; continue; }
        if (arg === "--population") { population = toPositiveInt(next, population); i++; continue; }
        if (arg === "--generations") { generations = toPositiveInt(next, generations); i++; continue; }
        if (arg === "--elite") { eliteCount = toPositiveInt(next, eliteCount); i++; continue; }
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
        if (arg === "--direction") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "long" || value === "short" || value === "both" || value === "combined") {
                tradeDirection = value;
            }
            i++;
            continue;
        }
        if (arg === "--execution") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "signal_close" || value === "next_open" || value === "next_close") {
                executionModel = value;
            }
            i++;
            continue;
        }
        if (arg === "--slippage-bps") { slippageBps = toFinite(next, slippageBps); i++; continue; }
        if (arg === "--allow-same-bar-exit") { allowSameBarExit = toBoolean(next, allowSameBarExit); i++; continue; }
        positional.push(arg);
    }

    // Positional fallback for shells/npm environments that strip option flags:
    // genetic-hunt.ts <strategy> <symbol> <interval> [population] [generations] [bars]
    if (!strategyKey && positional[0]) strategyKey = positional[0].trim();
    if (!symbol && positional[1]) symbol = positional[1].trim().toUpperCase();
    if (!interval && positional[2]) interval = positional[2].trim();
    if (positional[3]) population = toPositiveInt(positional[3], population);
    if (positional[4]) generations = toPositiveInt(positional[4], generations);
    if (positional[5]) bars = toPositiveInt(positional[5], bars, 500);

    if (!dataPath && positional[6] && fs.existsSync(path.resolve(positional[6]))) {
        dataPath = positional[6];
    }

    return {
        strategyKey,
        symbol,
        interval,
        dataPath,
        bars,
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
        tradeDirection,
        executionModel,
        slippageBps,
        allowSameBarExit,
    };
}

function readDataFile(filePath: string): ParsedOhlcvDataFile {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parseOhlcvDataFile(raw);
}

function inferDirection(strategy: Strategy, requested: TradeDirection | undefined): TradeDirection {
    if (requested) return requested;
    const meta = strategy.metadata?.direction;
    if (meta === "long" || meta === "short" || meta === "both") return meta;
    return "long";
}

function buildGeneticConfig(opts: CliOptions): GeneticOptimizerConfig {
    return {
        populationSize: Math.max(10, opts.population),
        generations: Math.max(1, opts.generations),
        eliteCount: Math.max(1, opts.eliteCount),
        mutationRate: Math.max(0, Math.min(1, opts.mutationRate)),
        mutationSigma: Math.max(0.0001, opts.mutationSigma),
        rangePercent: Math.max(0, opts.rangePercent),
        seed: Math.max(1, Math.floor(opts.seed)),
        tournamentSize: 2,
        backtest: {
            initialCapital: Math.max(1, opts.initialCapital),
            positionSize: Math.max(0.0001, opts.positionSize),
            commission: Math.max(0, opts.commission),
            sizingMode: opts.sizingMode,
            fixedTradeAmount: Math.max(0, opts.fixedTradeAmount),
            minTrades: Math.max(0, opts.minTrades),
        },
    };
}

async function loadDataset(opts: CliOptions): Promise<OHLCVData[]> {
    if (opts.dataPath) {
        const fromFile = readDataFile(path.resolve(opts.dataPath));
        if (fromFile.bars.length === 0) {
            throw new Error(`[Genetic] Data file has no valid candles: ${opts.dataPath}`);
        }
        return fromFile.bars;
    }

    const localPath = path.resolve("price-data", `${opts.symbol}-${opts.interval}.json`);
    if (fs.existsSync(localPath)) {
        const fromLocal = readDataFile(localPath);
        if (fromLocal.bars.length > 0) {
            return fromLocal.bars;
        }
    }

    const fetched = await fetchBinanceDataWithLimit(opts.symbol, opts.interval, opts.bars);
    if (!Array.isArray(fetched) || fetched.length === 0) {
        throw new Error(`[Genetic] Failed to fetch ${opts.symbol} ${opts.interval} data from Binance.`);
    }

    const payload = {
        symbol: opts.symbol,
        interval: opts.interval,
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
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(payload, null, 2));
    return fetched;
}

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
        printUsage();
        return;
    }

    if (!parsed.strategyKey || !parsed.symbol || !parsed.interval) {
        printUsage();
        throw new Error("[Genetic] Missing required args: --strategy, --symbol, --interval.");
    }

    const strategy = (strategies as Record<string, Strategy>)[parsed.strategyKey];
    if (!strategy) {
        const available = Object.keys(strategies).sort().join(", ");
        throw new Error(`[Genetic] Strategy not found: ${parsed.strategyKey}\nAvailable: ${available}`);
    }

    const rawData = await loadDataset(parsed);
    const data = trimToClosedCandles(rawData, parsed.interval);
    if (data.length < 200) {
        throw new Error(`[Genetic] Not enough closed candles for optimization (${data.length}).`);
    }

    const settings = resolveBacktestSettingsFromRaw({
        tradeDirection: inferDirection(strategy, parsed.tradeDirection),
        executionModel: parsed.executionModel,
        allowSameBarExit: parsed.allowSameBarExit,
        slippageBps: parsed.slippageBps,
    } as BacktestSettings, {
        coerceWithoutUiToggles: true,
    });

    const config = buildGeneticConfig(parsed);
    console.log(`[Genetic] Strategy=${parsed.strategyKey} Symbol=${parsed.symbol} Interval=${parsed.interval} Bars=${data.length}`);
    console.log(`[Genetic] Population=${config.populationSize} Generations=${config.generations} Elite=${config.eliteCount} Seed=${config.seed}`);
    console.log(`[Genetic] MutationRate=${config.mutationRate} MutationSigma=${config.mutationSigma} Range=${config.rangePercent}%`);

    const result = await runGeneticOptimization({
        strategyKey: parsed.strategyKey,
        strategy,
        data,
        backtestSettings: settings,
        config,
        onGeneration: (stats) => {
            const generationLabel = `${stats.generation + 1}/${config.generations}`;
            const score = Number.isFinite(stats.bestScore) ? stats.bestScore.toFixed(6) : "NaN";
            console.log(
                `[Gen ${generationLabel}] score=${score} net=${stats.bestNetProfitPercent.toFixed(2)}% sharpe=${stats.bestSharpeRatio.toFixed(3)} dd=${stats.bestDrawdownPercent.toFixed(2)}%`
            );
        },
    });

    const alpha = result.bestGenome;
    const summary = {
        strategy: parsed.strategyKey,
        symbol: parsed.symbol,
        interval: parsed.interval,
        bars: data.length,
        elapsedMs: Number(result.elapsedMs.toFixed(2)),
        elapsedSec: Number((result.elapsedMs / 1000).toFixed(2)),
        fitness: alpha.fitness,
        alphaGenome: alpha.params,
    };

    console.log("[Genetic] Alpha Genome:");
    console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
