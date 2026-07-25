import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import { canonicalizeLegIdentity, type CanonicalLegIdentity } from "../synthetic-leg-identity";

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
    pairListText?: string;
}

export interface EnumerationResult {
    counts: CoverageCounts;
    eligibleAssets: string[];
    eligibleTargets: Array<{ asset: string; symbol: string }>;
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
    const baseDir = options.baseDir;
    const pairListText = options.pairListText?.trim();

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
                        catalogEntriesMap.set(clean.replace(/\./g, "-"), entry);
                        catalogEntriesMap.set(clean.replace(/-/g, "."), entry);
                    }
                }
            }
        } catch {
            // Ignore catalog parse failure for resilience
        }
    }

    const isTickerUsable = (cleanTicker: string): { usable: boolean; symbol?: string; reason?: string } => {
        const catalogEntry = catalogEntriesMap.get(cleanTicker);
        if (!catalogEntry) return { usable: false, reason: "not_in_catalog" };
        const symbol = catalogEntry.symbol;
        const csv30mPath = resolve(csv30mDir, `${symbol}.csv`);
        const has30mSeed = existsSync(csv30mPath);
        if (!has30mSeed) return { usable: false, symbol, reason: "missing_30m_seed" };

        let hasTargetIntervalData = true;
        if (interval !== "30m" && interval !== "4h" && interval !== "1h" && interval !== "2h") {
            const targetDir = resolvePriceDataPath(baseDir, "ibkr", "csv", interval);
            hasTargetIntervalData = existsSync(resolve(targetDir, `${symbol}.csv`));
        }
        if (!hasTargetIntervalData) return { usable: false, symbol, reason: "missing_target_interval" };

        return { usable: true, symbol };
    };

    // Branch A: Custom pair list provided (e.g. 2000 pairs pasted in UI)
    if (pairListText) {
        const rawLines = pairListText.split(/[\r\n,]+/).map((l) => l.trim()).filter(Boolean);
        const canonicalPairs: string[] = [];
        const eligibleTargetsByAsset = new Map<string, string>();
        const excludedAssetsSet = new Set<string>();
        let invalidPairCount = 0;

        const resolveCustomLeg = (identity: CanonicalLegIdentity): CanonicalLegIdentity | null => {
            if (identity.provider !== "ibkr") return identity;
            const check = isTickerUsable(identity.scoringAsset);
            if (!check.usable || !check.symbol) {
                excludedAssetsSet.add(check.symbol || identity.scoringAsset);
                return null;
            }
            return {
                ...identity,
                emittedToken: markIbkrSymbol(check.symbol),
                loaderSymbol: markIbkrSymbol(check.symbol),
            };
        };
        const registerTarget = (identity: CanonicalLegIdentity): boolean => {
            const existing = eligibleTargetsByAsset.get(identity.scoringAsset);
            if (existing && existing !== identity.loaderSymbol) {
                excludedAssetsSet.add(identity.scoringAsset);
                return false;
            }
            eligibleTargetsByAsset.set(identity.scoringAsset, identity.loaderSymbol);
            return true;
        };

        for (const line of rawLines) {
            const parsed = parseSyntheticPairToken(line);
            if (!parsed) {
                const direct = canonicalizeLegIdentity(line);
                const resolvedDirect = direct ? resolveCustomLeg(direct) : null;
                if (!resolvedDirect || !registerTarget(resolvedDirect)) {
                    invalidPairCount++;
                    continue;
                }
                canonicalPairs.push(resolvedDirect.loaderSymbol);
                continue;
            }

            const baseIdentity = canonicalizeLegIdentity(parsed.baseSymbol);
            const quoteIdentity = canonicalizeLegIdentity(parsed.quoteSymbol);
            const base = baseIdentity ? resolveCustomLeg(baseIdentity) : null;
            const quote = quoteIdentity ? resolveCustomLeg(quoteIdentity) : null;
            if (!base || !quote || base.scoringAsset === quote.scoringAsset) {
                invalidPairCount++;
                continue;
            }
            if (!registerTarget(base) || !registerTarget(quote)) {
                invalidPairCount++;
                continue;
            }
            canonicalPairs.push(`${base.loaderSymbol}+${quote.loaderSymbol}`);
        }

        const eligibleTargets = Array.from(eligibleTargetsByAsset, ([asset, symbol]) => ({ asset, symbol }))
            .sort((a, b) => a.asset.localeCompare(b.asset));
        const sortedEligibleAssets = eligibleTargets.map((target) => target.asset);

        let finalPairs = canonicalPairs;
        if (options.maxPairs && options.maxPairs > 0 && options.maxPairs < finalPairs.length) {
            finalPairs = finalPairs.slice(0, options.maxPairs);
        }

        const counts: CoverageCounts = {
            sp500AssetsCount: sortedEligibleAssets.length + excludedAssetsSet.size,
            catalogAssetsCount: sortedEligibleAssets.length,
            usable30mSeedCount: sortedEligibleAssets.length,
            usableTargetIntervalCount: sortedEligibleAssets.length,
            pairCount: finalPairs.length,
            excludedAssetsCount: excludedAssetsSet.size,
            excludedPairsCount: invalidPairCount,
        };

        return {
            counts,
            eligibleAssets: sortedEligibleAssets,
            eligibleTargets,
            canonicalPairs: finalPairs,
            excludedAssets: Array.from(excludedAssetsSet),
        };
    }

    // Branch B: Default S&P 500 company info enumeration
    let catalogAssetsCount = 0;
    let usable30mSeedCount = 0;
    let usableTargetIntervalCount = 0;

    const eligibleAssetsSet = new Set<string>();
    const excludedAssetsList: string[] = [];

    for (const rawTicker of sp500Tickers) {
        const cleanTicker = stripIbkrMarker(rawTicker).toUpperCase();
        const check = isTickerUsable(cleanTicker);

        if (!check.usable) {
            excludedAssetsList.push(check.symbol || cleanTicker);
            continue;
        }

        catalogAssetsCount++;
        usable30mSeedCount++;
        usableTargetIntervalCount++;
        eligibleAssetsSet.add(check.symbol!);
    }

    const sortedEligibleAssets = Array.from(eligibleAssetsSet).sort((a, b) =>
        stripIbkrMarker(a).localeCompare(stripIbkrMarker(b)),
    );

    // Pair materialization with an early-out cap. The prior loop built the full
    // N*(N-1)/2 list unconditionally — for ~400 eligible assets with maxPairs
    // capped at 2000, that was ~80k pair strings and ~160k `markIbkrSymbol`
    // calls, of which ~78k were discarded by the slice below. Two wins in one
    // rewrite: (a) hoist `markIbkrSymbol(sortedEligibleAssets[i])` out of the
    // inner j-loop; (b) `break outer` as soon as the cap is reached. Order of
    // the kept prefix is identical to the prior pre-slice ordering, so any
    // caller that relied on deterministic pair ordering still gets the same
    // prefix.
    const cap = options.maxPairs && options.maxPairs > 0 ? options.maxPairs : Infinity;
    const allCanonicalPairs: string[] = [];
    outer: for (let i = 0; i < sortedEligibleAssets.length; i++) {
        const baseSymbol = markIbkrSymbol(sortedEligibleAssets[i]!);
        for (let j = i + 1; j < sortedEligibleAssets.length; j++) {
            if (allCanonicalPairs.length >= cap) break outer;
            allCanonicalPairs.push(`${baseSymbol}+${markIbkrSymbol(sortedEligibleAssets[j]!)}`);
        }
    }

    const canonicalPairs = allCanonicalPairs;

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
        eligibleTargets: sortedEligibleAssets.map((asset) => ({
            asset: stripIbkrMarker(asset),
            symbol: markIbkrSymbol(asset),
        })),
        canonicalPairs,
        excludedAssets: excludedAssetsList,
    };
}
