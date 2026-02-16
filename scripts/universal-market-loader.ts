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

export async function ensureUniversalMarketData(
    options: Partial<UniversalMarketLoaderOptions> = {}
): Promise<UniversalMarketLoaderResult> {
    const cfg: UniversalMarketLoaderOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
        topN: Math.max(1, Math.floor(options.topN ?? DEFAULT_OPTIONS.topN)),
        bars: Math.max(1000, Math.floor(options.bars ?? DEFAULT_OPTIONS.bars)),
        freshnessHours: Math.max(1, Number(options.freshnessHours ?? DEFAULT_OPTIONS.freshnessHours)),
        outputDir: options.outputDir ? path.resolve(options.outputDir) : DEFAULT_OPTIONS.outputDir,
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
                datasets.push({
                    symbol,
                    interval: cfg.interval,
                    rank,
                    quoteVolume,
                    filePath,
                    bars: cachedBars,
                    generatedAt,
                    status: "cached",
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

        datasets.push({
            symbol,
            interval: cfg.interval,
            rank,
            quoteVolume,
            filePath,
            bars: fetched.length,
            generatedAt: String(payload.generatedAt),
            status: "fetched",
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
        positional.push(arg);
    }

    if (topN === undefined && positional[0]) topN = Number(positional[0]);
    if (!interval && positional[1]) interval = positional[1];
    if (bars === undefined && positional[2]) bars = Number(positional[2]);
    if (freshnessHours === undefined && positional[3]) freshnessHours = Number(positional[3]);
    if (!outputDir && positional[4]) outputDir = positional[4];

    return { topN, interval, bars, freshnessHours, outputDir };
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run market:load -- --top 50 --interval 15m --bars 10000 --fresh-hours 4",
        "",
        "Options:",
        "  --top <n>            Number of symbols to load (default: 50)",
        "  --interval <value>   Candle interval (default: 15m)",
        "  --bars <n>           Bars per symbol (default: 10000)",
        "  --fresh-hours <n>    Skip files fresher than this (default: 4)",
        "  --out-dir <path>     Output directory (default: price-data/universal)",
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

    console.log(`[UniversalLoader] Top ${result.requestedTopN} @ ${result.interval} | fetched=${fetched} cached=${cached}`);
    for (const dataset of result.datasets) {
        console.log(`[${dataset.rank.toString().padStart(2, "0")}] ${dataset.symbol} bars=${dataset.bars} status=${dataset.status} vol=${dataset.quoteVolume.toFixed(0)}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`universal-market-loader failed: ${message}`);
        process.exitCode = 1;
    });
}
