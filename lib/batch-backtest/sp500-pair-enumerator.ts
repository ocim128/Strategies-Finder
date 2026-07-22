import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";

export interface CoverageCounts {
    sp500AssetsCount: number;
    catalogAssetsCount: number;
    usable30mSeedCount: number;
    usableTargetIntervalCount: number;
    pairCount: number;
    excludedAssetsCount: number;
    excludedPairsCount: number;
}

export interface EnumerationOptions {
    interval?: string;
    baseDir?: string;
    maxPairs?: number;
}

export interface EnumerationResult {
    counts: CoverageCounts;
    eligibleAssets: string[];
    canonicalPairs: string[];
    excludedAssets: string[];
}

function resolvePriceDataPath(baseDir: string | undefined, ...parts: string[]): string {
    const root = baseDir || process.cwd();
    const directPath = resolve(root, "price-data", ...parts);
    if (existsSync(directPath)) return directPath;

    // Worktree fallback: if running in a worktree folder, check parent repository root
    const parentPath = resolve(root, "..", "Strategies-Finder", "price-data", ...parts);
    if (existsSync(parentPath)) return parentPath;

    return directPath;
}

export function parseSp500CompanyInfoCsv(csvContent: string): string[] {
    const lines = csvContent.split(/\r?\n/);
    const tickers: string[] = [];
    if (lines.length <= 1) return tickers;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const firstCommaIndex = line.indexOf(",");
        let rawTicker = firstCommaIndex !== -1 ? line.substring(0, firstCommaIndex) : line;
        rawTicker = rawTicker.replace(/^"/, "").replace(/"$/, "").trim();
        if (rawTicker && rawTicker !== "Ticker") {
            tickers.push(rawTicker);
        }
    }
    return tickers;
}

interface IbkrCatalogEntry {
    symbol: string;
    markedSymbol?: string;
    intervals?: Record<string, unknown>;
}

interface IbkrCatalog {
    entries?: IbkrCatalogEntry[] | Record<string, IbkrCatalogEntry>;
}

export function enumerateSp500Pairs(options: EnumerationOptions = {}): EnumerationResult {
    const interval = options.interval || "4h";
    void interval;
    const baseDir = options.baseDir;

    const companyInfoPath = resolvePriceDataPath(
        baseDir,
        "sp500_comprehensive_dataset",
        "sp500_comprehensive",
        "sp500_company_info.csv",
    );
    const catalogPath = resolvePriceDataPath(baseDir, "ibkr", "catalog.json");
    const csv30mDir = resolvePriceDataPath(baseDir, "ibkr", "csv", "30m");

    let sp500Tickers: string[] = [];
    if (existsSync(companyInfoPath)) {
        const content = readFileSync(companyInfoPath, "utf8");
        sp500Tickers = parseSp500CompanyInfoCsv(content);
    }

    const catalogEntriesMap = new Map<string, IbkrCatalogEntry>();
    if (existsSync(catalogPath)) {
        try {
            const catalog: IbkrCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
            if (catalog.entries) {
                const entriesArray = Array.isArray(catalog.entries)
                    ? catalog.entries
                    : Object.values(catalog.entries);
                for (const entry of entriesArray) {
                    if (entry && entry.symbol) {
                        const clean = stripIbkrMarker(entry.symbol).toUpperCase();
                        catalogEntriesMap.set(clean, entry);
                        // Also index dot/dash variations e.g. BRK.B vs BRK-B
                        catalogEntriesMap.set(clean.replace(/\./g, "-"), entry);
                        catalogEntriesMap.set(clean.replace(/-/g, "."), entry);
                    }
                }
            }
        } catch {
            // Ignore catalog parse failure for resilience
        }
    }

    let catalogAssetsCount = 0;
    let usable30mSeedCount = 0;
    let usableTargetIntervalCount = 0;

    const eligibleAssetsSet = new Set<string>();
    const excludedAssetsList: string[] = [];

    for (const rawTicker of sp500Tickers) {
        const cleanTicker = stripIbkrMarker(rawTicker).toUpperCase();
        const catalogEntry = catalogEntriesMap.get(cleanTicker);

        if (!catalogEntry) {
            excludedAssetsList.push(cleanTicker);
            continue;
        }

        catalogAssetsCount++;
        const symbol = catalogEntry.symbol;

        // Check 30m seed CSV file existence
        const csv30mPath = resolve(csv30mDir, `${symbol}.csv`);
        const has30mSeed = existsSync(csv30mPath);

        if (has30mSeed) {
            usable30mSeedCount++;
        }

        // Check target interval dataset availability. For 4h and 30m, 30m seeds are required.
        let hasTargetIntervalData = has30mSeed;
        if (interval !== "30m" && interval !== "4h") {
            const targetDir = resolvePriceDataPath(baseDir, "ibkr", "csv", interval);
            hasTargetIntervalData = existsSync(resolve(targetDir, `${symbol}.csv`)) || has30mSeed;
        }

        const isUsableForInterval = has30mSeed && hasTargetIntervalData;

        if (isUsableForInterval) {
            usableTargetIntervalCount++;
            eligibleAssetsSet.add(symbol);
        } else {
            excludedAssetsList.push(symbol);
        }
    }

    // Sort eligible assets lexicographically by stripped ticker
    const sortedEligibleAssets = Array.from(eligibleAssetsSet).sort((a, b) =>
        stripIbkrMarker(a).localeCompare(stripIbkrMarker(b)),
    );

    // Build canonical pairs: base < quote
    const allCanonicalPairs: string[] = [];
    for (let i = 0; i < sortedEligibleAssets.length; i++) {
        for (let j = i + 1; j < sortedEligibleAssets.length; j++) {
            const baseSymbol = markIbkrSymbol(sortedEligibleAssets[i]);
            const quoteSymbol = markIbkrSymbol(sortedEligibleAssets[j]);
            allCanonicalPairs.push(`${baseSymbol}+${quoteSymbol}`);
        }
    }

    let canonicalPairs = allCanonicalPairs;
    if (options.maxPairs && options.maxPairs > 0 && options.maxPairs < canonicalPairs.length) {
        canonicalPairs = canonicalPairs.slice(0, options.maxPairs);
    }

    const totalPossiblePairs = (sp500Tickers.length * (sp500Tickers.length - 1)) / 2;
    const actualPairCount = (usableTargetIntervalCount * (usableTargetIntervalCount - 1)) / 2;

    const counts: CoverageCounts = {
        sp500AssetsCount: sp500Tickers.length,
        catalogAssetsCount,
        usable30mSeedCount,
        usableTargetIntervalCount,
        pairCount: canonicalPairs.length,
        excludedAssetsCount: sp500Tickers.length - usableTargetIntervalCount,
        excludedPairsCount: totalPossiblePairs - actualPairCount,
    };

    return {
        counts,
        eligibleAssets: sortedEligibleAssets,
        canonicalPairs,
        excludedAssets: excludedAssetsList,
    };
}
