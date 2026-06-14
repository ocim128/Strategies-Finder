import * as fs from "node:fs";
import * as path from "node:path";

import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import type { OHLCVData } from "../lib/types/strategies";
import { parseOhlcvDataFile } from "./lib/ohlcv-file";
import {
    buildSyntheticPairPayload,
    deriveSyntheticSymbol,
    pickSourceInterval,
    type SyntheticPairPayload,
} from "./lib/synthetic-pair";

export type CliOptions = {
    baseSymbol: string;
    quoteSymbol: string;
    symbol: string;
    interval: string;
    bars: number;
    outPath: string;
    baseFile?: string;
    quoteFile?: string;
    help?: boolean;
};

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 10000",
        "",
        "Options:",
        "  --base-symbol <symbol>   Base symbol, e.g. BNBUSDT",
        "  --quote-symbol <symbol>  Quote symbol, e.g. PAXGUSDT",
        "  --symbol <symbol>        Optional synthetic output symbol, e.g. BNBPAXG",
        "  --interval <interval>    Target interval, e.g. 5m, 15m, 1h",
        "  --bars <count>           Number of bars to fetch per leg",
        "  --out <path>             Output JSON path (default: price-data/synthetic/<SYMBOL>-<interval>.json)",
        "  --base-file <path>       Optional local JSON file for base bars",
        "  --quote-file <path>      Optional local JSON file for quote bars",
        "  --help, -h               Show usage",
        "",
        "Examples:",
        "  npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 10000",
        "  npm run synthetic:pair -- --base-symbol ETHUSDT --quote-symbol PAXGUSDT --symbol ETHPAXG --interval 5m --bars 8000",
        "  npm run synthetic:pair -- --base-symbol BNBUSDT --quote-symbol PAXGUSDT --interval 15m --bars 2000 --base-file base.json --quote-file quote.json",
    ].join("\n"));
}

function fail(message: string): never {
    throw new Error(message);
}

export function parseCliOptions(argv: string[]): CliOptions {
    let baseSymbol: string | undefined;
    let quoteSymbol: string | undefined;
    let symbol: string | undefined;
    let interval: string | undefined;
    let bars: number | undefined;
    let outPath: string | undefined;
    let baseFile: string | undefined;
    let quoteFile: string | undefined;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        if (arg === "--help" || arg === "-h") {
            return { baseSymbol: "", quoteSymbol: "", symbol: "", interval: "", bars: 0, outPath: "", help: true };
        }

        if (arg === "--base-symbol" && next) { baseSymbol = next; i += 1; continue; }
        if (arg === "--quote-symbol" && next) { quoteSymbol = next; i += 1; continue; }
        if (arg === "--symbol" && next) { symbol = next; i += 1; continue; }
        if (arg === "--interval" && next) { interval = next; i += 1; continue; }
        if (arg === "--bars" && next) { bars = Number(next); i += 1; continue; }
        if (arg === "--out" && next) { outPath = next; i += 1; continue; }
        if (arg === "--base-file" && next) { baseFile = next; i += 1; continue; }
        if (arg === "--quote-file" && next) { quoteFile = next; i += 1; continue; }
    }

    if (!baseSymbol) fail("--base-symbol is required.");
    if (!quoteSymbol) fail("--quote-symbol is required.");
    if (!interval) fail("--interval is required.");
    if (!bars || !Number.isFinite(bars) || bars < 1000) fail("--bars must be a number >= 1000.");

    const normalizedBase = baseSymbol.trim().toUpperCase();
    const normalizedQuote = quoteSymbol.trim().toUpperCase();
    const normalizedSymbol = symbol?.trim().toUpperCase() || deriveSyntheticSymbol(normalizedBase, normalizedQuote);
    const resolvedInterval = interval.trim().toLowerCase();
    const resolvedOutPath = outPath
        ? path.resolve(outPath)
        : path.resolve("price-data", "synthetic", `${normalizedSymbol}-${resolvedInterval}.json`);

    return {
        baseSymbol: normalizedBase,
        quoteSymbol: normalizedQuote,
        symbol: normalizedSymbol,
        interval: resolvedInterval,
        bars: Math.max(1000, Math.floor(bars)),
        outPath: resolvedOutPath,
        baseFile,
        quoteFile,
    };
}


function printRunSummary(
    payload: SyntheticPairPayload,
    filePath: string,
    baseBars: number,
    quoteBars: number,
    droppedBars: number
): void {
    console.log(`[SyntheticPair] Base=${payload.source.baseSymbol} Quote=${payload.source.quoteSymbol} Interval=${payload.interval}`);
    console.log(`[SyntheticPair] SyntheticSymbol=${payload.symbol} Method=${payload.source.method}`);
    console.log(`[SyntheticPair] FetchedBase=${baseBars} FetchedQuote=${quoteBars} SyntheticBars=${payload.bars} Dropped=${droppedBars}`);
    console.log(`[SyntheticPair] Output=${filePath}`);
}

function loadLocalBars(filePath: string, label: string): OHLCVData[] {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        fail(`${label} file not found: ${resolved}`);
    }

    const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const parsed = parseOhlcvDataFile(raw);

    if (parsed.bars.length === 0) {
        fail(`${label} file has no valid candles: ${resolved}`);
    }

    return parsed.bars;
}

export async function run(argv: string[]): Promise<void> {
    const options = parseCliOptions(argv);
    if (options.help) {
        printUsage();
        return;
    }

    const source = options.baseFile || options.quoteFile
        ? null
        : pickSourceInterval(options.interval);
    const sourceInterval = source?.sourceInterval ?? options.interval;
    const fetchBars = source ? options.bars * source.ratio : options.bars;

    if (source) {
        console.log(`[SyntheticPair] Sub-bar reconstruction: target=${options.interval} source=${sourceInterval} ratio=${source.ratio}x (fetching ${fetchBars} bars/leg)`);
    }

    const baseBars = options.baseFile
        ? loadLocalBars(options.baseFile, "Base")
        : await fetchBinanceDataWithLimit(options.baseSymbol, sourceInterval, fetchBars, {
              requestDelayMs: 30,
              maxRequests: Math.ceil(fetchBars / 1000) + 2,
          });

    const quoteBars = options.quoteFile
        ? loadLocalBars(options.quoteFile, "Quote")
        : await fetchBinanceDataWithLimit(options.quoteSymbol, sourceInterval, fetchBars, {
              requestDelayMs: 30,
              maxRequests: Math.ceil(fetchBars / 1000) + 2,
          });

    if (!Array.isArray(baseBars) || baseBars.length === 0) {
        fail(`No base data returned for ${options.baseSymbol} on ${sourceInterval}.`);
    }

    if (!Array.isArray(quoteBars) || quoteBars.length === 0) {
        fail(`No quote data returned for ${options.quoteSymbol} on ${sourceInterval}.`);
    }

    const payload = buildSyntheticPairPayload({
        baseSymbol: options.baseSymbol,
        quoteSymbol: options.quoteSymbol,
        symbol: options.symbol,
        interval: options.interval,
        base: baseBars,
        quote: quoteBars,
        minBars: 1,
        sourceInterval: source?.sourceInterval,
    });

    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, JSON.stringify(payload, null, 2), "utf8");

    const alignedBars = payload.bars;
    const droppedBars = Math.max(0, baseBars.length - alignedBars);
    printRunSummary(payload, options.outPath, baseBars.length, quoteBars.length, droppedBars);
}

if (process.argv[1] && /build-synthetic-pair\.(ts|js)$/i.test(process.argv[1])) {
    run(process.argv.slice(2)).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
