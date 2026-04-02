import fs from "node:fs/promises";
import path from "node:path";
import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import { selectLatestEntryExportCandles } from "../lib/latest-entry-export-window";
import { evaluateLatestEntrySignal, type EntrySignalEvaluationRequest } from "../lib/signal-entry-evaluator";
import { strategies } from "../lib/strategies/library";

type CliConfig = {
    symbol: string;
    interval: string;
    strategyKey: string;
    bars: number;
    outPath: string;
    freshnessBars: number;
    maxEntryDelaySecs: number;
    params: Record<string, number>;
    backtestSettings: Record<string, unknown>;
    capitalSettings: Record<string, unknown>;
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
    source: "strategy_finder_cli";
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyName: string;
    rawSignalCount: number;
    preparedSignalCount: number;
    polymarketEntryOffset?: number;
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
        "  npm run signal:export -- --strategy <key> [options]",
        "  ..\\..\\..\\node_modules\\.bin\\esno scripts\\export-latest-entry-signal.ts --strategy <key> [options]",
        "",
        "Options:",
        "  --strategy <key>              Required strategy key from lib/strategies/lib/*",
        "  --symbol <BTCUSDT>            Binance symbol (default: BTCUSDT)",
        "  --interval <5m>               Interval (default: 5m)",
        "  --bars <n>                    Candle lookback (default: 500)",
        "  --freshness-bars <n>          Signal freshness threshold in bars (default: 0)",
        "  --max-entry-delay-secs <n>    Null latestEntry when the actionable time is older than this (default: 120)",
        "  --params <json>               Inline strategy params JSON",
        "  --params-file <path>          Strategy params JSON file",
        "  --backtest-settings <json>    Inline backtest settings JSON",
        "  --backtest-settings-file <p>  Backtest settings JSON file",
        "  --capital-settings <json>     Inline capital settings JSON",
        "  --capital-settings-file <p>   Capital settings JSON file",
        "  --out <path>                  Output JSON path (default: ./signals/latest-entry-signal.json)",
        "",
        "Example:",
        "  npm run signal:export -- --strategy classic_nr7_breakout_surge --symbol BTCUSDT --interval 5m --params \"{\\\"lookback\\\":7}\"",
    ].join("\n"));
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(filePath, "utf8");
    const normalized = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Expected JSON object in ${filePath}`);
    }
    return parsed as Record<string, unknown>;
}

function parseObjectJson(raw: string, label: string): Record<string, unknown> {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

function normalizeNumberRecord(input: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(input)) {
        const num = Number(value);
        if (Number.isFinite(num)) {
            out[key] = num;
        }
    }
    return out;
}

function resolvePolymarketEntryOffset(backtestSettings: Record<string, unknown>): number | undefined {
    const value = Number(backtestSettings.polymarketEntryOffset);
    if (!Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(0, Math.min(4, Math.floor(value)));
}

async function parseArgs(argv: string[]): Promise<CliConfig | null> {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    let symbol = "BTCUSDT";
    let interval = "5m";
    let strategyKey = "";
    let bars = 500;
    let freshnessBars = 0;
    let maxEntryDelaySecs = 120;
    let outPath = path.resolve("signals", "latest-entry-signal.json");
    let params: Record<string, unknown> = {};
    let backtestSettings: Record<string, unknown> = {
        executionModel: "next_open",
        tradeDirection: "both",
    };
    let capitalSettings: Record<string, unknown> = {};
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (!arg.startsWith("--")) {
            positional.push(arg);
            continue;
        }
        if (arg === "--strategy") {
            strategyKey = String(next ?? "").trim();
            i++;
            continue;
        }
        if (arg === "--symbol") {
            symbol = String(next ?? "").trim().toUpperCase() || symbol;
            i++;
            continue;
        }
        if (arg === "--interval") {
            interval = String(next ?? "").trim().toLowerCase() || interval;
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
        if (arg === "--params") {
            params = parseObjectJson(String(next ?? "{}"), "--params");
            i++;
            continue;
        }
        if (arg === "--params-file") {
            params = await readJsonFile(path.resolve(String(next ?? "").trim()));
            i++;
            continue;
        }
        if (arg === "--backtest-settings") {
            backtestSettings = parseObjectJson(String(next ?? "{}"), "--backtest-settings");
            i++;
            continue;
        }
        if (arg === "--backtest-settings-file") {
            backtestSettings = await readJsonFile(path.resolve(String(next ?? "").trim()));
            i++;
            continue;
        }
        if (arg === "--capital-settings") {
            capitalSettings = parseObjectJson(String(next ?? "{}"), "--capital-settings");
            i++;
            continue;
        }
        if (arg === "--capital-settings-file") {
            capitalSettings = await readJsonFile(path.resolve(String(next ?? "").trim()));
            i++;
            continue;
        }
    }

    if (!strategyKey && positional.length > 0) {
        strategyKey = positional[0] ?? strategyKey;
        symbol = (positional[1] ?? symbol).trim().toUpperCase() || symbol;
        interval = (positional[2] ?? interval).trim().toLowerCase() || interval;
        const positionalBars = Number(positional[3]);
        if (Number.isFinite(positionalBars) && positionalBars > 0) {
            bars = Math.floor(positionalBars);
        }
        if ((positional[4] ?? "").trim()) {
            outPath = path.resolve(positional[4]);
        }
    }

    if (!strategyKey) {
        throw new Error("Missing required --strategy <key>.");
    }

    return {
        symbol,
        interval,
        strategyKey,
        bars: Math.max(50, bars),
        outPath,
        freshnessBars,
        maxEntryDelaySecs,
        params: normalizeNumberRecord(params),
        backtestSettings,
        capitalSettings,
    };
}

function toExportEntry(
    entry: NonNullable<ReturnType<typeof evaluateLatestEntrySignal>["latestEntry"]>,
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

    const strategy = strategies[config.strategyKey];
    if (!strategy) {
        throw new Error(`Unknown strategy "${config.strategyKey}".`);
    }

    const rawCandles = await fetchBinanceDataWithLimit(config.symbol, config.interval, config.bars);
    if (!rawCandles.length) {
        throw new Error(`No candles returned for ${config.symbol} ${config.interval}.`);
    }
    const candles = selectLatestEntryExportCandles(
        rawCandles,
        config.interval,
        config.backtestSettings,
        Math.floor(Date.now() / 1000)
    );
    if (!candles || candles.length < 2) {
        throw new Error(`Not enough closed candles returned for ${config.symbol} ${config.interval}.`);
    }

    const evaluationRequest: EntrySignalEvaluationRequest = {
        strategyKey: config.strategyKey,
        candles,
        strategyParams: config.params,
        backtestSettings: config.backtestSettings,
        capitalSettings: config.capitalSettings,
        freshnessBars: config.freshnessBars,
    };
    const result = evaluateLatestEntrySignal(evaluationRequest);
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
        source: "strategy_finder_cli",
        symbol: config.symbol,
        interval: config.interval,
        strategyKey: config.strategyKey,
        strategyName: strategy.name,
        rawSignalCount: result.rawSignalCount,
        preparedSignalCount: result.preparedSignalCount,
        polymarketEntryOffset: resolvePolymarketEntryOffset(config.backtestSettings),
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

    console.log(`[signal:export] wrote ${config.outPath}`);
    console.log(`[signal:export] ${config.symbol} ${config.interval} ${config.strategyKey} -> ${summary}`);
}

void main().catch((error) => {
    console.error(`[signal:export] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
