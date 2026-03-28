import fs from "node:fs/promises";
import path from "node:path";
import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
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
    rawSignalCount: number;
    preparedSignalCount: number;
    latestEntry: null | {
        direction: "long" | "short";
        signalTimeSec: number;
        entryTimeSec: number | null;
        signalAgeBars: number;
        isFresh: boolean;
        fingerprint: string;
        signalPrice: number;
        entryPrice: number | null;
    };
    pendingEntry?: null | {
        direction: "long" | "short";
        signalTimeSec: number;
        entryTimeSec: number | null;
        signalAgeBars: number;
        isFresh: boolean;
        fingerprint: string;
        signalPrice: number;
        entryPrice: number | null;
    };
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
        if (arg === "--out") {
            outPath = path.resolve(String(next ?? "").trim() || outPath);
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
    };
}

async function main(): Promise<void> {
    const config = await parseArgs(process.argv.slice(2));
    if (!config) return;

    const recipe = await readRecipeFile(config.recipePath);
    const candles = await fetchBinanceDataWithLimit(config.symbol, config.interval, config.bars);
    if (!candles.length) {
        throw new Error(`No candles returned for ${config.symbol} ${config.interval}.`);
    }

    const resolved = buildPreparedSignalsForEnsembleRecipe({
        recipe: {
            ...recipe,
            symbol: config.symbol,
            interval: config.interval,
        },
        candles,
        getStrategy: (strategyKey) => strategies[strategyKey],
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
    const payload: ExportPayload = {
        schemaVersion: 1,
        generatedAt: generatedAt.toISOString(),
        generatedAtSec: Math.floor(generatedAt.getTime() / 1000),
        source: "ensemble_signal_recipe_cli",
        symbol: config.symbol,
        interval: config.interval,
        strategyKey: `ensemble_recipe:${recipe.mode}`,
        strategyName: recipe.name,
        rawSignalCount: result.rawSignalCount,
        preparedSignalCount: result.preparedSignalCount,
        latestEntry: result.latestEntry
            ? {
                direction: result.latestEntry.direction,
                signalTimeSec: result.latestEntry.signalTimeSec,
                entryTimeSec: result.latestEntry.entryTimeSec,
                signalAgeBars: result.latestEntry.signalAgeBars,
                isFresh: result.latestEntry.isFresh,
                fingerprint: result.latestEntry.fingerprint,
                signalPrice: result.latestEntry.signal.price,
                entryPrice: result.latestEntry.entryPrice ?? result.latestTrade?.entryPrice ?? null,
            }
            : null,
        pendingEntry: result.pendingEntry
            ? {
                direction: result.pendingEntry.direction,
                signalTimeSec: result.pendingEntry.signalTimeSec,
                entryTimeSec: result.pendingEntry.entryTimeSec,
                signalAgeBars: result.pendingEntry.signalAgeBars,
                isFresh: result.pendingEntry.isFresh,
                fingerprint: result.pendingEntry.fingerprint,
                signalPrice: result.pendingEntry.signal.price,
                entryPrice: result.pendingEntry.entryPrice ?? null,
            }
            : null,
        latestTrade: result.latestTrade
            ? {
                entryTimeSec: result.latestTrade.entryTimeSec,
                entryPrice: result.latestTrade.entryPrice,
                exitReason: result.latestTrade.exitReason,
                isOpen: result.latestTrade.isOpen,
            }
            : null,
    };

    await fs.mkdir(path.dirname(config.outPath), { recursive: true });
    await fs.writeFile(config.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const summary = payload.latestEntry
        ? `${payload.latestEntry.direction} signal=${payload.latestEntry.signalTimeSec} entry=${payload.latestEntry.entryTimeSec ?? "n/a"} age=${payload.latestEntry.signalAgeBars} fresh=${payload.latestEntry.isFresh}`
        : "no latest entry";

    console.log(`[signal:export:ensemble] wrote ${config.outPath}`);
    console.log(`[signal:export:ensemble] ${config.symbol} ${config.interval} ${recipe.name} -> ${summary}`);
}

void main().catch((error) => {
    console.error(`[signal:export:ensemble] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
