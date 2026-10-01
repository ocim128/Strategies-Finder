import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import {
    canonicalizeLegIdentity,
    hasKnownQuoteSuffix,
    type CanonicalLegIdentity,
} from "../synthetic-leg-identity";

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
    /** Pair rows skipped because an explicit local/provider leg has no usable data. */
    skippedPairTokens: string[];
    rejectedPairTokens: string[];
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
    if (!pairListText) throw new Error("TOP_MEAN requires an explicit pair list.");

    const catalogPath = resolvePriceDataPath(baseDir, "ibkr", "catalog.json");
    const csv30mDir = resolvePriceDataPath(baseDir, "ibkr", "csv", "30m");

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

    // Resolve the explicit pair list against available provider data.
    const rawLines = pairListText.split(/[\r\n,]+/).map((l) => l.trim()).filter(Boolean);
    const canonicalPairs: string[] = [];
    const eligibleTargetsByAsset = new Map<string, string>();
    const excludedAssetsSet = new Set<string>();
    const skippedPairTokens: string[] = [];
    const rejectedPairTokens: string[] = [];
    let excludedPairCount = 0;

    const resolveCustomLeg = (
        identity: CanonicalLegIdentity,
        missingDataAssets?: Set<string>,
    ): CanonicalLegIdentity | null => {
        if (identity.provider !== "ibkr") return identity;
        const check = isTickerUsable(identity.scoringAsset);
        if (!check.usable || !check.symbol) {
            const missingAsset = check.symbol || identity.scoringAsset;
            excludedAssetsSet.add(missingAsset);
            missingDataAssets?.add(missingAsset);
            return null;
        }
        return {
            ...identity,
            emittedToken: markIbkrSymbol(check.symbol),
            loaderSymbol: markIbkrSymbol(check.symbol),
        };
    };
    const resolveCustomToken = (
        rawToken: string,
        missingDataAssets?: Set<string>,
    ): CanonicalLegIdentity | null => {
        const identity = canonicalizeLegIdentity(rawToken);
        if (!identity) return null;

        // Custom Nasdaq lists commonly contain bare tickers. Treat a bare
        // token as IBKR only when the local catalog and 30m seed prove it
        // is available there. Explicit quote-suffixed market symbols keep
        // their existing Binance/market meaning (for example BTCUSDT).
        const normalized = rawToken.trim().toUpperCase();
        if (identity.provider === "market" && !hasKnownQuoteSuffix(normalized)) {
            const check = isTickerUsable(identity.scoringAsset);
            if (check.usable && check.symbol) {
                return resolveCustomLeg({
                    ...identity,
                    provider: "ibkr",
                    scoringAsset: stripIbkrMarker(check.symbol),
                });
            }
        }
        return resolveCustomLeg(identity, missingDataAssets);
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
            const missingDataAssets = new Set<string>();
            const resolvedDirect = resolveCustomToken(line, missingDataAssets);
            if (!resolvedDirect || !registerTarget(resolvedDirect)) {
                excludedPairCount++;
                if (missingDataAssets.size > 0) skippedPairTokens.push(line);
                else rejectedPairTokens.push(line);
                continue;
            }
            canonicalPairs.push(resolvedDirect.loaderSymbol);
            continue;
        }

        const separator = line.indexOf("+");
        const missingDataAssets = new Set<string>();
        const base = separator >= 0 ? resolveCustomToken(line.slice(0, separator), missingDataAssets) : null;
        const quote = separator >= 0 ? resolveCustomToken(line.slice(separator + 1), missingDataAssets) : null;
        if (!base || !quote) {
            excludedPairCount++;
            if (missingDataAssets.size > 0) skippedPairTokens.push(line);
            else rejectedPairTokens.push(line);
            continue;
        }
        if (base.scoringAsset === quote.scoringAsset) {
            excludedPairCount++;
            rejectedPairTokens.push(line);
            continue;
        }
        if (!registerTarget(base) || !registerTarget(quote)) {
            excludedPairCount++;
            rejectedPairTokens.push(line);
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
        excludedPairsCount: excludedPairCount,
    };

    return {
        counts,
        eligibleAssets: sortedEligibleAssets,
        eligibleTargets,
        canonicalPairs: finalPairs,
        excludedAssets: Array.from(excludedAssetsSet),
        skippedPairTokens,
        rejectedPairTokens,
    };
}

/**
 * Replay target set for exactly the pairs a run will execute (audit
 * smoke-replay-bounds finding). `eligibleTargets` always covers the FULL
 * universe — even when `maxPairs` sliced `canonicalPairs` down to a smoke
 * subset — so a coordinator replay driven from it loaded and cached datasets
 * for assets no retained artifact ever references. This derives the same
 * `{ asset, symbol }` shape from the pair list itself: synthetic
 * `BASE+QUOTE` tokens contribute both legs, direct symbols contribute
 * themselves. Deduped by scoring asset, sorted by asset for deterministic
 * traversal.
 */
export function deriveReplayTargetsFromCanonicalPairs(
    canonicalPairs: readonly string[],
): Array<{ asset: string; symbol: string }> {
    const symbolByAsset = new Map<string, string>();
    const addLeg = (asset: string, symbol: string): void => {
        const key = asset.trim().toUpperCase();
        if (key !== "" && !symbolByAsset.has(key)) {
            symbolByAsset.set(key, symbol);
        }
    };
    for (const pair of canonicalPairs) {
        const parsed = parsePortfolioSyntheticPairSymbol(pair);
        if (parsed) {
            addLeg(parsed.baseAsset, parsed.baseSymbol);
            addLeg(parsed.quoteAsset, parsed.quoteSymbol);
        } else {
            const direct = canonicalizeLegIdentity(pair);
            addLeg(direct?.scoringAsset ?? pair, direct?.loaderSymbol ?? pair);
        }
    }
    return Array.from(symbolByAsset, ([asset, symbol]) => ({ asset, symbol }))
        .sort((a, b) => a.asset.localeCompare(b.asset));
}
