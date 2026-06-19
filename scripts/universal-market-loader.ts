import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import type { OHLCVData } from "../lib/types/strategies";

type Ticker24h = {
    symbol: string;
    quoteVolume: string;
};

export interface UniversalMarketLoaderOptions {
    topN: number;
    interval: string;
    bars: number;
    freshnessHours: number;
    outputDir: string;
    /**
     * When set, each fetched dataset is also POSTed to the running dev server's
     * SQLite store endpoint so the universe Finder (which reads SQLite offline)
     * can serve the freshly backfilled bars without a remote gap-fill. Requires
     * the dev server to be running at `sqliteOrigin`.
     */
    ingestSqlite?: boolean;
    /**
     * Dev-server origin for the SQLite ingest endpoint. Defaults to the Vite
     * dev server on 127.0.0.1:5174.
     */
    sqliteOrigin?: string;
}

export interface UniversalMarketDataset {
    symbol: string;
    interval: string;
    rank: number;
    quoteVolume: number;
    filePath: string;
    bars: number;
    generatedAt: string;
    status: "fetched" | "cached";
    sqliteIngested?: number;
    sqliteIngestError?: string;
}

export interface UniversalMarketLoaderResult {
    requestedTopN: number;
    interval: string;
    bars: number;
    freshnessHours: number;
    generatedAt: string;
    datasets: UniversalMarketDataset[];
}

const DEFAULT_OPTIONS: UniversalMarketLoaderOptions = {
    topN: 50,
    interval: "15m",
    bars: 10000,
    freshnessHours: 4,
    outputDir: path.resolve("price-data", "universal"),
    ingestSqlite: false,
    sqliteOrigin: "http://127.0.0.1:5174",
};

const STABLE_BASES = new Set([
    "USDT",
    "USDC",
    "FDUSD",
    "BUSD",
    "TUSD",
    "USDP",
    "DAI",
    "EUR",
    "EURT",
    "USDJ",
    "PAX",
    "UST",
    "USTC",
    "SUSD",
    "USDS",
]);

function isLeveragedBase(base: string): boolean {
    return base.endsWith("UP") || base.endsWith("DOWN") || base.endsWith("BULL") || base.endsWith("BEAR");
}

async function fetchTopUsdtSymbolsByQuoteVolume(topN: number): Promise<Array<{ symbol: string; quoteVolume: number }>> {
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!response.ok) {
        throw new Error(`[UniversalLoader] Binance ticker fetch failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
        throw new Error("[UniversalLoader] Binance ticker payload is not an array.");
    }

    const ranked = (payload as Ticker24h[])
        .filter((item) => typeof item?.symbol === "string" && item.symbol.endsWith("USDT"))
        .map((item) => ({
            symbol: item.symbol,
            base: item.symbol.slice(0, -4),
            quoteVolume: Number(item.quoteVolume),
        }))
        .filter((item) => Number.isFinite(item.quoteVolume) && item.quoteVolume > 0)
        .filter((item) => item.base.length > 0)
        .filter((item) => !STABLE_BASES.has(item.base))
        .filter((item) => !isLeveragedBase(item.base))
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, Math.max(1, topN))
        .map((item) => ({ symbol: item.symbol, quoteVolume: item.quoteVolume }));

    if (ranked.length === 0) {
        throw new Error("[UniversalLoader] No eligible USDT symbols found from Binance ticker.");
    }
    return ranked;
}

function readFileFreshnessMs(filePath: string): number | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
        const generatedAtRaw = typeof raw.generatedAt === "string" ? raw.generatedAt : null;
        if (generatedAtRaw) {
            const parsed = Date.parse(generatedAtRaw);
            if (Number.isFinite(parsed)) return Date.now() - parsed;
        }
    } catch {
        // Fallback below to file mtime.
    }

    try {
        const stats = fs.statSync(filePath);
        return Date.now() - stats.mtimeMs;
    } catch {
        return null;
    }
}

function buildDatasetPayload(symbol: string, interval: string, bars: OHLCVData[]): Record<string, unknown> {
    const start = bars[0];
    const end = bars[bars.length - 1];
    return {
        symbol,
        interval,
        provider: "Binance",
        bars: bars.length,
        range: {
            start: new Date(Number(start.time) * 1000).toISOString(),
            end: new Date(Number(end.time) * 1000).toISOString(),
        },
        generatedAt: new Date().toISOString(),
        data: bars.map((bar) => ({
            time: Number(bar.time),
            datetime: new Date(Number(bar.time) * 1000).toISOString(),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
        })),
    };
}

const SQLITE_INGEST_BATCH_ROWS = 10_000;
const SQLITE_INGEST_TIMEOUT_MS = 180_000;

/**
 * Reads OHLCV bars back out of a cached universal-loader JSON payload so the
 * SQLite ingest path can re-hydrate the dev-server cache from an existing
 * fresh seed file without re-fetching from Binance.
 */
function extractCandlesFromPayload(raw: Record<string, unknown>): OHLCVData[] {
    const rows = Array.isArray(raw.data) ? raw.data : [];
    const candles: OHLCVData[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const value = row as Record<string, unknown>;
        const time = Number(value.time);
        const open = Number(value.open);
        const high = Number(value.high);
        const low = Number(value.low);
        const close = Number(value.close);
        const volume = Number(value.volume ?? 0);
        if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            continue;
        }
        candles.push({
            time: time as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }
    return candles;
}

/**
 * POSTs a fetched dataset to the dev server's SQLite store endpoint in batches.
 * Mirrors the JSON shape that lib/local-sqlite-api.ts -> storeSqliteCandles
 * sends (and that lib/local-sqlite-vite-plugin.ts -> /store-ohlcv accepts), so
 * the universe Finder's offline SQLite read path sees the backfilled bars.
 *
 * Batching keeps each request body bounded so the dev server's JSON parser
 * does not choke on 100k-row payloads. Throws on any non-OK response, network
 * error, or timeout so the caller can count it as a failed ingest.
 */
async function ingestDatasetToSqlite(
    symbol: string,
    interval: string,
    bars: OHLCVData[],
    origin: string,
): Promise<number> {
    const url = `${origin.replace(/\/$/, "")}/api/sqlite/store-ohlcv`;
    let upserted = 0;
    for (let offset = 0; offset < bars.length; offset += SQLITE_INGEST_BATCH_ROWS) {
        const chunk = bars.slice(offset, offset + SQLITE_INGEST_BATCH_ROWS);
        const body = {
            symbol: symbol.toUpperCase(),
            interval: interval.toLowerCase(),
            provider: "Binance",
            source: "universal-loader",
            candles: chunk.map((bar) => ({
                time: Number(bar.time),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
            })),
        };
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SQLITE_INGEST_TIMEOUT_MS);
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timer);
            const payload = (await response.json().catch(() => null)) as { ok?: boolean; upserted?: number; error?: string } | null;
            if (!response.ok || !payload?.ok) {
                throw new Error(payload?.error || `HTTP ${response.status}`);
            }
            upserted += Number(payload.upserted ?? 0);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`SQLite ingest failed for ${symbol} ${interval} (offset ${offset}): ${message}`);
        }
    }
    return upserted;
}

export async function ensureUniversalMarketData(
    options: Partial<UniversalMarketLoaderOptions> = {}
): Promise<UniversalMarketLoaderResult> {
    const sqliteOrigin = (options.sqliteOrigin ?? DEFAULT_OPTIONS.sqliteOrigin ?? "http://127.0.0.1:5174").trim()
        || "http://127.0.0.1:5174";
    const cfg: UniversalMarketLoaderOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
        topN: Math.max(1, Math.floor(options.topN ?? DEFAULT_OPTIONS.topN)),
        bars: Math.max(1000, Math.floor(options.bars ?? DEFAULT_OPTIONS.bars)),
        freshnessHours: Math.max(1, Number(options.freshnessHours ?? DEFAULT_OPTIONS.freshnessHours)),
        outputDir: options.outputDir ? path.resolve(options.outputDir) : DEFAULT_OPTIONS.outputDir,
        ingestSqlite: options.ingestSqlite === true,
        sqliteOrigin,
    };

    fs.mkdirSync(cfg.outputDir, { recursive: true });
    const freshnessMs = cfg.freshnessHours * 60 * 60 * 1000;
    const rankedSymbols = await fetchTopUsdtSymbolsByQuoteVolume(cfg.topN);
    const datasets: UniversalMarketDataset[] = [];

    for (let i = 0; i < rankedSymbols.length; i++) {
        const { symbol, quoteVolume } = rankedSymbols[i];
        const rank = i + 1;
        const filePath = path.resolve(cfg.outputDir, `${symbol}-${cfg.interval}.json`);
        const ageMs = readFileFreshnessMs(filePath);

        if (ageMs !== null && ageMs < freshnessMs) {
            const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
            const generatedAt = typeof raw.generatedAt === "string" ? raw.generatedAt : new Date(Date.now() - ageMs).toISOString();
            const cachedBars = Number(raw.bars);
            const hasEnoughBars = Number.isFinite(cachedBars) && cachedBars >= cfg.bars;
            if (hasEnoughBars) {
                let sqliteIngested: number | undefined;
                let sqliteIngestError: string | undefined;
                if (cfg.ingestSqlite) {
                    // Even when the JSON seed is fresh, the SQLite cache the
                    // universe Finder reads from may not yet hold these bars, so
                    // re-ingest from the cached file when --ingest-sqlite is set.
                    const cachedCandles = extractCandlesFromPayload(raw);
                    if (cachedCandles.length > 0) {
                        try {
                            sqliteIngested = await ingestDatasetToSqlite(symbol, cfg.interval, cachedCandles, sqliteOrigin);
                        } catch (error) {
                            sqliteIngestError = error instanceof Error ? error.message : String(error);
                            console.warn(`[UniversalLoader] ${symbol}: ${sqliteIngestError}`);
                        }
                    }
                }
                datasets.push({
                    symbol,
                    interval: cfg.interval,
                    rank,
                    quoteVolume,
                    filePath,
                    bars: cachedBars,
                    generatedAt,
                    status: "cached",
                    sqliteIngested,
                    sqliteIngestError,
                });
                continue;
            }
        }

        const fetched = await fetchBinanceDataWithLimit(symbol, cfg.interval, cfg.bars, {
            requestDelayMs: 30,
            maxRequests: Math.ceil(cfg.bars / 1000) + 2,
        });
        if (!Array.isArray(fetched) || fetched.length === 0) {
            continue;
        }

        const payload = buildDatasetPayload(symbol, cfg.interval, fetched);
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

        let sqliteIngested: number | undefined;
        let sqliteIngestError: string | undefined;
        if (cfg.ingestSqlite) {
            try {
                sqliteIngested = await ingestDatasetToSqlite(symbol, cfg.interval, fetched, sqliteOrigin);
            } catch (error) {
                sqliteIngestError = error instanceof Error ? error.message : String(error);
                console.warn(`[UniversalLoader] ${symbol}: ${sqliteIngestError}`);
            }
        }

        datasets.push({
            symbol,
            interval: cfg.interval,
            rank,
            quoteVolume,
            filePath,
            bars: fetched.length,
            generatedAt: String(payload.generatedAt),
            status: "fetched",
            sqliteIngested,
            sqliteIngestError,
        });
    }

    return {
        requestedTopN: cfg.topN,
        interval: cfg.interval,
        bars: cfg.bars,
        freshnessHours: cfg.freshnessHours,
        generatedAt: new Date().toISOString(),
        datasets,
    };
}

function parseCliOptions(argv: string[]): Partial<UniversalMarketLoaderOptions> & { help?: boolean } {
    let topN: number | undefined;
    let interval: string | undefined;
    let bars: number | undefined;
    let freshnessHours: number | undefined;
    let outputDir: string | undefined;
    let ingestSqlite = false;
    let sqliteOrigin: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") {
            return { help: true };
        }
        if (arg === "--top") { topN = Number(next); i++; continue; }
        if (arg === "--interval") { interval = String(next ?? "").trim(); i++; continue; }
        if (arg === "--bars") { bars = Number(next); i++; continue; }
        if (arg === "--fresh-hours") { freshnessHours = Number(next); i++; continue; }
        if (arg === "--out-dir") { outputDir = String(next ?? ""); i++; continue; }
        if (arg === "--ingest-sqlite") { ingestSqlite = true; continue; }
        if (arg === "--origin") { sqliteOrigin = String(next ?? "").trim(); i++; continue; }
        positional.push(arg);
    }

    if (topN === undefined && positional[0]) topN = Number(positional[0]);
    if (!interval && positional[1]) interval = positional[1];
    if (bars === undefined && positional[2]) bars = Number(positional[2]);
    if (freshnessHours === undefined && positional[3]) freshnessHours = Number(positional[3]);
    if (!outputDir && positional[4]) outputDir = positional[4];

    return { topN, interval, bars, freshnessHours, outputDir, ingestSqlite, sqliteOrigin };
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run market:load -- --top 50 --interval 15m --bars 10000 --fresh-hours 4",
        "  npm run market:load -- --interval 5m --bars 100000 --ingest-sqlite   # backfill universe Finder source data",
        "",
        "Options:",
        "  --top <n>            Number of symbols to load (default: 50)",
        "  --interval <value>   Candle interval (default: 15m)",
        "  --bars <n>           Bars per symbol (default: 10000)",
        "  --fresh-hours <n>    Skip files fresher than this (default: 4)",
        "  --out-dir <path>     Output directory (default: price-data/universal)",
        "  --ingest-sqlite      Also POST each dataset into the dev server's SQLite store",
        "                       (requires the dev server running at --origin; lets the",
        "                       universe Finder serve these bars offline)",
        "  --origin <url>       Dev-server origin for --ingest-sqlite (default: http://127.0.0.1:5174)",
    ].join("\n"));
}

async function main(): Promise<void> {
    const parsed = parseCliOptions(process.argv.slice(2));
    if (parsed.help) {
        printUsage();
        return;
    }

    const result = await ensureUniversalMarketData(parsed);
    const fetched = result.datasets.filter((d) => d.status === "fetched").length;
    const cached = result.datasets.filter((d) => d.status === "cached").length;
    const ingestedTotal = result.datasets.reduce((sum, d) => sum + (d.sqliteIngested ?? 0), 0);
    const ingestFailures = result.datasets.filter((d) => d.sqliteIngestError).length;
    const ingestAttempted = result.datasets.filter((d) => d.sqliteIngested !== undefined || d.sqliteIngestError).length;

    console.log(
        `[UniversalLoader] Top ${result.requestedTopN} @ ${result.interval} | fetched=${fetched} cached=${cached}`
        + (parsed.ingestSqlite ? ` sqliteIngested=${ingestedTotal} (attempted=${ingestAttempted} failed=${ingestFailures})` : "")
    );
    for (const dataset of result.datasets) {
        const ingest = parsed.ingestSqlite
            ? dataset.sqliteIngestError
                ? ` sqlite=FAIL:${dataset.sqliteIngestError}`
                : typeof dataset.sqliteIngested === "number"
                    ? ` sqlite=${dataset.sqliteIngested}`
                    : ""
            : "";
        console.log(`[${dataset.rank.toString().padStart(2, "0")}] ${dataset.symbol} bars=${dataset.bars} status=${dataset.status}${ingest} vol=${dataset.quoteVolume.toFixed(0)}`);
    }

    // When --ingest-sqlite was requested but every ingest failed (e.g. dev
    // server not running), exit non-zero so the user knows the backfill did
    // not land and the universe Finder will not see fresh SQLite data.
    if (parsed.ingestSqlite && ingestAttempted > 0 && ingestedTotal === 0 && ingestFailures === ingestAttempted) {
        console.error(`[UniversalLoader] All ${ingestFailures} SQLite ingests failed; is the dev server running at ${parsed.sqliteOrigin}?`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`universal-market-loader failed: ${message}`);
        process.exitCode = 1;
    });
}
