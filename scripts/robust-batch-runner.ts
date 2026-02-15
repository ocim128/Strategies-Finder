import fs from "node:fs";
import path from "node:path";

import { runFinderExecution, type FinderSelectedStrategy } from "../lib/finder/finder-runner";
import { FinderParamSpace } from "../lib/finder/finder-param-space";
import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { debugLogger } from "../lib/debug-logger";
import { parseTimeToUnixSeconds } from "../lib/time-normalization";
import { strategies } from "../lib/strategies/library";
import type { FinderOptions } from "../lib/types/finder";
import type {
    BacktestSettings,
    OHLCVData,
    Time,
    Strategy,
    StrategyParams,
    TradeDirection,
    TradeFilterMode,
} from "../lib/types/strategies";

type CliOverrides = {
    configPath: string | null;
    outDir?: string;
    strategyKeys?: string[];
    seeds?: number[];
    help?: boolean;
};

type BatchCellConfig = {
    label?: string;
    enabled?: boolean;
    dataPath: string;
    symbol?: string;
    interval?: string;
    strategyKeys?: string[];
    strategyParams?: Record<string, StrategyParams>;
    tradeFilterModes?: TradeFilterMode[];
    tradeDirections?: TradeDirection[];
};

type BatchConfig = {
    strategyKeys: string[] | "all";
    seeds?: number[];
    finder?: {
        rangePercent?: number;
        maxRuns?: number;
        steps?: number;
        topN?: number;
        minTrades?: number;
        maxTrades?: number;
    };
    tradeFilterModes?: TradeFilterMode[];
    tradeDirections?: TradeDirection[];
    backtestSettings?: BacktestSettings;
    capital?: {
        initialCapital?: number;
        positionSize?: number;
        commission?: number;
        sizingMode?: "percent" | "fixed";
        fixedTradeAmount?: number;
    };
    reportPolicy?: {
        minSeedRuns?: number;
        minSeedPasses?: number;
        minMedianCellPassRate?: number;
        minMedianStageCSurvivors?: number;
        maxMedianDDBreachRate?: number;
        maxMedianFoldStabilityPenalty?: number;
    };
    output?: {
        outDir?: string;
        filePrefix?: string;
        writePerCellJsonSummary?: boolean;
        writePerCellJsonReport?: boolean;
        writePerCellTableReport?: boolean;
        writeBatchJsonSummary?: boolean;
        writeBatchJsonReport?: boolean;
        writeBatchTableReport?: boolean;
    };
    matrix: BatchCellConfig[];
};

type ParsedDataFile = {
    bars: OHLCVData[];
    symbol: string | null;
    interval: string | null;
};

type EffectiveTask = {
    label: string;
    dataPath: string;
    symbol: string;
    interval: string;
    strategyKeys: string[];
    strategyParams?: Record<string, StrategyParams>;
    tradeFilterMode: TradeFilterMode;
    tradeDirection: TradeDirection;
};

type EffectiveBatchConfig = {
    tasks: EffectiveTask[];
    seeds: number[];
    finder: {
        rangePercent: number;
        maxRuns: number;
        steps: number;
        topN: number;
        minTrades: number;
        maxTrades: number;
    };
    baseBacktestSettings: BacktestSettings;
    capital: {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: "percent" | "fixed";
        fixedTradeAmount: number;
    };
    policy: {
        minSeedRuns: number;
        minSeedPasses: number;
        minMedianCellPassRate: number;
        minMedianStageCSurvivors: number;
        maxMedianDDBreachRate: number;
        maxMedianFoldStabilityPenalty: number;
    };
    output: {
        outDir: string;
        filePrefix: string;
        writePerCellJsonSummary: boolean;
        writePerCellJsonReport: boolean;
        writePerCellTableReport: boolean;
        writeBatchJsonSummary: boolean;
        writeBatchJsonReport: boolean;
        writeBatchTableReport: boolean;
    };
};

type EffectiveTaskRunResult = {
    task: EffectiveTask;
    runDir: string;
    runFiles: string[];
    summaryJsonPath?: string;
    reportJsonPath?: string;
    reportTablePath?: string;
};

const DEFAULT_SEEDS = [1337, 7331, 2026, 4242, 9001];
const DEFAULT_FILE_PREFIX = "run-seed";
const VALID_TRADE_FILTERS: TradeFilterMode[] = ["none", "close", "volume", "rsi", "trend", "adx"];
const VALID_DIRECTIONS: TradeDirection[] = ["long", "short", "both", "combined"];

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run robust:batch -- --config <path>",
        "",
        "Positional fallback:",
        "  npm run robust:batch -- scripts/robust-batch-config.example.json",
        "",
        "Optional overrides:",
        "  --out-dir <path>",
        "  --strategy <key[,key2,...]>",
        "  --seeds <n1,n2,n3,...>",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliOverrides {
    const out: CliOverrides = { configPath: null };
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
        if (arg === "--out-dir") {
            out.outDir = String(argv[i + 1] ?? "");
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
        if (arg === "--seeds") {
            out.seeds = String(argv[i + 1] ?? "")
                .split(",")
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v));
            i += 1;
            continue;
        }
        positional.push(arg);
    }

    if (!out.configPath && positional[0]) {
        out.configPath = positional[0];
    }
    if (!out.seeds && positional[1]) {
        const parsed = positional[1]
            .split(",")
            .map((v) => Number(v.trim()))
            .filter((v) => Number.isFinite(v));
        if (parsed.length > 0) out.seeds = parsed;
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
        if (typeof raw.symbol === "string" && raw.symbol.trim()) symbol = raw.symbol.trim();
        if (typeof raw.interval === "string" && raw.interval.trim()) interval = raw.interval.trim();
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
    const source = seeds && seeds.length > 0 ? seeds : DEFAULT_SEEDS;
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

function toRatio(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const ratio = parsed > 1 ? parsed / 100 : parsed;
    return Math.max(0, Math.min(1, ratio));
}

function sanitizeDirName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function normalizeTradeFilterModes(values: unknown, fallback: TradeFilterMode[]): TradeFilterMode[] {
    const list = Array.isArray(values) ? values : fallback;
    const normalized = list
        .map((v) => String(v).trim().toLowerCase() as TradeFilterMode)
        .filter((v) => VALID_TRADE_FILTERS.includes(v));
    return Array.from(new Set(normalized.length > 0 ? normalized : fallback));
}

function normalizeTradeDirections(values: unknown, fallback: TradeDirection[]): TradeDirection[] {
    const list = Array.isArray(values) ? values : fallback;
    const normalized = list
        .map((v) => String(v).trim().toLowerCase() as TradeDirection)
        .filter((v) => VALID_DIRECTIONS.includes(v));
    return Array.from(new Set(normalized.length > 0 ? normalized : fallback));
}

function resolveStrategyKeys(raw: BatchConfig, overrides: CliOverrides): string[] {
    if (overrides.strategyKeys && overrides.strategyKeys.length > 0) {
        return overrides.strategyKeys;
    }
    if (raw.strategyKeys === "all") {
        return Object.keys(strategies);
    }
    if (Array.isArray(raw.strategyKeys) && raw.strategyKeys.length > 0) {
        return raw.strategyKeys;
    }
    throw new Error("No strategy keys provided. Set strategyKeys or pass --strategy.");
}

function normalizeStrategyParamsMap(raw: unknown, context: string): Record<string, StrategyParams> | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isObject(raw)) {
        throw new Error(`${context} must be an object keyed by strategy key.`);
    }

    const out: Record<string, StrategyParams> = {};
    for (const [strategyKey, value] of Object.entries(raw)) {
        if (!isObject(value)) {
            throw new Error(`${context}.${strategyKey} must be an object of numeric params.`);
        }
        const params: StrategyParams = {};
        for (const [paramKey, paramValue] of Object.entries(value)) {
            const asNumber = Number(paramValue);
            if (!Number.isFinite(asNumber)) {
                throw new Error(`${context}.${strategyKey}.${paramKey} must be numeric.`);
            }
            params[paramKey] = asNumber;
        }
        out[strategyKey] = params;
    }
    return out;
}

function resolveSelectedStrategies(
    strategyKeys: string[],
    strategyParams?: Record<string, StrategyParams>
): FinderSelectedStrategy[] {
    const resolved: FinderSelectedStrategy[] = [];
    const missing: string[] = [];

    for (const key of strategyKeys) {
        const baseStrategy = strategies[key];
        if (!baseStrategy) {
            missing.push(key);
            continue;
        }

        const paramOverride = strategyParams?.[key];
        if (paramOverride && Object.keys(paramOverride).length > 0) {
            const strategy: Strategy = {
                ...baseStrategy,
                defaultParams: {
                    ...baseStrategy.defaultParams,
                    ...paramOverride,
                },
            };
            resolved.push({ key, name: strategy.name, strategy });
            continue;
        }

        resolved.push({ key, name: baseStrategy.name, strategy: baseStrategy });
    }

    if (missing.length > 0) {
        throw new Error(`Unknown strategy key(s): ${missing.join(", ")}`);
    }
    return resolved;
}

function resolveConfig(rawConfig: BatchConfig, overrides: CliOverrides): EffectiveBatchConfig {
    const globalStrategyKeys = resolveStrategyKeys(rawConfig, overrides);
    const seeds = normalizeSeeds(overrides.seeds ?? rawConfig.seeds);
    if (seeds.length === 0) {
        throw new Error("No valid seeds provided.");
    }

    const finderRaw = rawConfig.finder ?? {};
    const rawBacktest = { ...(rawConfig.backtestSettings ?? {}) };
    const baseBacktestSettings = resolveBacktestSettingsFromRaw(rawBacktest as BacktestSettings, {
        captureSnapshots: false,
        coerceWithoutUiToggles: true,
    });
    baseBacktestSettings.confirmationStrategies = [];
    baseBacktestSettings.confirmationStrategyParams = {};

    const defaultFilter = (baseBacktestSettings.tradeFilterMode ?? "none") as TradeFilterMode;
    const defaultDirection = (baseBacktestSettings.tradeDirection ?? "short") as TradeDirection;
    const globalFilters = normalizeTradeFilterModes(rawConfig.tradeFilterModes, [defaultFilter]);
    const globalDirections = normalizeTradeDirections(rawConfig.tradeDirections, [defaultDirection]);

    if (!Array.isArray(rawConfig.matrix) || rawConfig.matrix.length === 0) {
        throw new Error("Missing matrix rows in config.");
    }

    const tasks: EffectiveTask[] = [];
    for (let i = 0; i < rawConfig.matrix.length; i++) {
        const row = rawConfig.matrix[i];
        if (!row || row.enabled === false) continue;

        if (!row.dataPath) {
            throw new Error(`matrix[${i}] is missing dataPath`);
        }
        const perRowStrategies = Array.isArray(row.strategyKeys) && row.strategyKeys.length > 0
            ? row.strategyKeys
            : globalStrategyKeys;
        const perRowStrategyParams = normalizeStrategyParamsMap(
            (row as { strategyParams?: unknown }).strategyParams,
            `matrix[${i}].strategyParams`
        );
        const filters = normalizeTradeFilterModes(row.tradeFilterModes, globalFilters);
        const directions = normalizeTradeDirections(row.tradeDirections, globalDirections);

        const baseLabel = row.label?.trim() || `task-${i + 1}`;
        for (const tradeFilterMode of filters) {
            for (const tradeDirection of directions) {
                tasks.push({
                    label: `${baseLabel}:${tradeFilterMode}:${tradeDirection}`,
                    dataPath: path.resolve(row.dataPath),
                    symbol: String(row.symbol ?? "").trim() || "",
                    interval: String(row.interval ?? "").trim() || "",
                    strategyKeys: perRowStrategies,
                    strategyParams: perRowStrategyParams,
                    tradeFilterMode,
                    tradeDirection,
                });
            }
        }
    }

    if (tasks.length === 0) {
        throw new Error("No active matrix tasks after expansion.");
    }

    const capitalRaw = rawConfig.capital ?? {};
    const outputRaw = rawConfig.output ?? {};
    const outDir = path.resolve(overrides.outDir || outputRaw.outDir || process.cwd());
    const policyRaw = rawConfig.reportPolicy ?? {};

    const policy = {
        minSeedRuns: mustFinitePositiveInt(policyRaw.minSeedRuns, 5),
        minSeedPasses: mustFinitePositiveInt(policyRaw.minSeedPasses, 3),
        minMedianCellPassRate: toRatio(policyRaw.minMedianCellPassRate, 0.01),
        minMedianStageCSurvivors: mustFiniteNonNegative(policyRaw.minMedianStageCSurvivors, 2),
        maxMedianDDBreachRate: toRatio(policyRaw.maxMedianDDBreachRate, 0.20),
        maxMedianFoldStabilityPenalty: mustFiniteNonNegative(policyRaw.maxMedianFoldStabilityPenalty, 1.8),
    };
    if (policy.minSeedPasses > policy.minSeedRuns) {
        throw new Error("Invalid policy: minSeedPasses cannot exceed minSeedRuns.");
    }

    return {
        tasks,
        seeds,
        finder: {
            rangePercent: mustFiniteNonNegative(finderRaw.rangePercent, 35),
            maxRuns: mustFinitePositiveInt(finderRaw.maxRuns, 120),
            steps: mustFinitePositiveInt(finderRaw.steps, 3),
            topN: mustFinitePositiveInt(finderRaw.topN, 10),
            minTrades: mustFiniteNonNegative(finderRaw.minTrades, 40),
            maxTrades: Math.max(
                mustFiniteNonNegative(finderRaw.minTrades, 40),
                Number.isFinite(Number(finderRaw.maxTrades)) ? Number(finderRaw.maxTrades) : Number.POSITIVE_INFINITY
            ),
        },
        baseBacktestSettings,
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
        policy,
        output: {
            outDir,
            filePrefix: String(outputRaw.filePrefix || DEFAULT_FILE_PREFIX),
            writePerCellJsonSummary: outputRaw.writePerCellJsonSummary !== false,
            writePerCellJsonReport: outputRaw.writePerCellJsonReport !== false,
            writePerCellTableReport: outputRaw.writePerCellTableReport !== false,
            writeBatchJsonSummary: outputRaw.writeBatchJsonSummary !== false,
            writeBatchJsonReport: outputRaw.writeBatchJsonReport !== false,
            writeBatchTableReport: outputRaw.writeBatchTableReport !== false,
        },
    };
}

function buildFinderOptions(seed: number, cfg: EffectiveBatchConfig): FinderOptions {
    return {
        mode: "robust_random_wf",
        sortPriority: [
            "expectancy",
            "profitFactor",
            "totalTrades",
            "maxDrawdownPercent",
            "sharpeRatio",
            "averageGain",
            "winRate",
            "netProfitPercent",
            "netProfit",
        ],
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

function buildAuditLinesForSeed(seed: number): string[] {
    return debugLogger.getEntries()
        .filter((entry) => entry.message === "[Finder][robust_random_wf][cell_audit]")
        .map((entry) => entry.data)
        .filter((payload): payload is Record<string, unknown> => isObject(payload))
        .filter((payload) => Number(payload.seed) === seed)
        .map((payload) => `[Finder][robust_random_wf][cell_audit] ${JSON.stringify(payload)}`);
}

async function runSeed(
    seed: number,
    task: EffectiveTask,
    cfg: EffectiveBatchConfig,
    bars: OHLCVData[],
    selectedStrategies: FinderSelectedStrategy[],
    settings: BacktestSettings,
    runDir: string,
    taskIndex: number,
    totalTasks: number
): Promise<string> {
    debugLogger.clear();
    (debugLogger as unknown as { maxEntries?: number }).maxEntries = Math.max((debugLogger as unknown as { maxEntries?: number }).maxEntries ?? 200, 20_000);

    const finderOptions = buildFinderOptions(seed, cfg);
    let lastProgressBucket = -1;
    let lastStatus = "";
    await runFinderExecution(
        {
            ohlcvData: bars,
            symbol: task.symbol,
            interval: task.interval,
            options: finderOptions,
            settings,
            requiresTsEngine: true,
            selectedStrategies,
            initialCapital: cfg.capital.initialCapital,
            positionSize: cfg.capital.positionSize,
            commission: cfg.capital.commission,
            sizingMode: cfg.capital.sizingMode,
            fixedTradeAmount: cfg.capital.fixedTradeAmount,
            getFinderTimeframesForRun: () => [task.interval],
            loadMultiTimeframeDatasets: async () => [],
            generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) =>
                new FinderParamSpace().generateParamSets(defaultParams, options),
            buildRandomConfirmationParams: () => ({}),
        },
        {
            setProgress: (percent, text) => {
                const bucket = Math.floor(percent / 20);
                if (bucket === lastProgressBucket && percent < 100) return;
                lastProgressBucket = bucket;
                console.log(`[task ${taskIndex}/${totalTasks}][seed ${seed}] ${percent.toFixed(1)}% ${text}`);
            },
            setStatus: (text) => {
                if (text === lastStatus) return;
                lastStatus = text;
                console.log(`[task ${taskIndex}/${totalTasks}][seed ${seed}] ${text}`);
            },
            yieldControl: async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            },
        }
    );

    const lines = buildAuditLinesForSeed(seed);
    const filePath = path.join(runDir, `${cfg.output.filePrefix}-${seed}.txt`);
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`[task ${taskIndex}/${totalTasks}][seed ${seed}] wrote ${lines.length} line(s) -> ${filePath}`);
    return filePath;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }

    const configPath = args.configPath ? path.resolve(args.configPath) : null;
    if (!configPath) {
        throw new Error("Missing --config <path>.");
    }
    const rawConfig = readJsonFile(configPath) as BatchConfig;
    const cfg = resolveConfig(rawConfig, args);
    fs.mkdirSync(cfg.output.outDir, { recursive: true });

    const dataCache = new Map<string, ParsedDataFile>();
    const taskRuns: EffectiveTaskRunResult[] = [];
    const allRunFiles: string[] = [];

    console.log(`Expanded tasks: ${cfg.tasks.length}`);
    console.log(`Seeds: ${cfg.seeds.join(", ")}`);
    console.log(`Output: ${cfg.output.outDir}`);

    for (let i = 0; i < cfg.tasks.length; i++) {
        const task = cfg.tasks[i];
        const taskIndex = i + 1;
        const loaded = dataCache.get(task.dataPath) ?? (() => {
            const parsed = parseDataFile(readJsonFile(task.dataPath));
            if (parsed.bars.length === 0) {
                throw new Error(`No OHLCV bars parsed from ${task.dataPath}`);
            }
            dataCache.set(task.dataPath, parsed);
            return parsed;
        })();

        const symbol = task.symbol || loaded.symbol || "UNKNOWN";
        const interval = task.interval || loaded.interval || "UNKNOWN";
        const runTask: EffectiveTask = { ...task, symbol, interval };
        const strategySelection = resolveSelectedStrategies(runTask.strategyKeys, runTask.strategyParams);

        const settingsForTask: BacktestSettings = {
            ...cfg.baseBacktestSettings,
            tradeFilterMode: runTask.tradeFilterMode,
            tradeDirection: runTask.tradeDirection,
            confirmationStrategies: [],
            confirmationStrategyParams: {},
        };

        const runDir = path.join(
            cfg.output.outDir,
            `${sanitizeDirName(runTask.label)}__${sanitizeDirName(runTask.symbol)}_${sanitizeDirName(runTask.interval)}_${sanitizeDirName(runTask.tradeFilterMode)}_${sanitizeDirName(runTask.tradeDirection)}`
        );
        fs.mkdirSync(runDir, { recursive: true });

        console.log(
            `[task ${taskIndex}/${cfg.tasks.length}] ${runTask.label} | ${runTask.symbol} ${runTask.interval} | filter=${runTask.tradeFilterMode} direction=${runTask.tradeDirection} | strategies=${runTask.strategyKeys.length} | bars=${loaded.bars.length}`
        );

        const runFiles: string[] = [];
        for (const seed of cfg.seeds) {
            const runFile = await runSeed(seed, runTask, cfg, loaded.bars, strategySelection, settingsForTask, runDir, taskIndex, cfg.tasks.length);
            runFiles.push(runFile);
            allRunFiles.push(runFile);
        }

        taskRuns.push({ task: runTask, runDir, runFiles });
    }

    const { collectRecords, buildSummary } = await import("./robust-log-utils.mjs");
    const { buildReport, formatTable } = await import("./robust-go-no-go-report.mjs");
    const dateTag = new Date().toISOString().slice(0, 10);

    for (const taskRun of taskRuns) {
        if (!cfg.output.writePerCellJsonSummary && !cfg.output.writePerCellJsonReport && !cfg.output.writePerCellTableReport) {
            break;
        }
        const { records, warnings } = collectRecords(taskRun.runFiles);
        if (records.length === 0) continue;
        const summary = buildSummary(records);
        const report = buildReport(summary, cfg.policy);

        if (cfg.output.writePerCellJsonSummary) {
            const summaryPath = path.join(taskRun.runDir, `matrix-summary-${dateTag}.json`);
            fs.writeFileSync(summaryPath, JSON.stringify({
                generatedAt: new Date().toISOString(),
                inputFiles: taskRun.runFiles.map((p) => path.resolve(p)),
                recordCount: records.length,
                cellCount: summary.cells.length,
                warnings,
                summary,
            }, null, 2), "utf8");
            taskRun.summaryJsonPath = summaryPath;
        }
        if (cfg.output.writePerCellJsonReport) {
            const reportPath = path.join(taskRun.runDir, `go-no-go-${dateTag}.json`);
            fs.writeFileSync(reportPath, JSON.stringify({
                generatedAt: new Date().toISOString(),
                inputFiles: taskRun.runFiles.map((p) => path.resolve(p)),
                recordCount: records.length,
                cellCount: summary.cells.length,
                warnings,
                summary,
                report,
            }, null, 2), "utf8");
            taskRun.reportJsonPath = reportPath;
        }
        if (cfg.output.writePerCellTableReport) {
            const tablePath = path.join(taskRun.runDir, `go-no-go-${dateTag}.txt`);
            fs.writeFileSync(tablePath, formatTable(summary, report), "utf8");
            taskRun.reportTablePath = tablePath;
        }
    }

    const manifestPath = path.join(cfg.output.outDir, `batch-manifest-${dateTag}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        configPath,
        taskCount: taskRuns.length,
        seedCount: cfg.seeds.length,
        tasks: taskRuns.map((taskRun) => ({
            label: taskRun.task.label,
            symbol: taskRun.task.symbol,
            interval: taskRun.task.interval,
            tradeFilterMode: taskRun.task.tradeFilterMode,
            tradeDirection: taskRun.task.tradeDirection,
            strategyKeys: taskRun.task.strategyKeys,
            strategyParams: taskRun.task.strategyParams ?? null,
            runDir: taskRun.runDir,
            runFiles: taskRun.runFiles,
            summaryJsonPath: taskRun.summaryJsonPath ?? null,
            reportJsonPath: taskRun.reportJsonPath ?? null,
            reportTablePath: taskRun.reportTablePath ?? null,
        })),
    }, null, 2), "utf8");

    if (allRunFiles.length > 0) {
        const { records, warnings } = collectRecords(allRunFiles);
        if (records.length > 0) {
            const summary = buildSummary(records);
            const report = buildReport(summary, cfg.policy);

            if (cfg.output.writeBatchJsonSummary) {
                const summaryPath = path.join(cfg.output.outDir, `batch-matrix-summary-${dateTag}.json`);
                fs.writeFileSync(summaryPath, JSON.stringify({
                    generatedAt: new Date().toISOString(),
                    inputFiles: allRunFiles.map((p) => path.resolve(p)),
                    recordCount: records.length,
                    cellCount: summary.cells.length,
                    warnings,
                    summary,
                }, null, 2), "utf8");
            }
            if (cfg.output.writeBatchJsonReport) {
                const reportPath = path.join(cfg.output.outDir, `batch-go-no-go-${dateTag}.json`);
                fs.writeFileSync(reportPath, JSON.stringify({
                    generatedAt: new Date().toISOString(),
                    inputFiles: allRunFiles.map((p) => path.resolve(p)),
                    recordCount: records.length,
                    cellCount: summary.cells.length,
                    warnings,
                    summary,
                    report,
                }, null, 2), "utf8");
            }
            if (cfg.output.writeBatchTableReport) {
                const tablePath = path.join(cfg.output.outDir, `batch-go-no-go-${dateTag}.txt`);
                fs.writeFileSync(tablePath, formatTable(summary, report), "utf8");
            }
        }
    }

    console.log(`Batch complete. Tasks: ${taskRuns.length}, run files: ${allRunFiles.length}`);
    console.log(`Manifest: ${manifestPath}`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`robust-batch-runner failed: ${message}`);
    process.exitCode = 1;
});
