import { openSecondMarketDb, upsertSecondDataQualityRun } from "../lib/second-market/db";
import {
    loadBinance1sCandles,
    loadPolymarketClob1sQuotes,
    loadPolymarketGammaSnapshots,
    loadPolymarketReference1sPrices,
} from "../lib/second-market/loaders";
import { syncBinance1sRange } from "../lib/second-market/binance-1s-sync";
import { syncGammaSnapshots } from "../lib/second-market/polymarket-gamma-sync";
import {
    runPolymarketClobCapture,
    selectClobSubscriptionEvents,
} from "../lib/second-market/polymarket-clob-sync";
import { runPolymarketReferenceCapture } from "../lib/second-market/polymarket-reference-sync";
import { buildSecondDataQualityRun } from "../lib/second-market/quality-report";
import {
    DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    getPolymarketOutcomeIntervalDurationSec,
    resolvePolymarketOutcomeInterval,
    type PolymarketOutcomeInterval,
} from "../lib/polymarket-outcome-interval";
import { parseSecondMarketSymbolList } from "../lib/second-market/symbols";
import type {
    SecondMarketPolymarketEvent,
    SecondMarketReferenceSource,
    SecondMarketSymbol,
} from "../lib/second-market/types";

type MinerMode = "backfill" | "live" | "verify";

const GAMMA_LIVE_POLL_MS = 30_000;
const CLOB_SUBSCRIPTION_REFRESH_SEC = 60;
const CLOB_SUBSCRIPTION_HORIZON_MULTIPLIER = 3;

type CliConfig = {
    mode: MinerMode;
    dbPath?: string;
    symbols: SecondMarketSymbol[];
    marketType: "spot" | "futures";
    outcomeInterval: PolymarketOutcomeInterval;
    startTs: number;
    endTs: number;
    durationSec: number | null;
    includeBinance: boolean;
    includeClob: boolean;
    includeReference: boolean;
    includeGamma: boolean;
    referenceSources: SecondMarketReferenceSource[];
    requestDelayMs: number;
};

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function parseIsoSec(value: string | undefined): number | null {
    if (!value) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.floor(numeric);
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function parseNumber(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function parseReferenceSources(value: string | undefined): SecondMarketReferenceSource[] {
    if (!value) return ["crypto_prices"];
    const out = value
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is SecondMarketReferenceSource =>
            item === "crypto_prices" || item === "crypto_prices_chainlink"
        );
    return out.length > 0 ? Array.from(new Set(out)) : ["crypto_prices"];
}

function looksLikeDbPath(value: string): boolean {
    return /[\\/]/.test(value) || /\.(sqlite|sqlite3|db)$/i.test(value);
}

function splitSymbolTokens(value: string): string[] {
    return value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (ms <= 0 || signal?.aborted) {
            resolve();
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run mine:1s -- --mode backfill --symbols BTCUSDT,XRPUSDT --start-date 2026-05-13T00:00:00Z --end-date 2026-05-13T01:00:00Z",
        "  npm run mine:1s -- backfill BTCUSDT,XRPUSDT futures 2026-05-13T00:00:00Z 2026-05-13T01:00:00Z",
        "  npm run mine:1s -- --mode live --symbols BTCUSDT,XRPUSDT --duration-sec 300",
        "  npm run mine:1s -- --mode verify --symbols BTCUSDT,XRPUSDT --start-date 2026-05-13T00:00:00Z --end-date 2026-05-13T01:00:00Z",
        "",
        "Options:",
        "  --mode <backfill|live|verify>",
        "  --symbols <BTCUSDT,XRPUSDT>",
        "  --db <path>",
        "  --market-type <spot|futures>",
        "  --outcome-interval <5m|15m|1h>",
        "  --start-date <iso|unix-sec>",
        "  --end-date <iso|unix-sec>",
        "  --duration-sec <n>",
        "  --include-binance",
        "  --include-clob",
        "  --include-reference",
        "  --include-gamma",
        "  --reference-sources <crypto_prices,crypto_prices_chainlink>",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliConfig {
    let mode: MinerMode = "verify";
    let dbPath: string | undefined;
    let symbols = parseSecondMarketSymbolList("");
    let marketType: "spot" | "futures" = "spot";
    let outcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL;
    let startTs = nowSec() - 3600;
    let endTs = nowSec() - 2;
    let durationSec: number | null = null;
    let includeBinance = false;
    let includeClob = false;
    let includeReference = false;
    let includeGamma = false;
    let referenceSources: SecondMarketReferenceSource[] = ["crypto_prices"];
    let requestDelayMs = 80;
    let hasDbPath = false;
    let hasSymbols = false;
    let hasMarketType = false;
    let hasStartTs = false;
    let hasEndTs = false;
    let positionals: string[] = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
        if (arg === "--mode") {
            const value = String(next ?? "").trim();
            if (value === "backfill" || value === "live" || value === "verify") mode = value;
            i += 1;
            continue;
        }
        if (arg === "--db") { dbPath = String(next ?? "").trim() || undefined; hasDbPath = true; i += 1; continue; }
        if (arg === "--symbols") { symbols = parseSecondMarketSymbolList(next ?? ""); hasSymbols = true; i += 1; continue; }
        if (arg === "--market-type") {
            marketType = String(next ?? "").trim().toLowerCase() === "futures" ? "futures" : "spot";
            hasMarketType = true;
            i += 1;
            continue;
        }
        if (arg === "--outcome-interval") {
            outcomeInterval = resolvePolymarketOutcomeInterval(next);
            i += 1;
            continue;
        }
        if (arg === "--start-date") { startTs = parseIsoSec(next) ?? startTs; hasStartTs = true; i += 1; continue; }
        if (arg === "--end-date") { endTs = parseIsoSec(next) ?? endTs; hasEndTs = true; i += 1; continue; }
        if (arg === "--duration-sec") { durationSec = Math.max(1, Math.floor(parseNumber(next, 0))); i += 1; continue; }
        if (arg === "--request-delay-ms") { requestDelayMs = Math.max(0, Math.floor(parseNumber(next, requestDelayMs))); i += 1; continue; }
        if (arg === "--include-binance") { includeBinance = true; continue; }
        if (arg === "--include-clob") { includeClob = true; continue; }
        if (arg === "--include-reference") { includeReference = true; continue; }
        if (arg === "--include-gamma") { includeGamma = true; continue; }
        if (arg === "--reference-sources") { referenceSources = parseReferenceSources(next); i += 1; continue; }
        if (!arg.startsWith("-")) {
            positionals.push(arg);
        }
    }

    if (positionals[0] === "backfill" || positionals[0] === "live" || positionals[0] === "verify") {
        mode = positionals.shift() as MinerMode;
    }
    if (!hasSymbols && positionals[0]) {
        const symbolTokens: string[] = [];
        const remainingPositionals: string[] = [];
        for (const positional of positionals) {
            const tokens = splitSymbolTokens(positional);
            const parsedSymbols = parseSecondMarketSymbolList(tokens.join(","));
            if (tokens.length > 0 && parsedSymbols.length === tokens.length) {
                symbolTokens.push(...tokens);
            } else {
                remainingPositionals.push(positional);
            }
        }
        if (symbolTokens.length > 0) {
            symbols = parseSecondMarketSymbolList(symbolTokens.join(","));
            positionals = remainingPositionals;
        }
    }
    if (!hasDbPath && positionals[0] && looksLikeDbPath(positionals[0])) {
        dbPath = positionals.shift();
    }
    if (!hasMarketType && (positionals[0] === "spot" || positionals[0] === "futures")) {
        marketType = positionals.shift() as "spot" | "futures";
    }
    if (!hasStartTs && positionals[0]) {
        startTs = parseIsoSec(positionals.shift()) ?? startTs;
    }
    if (!hasEndTs && positionals[0]) {
        endTs = parseIsoSec(positionals.shift()) ?? endTs;
    }

    if (!includeBinance && !includeClob && !includeReference && !includeGamma) {
        if (mode === "backfill") includeBinance = true;
        if (mode === "live") {
            includeBinance = true;
            includeClob = true;
            includeReference = true;
            includeGamma = true;
        }
    }

    if (endTs < startTs) {
        throw new Error("--end-date must be greater than or equal to --start-date.");
    }
    if (symbols.length === 0) {
        throw new Error("No supported symbols selected. Use BTCUSDT and/or XRPUSDT.");
    }

    return {
        mode,
        dbPath,
        symbols,
        marketType,
        outcomeInterval,
        startTs,
        endTs,
        durationSec,
        includeBinance,
        includeClob,
        includeReference,
        includeGamma,
        referenceSources,
        requestDelayMs,
    };
}

async function runBackfill(config: CliConfig, signal: AbortSignal): Promise<void> {
    const db = openSecondMarketDb(config.dbPath);
    try {
        for (const symbol of config.symbols) {
            if (config.includeBinance) {
                console.log(`[mine:1s] binance ${symbol} ${config.marketType} ${config.startTs}-${config.endTs}`);
                const summary = await syncBinance1sRange(db, {
                    symbol,
                    marketType: config.marketType,
                    startTs: config.startTs,
                    endTs: config.endTs,
                    requestDelayMs: config.requestDelayMs,
                    signal,
                    onProgress: (progress) => {
                        if (progress.requestCount % 10 === 0) {
                            console.log(`[mine:1s] ${symbol} fetched=${progress.fetched} cursor=${progress.cursorTs}`);
                        }
                    },
                });
                console.log(`[mine:1s] binance ${symbol} fetched=${summary.fetched} upserted=${summary.upserted}`);
            }
            if (config.includeGamma) {
                const gamma = await syncGammaSnapshots(db, {
                    symbol,
                    outcomeInterval: config.outcomeInterval,
                    signal,
                });
                console.log(`[mine:1s] gamma ${symbol} events=${gamma.events.length} upserted=${gamma.upserted}`);
            }
        }
    } finally {
        db.close();
    }
}

async function runLiveBinancePolling(config: CliConfig, db: ReturnType<typeof openSecondMarketDb>, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const liveLookbackSec = 120;
    const pollMs = 15_000;

    while (!signal.aborted) {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        if (config.durationSec !== null && elapsedSec >= config.durationSec) break;

        const endTs = nowSec() - 2;
        const startTs = Math.max(0, endTs - liveLookbackSec);
        for (const symbol of config.symbols) {
            if (signal.aborted) break;
            try {
                const summary = await syncBinance1sRange(db, {
                    symbol,
                    marketType: config.marketType,
                    startTs,
                    endTs,
                    requestDelayMs: config.requestDelayMs,
                    signal,
                });
                console.log(`[mine:1s] binance live ${symbol} fetched=${summary.fetched} upserted=${summary.upserted} last=${summary.lastTs ?? "none"}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[mine:1s] binance live ${symbol} failed: ${message}`);
            }
        }

        const remainingMs = config.durationSec === null
            ? pollMs
            : Math.min(pollMs, Math.max(0, config.durationSec * 1000 - (Date.now() - startedAt)));
        await delay(remainingMs, signal);
    }
}

async function runRestartingLiveCapture(args: {
    label: string;
    durationSec: number | null;
    signal: AbortSignal;
    runOnce: (durationSec: number | undefined) => Promise<void>;
    restartOnComplete?: boolean;
    completedDelayMs?: number;
}): Promise<void> {
    const startedAt = Date.now();
    let attempt = 0;

    while (!args.signal.aborted) {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        if (args.durationSec !== null && elapsedSec >= args.durationSec) break;

        const remainingDurationSec = args.durationSec === null
            ? undefined
            : Math.max(1, args.durationSec - elapsedSec);

        try {
            await args.runOnce(remainingDurationSec);
            attempt = 0;
            if (!args.restartOnComplete) break;
            if (args.completedDelayMs && args.completedDelayMs > 0) {
                await delay(args.completedDelayMs, args.signal);
            }
        } catch (error) {
            if (args.signal.aborted) break;
            const elapsedAfterErrorSec = Math.floor((Date.now() - startedAt) / 1000);
            if (args.durationSec !== null && elapsedAfterErrorSec >= args.durationSec) break;
            attempt += 1;
            const message = error instanceof Error ? error.message : String(error);
            const retryMs = Math.min(30_000, 5_000 * attempt);
            console.warn(`[mine:1s] ${args.label} disconnected: ${message}`);
            console.warn(`[mine:1s] ${args.label} reconnecting in ${Math.round(retryMs / 1000)}s`);
            await delay(retryMs, args.signal);
        }
    }
}

async function syncLiveGammaEventsWithRetry(
    config: CliConfig,
    db: ReturnType<typeof openSecondMarketDb>,
    signal: AbortSignal
): Promise<SecondMarketPolymarketEvent[]> {
    const startedAt = Date.now();
    let attempt = 0;

    while (!signal.aborted) {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        if (config.durationSec !== null && elapsedSec >= config.durationSec) break;

        try {
            let allEvents: SecondMarketPolymarketEvent[] = [];
            for (const symbol of config.symbols) {
                const gamma = await syncGammaSnapshots(db, {
                    symbol,
                    outcomeInterval: config.outcomeInterval,
                    signal,
                });
                allEvents = allEvents.concat(gamma.events);
                console.log(`[mine:1s] gamma ${symbol} events=${gamma.events.length} upserted=${gamma.upserted}`);
            }
            return allEvents;
        } catch (error) {
            if (signal.aborted) break;
            attempt += 1;
            const message = error instanceof Error ? error.message : String(error);
            const retryMs = Math.min(30_000, 5_000 * attempt);
            console.warn(`[mine:1s] gamma sync failed: ${message}`);
            console.warn(`[mine:1s] gamma reconnecting in ${Math.round(retryMs / 1000)}s`);
            await delay(retryMs, signal);
        }
    }

    return [];
}

async function runLiveGammaPolling(
    config: CliConfig,
    db: ReturnType<typeof openSecondMarketDb>,
    signal: AbortSignal,
    onEvents: (events: SecondMarketPolymarketEvent[]) => void
): Promise<void> {
    const startedAt = Date.now();

    while (!signal.aborted) {
        const elapsedMs = Date.now() - startedAt;
        if (config.durationSec !== null && elapsedMs >= config.durationSec * 1000) break;

        const remainingMs = config.durationSec === null
            ? GAMMA_LIVE_POLL_MS
            : Math.min(GAMMA_LIVE_POLL_MS, Math.max(0, config.durationSec * 1000 - elapsedMs));
        await delay(remainingMs, signal);
        if (signal.aborted) break;
        if (config.durationSec !== null && Date.now() - startedAt >= config.durationSec * 1000) break;

        const events = await syncLiveGammaEventsWithRetry(config, db, signal);
        if (events.length > 0) {
            onEvents(events);
        }
    }
}

async function runLive(config: CliConfig, signal: AbortSignal): Promise<void> {
    const db = openSecondMarketDb(config.dbPath);
    try {
        const tasks: Promise<void>[] = [];
        let allEvents: SecondMarketPolymarketEvent[] = [];
        if (config.includeGamma || config.includeClob) {
            allEvents = await syncLiveGammaEventsWithRetry(config, db, signal);
        }

        if (config.includeGamma || config.includeClob) {
            tasks.push(runLiveGammaPolling(config, db, signal, (events) => {
                allEvents = events;
            }));
        }

        if (config.includeReference) {
            tasks.push(runRestartingLiveCapture({
                label: "reference",
                durationSec: config.durationSec,
                signal,
                runOnce: (durationSec) => runPolymarketReferenceCapture(db, {
                    symbols: config.symbols,
                    sources: config.referenceSources,
                    durationSec,
                    signal,
                    onRows: (rows) => {
                        console.log(`[mine:1s] reference rows=${rows.length}`);
                    },
                }),
            }));
        }

        if (config.includeBinance) {
            tasks.push(runLiveBinancePolling(config, db, signal));
        }

        if (config.includeClob) {
            const intervalSec = getPolymarketOutcomeIntervalDurationSec(config.outcomeInterval);
            const clobHorizonSec = intervalSec * CLOB_SUBSCRIPTION_HORIZON_MULTIPLIER;
            let lastSubscriptionKey = "";
            tasks.push(runRestartingLiveCapture({
                label: "clob",
                durationSec: config.durationSec,
                signal,
                restartOnComplete: true,
                completedDelayMs: 250,
                runOnce: async (durationSec) => {
                    const selectedEvents = selectClobSubscriptionEvents(allEvents, nowSec(), clobHorizonSec);
                    if (selectedEvents.length === 0) {
                        console.warn("[mine:1s] no current or near-future Polymarket events found for CLOB capture.");
                        await delay(5_000, signal);
                        return;
                    }

                    const subscriptionKey = selectedEvents
                        .map((event) => `${event.symbol}:${event.conditionId}:${event.yesTokenId}:${event.noTokenId}`)
                        .join("|");
                    if (subscriptionKey !== lastSubscriptionKey) {
                        const assetCount = selectedEvents.reduce((count, event) =>
                            count + (event.noTokenId ? 2 : 1), 0
                        );
                        console.log(`[mine:1s] clob subscribing events=${selectedEvents.length} assets=${assetCount}`);
                        lastSubscriptionKey = subscriptionKey;
                    }

                    const cycleDurationSec = durationSec === undefined
                        ? CLOB_SUBSCRIPTION_REFRESH_SEC
                        : Math.min(durationSec, CLOB_SUBSCRIPTION_REFRESH_SEC);
                    await runPolymarketClobCapture(db, {
                        events: selectedEvents,
                        durationSec: cycleDurationSec,
                        signal,
                        onSample: (rows) => {
                            console.log(`[mine:1s] clob sample rows=${rows.length}`);
                        },
                    });
                },
            }));
        }

        if (tasks.length === 0) {
            return;
        }
        await Promise.all(tasks);
    } finally {
        db.close();
    }
}

function runVerify(config: CliConfig): void {
    const db = openSecondMarketDb(config.dbPath);
    try {
        for (const symbol of config.symbols) {
            const binance = loadBinance1sCandles(db, {
                symbol,
                marketType: config.marketType,
                startTs: config.startTs,
                endTs: config.endTs,
            });
            const clob = loadPolymarketClob1sQuotes(db, {
                symbol,
                startTs: config.startTs,
                endTs: config.endTs,
            });
            const reference = loadPolymarketReference1sPrices(db, {
                symbol,
                startTs: config.startTs,
                endTs: config.endTs,
            });
            const gamma = loadPolymarketGammaSnapshots(db, {
                symbol,
                startTs: config.startTs,
                endTs: config.endTs,
            });
            const report = buildSecondDataQualityRun({
                id: `${symbol}:${config.startTs}:${config.endTs}:${Date.now()}`,
                symbol,
                startTs: config.startTs,
                endTs: config.endTs,
                binance,
                clob,
                reference,
                gamma,
            });
            upsertSecondDataQualityRun(db, report);
            console.log(`[mine:1s] verify ${symbol} binance=${report.binance_seconds} clob=${report.clob_quote_seconds} reference=${report.reference_price_seconds} gamma=${report.gamma_snapshot_count} exactQuoteCoverage=${report.exact_quote_coverage_pct.toFixed(2)}%`);
        }
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    const config = parseArgs(process.argv.slice(2));
    const controller = new AbortController();
    process.on("SIGINT", () => {
        console.log("[mine:1s] stopping...");
        controller.abort();
    });

    if (config.mode === "verify") {
        runVerify(config);
        return;
    }
    if (config.mode === "backfill") {
        await runBackfill(config, controller.signal);
        return;
    }
    await runLive(config, controller.signal);
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
