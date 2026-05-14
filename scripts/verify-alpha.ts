import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { runGeneticOptimization, type GeneticOptimizerConfig } from "../lib/finder/genetic-optimizer";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { precomputeIndicators, runBacktestCompact } from "../lib/strategies";
import { strategies } from "../lib/strategies/library";
import type {
    BacktestResult,
    BacktestSettings,
    ExecutionModel,
    OHLCVData,
    Strategy,
    StrategyParams,
    TradeDirection,
} from "../lib/types/strategies";
import { toBoolean, toFinite, toPositiveInt } from "./lib/cli-args";
import { parseOhlcvBars } from "./lib/ohlcv-file";

export type VerifyAlphaCliOptions = {
    inputFile: string;
    outFile: string;
    trainRatio: number;
    dropThresholdPercent: number;
    maxDrawdownPercent: number;
    tortureSlippageBps: number;
    commissionPercent: number;
    initialCapital: number;
    positionSize: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    minTrades: number;
    population: number;
    generations: number;
    eliteCount: number;
    mutationRate: number;
    mutationSigma: number;
    rangePercent: number;
    executionModel: ExecutionModel;
    allowSameBarExit: boolean;
    maxCandidates: number;
    seed: number;
    verificationSeeds: number;
    minPassCount: number;
    dataDir: string;
};

type AlphaWinner = {
    rank?: number;
    symbol?: string;
    interval?: string;
    strategyKey?: string;
    score?: number;
    netProfitPercent?: number;
    sharpeRatio?: number;
    maxDrawdownPercent?: number;
    totalTrades?: number;
    alphaGenome?: Record<string, number>;
};

type AlphaSymbolEntry = {
    symbol?: string;
    interval?: string;
    quoteVolume?: number;
    bars?: number;
    dataFile?: string;
};

type AlphaReport = {
    generatedAt?: string;
    winners?: AlphaWinner[];
    symbols?: AlphaSymbolEntry[];
};

type CandidateValidation = {
    seed: number;
    symbol: string;
    strategyKey: string;
    interval: string;
    quoteVolume: number;
    bars: number;
    dataFile: string;
    trainBars: number;
    testBars: number;
    optimizedParams: Record<string, number> | null;
    walkForward: {
        trainNetProfitPercent: number;
        trainSharpeRatio: number;
        testNetProfitPercent: number;
        testSharpeRatio: number;
        testMaxDrawdownPercent: number;
        testTotalTrades: number;
        dropPercent: number;
        pass: boolean;
    };
    torture: {
        commissionPercent: number;
        slippageBps: number;
        netProfitPercent: number;
        maxDrawdownPercent: number;
        pass: boolean;
    };
    stability: {
        worstMaxDrawdownPercent: number;
        thresholdPercent: number;
        pass: boolean;
    };
    score: number;
    passed: boolean;
    failReasons: string[];
};

type CandidateRobustValidation = {
    symbol: string;
    strategyKey: string;
    interval: string;
    quoteVolume: number;
    bars: number;
    dataFile: string;
    passCount: number;
    totalRuns: number;
    robustnessScore: string;
    seeds: number[];
    passed: boolean;
    representative: CandidateValidation;
    runs: CandidateValidation[];
};

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run verify:alpha",
        "",
        "Optional flags:",
        "  --in <file>                  default alpha_report.json",
        "  --out <file>                 default verified_alpha.json",
        "  --train-ratio <0..1>         default 0.7",
        "  --drop-threshold <percent>   default 50",
        "  --max-dd <percent>           default 25",
        "  --torture-slippage <bps>     default 8",
        "  --commission <percent>       default 0.1",
        "  --initial-capital <n>        default 10000",
        "  --position-size <n>          default 100",
        "  --sizing <percent|fixed>     default percent",
        "  --fixed-trade-amount <n>     default 1000",
        "  --min-trades <n>             default 20",
        "  --population <n>             default 40",
        "  --generations <n>            default 12",
        "  --elite <n>                  default 4",
        "  --mutation-rate <0..1>       default 0.12",
        "  --mutation-sigma <ratio>     default 0.12",
        "  --range <percent>            default 35",
        "  --max-candidates <n>         default 0 (all)",
        "  --seed <n>                   default 2026",
        "  --verify-seeds <n>           default 5",
        "  --min-pass-count <n>         default 4",
    ].join("\n"));
}

export function parseArgs(argv: string[]): VerifyAlphaCliOptions & { help?: boolean } {
    let inputFile = path.resolve("alpha_report.json");
    let outFile = path.resolve("verified_alpha.json");
    let trainRatio = 0.7;
    let dropThresholdPercent = 50;
    let maxDrawdownPercent = 25;
    let tortureSlippageBps = 8;
    let commissionPercent = Number(CAPITAL_DEFAULTS.commission);
    let initialCapital = Number(CAPITAL_DEFAULTS.initialCapital);
    let positionSize = Number(CAPITAL_DEFAULTS.positionSize);
    let sizingMode: "percent" | "fixed" = "percent";
    let fixedTradeAmount = Number(CAPITAL_DEFAULTS.fixedTradeAmount);
    let minTrades = 20;
    let population = 40;
    let generations = 12;
    let eliteCount = 4;
    let mutationRate = 0.12;
    let mutationSigma = 0.12;
    let rangePercent = 35;
    let executionModel: ExecutionModel = "signal_close";
    let allowSameBarExit = true;
    let maxCandidates = 0;
    let seed = 2026;
    let verificationSeeds = 5;
    let minPassCount = 4;
    let dataDir = path.resolve("price-data", "universal");
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") return {
            help: true,
            inputFile, outFile, trainRatio, dropThresholdPercent, maxDrawdownPercent, tortureSlippageBps,
            commissionPercent, initialCapital, positionSize, sizingMode, fixedTradeAmount, minTrades,
            population, generations, eliteCount, mutationRate, mutationSigma, rangePercent,
            executionModel, allowSameBarExit, maxCandidates, seed, verificationSeeds, minPassCount, dataDir,
        };
        if (arg === "--in") { inputFile = path.resolve(String(next ?? inputFile)); i++; continue; }
        if (arg === "--out") { outFile = path.resolve(String(next ?? outFile)); i++; continue; }
        if (arg === "--train-ratio") { trainRatio = toFinite(next, trainRatio); i++; continue; }
        if (arg === "--drop-threshold") { dropThresholdPercent = toFinite(next, dropThresholdPercent); i++; continue; }
        if (arg === "--max-dd") { maxDrawdownPercent = toFinite(next, maxDrawdownPercent); i++; continue; }
        if (arg === "--torture-slippage") { tortureSlippageBps = toFinite(next, tortureSlippageBps); i++; continue; }
        if (arg === "--commission") { commissionPercent = toFinite(next, commissionPercent); i++; continue; }
        if (arg === "--initial-capital") { initialCapital = toFinite(next, initialCapital); i++; continue; }
        if (arg === "--position-size") { positionSize = toFinite(next, positionSize); i++; continue; }
        if (arg === "--sizing") {
            const mode = String(next ?? "").trim().toLowerCase();
            sizingMode = mode === "fixed" ? "fixed" : "percent";
            i++;
            continue;
        }
        if (arg === "--fixed-trade-amount") { fixedTradeAmount = toFinite(next, fixedTradeAmount); i++; continue; }
        if (arg === "--min-trades") { minTrades = toPositiveInt(next, minTrades, 0); i++; continue; }
        if (arg === "--population") { population = toPositiveInt(next, population, 10); i++; continue; }
        if (arg === "--generations") { generations = toPositiveInt(next, generations, 1); i++; continue; }
        if (arg === "--elite") { eliteCount = toPositiveInt(next, eliteCount, 1); i++; continue; }
        if (arg === "--mutation-rate") { mutationRate = toFinite(next, mutationRate); i++; continue; }
        if (arg === "--mutation-sigma") { mutationSigma = toFinite(next, mutationSigma); i++; continue; }
        if (arg === "--range") { rangePercent = toFinite(next, rangePercent); i++; continue; }
        if (arg === "--execution") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "signal_close" || value === "next_open" || value === "next_close") executionModel = value;
            i++;
            continue;
        }
        if (arg === "--allow-same-bar-exit") { allowSameBarExit = toBoolean(next, allowSameBarExit); i++; continue; }
        if (arg === "--max-candidates") { maxCandidates = toPositiveInt(next, maxCandidates, 0); i++; continue; }
        if (arg === "--seed") { seed = toPositiveInt(next, seed); i++; continue; }
        if (arg === "--verify-seeds") { verificationSeeds = toPositiveInt(next, verificationSeeds, 1); i++; continue; }
        if (arg === "--min-pass-count") { minPassCount = toPositiveInt(next, minPassCount, 1); i++; continue; }
        if (arg === "--data-dir") { dataDir = path.resolve(String(next ?? dataDir)); i++; continue; }
        positional.push(arg);
    }

    if (positional[0]) inputFile = path.resolve(positional[0]);
    if (positional[1]) outFile = path.resolve(positional[1]);

    const verificationSeedsSafe = Math.max(1, verificationSeeds);
    const minPassCountSafe = Math.min(Math.max(1, minPassCount), verificationSeedsSafe);

    return {
        inputFile,
        outFile,
        trainRatio: Math.max(0.5, Math.min(0.9, trainRatio)),
        dropThresholdPercent: Math.max(0, dropThresholdPercent),
        maxDrawdownPercent: Math.max(1, maxDrawdownPercent),
        tortureSlippageBps: Math.max(0, tortureSlippageBps),
        commissionPercent: Math.max(0, commissionPercent),
        initialCapital: Math.max(100, initialCapital),
        positionSize: Math.max(0.0001, positionSize),
        sizingMode,
        fixedTradeAmount: Math.max(0, fixedTradeAmount),
        minTrades: Math.max(0, minTrades),
        population: Math.max(10, population),
        generations: Math.max(1, generations),
        eliteCount: Math.max(1, eliteCount),
        mutationRate: Math.max(0, Math.min(1, mutationRate)),
        mutationSigma: Math.max(0.0001, mutationSigma),
        rangePercent: Math.max(0, rangePercent),
        executionModel,
        allowSameBarExit,
        maxCandidates: Math.max(0, maxCandidates),
        seed: Math.max(1, seed),
        verificationSeeds: verificationSeedsSafe,
        minPassCount: minPassCountSafe,
        dataDir,
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

function buildVerificationSeeds(baseSeed: number, symbol: string, strategyKey: string, count: number): number[] {
    const seeds: number[] = [];
    const seen = new Set<number>();
    let cursor = deriveSeed(baseSeed, symbol, strategyKey);
    while (seeds.length < count) {
        cursor = Math.imul(cursor ^ 0x9e3779b9, 1664525) + 1013904223;
        const candidate = (cursor >>> 0) || 1;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        seeds.push(candidate);
    }
    return seeds;
}

function pickRepresentativeValidation(runs: CandidateValidation[]): CandidateValidation {
    const source = runs.filter((run) => run.passed);
    const pool = source.length > 0 ? source : runs;
    const sorted = pool.slice().sort((a, b) => a.score - b.score);
    const idx = Math.floor(sorted.length / 2);
    return sorted[Math.min(idx, sorted.length - 1)];
}

function buildGeneticConfig(options: VerifyAlphaCliOptions, seed: number, commissionPercent: number): GeneticOptimizerConfig {
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
            commission: commissionPercent,
            sizingMode: options.sizingMode,
            fixedTradeAmount: options.fixedTradeAmount,
            minTrades: options.minTrades,
        },
    };
}

function runBacktestForParams(
    strategy: Strategy,
    data: OHLCVData[],
    params: StrategyParams,
    commissionPercent: number,
    settings: BacktestSettings,
    options: VerifyAlphaCliOptions
): BacktestResult {
    const signals = strategy.execute(data, params);
    const precomputed = precomputeIndicators(data, settings);
    return runBacktestCompact(
        data,
        signals,
        options.initialCapital,
        options.positionSize,
        commissionPercent,
        settings,
        { mode: options.sizingMode, fixedTradeAmount: options.fixedTradeAmount },
        precomputed
    );
}

function getSymbolEntryMap(symbols: AlphaSymbolEntry[]): Map<string, AlphaSymbolEntry> {
    const map = new Map<string, AlphaSymbolEntry>();
    for (const symbol of symbols) {
        const key = String(symbol.symbol ?? "").trim().toUpperCase();
        if (!key) continue;
        map.set(key, symbol);
    }
    return map;
}

async function validateCandidate(
    winner: AlphaWinner,
    symbolEntry: AlphaSymbolEntry | undefined,
    options: VerifyAlphaCliOptions,
    verificationSeed: number
): Promise<CandidateValidation> {
    const symbol = String(winner.symbol ?? "").trim().toUpperCase();
    const interval = String(winner.interval ?? symbolEntry?.interval ?? "15m").trim() || "15m";
    const strategyKey = String(winner.strategyKey ?? "").trim();
    const quoteVolume = Number(symbolEntry?.quoteVolume ?? 0);
    const dataFile = path.resolve(
        String(symbolEntry?.dataFile ?? path.resolve(options.dataDir, `${symbol}-${interval}.json`))
    );

    const failReasons: string[] = [];
    if (!symbol || !strategyKey) {
        throw new Error("[VerifyAlpha] Invalid winner entry (missing symbol/strategyKey).");
    }
    const strategy = (strategies as Record<string, Strategy>)[strategyKey];
    if (!strategy) {
        failReasons.push("unknown_strategy");
    }
    if (!fs.existsSync(dataFile)) {
        failReasons.push("missing_data_file");
    }
    if (failReasons.length > 0) {
        return {
            seed: verificationSeed,
            symbol,
            strategyKey,
            interval,
            quoteVolume,
            bars: 0,
            dataFile,
            trainBars: 0,
            testBars: 0,
            optimizedParams: null,
            walkForward: { trainNetProfitPercent: 0, trainSharpeRatio: 0, testNetProfitPercent: 0, testSharpeRatio: 0, testMaxDrawdownPercent: 1000, testTotalTrades: 0, dropPercent: 1000, pass: false },
            torture: { commissionPercent: options.commissionPercent * 2, slippageBps: options.tortureSlippageBps, netProfitPercent: 0, maxDrawdownPercent: 1000, pass: false },
            stability: { worstMaxDrawdownPercent: 1000, thresholdPercent: options.maxDrawdownPercent, pass: false },
            score: Number.NEGATIVE_INFINITY,
            passed: false,
            failReasons,
        };
    }

    const raw = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const bars = trimToClosedCandles(parseOhlcvBars(raw), interval);
    if (bars.length < 300) {
        return {
            seed: verificationSeed,
            symbol,
            strategyKey,
            interval,
            quoteVolume,
            bars: bars.length,
            dataFile,
            trainBars: 0,
            testBars: 0,
            optimizedParams: null,
            walkForward: { trainNetProfitPercent: 0, trainSharpeRatio: 0, testNetProfitPercent: 0, testSharpeRatio: 0, testMaxDrawdownPercent: 1000, testTotalTrades: 0, dropPercent: 1000, pass: false },
            torture: { commissionPercent: options.commissionPercent * 2, slippageBps: options.tortureSlippageBps, netProfitPercent: 0, maxDrawdownPercent: 1000, pass: false },
            stability: { worstMaxDrawdownPercent: 1000, thresholdPercent: options.maxDrawdownPercent, pass: false },
            score: Number.NEGATIVE_INFINITY,
            passed: false,
            failReasons: ["insufficient_bars"],
        };
    }

    const split = Math.floor(bars.length * options.trainRatio);
    const trainData = bars.slice(0, split);
    const testData = bars.slice(split);
    if (trainData.length < 150 || testData.length < 100) {
        return {
            seed: verificationSeed,
            symbol,
            strategyKey,
            interval,
            quoteVolume,
            bars: bars.length,
            dataFile,
            trainBars: trainData.length,
            testBars: testData.length,
            optimizedParams: null,
            walkForward: { trainNetProfitPercent: 0, trainSharpeRatio: 0, testNetProfitPercent: 0, testSharpeRatio: 0, testMaxDrawdownPercent: 1000, testTotalTrades: 0, dropPercent: 1000, pass: false },
            torture: { commissionPercent: options.commissionPercent * 2, slippageBps: options.tortureSlippageBps, netProfitPercent: 0, maxDrawdownPercent: 1000, pass: false },
            stability: { worstMaxDrawdownPercent: 1000, thresholdPercent: options.maxDrawdownPercent, pass: false },
            score: Number.NEGATIVE_INFINITY,
            passed: false,
            failReasons: ["invalid_split"],
        };
    }

    const baselineSettings = resolveBacktestSettingsFromRaw({
        tradeDirection: inferDirection(strategy!),
        executionModel: options.executionModel,
        allowSameBarExit: options.allowSameBarExit,
        slippageBps: 0,
    } as BacktestSettings, {
        coerceWithoutUiToggles: true,
    });

    const tortureSettings = resolveBacktestSettingsFromRaw({
        ...baselineSettings,
        slippageBps: options.tortureSlippageBps,
    } as BacktestSettings, {
        coerceWithoutUiToggles: true,
    });

    const seed = deriveSeed(verificationSeed, symbol, strategyKey);
    const ga = await runGeneticOptimization({
        strategyKey,
        strategy: strategy!,
        data: trainData,
        backtestSettings: baselineSettings,
        config: buildGeneticConfig(options, seed, options.commissionPercent),
    });
    const optimizedParams = ga.bestGenome.params;
    const trainResult = ga.bestGenome.result;
    const testResult = runBacktestForParams(strategy!, testData, optimizedParams, options.commissionPercent, baselineSettings, options);
    const tortureResult = runBacktestForParams(strategy!, testData, optimizedParams, options.commissionPercent * 2, tortureSettings, options);

    const trainNet = trainResult.netProfitPercent;
    const testNet = testResult.netProfitPercent;
    const dropPercent = trainNet > 0 ? ((trainNet - testNet) / Math.abs(trainNet)) * 100 : Number.POSITIVE_INFINITY;
    const walkForwardPass = Number.isFinite(dropPercent) && dropPercent <= options.dropThresholdPercent;
    if (!Number.isFinite(dropPercent)) failReasons.push("wf_non_positive_train_profit");
    else if (dropPercent > options.dropThresholdPercent) failReasons.push("wf_oos_drop_exceeds_threshold");

    const torturePass = tortureResult.netProfitPercent > 0;
    if (!torturePass) failReasons.push("torture_negative_profit");

    const worstDrawdown = Math.max(trainResult.maxDrawdownPercent, testResult.maxDrawdownPercent, tortureResult.maxDrawdownPercent);
    const stabilityPass = worstDrawdown <= options.maxDrawdownPercent;
    if (!stabilityPass) failReasons.push("stability_drawdown_breach");

    const passed = walkForwardPass && torturePass && stabilityPass;
    const score =
        testResult.netProfitPercent * 0.8 +
        testResult.sharpeRatio * 20 -
        worstDrawdown * 0.9 -
        Math.max(0, dropPercent) * 0.15;

    return {
        seed: verificationSeed,
        symbol,
        strategyKey,
        interval,
        quoteVolume,
        bars: bars.length,
        dataFile,
        trainBars: trainData.length,
        testBars: testData.length,
        optimizedParams: optimizedParams as Record<string, number>,
        walkForward: {
            trainNetProfitPercent: trainNet,
            trainSharpeRatio: trainResult.sharpeRatio,
            testNetProfitPercent: testNet,
            testSharpeRatio: testResult.sharpeRatio,
            testMaxDrawdownPercent: testResult.maxDrawdownPercent,
            testTotalTrades: testResult.totalTrades,
            dropPercent,
            pass: walkForwardPass,
        },
        torture: {
            commissionPercent: options.commissionPercent * 2,
            slippageBps: options.tortureSlippageBps,
            netProfitPercent: tortureResult.netProfitPercent,
            maxDrawdownPercent: tortureResult.maxDrawdownPercent,
            pass: torturePass,
        },
        stability: {
            worstMaxDrawdownPercent: worstDrawdown,
            thresholdPercent: options.maxDrawdownPercent,
            pass: stabilityPass,
        },
        score,
        passed,
        failReasons,
    };
}

export async function runVerification(options: VerifyAlphaCliOptions): Promise<void> {
    if (!fs.existsSync(options.inputFile)) {
        throw new Error(`[VerifyAlpha] Input report not found: ${options.inputFile}`);
    }

    const report = JSON.parse(fs.readFileSync(options.inputFile, "utf8")) as AlphaReport;
    const winners = Array.isArray(report.winners) ? report.winners : [];
    const symbols = Array.isArray(report.symbols) ? report.symbols : [];
    if (winners.length === 0) {
        throw new Error("[VerifyAlpha] No winners found in alpha_report.json.");
    }

    const symbolMap = getSymbolEntryMap(symbols);
    const candidateList = options.maxCandidates > 0 ? winners.slice(0, options.maxCandidates) : winners.slice();
    const requiredPassCount = Math.min(options.minPassCount, options.verificationSeeds);
    const robustValidations: CandidateRobustValidation[] = [];
    const seedRuns: CandidateValidation[] = [];

    for (let i = 0; i < candidateList.length; i++) {
        const candidate = candidateList[i];
        const symbol = String(candidate.symbol ?? "").trim().toUpperCase();
        const strategyKey = String(candidate.strategyKey ?? "").trim();
        const label = `${symbol} ${strategyKey}`.trim();
        const seeds = buildVerificationSeeds(options.seed, symbol, strategyKey, options.verificationSeeds);
        const runs: CandidateValidation[] = [];

        console.log(`[VerifyAlpha][Gauntlet2] ${i + 1}/${candidateList.length} validating ${label} across ${seeds.length} seeds`);
        for (const seed of seeds) {
            const run = await validateCandidate(candidate, symbolMap.get(symbol), options, seed);
            runs.push(run);
            seedRuns.push(run);
        }

        const passCount = runs.filter((run) => run.passed).length;
        const representative = pickRepresentativeValidation(runs);
        const robustnessScore = `${passCount}/${runs.length}`;
        const candidatePassed = passCount >= requiredPassCount;
        const reasonCounts = new Map<string, number>();
        for (const run of runs) {
            if (run.passed) continue;
            for (const reason of run.failReasons) {
                reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
            }
        }
        const topReasons = Array.from(reasonCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(",");

        robustValidations.push({
            symbol: representative.symbol,
            strategyKey: representative.strategyKey,
            interval: representative.interval,
            quoteVolume: representative.quoteVolume,
            bars: representative.bars,
            dataFile: representative.dataFile,
            passCount,
            totalRuns: runs.length,
            robustnessScore,
            seeds,
            passed: candidatePassed,
            representative,
            runs,
        });

        const verdict = candidatePassed ? "PASS" : "FAIL";
        console.log(
            `[VerifyAlpha][Gauntlet2] ${label} -> ${verdict} robustness=${robustnessScore} net=${representative.walkForward.testNetProfitPercent.toFixed(2)}% dd=${representative.stability.worstMaxDrawdownPercent.toFixed(2)}%${topReasons ? ` failFreq=${topReasons}` : ""}`
        );
    }

    const passed = robustValidations
        .filter((item) => item.passed)
        .sort((a, b) => {
            if (b.passCount !== a.passCount) return b.passCount - a.passCount;
            return b.representative.score - a.representative.score;
        });

    const verifiedWinners = passed.map((item, index) => {
        const v = item.representative;
        return {
            rank: index + 1,
            symbol: v.symbol,
            interval: v.interval,
            strategyKey: v.strategyKey,
            score: v.score,
            netProfitPercent: v.walkForward.testNetProfitPercent,
            sharpeRatio: v.walkForward.testSharpeRatio,
            maxDrawdownPercent: v.stability.worstMaxDrawdownPercent,
            totalTrades: v.walkForward.testTotalTrades,
            drift: Number.isFinite(v.walkForward.dropPercent) ? Math.abs(v.walkForward.dropPercent) / 100 : 1,
            robustness_score: item.robustnessScore,
            pass_count: item.passCount,
            verification_runs: item.totalRuns,
            alphaGenome: v.optimizedParams ?? {},
        };
    });

    const verifiedSymbols = passed.map((item, index) => {
        const v = item.representative;
        return {
            rank: index + 1,
            symbol: v.symbol,
            interval: v.interval,
            quoteVolume: v.quoteVolume,
            bars: v.bars,
            dataFile: v.dataFile,
            robustness_score: item.robustnessScore,
            pass_count: item.passCount,
            verification_runs: item.totalRuns,
            hunts: [
                {
                    strategyKey: v.strategyKey,
                    fitness: {
                        score: v.score,
                        netProfitPercent: v.walkForward.testNetProfitPercent,
                        sharpeRatio: v.walkForward.testSharpeRatio,
                        stability: 1 / (1 + (v.stability.worstMaxDrawdownPercent / 25)),
                        maxDrawdownPercent: v.stability.worstMaxDrawdownPercent,
                        totalTrades: v.walkForward.testTotalTrades,
                        drift: Number.isFinite(v.walkForward.dropPercent) ? Math.abs(v.walkForward.dropPercent) / 100 : 1,
                        robustnessScore: item.robustnessScore,
                    },
                },
            ],
            winner: {
                strategyKey: v.strategyKey,
                fitness: {
                    score: v.score,
                    netProfitPercent: v.walkForward.testNetProfitPercent,
                    sharpeRatio: v.walkForward.testSharpeRatio,
                    stability: 1 / (1 + (v.stability.worstMaxDrawdownPercent / 25)),
                    maxDrawdownPercent: v.stability.worstMaxDrawdownPercent,
                    totalTrades: v.walkForward.testTotalTrades,
                    drift: Number.isFinite(v.walkForward.dropPercent) ? Math.abs(v.walkForward.dropPercent) / 100 : 1,
                    robustnessScore: item.robustnessScore,
                },
            },
        };
    });

    const output = {
        generatedAt: new Date().toISOString(),
        sourceReport: options.inputFile,
        config: {
            trainRatio: options.trainRatio,
            dropThresholdPercent: options.dropThresholdPercent,
            maxDrawdownPercent: options.maxDrawdownPercent,
            torture: {
                commissionPercent: options.commissionPercent * 2,
                slippageBps: options.tortureSlippageBps,
            },
            optimizer: {
                population: options.population,
                generations: options.generations,
                eliteCount: options.eliteCount,
                mutationRate: options.mutationRate,
                mutationSigma: options.mutationSigma,
                rangePercent: options.rangePercent,
                minTrades: options.minTrades,
                seed: options.seed,
            },
            gauntlet: {
                verificationSeeds: options.verificationSeeds,
                minPassCount: requiredPassCount,
            },
        },
        summary: {
            totalCandidates: robustValidations.length,
            passed: passed.length,
            failed: robustValidations.length - passed.length,
            passRatePercent: robustValidations.length > 0 ? (passed.length / robustValidations.length) * 100 : 0,
            totalSeedRuns: seedRuns.length,
        },
        winners: verifiedWinners,
        symbols: verifiedSymbols,
        candidates: robustValidations,
        seedRuns,
    };

    fs.writeFileSync(options.outFile, JSON.stringify(output, null, 2), "utf8");
    console.log(`[VerifyAlpha][Gauntlet2] Passed ${passed.length}/${robustValidations.length} with threshold ${requiredPassCount}/${options.verificationSeeds}. Wrote: ${options.outFile}`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    await runVerification(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`verify-alpha failed: ${message}`);
        process.exitCode = 1;
    });
}
