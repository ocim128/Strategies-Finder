import fs from "node:fs/promises";
import path from "node:path";
import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import {
    normalizeEnsembleRecipeReplayDirectionOverride,
    type EnsembleRecipeReplayDirectionOverride,
} from "../lib/ensemble-signal-direction";
import { selectLatestEntryExportCandles } from "../lib/latest-entry-export-window";
import { buildPreparedSignalsForEnsembleRecipe } from "../lib/ensemble-signal-recipes";
import { normalizeStoredEnsembleSignalRecipe } from "../lib/settings-model";
import { evaluateLatestEntrySignalFromPreparedSignals } from "../lib/signal-entry-evaluator";
import { strategies } from "../lib/strategies/library";
import { resolveCapitalSettingsFromRaw } from "../lib/backtest-capital-settings";

type CliConfig = {
    symbol: string;
    interval: string;
    bars: number;
    outPath: string;
    freshnessBars: number;
    recipePath: string;
    maxEntryDelaySecs: number;
    directionOverride: EnsembleRecipeReplayDirectionOverride;
};

type ExportEntry = {
    direction: "long" | "short";
    signalTimeSec: number;
    entryTimeSec: number | null;
    signalAgeBars: number;
    isFresh: boolean;
    fingerprint: string;
    signalPrice: number;
    entryPrice: number | null;
};

type ExportPayload = {
    schemaVersion: 1;
    generatedAt: string;
    generatedAtSec: number;
    source: "ensemble_signal_recipe_cli";
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyName: string;
    directionOverride: EnsembleRecipeReplayDirectionOverride;
    rawSignalCount: number;
    preparedSignalCount: number;
    latestEntry: null | ExportEntry;
    latestEntryCandidate?: null | ExportEntry;
    latestEntryState?:
        | "actionable"
        | "no_latest_entry"
        | "signal_not_fresh"
        | "entry_delay_exceeded"
        | "source_trade_still_open";
    pendingEntry?: null | ExportEntry;
    latestTrade: null | {
        entryTimeSec: number;
        entryPrice: number;
        exitReason: string | null;
        isOpen: boolean;
    };
};

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run signal:export:ensemble -- --recipe-file <path> [options]",
        "",
        "Options:",
        "  --recipe-file <path>          Required saved ensemble recipe JSON file",
        "  --symbol <BTCUSDT>            Binance symbol (default: recipe symbol)",
        "  --interval <5m>               Interval (default: recipe interval)",
        "  --bars <n>                    Candle lookback (default: 500)",
        "  --freshness-bars <n>          Signal freshness threshold in bars (default: 0)",
        "  --max-entry-delay-secs <n>    Null latestEntry when the actionable time is older than this (default: 120)",
        "  --direction-override <mode>   auto | short | long | combined (default: auto)",
        "  --out <path>                  Output JSON path (default: ./signals/latest-entry-signal.json)",
    ].join("\n"));
}

async function readRecipeFile(filePath: string) {
    const raw = await fs.readFile(filePath, "utf8");
    const normalized = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(normalized) as unknown;
    const recipe = normalizeStoredEnsembleSignalRecipe(parsed);
    if (!recipe) {
        throw new Error(`Invalid ensemble recipe JSON in ${filePath}`);
    }
    return recipe;
}

async function parseArgs(argv: string[]): Promise<CliConfig | null> {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    let recipePath = "";
    let symbol = "";
    let interval = "";
    let bars = 500;
    let freshnessBars = 0;
    let maxEntryDelaySecs = 120;
    let directionOverride: EnsembleRecipeReplayDirectionOverride = "auto";
    let outPath = path.resolve("signals", "latest-entry-signal.json");

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--recipe-file") {
            recipePath = path.resolve(String(next ?? "").trim());
            i++;
            continue;
        }
        if (arg === "--symbol") {
            symbol = String(next ?? "").trim().toUpperCase();
            i++;
            continue;
        }
        if (arg === "--interval") {
            interval = String(next ?? "").trim().toLowerCase();
            i++;
            continue;
        }
        if (arg === "--bars") {
            const value = Number(next);
            if (Number.isFinite(value) && value > 0) bars = Math.floor(value);
            i++;
            continue;
        }
        if (arg === "--freshness-bars") {
            const value = Number(next);
            if (Number.isFinite(value) && value >= 0) freshnessBars = Math.floor(value);
            i++;
            continue;
        }
        if (arg === "--max-entry-delay-secs") {
            const value = Number(next);
            if (Number.isFinite(value) && value >= 0) maxEntryDelaySecs = Math.floor(value);
            i++;
            continue;
        }
        if (arg === "--out") {
            outPath = path.resolve(String(next ?? "").trim() || outPath);
            i++;
            continue;
        }
        if (arg === "--direction-override") {
            directionOverride = normalizeEnsembleRecipeReplayDirectionOverride(next, "auto");
            i++;
            continue;
        }
    }

    if (!recipePath) {
        throw new Error("Missing required --recipe-file <path>.");
    }

    const recipe = await readRecipeFile(recipePath);

    return {
        recipePath,
        symbol: symbol || recipe.symbol,
        interval: interval || recipe.interval,
        bars: Math.max(50, bars),
        outPath,
        freshnessBars,
        maxEntryDelaySecs,
        directionOverride,
    };
}

function toExportEntry(
    entry: NonNullable<ReturnType<typeof evaluateLatestEntrySignalFromPreparedSignals>["latestEntry"]>,
    fallbackEntryPrice: number | null
): ExportEntry {
    return {
        direction: entry.direction,
        signalTimeSec: entry.signalTimeSec,
        entryTimeSec: entry.entryTimeSec,
        signalAgeBars: entry.signalAgeBars,
        isFresh: entry.isFresh,
        fingerprint: entry.fingerprint,
        signalPrice: entry.signal.price,
        entryPrice: entry.entryPrice ?? fallbackEntryPrice,
    };
}

function resolveLatestEntryExport(args: {
    latestEntry: ExportEntry | null;
    latestTrade: ExportPayload["latestTrade"];
    generatedAtSec: number;
    maxEntryDelaySecs: number;
}): {
    latestEntry: ExportEntry | null;
    latestEntryCandidate: ExportEntry | null;
    latestEntryState: NonNullable<ExportPayload["latestEntryState"]>;
} {
    const candidate = args.latestEntry;
    if (!candidate) {
        return {
            latestEntry: null,
            latestEntryCandidate: null,
            latestEntryState: "no_latest_entry",
        };
    }

    if (!(candidate.isFresh || candidate.signalAgeBars <= 3)) {
        return {
            latestEntry: null,
            latestEntryCandidate: candidate,
            latestEntryState: "signal_not_fresh",
        };
    }

    const actionableTimeSec = candidate.entryTimeSec ?? candidate.signalTimeSec;
    const delaySecs = Math.max(0, args.generatedAtSec - actionableTimeSec);
    if (args.latestTrade?.isOpen && actionableTimeSec <= args.latestTrade.entryTimeSec && delaySecs > args.maxEntryDelaySecs) {
        return {
            latestEntry: null,
            latestEntryCandidate: candidate,
            latestEntryState: "source_trade_still_open",
        };
    }

    if (delaySecs > args.maxEntryDelaySecs) {
        return {
            latestEntry: null,
            latestEntryCandidate: candidate,
            latestEntryState: "entry_delay_exceeded",
        };
    }

    return {
        latestEntry: candidate,
        latestEntryCandidate: candidate,
        latestEntryState: "actionable",
    };
}

async function main(): Promise<void> {
    const config = await parseArgs(process.argv.slice(2));
    if (!config) return;

    const recipe = await readRecipeFile(config.recipePath);
    const rawCandles = await fetchBinanceDataWithLimit(config.symbol, config.interval, config.bars);
    if (!rawCandles.length) {
        throw new Error(`No candles returned for ${config.symbol} ${config.interval}.`);
    }
    const candles = selectLatestEntryExportCandles(
        rawCandles,
        config.interval,
        recipe.anchorConfig.backtestSettings ?? { executionModel: "next_open" },
        Math.floor(Date.now() / 1000)
    );
    if (!candles || candles.length < 2) {
        throw new Error(`Not enough closed candles returned for ${config.symbol} ${config.interval}.`);
    }

    const resolved = buildPreparedSignalsForEnsembleRecipe({
        recipe: {
            ...recipe,
            symbol: config.symbol,
            interval: config.interval,
        },
        candles,
        getStrategy: (strategyKey) => strategies[strategyKey],
        directionOverride: config.directionOverride,
    });
    const capitalSettings = resolveCapitalSettingsFromRaw(resolved.anchorConfig.backtestSettings);
    const result = evaluateLatestEntrySignalFromPreparedSignals({
        strategyKey: `ensemble_recipe:${recipe.mode}`,
        strategyName: recipe.name,
        candles,
        preparedSignals: resolved.preparedSignals,
        backtestSettings: resolved.anchorConfig.backtestSettings,
        capitalSettings,
        freshnessBars: config.freshnessBars,
    });

    if (!result.ok && result.reason !== "no_signals") {
        throw new Error(`Signal evaluation failed: ${result.reason ?? "unknown_error"}`);
    }

    const generatedAt = new Date();
    const generatedAtSec = Math.floor(generatedAt.getTime() / 1000);
    const latestTrade = result.latestTrade
        ? {
            entryTimeSec: result.latestTrade.entryTimeSec,
            entryPrice: result.latestTrade.entryPrice,
            exitReason: result.latestTrade.exitReason,
            isOpen: result.latestTrade.isOpen,
        }
        : null;
    const latestEntryCandidate = result.latestEntry
        ? toExportEntry(result.latestEntry, result.latestTrade?.entryPrice ?? null)
        : null;
    const pendingEntry = result.pendingEntry
        ? toExportEntry(result.pendingEntry, null)
        : null;
    const latestEntryExport = resolveLatestEntryExport({
        latestEntry: latestEntryCandidate,
        latestTrade,
        generatedAtSec,
        maxEntryDelaySecs: config.maxEntryDelaySecs,
    });
    const payload: ExportPayload = {
        schemaVersion: 1,
        generatedAt: generatedAt.toISOString(),
        generatedAtSec,
        source: "ensemble_signal_recipe_cli",
        symbol: config.symbol,
        interval: config.interval,
        strategyKey: `ensemble_recipe:${recipe.mode}`,
        strategyName: recipe.name,
        directionOverride: config.directionOverride,
        rawSignalCount: result.rawSignalCount,
        preparedSignalCount: result.preparedSignalCount,
        latestEntry: latestEntryExport.latestEntry,
        latestEntryCandidate,
        latestEntryState: latestEntryExport.latestEntryState,
        pendingEntry,
        latestTrade,
    };

    await fs.mkdir(path.dirname(config.outPath), { recursive: true });
    await fs.writeFile(config.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const summary = payload.latestEntry
        ? `${payload.latestEntry.direction} signal=${payload.latestEntry.signalTimeSec} entry=${payload.latestEntry.entryTimeSec ?? "n/a"} age=${payload.latestEntry.signalAgeBars} fresh=${payload.latestEntry.isFresh}`
        : `no actionable latest entry (${payload.latestEntryState ?? "unknown"})`;

    console.log(`[signal:export:ensemble] wrote ${config.outPath}`);
    console.log(`[signal:export:ensemble] ${config.symbol} ${config.interval} ${recipe.name} -> ${summary}`);
}

void main().catch((error) => {
    console.error(`[signal:export:ensemble] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
