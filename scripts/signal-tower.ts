import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import { getOpenPositionForScanner, prepareSignalsForScanner, timeKey } from "../lib/strategies/index";
import { strategies } from "../lib/strategies/library";
import type {
    BacktestSettings,
    OHLCVData,
    Strategy,
    StrategyParams,
    TradeDirection,
} from "../lib/types/strategies";

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
    drift?: number;
    parameterDrift?: { changedParamRatePerWindow?: number };
};

type AlphaSymbolEntry = {
    symbol?: string;
    interval?: string;
    quoteVolume?: number;
    bars?: number;
    dataFile?: string;
    hunts?: Array<{
        strategyKey?: string;
        fitness?: {
            score?: number;
            netProfitPercent?: number;
            sharpeRatio?: number;
            stability?: number;
            maxDrawdownPercent?: number;
            totalTrades?: number;
            drift?: number;
        };
    }>;
    winner?: {
        strategyKey?: string;
        fitness?: {
            score?: number;
            netProfitPercent?: number;
            sharpeRatio?: number;
            stability?: number;
            maxDrawdownPercent?: number;
            totalTrades?: number;
            drift?: number;
        };
    };
};

type AlphaReport = {
    generatedAt?: string;
    winners?: AlphaWinner[];
    symbols?: AlphaSymbolEntry[];
};

type SuperAlpha = {
    symbol: string;
    interval: string;
    strategyKey: string;
    params: StrategyParams;
    quoteVolume: number;
    netProfitPercent: number;
    sharpeRatio: number;
    maxDrawdownPercent: number;
    totalTrades: number;
    drift: number;
    robustScore: number;
    dataFile?: string;
};

type TowerAssetState = {
    alpha: SuperAlpha;
    strategy: Strategy;
    data: OHLCVData[];
    lastClosedTime: number;
};

type ActiveSignal = {
    id: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    action: "entry" | "exit" | "flip" | "signal";
    side: "buy" | "sell";
    price: number;
    barTime: number;
    detectedAt: string;
    reason?: string;
    robustScore: number;
    quoteVolume: number;
    params: StrategyParams;
};

type TowerOptions = {
    reportPath: string;
    outPath: string;
    topN: number;
    interval: string;
    pollSeconds: number;
    historyBars: number;
    minVolume: number;
    maxDrawdownPercent: number;
    minTrades: number;
    dataDir: string;
    once: boolean;
};

const DEFAULTS: TowerOptions = {
    reportPath: path.resolve("verified_alpha.json"),
    outPath: path.resolve("active_signals.json"),
    topN: 3,
    interval: "15m",
    pollSeconds: 60,
    historyBars: 1000,
    minVolume: 50_000_000,
    maxDrawdownPercent: 35,
    minTrades: 10,
    dataDir: path.resolve("price-data", "universal"),
    once: false,
};

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toNumberOr(value: unknown, fallback = 0): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function parseArgs(argv: string[]): TowerOptions & { help?: boolean } {
    const options: TowerOptions = { ...DEFAULTS };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") return { ...options, help: true };
        if (arg === "--report") { options.reportPath = path.resolve(String(next ?? options.reportPath)); i++; continue; }
        if (arg === "--out") { options.outPath = path.resolve(String(next ?? options.outPath)); i++; continue; }
        if (arg === "--top") { options.topN = Math.max(1, Math.floor(toNumberOr(next, options.topN))); i++; continue; }
        if (arg === "--interval") { options.interval = String(next ?? options.interval).trim() || options.interval; i++; continue; }
        if (arg === "--poll-seconds") { options.pollSeconds = Math.max(5, Math.floor(toNumberOr(next, options.pollSeconds))); i++; continue; }
        if (arg === "--history") { options.historyBars = Math.max(200, Math.floor(toNumberOr(next, options.historyBars))); i++; continue; }
        if (arg === "--min-volume") { options.minVolume = Math.max(0, toNumberOr(next, options.minVolume)); i++; continue; }
        if (arg === "--max-dd") { options.maxDrawdownPercent = Math.max(0, toNumberOr(next, options.maxDrawdownPercent)); i++; continue; }
        if (arg === "--min-trades") { options.minTrades = Math.max(0, Math.floor(toNumberOr(next, options.minTrades))); i++; continue; }
        if (arg === "--data-dir") { options.dataDir = path.resolve(String(next ?? options.dataDir)); i++; continue; }
        if (arg === "--once") { options.once = true; continue; }
        positional.push(arg);
    }

    if (positional[0]) {
        const first = positional[0];
        const firstAsNumber = Number(first);
        const looksLikeReport = first.toLowerCase().endsWith(".json") || fs.existsSync(path.resolve(first));
        if (looksLikeReport || !Number.isFinite(firstAsNumber)) {
            options.reportPath = path.resolve(first);
            if (positional[1]) options.topN = Math.max(1, Math.floor(toNumberOr(positional[1], options.topN)));
            if (positional[2]) options.pollSeconds = Math.max(5, Math.floor(toNumberOr(positional[2], options.pollSeconds)));
        } else {
            options.topN = Math.max(1, Math.floor(firstAsNumber));
            if (positional[1]) options.pollSeconds = Math.max(5, Math.floor(toNumberOr(positional[1], options.pollSeconds)));
        }
    }
    return options;
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run signal:tower",
        "",
        "Options:",
        "  --report <path>         Verified alpha report path (default: verified_alpha.json)",
        "  --out <path>            Active signals output (default: active_signals.json)",
        "  --top <n>               Super-alphas to watch (default: 3)",
        "  --interval <value>      Candle interval (default: 15m)",
        "  --poll-seconds <n>      Poll cadence seconds (default: 60)",
        "  --history <n>           Rolling bars in memory (default: 1000)",
        "  --min-volume <n>        Min quote volume filter (default: 50000000)",
        "  --max-dd <n>            Max drawdown filter % (default: 35)",
        "  --min-trades <n>        Min trades filter (default: 10)",
        "  --once                  Execute one cycle and exit",
    ].join("\n"));
}

function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseBarsFromDataFile(filePath: string): OHLCVData[] {
    const raw = readJson(filePath);
    const rows = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data))
            ? (raw as Record<string, unknown>).data as unknown[]
            : [];
    const parsed: OHLCVData[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const timeRaw = toNumberOr(rec.time, NaN);
        const time = Number.isFinite(timeRaw) ? (timeRaw > 1e12 ? Math.floor(timeRaw / 1000) : Math.floor(timeRaw)) : NaN;
        const open = toNumberOr(rec.open, NaN);
        const high = toNumberOr(rec.high, NaN);
        const low = toNumberOr(rec.low, NaN);
        const close = toNumberOr(rec.close, NaN);
        const volume = toNumberOr(rec.volume, 0);
        if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
        parsed.push({ time: time as unknown as OHLCVData["time"], open, high, low, close, volume });
    }
    parsed.sort((a, b) => Number(a.time) - Number(b.time));
    const deduped: OHLCVData[] = [];
    for (const bar of parsed) {
        const last = deduped[deduped.length - 1];
        if (last && Number(last.time) === Number(bar.time)) deduped[deduped.length - 1] = bar;
        else deduped.push(bar);
    }
    return deduped;
}

function extractDrift(winner: AlphaWinner, symbolEntry?: AlphaSymbolEntry): number {
    const explicitDrift = toNumberOr(winner.drift, NaN);
    if (Number.isFinite(explicitDrift)) return Math.abs(explicitDrift);

    const winnerHunt = symbolEntry?.hunts?.find((hunt) => hunt.strategyKey === winner.strategyKey);
    const huntDrift = toNumberOr(winnerHunt?.fitness?.drift, NaN);
    if (Number.isFinite(huntDrift)) return Math.abs(huntDrift);

    const changedParamRate = toNumberOr(winner.parameterDrift?.changedParamRatePerWindow, NaN);
    if (Number.isFinite(changedParamRate)) return Math.abs(changedParamRate);

    const trades = Math.max(1, toNumberOr(winner.totalTrades, winnerHunt?.fitness?.totalTrades ?? 0));
    // Drift proxy: sparse trade count implies higher parameter fragility.
    return 1 / Math.sqrt(trades);
}

function computeRobustScore(candidate: {
    netProfitPercent: number;
    sharpeRatio: number;
    maxDrawdownPercent: number;
    drift: number;
}): number {
    const netTerm = candidate.netProfitPercent * 0.7;
    const sharpeTerm = candidate.sharpeRatio * 25;
    const ddPenalty = candidate.maxDrawdownPercent * 0.8;
    const driftPenalty = candidate.drift * 20;
    return netTerm + sharpeTerm - ddPenalty - driftPenalty;
}

function selectSuperAlphas(reportPath: string, options: TowerOptions): SuperAlpha[] {
    const report = readJson(reportPath) as AlphaReport;
    const winners = Array.isArray(report.winners) ? report.winners : [];
    const symbols = Array.isArray(report.symbols) ? report.symbols : [];
    const symbolMap = new Map<string, AlphaSymbolEntry>();
    for (const symbol of symbols) {
        if (typeof symbol.symbol === "string" && symbol.symbol.trim()) {
            symbolMap.set(symbol.symbol.trim().toUpperCase(), symbol);
        }
    }

    const candidates: SuperAlpha[] = [];
    for (const winner of winners) {
        const symbol = String(winner.symbol ?? "").trim().toUpperCase();
        const strategyKey = String(winner.strategyKey ?? "").trim();
        if (!symbol || !strategyKey || !winner.alphaGenome) continue;
        const symbolEntry = symbolMap.get(symbol);
        const quoteVolume = toNumberOr(symbolEntry?.quoteVolume, 0);
        const netProfitPercent = toNumberOr(winner.netProfitPercent, 0);
        const sharpeRatio = toNumberOr(winner.sharpeRatio, 0);
        const maxDrawdownPercent = toNumberOr(winner.maxDrawdownPercent, 1000);
        const totalTrades = Math.max(0, Math.floor(toNumberOr(winner.totalTrades, 0)));
        const drift = extractDrift(winner, symbolEntry);
        const robustScore = computeRobustScore({ netProfitPercent, sharpeRatio, maxDrawdownPercent, drift });

        candidates.push({
            symbol,
            interval: String(winner.interval ?? symbolEntry?.interval ?? options.interval).trim() || options.interval,
            strategyKey,
            params: winner.alphaGenome,
            quoteVolume,
            netProfitPercent,
            sharpeRatio,
            maxDrawdownPercent,
            totalTrades,
            drift,
            robustScore,
            dataFile: typeof symbolEntry?.dataFile === "string" ? symbolEntry.dataFile : undefined,
        });
    }

    const filtered = candidates.filter((item) =>
        item.quoteVolume >= options.minVolume &&
        item.maxDrawdownPercent <= options.maxDrawdownPercent &&
        item.totalTrades >= options.minTrades &&
        item.sharpeRatio > 0
    );
    const source = filtered.length >= options.topN ? filtered : candidates;
    source.sort((a, b) => b.robustScore - a.robustScore);
    return source.slice(0, options.topN);
}

async function fetchClosedCandlesAfter(symbol: string, interval: string, afterTimeSec: number): Promise<OHLCVData[]> {
    const params = new URLSearchParams({
        symbol,
        interval,
        limit: "200",
    });
    if (afterTimeSec > 0) {
        params.set("startTime", String((afterTimeSec + 1) * 1000));
    }
    const response = await fetch(`https://api.binance.com/api/v3/klines?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`[SignalTower] Binance klines failed for ${symbol}: HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) return [];
    const now = Date.now();
    const candles: OHLCVData[] = [];
    for (const row of payload) {
        if (!Array.isArray(row) || row.length < 7) continue;
        const openTimeMs = Number(row[0]);
        const closeTimeMs = Number(row[6]);
        if (!Number.isFinite(openTimeMs) || !Number.isFinite(closeTimeMs)) continue;
        // Keep only fully closed bars.
        if (closeTimeMs > now - 500) continue;
        const timeSec = Math.floor(openTimeMs / 1000);
        if (timeSec <= afterTimeSec) continue;
        const open = toNumberOr(row[1], NaN);
        const high = toNumberOr(row[2], NaN);
        const low = toNumberOr(row[3], NaN);
        const close = toNumberOr(row[4], NaN);
        const volume = toNumberOr(row[5], 0);
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
        candles.push({
            time: timeSec as unknown as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume,
        });
    }
    candles.sort((a, b) => Number(a.time) - Number(b.time));
    return candles;
}

async function buildInitialState(alpha: SuperAlpha, options: TowerOptions): Promise<TowerAssetState | null> {
    const strategy = (strategies as Record<string, Strategy>)[alpha.strategyKey];
    if (!strategy) {
        console.warn(`[SignalTower] Strategy not found for ${alpha.symbol}: ${alpha.strategyKey}`);
        return null;
    }

    let bars: OHLCVData[] = [];
    const preferredFile = alpha.dataFile ? path.resolve(alpha.dataFile) : path.resolve(options.dataDir, `${alpha.symbol}-${alpha.interval}.json`);
    if (fs.existsSync(preferredFile)) {
        bars = parseBarsFromDataFile(preferredFile);
    }
    if (bars.length === 0) {
        bars = await fetchBinanceDataWithLimit(alpha.symbol, alpha.interval, options.historyBars, {
            requestDelayMs: 30,
            maxRequests: Math.ceil(options.historyBars / 1000) + 2,
        });
    }
    if (bars.length === 0) {
        console.warn(`[SignalTower] No initial bars for ${alpha.symbol}.`);
        return null;
    }

    const trimmed = bars.slice(-options.historyBars);
    return {
        alpha,
        strategy,
        data: trimmed,
        lastClosedTime: Number(trimmed[trimmed.length - 1].time),
    };
}

function inferTradeDirection(strategy: Strategy): TradeDirection {
    const direction = strategy.metadata?.direction;
    if (direction === "short" || direction === "both" || direction === "long") return direction;
    return "long";
}

function buildBacktestSettings(state: TowerAssetState): BacktestSettings {
    return {
        tradeDirection: inferTradeDirection(state.strategy),
        executionModel: "signal_close",
        tradeFilterMode: "none",
        allowSameBarExit: true,
        slippageBps: 0,
    };
}

function classifySignalAction(prevOpen: ReturnType<typeof getOpenPositionForScanner>, currOpen: ReturnType<typeof getOpenPositionForScanner>): ActiveSignal["action"] {
    if (!prevOpen && currOpen) return "entry";
    if (prevOpen && !currOpen) return "exit";
    if (prevOpen && currOpen && prevOpen.direction !== currOpen.direction) return "flip";
    return "signal";
}

function evaluateLatestSignals(state: TowerAssetState): ActiveSignal[] {
    if (state.data.length < 50) return [];
    const settings = buildBacktestSettings(state);
    const rawSignals = state.strategy.execute(state.data, state.alpha.params);
    const preparedSignals = prepareSignalsForScanner(state.data, rawSignals, settings);
    const lastBar = state.data[state.data.length - 1];
    const lastBarKey = timeKey(lastBar.time);
    const latestSignals = preparedSignals.filter((signal) => timeKey(signal.time) === lastBarKey);
    if (latestSignals.length === 0) return [];

    const prevData = state.data.slice(0, -1);
    const prevSignals = prevData.length > 0 ? state.strategy.execute(prevData, state.alpha.params) : [];
    const prevOpen = prevData.length > 0 ? getOpenPositionForScanner(prevData, prevSignals, settings) : null;
    const currOpen = getOpenPositionForScanner(state.data, rawSignals, settings);
    const action = classifySignalAction(prevOpen, currOpen);

    const detectedAt = new Date().toISOString();
    return latestSignals.map((signal) => ({
        id: `${state.alpha.symbol}|${state.alpha.strategyKey}|${action}|${signal.type}|${Number(signal.time)}`,
        symbol: state.alpha.symbol,
        interval: state.alpha.interval,
        strategyKey: state.alpha.strategyKey,
        action,
        side: signal.type,
        price: signal.price,
        barTime: Number(signal.time),
        detectedAt,
        reason: signal.reason,
        robustScore: state.alpha.robustScore,
        quoteVolume: state.alpha.quoteVolume,
        params: state.alpha.params,
    }));
}

function writeActiveSignalsFile(
    options: TowerOptions,
    watchlist: TowerAssetState[],
    activeSignals: ActiveSignal[],
    cycleAt: string
): void {
    const payload = {
        generatedAt: new Date().toISOString(),
        cycleAt,
        pollSeconds: options.pollSeconds,
        interval: options.interval,
        watchlist: watchlist.map((item) => ({
            symbol: item.alpha.symbol,
            strategyKey: item.alpha.strategyKey,
            robustScore: item.alpha.robustScore,
            quoteVolume: item.alpha.quoteVolume,
            lastClosedTime: item.lastClosedTime,
            lastClose: item.data[item.data.length - 1]?.close ?? null,
        })),
        activeSignals: activeSignals
            .slice()
            .sort((a, b) => b.barTime - a.barTime)
            .map((signal) => ({
                ...signal,
                barTimeIso: new Date(signal.barTime * 1000).toISOString(),
            })),
    };
    fs.writeFileSync(options.outPath, JSON.stringify(payload, null, 2), "utf8");
}

async function runSignalTower(options: TowerOptions): Promise<void> {
    if (!fs.existsSync(options.reportPath)) {
        throw new Error(`[SignalTower] Verified alpha report not found: ${options.reportPath}`);
    }

    const selected = selectSuperAlphas(options.reportPath, options);
    if (selected.length === 0) {
        throw new Error("[SignalTower] No Super-Alphas passed selection.");
    }
    console.log("[SignalTower] Super-Alphas:");
    for (const alpha of selected) {
        console.log(
            `  ${alpha.symbol} ${alpha.strategyKey} score=${alpha.robustScore.toFixed(3)} net=${alpha.netProfitPercent.toFixed(2)}% dd=${alpha.maxDrawdownPercent.toFixed(2)}% drift=${alpha.drift.toFixed(4)} vol=${alpha.quoteVolume.toFixed(0)}`
        );
    }

    const states: TowerAssetState[] = [];
    for (const alpha of selected) {
        const state = await buildInitialState(alpha, options);
        if (state) states.push(state);
    }
    if (states.length === 0) {
        throw new Error("[SignalTower] No asset states initialized.");
    }

    let keepRunning = true;
    process.on("SIGINT", () => { keepRunning = false; });
    process.on("SIGTERM", () => { keepRunning = false; });

    const activeByAsset = new Map<string, ActiveSignal>();
    while (keepRunning) {
        const cycleStarted = Date.now();
        const cycleAt = new Date(cycleStarted).toISOString();
        for (const state of states) {
            try {
                const newBars = await fetchClosedCandlesAfter(state.alpha.symbol, state.alpha.interval, state.lastClosedTime);
                if (newBars.length === 0) continue;

                for (const bar of newBars) {
                    state.data.push(bar);
                    if (state.data.length > options.historyBars) {
                        state.data = state.data.slice(-options.historyBars);
                    }
                    state.lastClosedTime = Number(bar.time);

                    const emitted = evaluateLatestSignals(state);
                    for (const signal of emitted) {
                        const assetKey = `${signal.symbol}|${signal.strategyKey}`;
                        const previous = activeByAsset.get(assetKey);
                        if (!previous || previous.id !== signal.id) {
                            activeByAsset.set(assetKey, signal);
                            const sideLabel = signal.side.toUpperCase();
                            console.log(`⚡ SIGNAL DETECTED: [${sideLabel}] ${signal.symbol} @ ${signal.price}`);
                        }
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[SignalTower] Poll error for ${state.alpha.symbol}: ${message}`);
            }
        }

        writeActiveSignalsFile(options, states, Array.from(activeByAsset.values()), cycleAt);
        if (options.once) break;

        const elapsed = Date.now() - cycleStarted;
        const sleepMs = options.pollSeconds * 1000 - elapsed;
        if (sleepMs > 0) {
            await wait(sleepMs);
        }
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    await runSignalTower(options);
    if (options.once) {
        process.exit(0);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`signal-tower failed: ${message}`);
        process.exitCode = 1;
    });
}
