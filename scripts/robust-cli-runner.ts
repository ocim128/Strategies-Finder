import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runFinderExecution, type FinderSelectedStrategy } from "../lib/finder/finder-runner";
import { FinderParamSpace } from "../lib/finder/finder-param-space";
import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { debugLogger } from "../lib/debug-logger";
import { parseTimeToUnixSeconds } from "../lib/time-normalization";
import { strategies } from "../lib/strategies/library";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, StrategyParams, Time, TradeDirection, TradeFilterMode } from "../lib/types/strategies";

type CliOverrides = {
    configPath: string | null;
    dataPath?: string;
    strategyKeys?: string[];
    symbol?: string;
    interval?: string;
    seeds?: number[];
    rangePercent?: number;
    maxRuns?: number;
    steps?: number;
    topN?: number;
    minTrades?: number;
    tradeFilterMode?: TradeFilterMode;
    tradeDirection?: TradeDirection;
    outDir?: string;
};

type RobustCliConfig = {
    dataPath: string;
    symbol?: string;
    interval?: string;
    strategyKeys: string[];
    seeds?: number[];
    finder?: {
        rangePercent?: number;
        maxRuns?: number;
        steps?: number;
        topN?: number;
        minTrades?: number;
        maxTrades?: number;
    };
    backtestSettings?: BacktestSettings;
    capital?: {
        initialCapital?: number;
        positionSize?: number;
        commission?: number;
        sizingMode?: "percent" | "fixed";
        fixedTradeAmount?: number;
    };
    output?: {
        outDir?: string;
        filePrefix?: string;
        writeJsonSummary?: boolean;
        writeJsonReport?: boolean;
        writeTableSummary?: boolean;
        writeTableReport?: boolean;
    };
};

type EffectiveConfig = {
    dataPath: string;
    symbol: string;
    interval: string;
    strategyKeys: string[];
    seeds: number[];
    finder: {
        rangePercent: number;
        maxRuns: number;
        steps: number;
        topN: number;
        minTrades: number;
        maxTrades: number;
    };
    backtestSettings: BacktestSettings;
    capital: {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: "percent" | "fixed";
        fixedTradeAmount: number;
    };
    output: {
        outDir: string;
        filePrefix: string;
        writeJsonSummary: boolean;
        writeJsonReport: boolean;
        writeTableSummary: boolean;
        writeTableReport: boolean;
    };
};

type ParsedDataFile = {
    bars: OHLCVData[];
    symbol: string | null;
    interval: string | null;
};

const DEFAULT_SEEDS = [1337, 7331, 2026, 4242, 9001];
const DEFAULT_FILE_PREFIX = "run-seed";

function printUsage(): void {
    console.log([
        "Usage:",
        "  esno scripts/robust-cli-runner.ts --config <path>",
        "",
        "Config-first workflow (recommended):",
        "  npm run robust:run -- --config scripts/robust-cli-config.example.json",
        "",
        "Optional overrides:",
        "  --data <path>",
        "  --strategy <key[,key2,...]>",
        "  --symbol <symbol>",
        "  --interval <interval>",
        "  --seeds <n1,n2,n3,...>",
        "  --range <percent>",
        "  --runs <maxRuns>",
        "  --steps <steps>",
        "  --topn <topN>",
        "  --min-trades <minTrades>",
        "  --trade-filter <none|close|volume|rsi|trend|adx>",
        "  --trade-direction <long|short|both|combined>",
        "  --out-dir <path>",
        "",
        "Notes:",
        "  - Writes one file per seed: run-seed-<seed>.txt",
        "  - Then runs robust summary/report scripts over all generated files.",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliOverrides & { help?: boolean } {
    const out: CliOverrides & { help?: boolean } = {
        configPath: null,
    };
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            out.help = true;
            continue;
        }
        if (arg === "--config") {
            out.configPath = String(argv[i + 1] ?? "");
            i += 1;
            continue;
        }
        if (arg === "--data") {
            out.dataPath = String(argv[i + 1] ?? "");
            i += 1;
            continue;
        }
        if (arg === "--strategy") {
            out.strategyKeys = String(argv[i + 1] ?? "")
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
            i += 1;
            continue;
        }
        if (arg === "--symbol") {
            out.symbol = String(argv[i + 1] ?? "").trim();
            i += 1;
            continue;
        }
        if (arg === "--interval") {
            out.interval = String(argv[i + 1] ?? "").trim();
            i += 1;
            continue;
        }
        if (arg === "--seeds") {
            out.seeds = String(argv[i + 1] ?? "")
                .split(",")
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v));
            i += 1;
            continue;
        }
        if (arg === "--range") {
            out.rangePercent = Number(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg === "--runs") {
            out.maxRuns = Number(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg === "--steps") {
            out.steps = Number(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg === "--topn") {
            out.topN = Number(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg === "--min-trades") {
            out.minTrades = Number(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg === "--trade-filter") {
            out.tradeFilterMode = String(argv[i + 1]).trim().toLowerCase() as TradeFilterMode;
            i += 1;
            continue;
        }
        if (arg === "--trade-direction") {
            out.tradeDirection = String(argv[i + 1]).trim().toLowerCase() as TradeDirection;
            i += 1;
            continue;
        }
        if (arg === "--out-dir") {
            out.outDir = String(argv[i + 1] ?? "");
            i += 1;
            continue;
        }

        positional.push(arg);
    }

    // Positional fallback for environments where npm strips option flags:
    // robust-cli-runner.ts <configPath> [seedsCsv] [maxRuns] [rangePercent]
    if (!out.configPath && positional[0]) {
        out.configPath = positional[0];
    }
    if (!out.seeds && positional[1]) {
        const parsedSeeds = positional[1]
            .split(",")
            .map((v) => Number(v.trim()))
            .filter((v) => Number.isFinite(v));
        if (parsedSeeds.length > 0) out.seeds = parsedSeeds;
    }
    if (out.maxRuns === undefined && positional[2]) {
        const parsed = Number(positional[2]);
        if (Number.isFinite(parsed)) out.maxRuns = parsed;
    }
    if (out.rangePercent === undefined && positional[3]) {
        const parsed = Number(positional[3]);
        if (Number.isFinite(parsed)) out.rangePercent = parsed;
    }

    return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseBar(row: unknown): OHLCVData | null {
    if (Array.isArray(row)) {
        if (row.length < 5) return null;
        const time = parseTimeToUnixSeconds(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = row.length > 5 ? Number(row[5]) : 0;
        if (time === null) return null;
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        return { time: time as Time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    }

    if (!isObject(row)) return null;

    const time = parseTimeToUnixSeconds(
        row.time ?? row.t ?? row.timestamp ?? row.date ?? row.datetime ?? row.start ?? row.openTime
    );
    const open = Number(row.open ?? row.o);
    const high = Number(row.high ?? row.h);
    const low = Number(row.low ?? row.l);
    const close = Number(row.close ?? row.c);
    const volume = Number(row.volume ?? row.v ?? 0);

    if (time === null) return null;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
    return { time: time as Time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

function parseDataFile(raw: unknown): ParsedDataFile {
    let symbol: string | null = null;
    let interval: string | null = null;
    let rows: unknown[] = [];

    if (Array.isArray(raw)) {
        rows = raw;
    } else if (isObject(raw)) {
        if (typeof raw.symbol === "string" && raw.symbol.trim().length > 0) {
            symbol = raw.symbol.trim();
        }
        if (typeof raw.interval === "string" && raw.interval.trim().length > 0) {
            interval = raw.interval.trim();
        }

        if (Array.isArray(raw.data)) rows = raw.data;
        else if (Array.isArray(raw.ohlcv)) rows = raw.ohlcv;
        else if (Array.isArray(raw.candles)) rows = raw.candles;
    }

    const parsed = rows
        .map((row) => parseBar(row))
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

function normalizeSeeds(seeds: number[] | undefined): number[] {
    const source = (seeds && seeds.length > 0) ? seeds : DEFAULT_SEEDS;
    const normalized = source
        .map((seed) => Math.floor(Number(seed)))
        .filter((seed) => Number.isFinite(seed))
        .map((seed) => (seed >>> 0) || 1);
    return Array.from(new Set(normalized));
}

function mustFinitePositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.floor(parsed));
}

function mustFiniteNonNegative(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, parsed);
}

function resolveConfig(rawConfig: RobustCliConfig, overrides: CliOverrides, parsedData: ParsedDataFile): EffectiveConfig {
    const strategyKeys = (overrides.strategyKeys && overrides.strategyKeys.length > 0)
        ? overrides.strategyKeys
        : rawConfig.strategyKeys;
    if (!Array.isArray(strategyKeys) || strategyKeys.length === 0) {
        throw new Error("No strategy keys provided. Set strategyKeys in config or pass --strategy.");
    }

    const symbol = overrides.symbol
        || rawConfig.symbol
        || parsedData.symbol
        || "ETHUSDT";
    const interval = overrides.interval
        || rawConfig.interval
        || parsedData.interval
        || "120m";

    const finderRaw = rawConfig.finder ?? {};
    const seeds = normalizeSeeds(overrides.seeds ?? rawConfig.seeds);
    if (seeds.length === 0) {
        throw new Error("No valid seeds provided.");
    }

    const rawBacktest = { ...(rawConfig.backtestSettings ?? {}) };
    if (overrides.tradeFilterMode) rawBacktest.tradeFilterMode = overrides.tradeFilterMode;
    if (overrides.tradeDirection) rawBacktest.tradeDirection = overrides.tradeDirection;

    const resolvedSettings = resolveBacktestSettingsFromRaw(rawBacktest as BacktestSettings, {
        captureSnapshots: false,
        coerceWithoutUiToggles: true,
    });
    resolvedSettings.confirmationStrategies = [];
    resolvedSettings.confirmationStrategyParams = {};

    const capitalRaw = rawConfig.capital ?? {};
    const outputRaw = rawConfig.output ?? {};
    const outDir = path.resolve(overrides.outDir || outputRaw.outDir || process.cwd());

    return {
        dataPath: path.resolve(overrides.dataPath || rawConfig.dataPath),
        symbol,
        interval,
        strategyKeys,
        seeds,
        finder: {
            rangePercent: mustFiniteNonNegative(overrides.rangePercent ?? finderRaw.rangePercent, 35),
            maxRuns: mustFinitePositiveInt(overrides.maxRuns ?? finderRaw.maxRuns, 120),
            steps: mustFinitePositiveInt(overrides.steps ?? finderRaw.steps, 3),
            topN: mustFinitePositiveInt(overrides.topN ?? finderRaw.topN, 10),
            minTrades: mustFiniteNonNegative(overrides.minTrades ?? finderRaw.minTrades, 40),
            maxTrades: Math.max(
                mustFiniteNonNegative(overrides.minTrades ?? finderRaw.minTrades, 40),
                Number.isFinite(Number(finderRaw.maxTrades)) ? Number(finderRaw.maxTrades) : Number.POSITIVE_INFINITY
            ),
        },
        backtestSettings: resolvedSettings,
        capital: {
            initialCapital: Number.isFinite(Number(capitalRaw.initialCapital))
                ? Number(capitalRaw.initialCapital)
                : CAPITAL_DEFAULTS.initialCapital,
            positionSize: Number.isFinite(Number(capitalRaw.positionSize))
                ? Number(capitalRaw.positionSize)
                : CAPITAL_DEFAULTS.positionSize,
            commission: Number.isFinite(Number(capitalRaw.commission))
                ? Number(capitalRaw.commission)
                : CAPITAL_DEFAULTS.commission,
            sizingMode: capitalRaw.sizingMode === "fixed" ? "fixed" : "percent",
            fixedTradeAmount: Number.isFinite(Number(capitalRaw.fixedTradeAmount))
                ? Number(capitalRaw.fixedTradeAmount)
                : CAPITAL_DEFAULTS.fixedTradeAmount,
        },
        output: {
            outDir,
            filePrefix: String(outputRaw.filePrefix || DEFAULT_FILE_PREFIX),
            writeJsonSummary: outputRaw.writeJsonSummary !== false,
            writeJsonReport: outputRaw.writeJsonReport !== false,
            writeTableSummary: outputRaw.writeTableSummary !== false,
            writeTableReport: outputRaw.writeTableReport !== false,
        },
    };
}

function resolveSelectedStrategies(strategyKeys: string[]): FinderSelectedStrategy[] {
    const resolved: FinderSelectedStrategy[] = [];
    const missing: string[] = [];

    for (const key of strategyKeys) {
        const strategy = strategies[key];
        if (!strategy) {
            missing.push(key);
            continue;
        }
        resolved.push({
            key,
            name: strategy.name,
            strategy,
        });
    }

    if (missing.length > 0) {
        throw new Error(`Unknown strategy key(s): ${missing.join(", ")}`);
    }
    return resolved;
}

function buildFinderOptions(seed: number, cfg: EffectiveConfig): FinderOptions {
    return {
        mode: "robust_random_wf",
        sortPriority: ["expectancy", "profitFactor", "totalTrades", "maxDrawdownPercent", "sharpeRatio", "averageGain", "winRate", "netProfitPercent", "netProfit"],
        useAdvancedSort: false,
        robustSeed: seed,
        multiTimeframeEnabled: false,
        timeframes: [],
        topN: cfg.finder.topN,
        steps: cfg.finder.steps,
        rangePercent: cfg.finder.rangePercent,
        maxRuns: cfg.finder.maxRuns,
        tradeFilterEnabled: true,
        minTrades: cfg.finder.minTrades,
        maxTrades: cfg.finder.maxTrades,
    };
}

function runNodeScript(args: string[]): void {
    const result = spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        stdio: "inherit",
    });
    if (result.status !== 0) {
        throw new Error(`Command failed: node ${args.join(" ")}`);
    }
}

function buildAuditLinesForSeed(seed: number): string[] {
    return debugLogger.getEntries()
        .filter((entry) => entry.message === "[Finder][robust_random_wf][cell_audit]")
        .map((entry) => entry.data)
        .filter((payload): payload is Record<string, unknown> => isObject(payload))
        .filter((payload) => Number(payload.seed) === seed)
        .map((payload) => `[Finder][robust_random_wf][cell_audit] ${JSON.stringify(payload)}`);
}

async function runSeed(seed: number, cfg: EffectiveConfig, bars: OHLCVData[], selectedStrategies: FinderSelectedStrategy[]): Promise<string> {
    debugLogger.clear();
    (debugLogger as any).maxEntries = Math.max((debugLogger as any).maxEntries ?? 200, 20_000);

    const finderOptions = buildFinderOptions(seed, cfg);
    let lastProgressBucket = -1;
    let lastStatus = "";

    const output = await runFinderExecution(
        {
            ohlcvData: bars,
            symbol: cfg.symbol,
            interval: cfg.interval,
            options: finderOptions,
            settings: cfg.backtestSettings,
            requiresTsEngine: true,
            selectedStrategies,
            initialCapital: cfg.capital.initialCapital,
            positionSize: cfg.capital.positionSize,
            commission: cfg.capital.commission,
            sizingMode: cfg.capital.sizingMode,
            fixedTradeAmount: cfg.capital.fixedTradeAmount,
            getFinderTimeframesForRun: () => [cfg.interval],
            loadMultiTimeframeDatasets: async () => [],
            generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) =>
                new FinderParamSpace().generateParamSets(defaultParams, options),
            buildRandomConfirmationParams: () => ({}),
        },
        {
            setProgress: (percent, text) => {
                const bucket = Math.floor(percent / 10);
                if (bucket === lastProgressBucket && percent < 100) return;
                lastProgressBucket = bucket;
                console.log(`[seed ${seed}] progress ${percent.toFixed(1)}% - ${text}`);
            },
            setStatus: (text) => {
                if (text === lastStatus) return;
                lastStatus = text;
                console.log(`[seed ${seed}] ${text}`);
            },
            yieldControl: async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            },
        }
    );

    const lines = buildAuditLinesForSeed(seed);
    const filePath = path.join(cfg.output.outDir, `${cfg.output.filePrefix}-${seed}.txt`);
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`[seed ${seed}] wrote ${lines.length} cell_audit line(s) -> ${filePath} (${output.results.length} shown)`);
    return filePath;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }

    const configPath = args.configPath ? path.resolve(args.configPath) : null;
    const rawConfig = (configPath ? readJsonFile(configPath) : {}) as RobustCliConfig;
    if (!args.dataPath && !rawConfig.dataPath) {
        throw new Error("Missing data path. Provide --data or set dataPath in config.");
    }

    const rawData = readJsonFile(path.resolve(args.dataPath || rawConfig.dataPath));
    const parsedData = parseDataFile(rawData);
    if (parsedData.bars.length === 0) {
        throw new Error("No valid OHLCV bars parsed from input data file.");
    }

    const cfg = resolveConfig(rawConfig, args, parsedData);
    fs.mkdirSync(cfg.output.outDir, { recursive: true });

    const selectedStrategies = resolveSelectedStrategies(cfg.strategyKeys);
    console.log(`Loaded ${parsedData.bars.length} bars for ${cfg.symbol} ${cfg.interval}.`);
    console.log(`Strategies: ${cfg.strategyKeys.join(", ")}`);
    console.log(`Seeds: ${cfg.seeds.join(", ")}`);
    console.log(`Finder: mode=robust_random_wf range=${cfg.finder.rangePercent}% runs=${cfg.finder.maxRuns} steps=${cfg.finder.steps}`);
    console.log(`Backtest filter: ${cfg.backtestSettings.tradeFilterMode ?? "none"} | direction: ${cfg.backtestSettings.tradeDirection ?? "short"}`);

    const runFiles: string[] = [];
    for (const seed of cfg.seeds) {
        const filePath = await runSeed(seed, cfg, parsedData.bars, selectedStrategies);
        runFiles.push(filePath);
    }

    if (cfg.output.writeTableSummary) {
        runNodeScript([path.resolve("scripts/robust-matrix-summary.mjs"), ...runFiles]);
    }
    if (cfg.output.writeTableReport) {
        runNodeScript([path.resolve("scripts/robust-go-no-go-report.mjs"), ...runFiles]);
    }

    const dateTag = new Date().toISOString().slice(0, 10);
    if (cfg.output.writeJsonSummary) {
        const summaryPath = path.join(cfg.output.outDir, `matrix-summary-${dateTag}.json`);
        runNodeScript([
            path.resolve("scripts/robust-matrix-summary.mjs"),
            "--format",
            "json",
            "--out",
            summaryPath,
            ...runFiles,
        ]);
    }
    if (cfg.output.writeJsonReport) {
        const reportPath = path.join(cfg.output.outDir, `go-no-go-${dateTag}.json`);
        runNodeScript([
            path.resolve("scripts/robust-go-no-go-report.mjs"),
            "--format",
            "json",
            "--out",
            reportPath,
            ...runFiles,
        ]);
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`robust-cli-runner failed: ${message}`);
    process.exitCode = 1;
});
