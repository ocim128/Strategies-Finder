/**
 * Exposure & Redundancy engine — descriptive analysis of a batch run's pair
 * concentration and cross-pair overlap.
 *
 * Three views, all derived from stored `BatchSyntheticPairArtifact`s:
 *
 * 1. **Asset incidence** (metadata only): how many pairs contain each
 *    underlying asset, and the connected-component clusters of the asset-pair
 *    bipartite graph (two pairs are connected when they share a leg). Uses
 *    only `baseAsset` / `quoteAsset` — no OHLCV needed.
 *
 * 2. **Exit-P&L correlation**: the batch runner sets `omitEquityCurve`, so
 *    true equity curves are NOT on the artifact. Per-trade
 *    `result.trades[].pnl` cash-flow events are aligned by `timeKey(exitTime)`
 *    and correlated on simultaneous exits. This is explicitly a sparse proxy,
 *    not strategy-equity-return correlation.
 *
 * 3. **Ratio-return correlation**: close-to-close returns of the ratio OHLCV
 *    (`artifact.data`), aligned on the pairwise timestamp intersection, Pearson
 *    on the overlapping bars. Requires a minimum bar overlap.
 *
 * Descriptive only — NO quality labels, NO composite score, NO "best/avoid".
 * The Mine Timing investigation proved theoretically-plausible metrics can
 * have zero OOS value; this report describes structure, it does not rank.
 *
 * Pure leaf: imports only `../types/strategies` (type-only — the
 * `lightweight-charts` `Time` import is erased at compile time, so this stays
 * out of the cjs config bundle) and `../strategies` for `timeKey`. No DOM.
 *
 * Artifact loading: the caller feeds artifacts ONE AT A TIME through an async
 * iterable (`artifactLoader`). The engine extracts metadata, sparse trade-P&L
 * events, and compact typed ratio arrays, then releases the artifact reference.
 * Peak memory = 1 artifact + accumulated compact snapshots. It NEVER
 * takes a `BatchSyntheticPairArtifact[]` — that would defeat the disk-backed
 * parsed-artifact LRU in the vite plugin.
 */
import { timeKey, timeToNumber } from "../strategies";
import type { BatchSyntheticPairArtifact } from "../batch-backtest/batch-synthetic-state-miner";

// ============================================================================
// Public types
// ============================================================================

export interface AssetIncidenceEntry {
    asset: string;
    totalPairs: number;
    /** Share of all pair-leg slots (2 * pair count), in [0, 1]. */
    grossSlotShare: number;
    pairs: string[];
}

export interface ExposureCluster {
    assets: string[];
    pairs: string[];
    size: number;
}

export interface ExitPnlCorrelationEntry {
    pairA: string;
    pairB: string;
    /** Pearson correlation; null when below the minimum trade overlap. */
    correlation: number | null;
    overlap: number;
}

export interface RatioCorrelationEntry {
    pairA: string;
    pairB: string;
    /** Pearson correlation; null when below the minimum bar overlap. */
    correlation: number | null;
    overlapBars: number;
}

export interface ExposureRedundancyResult {
    /** Array rather than Map so the NDJSON wire shape remains serializable. */
    assetIncidence: AssetIncidenceEntry[];
    clusters: ExposureCluster[];
    topExitPnlCorrelations: ExitPnlCorrelationEntry[];
    topRatioCorrelations: RatioCorrelationEntry[];
    reportLines: string[];
}

/** Minimum overlapping trade timestamps before an exit-P&L correlation is reported. */
export const MIN_TRADE_OVERLAP = 30;
/** Minimum overlapping ratio bars before a ratio correlation is reported. */
export const MIN_RATIO_BAR_OVERLAP = 100;
/** How many of the highest correlations to keep in the top-K lists. */
export const TOP_CORRELATION_COUNT = 10;
/** Positive exit-P&L correlation above which a pair relationship is flagged redundant. */
export const REDUNDANCY_CORRELATION_THRESHOLD = 0.7;

// ============================================================================
// Ingestion-time compact snapshot (one per pair; the artifact is released after)
// ============================================================================

interface PairSnapshot {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    /** timeKey(exitTime) -> summed pnl at that exit timestamp. */
    tradePnlByKey: Map<string, number>;
    /** Compact, time-sorted ratio data retained after the full artifact is released. */
    ratioTimes: Float64Array;
    ratioCloses: Float64Array;
}

function snapshotArtifact(artifact: BatchSyntheticPairArtifact): PairSnapshot {
    const tradePnlByKey = new Map<string, number>();
    for (const trade of artifact.result.trades ?? []) {
        const key = timeKey(trade.exitTime);
        tradePnlByKey.set(key, (tradePnlByKey.get(key) ?? 0) + trade.pnl);
    }
    const ratioTimes: number[] = [];
    const ratioCloses: number[] = [];
    for (const bar of artifact.data ?? []) {
        const timestamp = timeToNumber(bar.time);
        if (timestamp === null || !Number.isFinite(bar.close)) continue;
        ratioTimes.push(timestamp);
        ratioCloses.push(bar.close);
    }
    return {
        symbol: artifact.symbol,
        baseAsset: artifact.baseAsset,
        quoteAsset: artifact.quoteAsset,
        tradePnlByKey,
        ratioTimes: Float64Array.from(ratioTimes),
        ratioCloses: Float64Array.from(ratioCloses),
    };
}

// ============================================================================
// 1.1 Asset incidence + connected-component clusters
// ============================================================================

interface MutableAssetIncidenceEntry {
    totalPairs: number;
    pairs: string[];
}

function computeAssetIncidence(snapshots: readonly PairSnapshot[]): Map<string, MutableAssetIncidenceEntry> {
    const incidence = new Map<string, MutableAssetIncidenceEntry>();
    for (const snap of snapshots) {
        for (const asset of [snap.baseAsset, snap.quoteAsset]) {
            let entry = incidence.get(asset);
            if (!entry) {
                entry = { totalPairs: 0, pairs: [] };
                incidence.set(asset, entry);
            }
            entry.totalPairs += 1;
            entry.pairs.push(snap.symbol);
        }
    }
    return incidence;
}

function toAssetIncidenceEntries(
    incidence: ReadonlyMap<string, MutableAssetIncidenceEntry>,
    pairCount: number,
): AssetIncidenceEntry[] {
    const totalSlots = pairCount * 2;
    return [...incidence.entries()]
        .map(([asset, entry]) => ({
            asset,
            totalPairs: entry.totalPairs,
            grossSlotShare: totalSlots > 0 ? entry.totalPairs / totalSlots : 0,
            pairs: entry.pairs,
        }))
        .sort((a, b) => b.totalPairs - a.totalPairs || a.asset.localeCompare(b.asset));
}

/**
 * Connected components on the bipartite graph: pairs are nodes, an edge joins
 * two pairs that share at least one asset. Union-find over pair indexes.
 */
function computeClusters(snapshots: readonly PairSnapshot[]): ExposureCluster[] {
    const parent = snapshots.map((_, index) => index);
    const find = (index: number): number => {
        let root = index;
        while (parent[root] !== root) root = parent[root]!;
        // Path compression.
        let cursor = index;
        while (parent[cursor] !== cursor) {
            const next = parent[cursor]!;
            parent[cursor] = root;
            cursor = next;
        }
        return root;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    // Join every pair of snapshots that share an asset.
    const pairIndexesByAsset = new Map<string, number[]>();
    snapshots.forEach((snap, index) => {
        for (const asset of [snap.baseAsset, snap.quoteAsset]) {
            const list = pairIndexesByAsset.get(asset);
            if (list) list.push(index);
            else pairIndexesByAsset.set(asset, [index]);
        }
    });
    for (const indexes of pairIndexesByAsset.values()) {
        for (let i = 1; i < indexes.length; i += 1) {
            union(indexes[0]!, indexes[i]!);
        }
    }

    const byRoot = new Map<number, number[]>();
    snapshots.forEach((_, index) => {
        const root = find(index);
        const list = byRoot.get(root);
        if (list) list.push(index);
        else byRoot.set(root, [index]);
    });

    const clusters: ExposureCluster[] = [];
    for (const memberIndexes of byRoot.values()) {
        const assets = new Set<string>();
        const pairs: string[] = [];
        for (const index of memberIndexes) {
            const snap = snapshots[index]!;
            assets.add(snap.baseAsset);
            assets.add(snap.quoteAsset);
            pairs.push(snap.symbol);
        }
        clusters.push({
            assets: [...assets].sort(),
            pairs,
            size: memberIndexes.length,
        });
    }
    // Largest cluster first for the report.
    clusters.sort((a, b) => b.size - a.size);
    return clusters;
}

// ============================================================================
// Pearson correlation (inline, per plan — no shared primitive exists for
// aligned-pair Pearson with a null-on-insufficient-overlap contract).
// ============================================================================

/** Pearson on two equal-length aligned arrays. null when n < minN or a series is degenerate. */
function pearsonOnAligned(a: readonly number[], b: readonly number[], minN: number): number | null {
    const n = a.length;
    if (n < minN || n !== b.length) return null;
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < n; i += 1) {
        sumA += a[i]!;
        sumB += b[i]!;
    }
    const meanA = sumA / n;
    const meanB = sumB / n;
    let cov = 0;
    let varA = 0;
    let varB = 0;
    for (let i = 0; i < n; i += 1) {
        const da = a[i]! - meanA;
        const db = b[i]! - meanB;
        cov += da * db;
        varA += da * da;
        varB += db * db;
    }
    if (varA <= 0 || varB <= 0) return null;
    const corr = cov / Math.sqrt(varA * varB);
    // Clamp tiny float overshoot beyond [-1, 1].
    return Math.max(-1, Math.min(1, corr));
}

function correlationMagnitude(value: number | null): number {
    return value === null || !Number.isFinite(value) ? Number.NEGATIVE_INFINITY : Math.abs(value);
}

// ============================================================================
// 1.2 Exit-P&L correlation (sparse join on trade exit timestamps)
// ============================================================================

/** Align two trade-pnl maps on shared exit timestamps. Returns the overlap. */
function alignTradePnl(
    a: PairSnapshot,
    b: PairSnapshot,
): { alignedA: number[]; alignedB: number[] } {
    // Iterate the smaller map for the join.
    const [small, large] = a.tradePnlByKey.size <= b.tradePnlByKey.size
        ? [a.tradePnlByKey, b.tradePnlByKey]
        : [b.tradePnlByKey, a.tradePnlByKey];
    const alignedA: number[] = [];
    const alignedB: number[] = [];
    for (const [key, pnl] of small) {
        const other = large.get(key);
        if (other !== undefined) {
            alignedA.push(pnl);
            alignedB.push(other);
        }
    }
    return { alignedA, alignedB };
}

/** Full (untruncated) exit-P&L correlation list, sorted by |correlation| desc. */
function computeExitPnlCorrelations(snapshots: readonly PairSnapshot[]): ExitPnlCorrelationEntry[] {
    const out: ExitPnlCorrelationEntry[] = [];
    for (let i = 0; i < snapshots.length; i += 1) {
        for (let j = i + 1; j < snapshots.length; j += 1) {
            const a = snapshots[i]!;
            const b = snapshots[j]!;
            const { alignedA, alignedB } = alignTradePnl(a, b);
            const overlap = alignedA.length;
            const correlation = overlap >= MIN_TRADE_OVERLAP
                ? pearsonOnAligned(alignedA, alignedB, MIN_TRADE_OVERLAP)
                : null;
            out.push({ pairA: a.symbol, pairB: b.symbol, correlation, overlap });
        }
    }
    // Sort by |correlation| descending; nulls (insufficient overlap) sink to the bottom.
    out.sort((x, y) => correlationMagnitude(y.correlation) - correlationMagnitude(x.correlation));
    return out;
}

// ============================================================================
// 1.3 Ratio-return correlation (close-to-close returns on pairwise intersection)
// ============================================================================

function computeRatioCorrelations(snapshots: readonly PairSnapshot[]): RatioCorrelationEntry[] {
    const out: RatioCorrelationEntry[] = [];
    for (let i = 0; i < snapshots.length; i += 1) {
        for (let j = i + 1; j < snapshots.length; j += 1) {
            const a = snapshots[i]!;
            const b = snapshots[j]!;
            // Both compact snapshots are time-sorted. A two-pointer join avoids
            // retaining millions of string-keyed Map entries across the run.
            const closesA: number[] = [];
            const closesB: number[] = [];
            let indexA = 0;
            let indexB = 0;
            while (indexA < a.ratioTimes.length && indexB < b.ratioTimes.length) {
                const timeA = a.ratioTimes[indexA]!;
                const timeB = b.ratioTimes[indexB]!;
                if (timeA === timeB) {
                    closesA.push(a.ratioCloses[indexA]!);
                    closesB.push(b.ratioCloses[indexB]!);
                    indexA += 1;
                    indexB += 1;
                } else if (timeA < timeB) {
                    indexA += 1;
                } else {
                    indexB += 1;
                }
            }
            // Returns need overlap >= MIN+1 closes to produce MIN returns.
            const overlapBars = closesA.length;
            let correlation: number | null = null;
            if (overlapBars >= MIN_RATIO_BAR_OVERLAP + 1) {
                const returnsA: number[] = [];
                const returnsB: number[] = [];
                for (let k = 1; k < closesA.length; k += 1) {
                    const prevA = closesA[k - 1]!;
                    const prevB = closesB[k - 1]!;
                    if (prevA !== 0 && prevB !== 0) {
                        returnsA.push((closesA[k]! - prevA) / prevA);
                        returnsB.push((closesB[k]! - prevB) / prevB);
                    }
                }
                correlation = pearsonOnAligned(returnsA, returnsB, MIN_RATIO_BAR_OVERLAP);
            }
            out.push({ pairA: a.symbol, pairB: b.symbol, correlation, overlapBars });
        }
    }
    out.sort((x, y) => correlationMagnitude(y.correlation) - correlationMagnitude(x.correlation));
    return out.slice(0, TOP_CORRELATION_COUNT);
}

// ============================================================================
// Report rendering (descriptive, no quality labels)
// ============================================================================

function buildReportLines(
    snapshots: readonly PairSnapshot[],
    assetIncidence: ReadonlyMap<string, MutableAssetIncidenceEntry>,
    clusters: ExposureCluster[],
    topExitPnl: readonly ExitPnlCorrelationEntry[],
    topRatio: readonly RatioCorrelationEntry[],
    allExitPnl: readonly ExitPnlCorrelationEntry[],
): string[] {
    const lines: string[] = [];
    const pairs = snapshots.length;
    const assets = assetIncidence.size;
    lines.push(`EXPOSURE   | pairs=${pairs} assets=${assets}`);
    lines.push("EXPOSURE   | NOTE: descriptive analysis of pair concentration and overlap. No quality labels.");

    // Assets sorted by incidence descending.
    const totalLegSlots = pairs * 2;
    const sortedAssets = [...assetIncidence.entries()].sort((a, b) => b[1].totalPairs - a[1].totalPairs);
    const assetText = sortedAssets
        .slice(0, 12)
        .map(([asset, entry]) => {
            const slotShare = totalLegSlots > 0 ? (entry.totalPairs / totalLegSlots) * 100 : 0;
            return `${asset} in ${entry.totalPairs} pair${entry.totalPairs === 1 ? "" : "s"} (${slotShare.toFixed(1)}% leg slots)`;
        })
        .join(" | ");
    lines.push(`ASSETS     | ${assetText || "(none)"}`);

    const slotShares = sortedAssets.map(([, entry]) => totalLegSlots > 0 ? entry.totalPairs / totalLegSlots : 0);
    const hhi = slotShares.reduce((sum, share) => sum + share * share, 0);
    const effectiveAssets = hhi > 0 ? 1 / hhi : 0;
    const topShare = (count: number): number => slotShares.slice(0, count).reduce((sum, share) => sum + share, 0) * 100;
    lines.push(
        `CONCENTRATION | legSlots=${totalLegSlots} | EffAssets=${effectiveAssets.toFixed(1)} | Top5=${topShare(5).toFixed(1)}% | Top10=${topShare(10).toFixed(1)}%`,
    );

    const largestCluster = clusters[0];
    lines.push(largestCluster
        ? `NETWORK    | components=${clusters.length} | largest=${largestCluster.size}/${pairs} pairs across ${largestCluster.assets.length}/${assets} assets`
        : "NETWORK    | components=0");

    const exitPnlText = topExitPnl
        .filter((entry) => entry.correlation !== null)
        .slice(0, 5)
        .map((entry) => `${entry.pairA} ↔ ${entry.pairB} = ${entry.correlation!.toFixed(2)} (overlap=${entry.overlap} trades)`)
        .join(" | ");
    lines.push(`EXIT_PNL_CORR | Top simultaneous-exit correlations: ${exitPnlText || "(insufficient trade overlap)"}`);

    const snapshotBySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot] as const));
    const ratioText = topRatio
        .filter((entry) => entry.correlation !== null)
        .slice(0, 5)
        .map((entry) => {
            const a = snapshotBySymbol.get(entry.pairA);
            const b = snapshotBySymbol.get(entry.pairB);
            const shared = a && b
                ? [a.baseAsset, a.quoteAsset].filter((asset) => asset === b.baseAsset || asset === b.quoteAsset)
                : [];
            const sharedText = shared.length > 0 ? `, shared=${shared.join("+")}` : "";
            return `${entry.pairA} ↔ ${entry.pairB} = ${entry.correlation!.toFixed(4)} (overlap=${entry.overlapBars} bars${sharedText})`;
        })
        .join(" | ");
    lines.push(`RATIO_CORR | Top correlations: ${ratioText || "(insufficient bar overlap)"}`);
    lines.push("RATIO_CORR_NOTE | Full-history ratio returns may be dominated by shared corporate-action jumps; validate split-adjusted or event-filtered data before using as redundancy evidence.");

    // Positive correlation indicates redundancy; strong negative correlation
    // is reported separately because it may diversify rather than duplicate.
    const redundant = new Set<string>();
    let redundantRelationships = 0;
    let diversifyingRelationships = 0;
    for (const entry of allExitPnl) {
        if (entry.correlation !== null && entry.correlation > REDUNDANCY_CORRELATION_THRESHOLD) {
            redundant.add(entry.pairA);
            redundant.add(entry.pairB);
            redundantRelationships += 1;
        } else if (entry.correlation !== null && entry.correlation < -REDUNDANCY_CORRELATION_THRESHOLD) {
            diversifyingRelationships += 1;
        }
    }
    const hasExitPnlCorrelation = allExitPnl.some((entry) => entry.correlation !== null);
    lines.push(hasExitPnlCorrelation
        ? `REDUNDANCY | ${redundantRelationships} high-positive exit-P&L relationship${redundantRelationships === 1 ? "" : "s"} involve ${redundant.size} pair${redundant.size === 1 ? "" : "s"} (corr>${REDUNDANCY_CORRELATION_THRESHOLD}, overlap>=${MIN_TRADE_OVERLAP}); review shared exposure`
        : `REDUNDANCY | unavailable — no pair pairs met the ${MIN_TRADE_OVERLAP}-exit overlap requirement`);
    lines.push(hasExitPnlCorrelation
        ? `DIVERSIFICATION | ${diversifyingRelationships} high-negative exit-P&L relationship${diversifyingRelationships === 1 ? "" : "s"} (corr<-${REDUNDANCY_CORRELATION_THRESHOLD}, overlap>=${MIN_TRADE_OVERLAP})`
        : "DIVERSIFICATION | unavailable — no pair pairs met the exit overlap requirement");
    return lines;
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Run the Exposure & Redundancy report over artifacts supplied one at a time.
 *
 * @param artifactLoader returns an async iterable that yields each artifact
 *   exactly once. The engine snapshots compact data and releases the reference, so
 *   the caller must NOT pre-load all artifacts into an array.
 * @param onPairProgress optional progress callback after each pair is ingested.
 * @param shouldStop optional cancellation probe; checked between pairs.
 */
export async function runExposureRedundancyReport(
    artifactLoader: () => AsyncIterable<BatchSyntheticPairArtifact>,
    onPairProgress?: (symbol: string, done: number, total: number) => void,
    shouldStop?: () => boolean,
): Promise<ExposureRedundancyResult> {
    const snapshots: PairSnapshot[] = [];
    let done = 0;
    // `total` is unknown until iteration completes for a true async iterable;
    // the progress callback mirrors Mine's (symbol, done, total) shape with
    // total = best-known (grows as we ingest). Callers that know the count up
    // front can wrap the loader and supply their own total via the callback's
    // third arg — here we pass the running count.
    for await (const artifact of artifactLoader()) {
        if (shouldStop?.()) break;
        snapshots.push(snapshotArtifact(artifact));
        done += 1;
        onPairProgress?.(artifact.symbol, done, done);
    }

    const assetIncidenceMap = computeAssetIncidence(snapshots);
    const assetIncidence = toAssetIncidenceEntries(assetIncidenceMap, snapshots.length);
    const clusters = computeClusters(snapshots);
    // Full exit-P&L set drives the relationship counts; the truncated top-K is for display.
    const allExitPnl = computeExitPnlCorrelations(snapshots);
    const topExitPnl = allExitPnl.slice(0, TOP_CORRELATION_COUNT);
    const topRatio = computeRatioCorrelations(snapshots);
    const reportLines = buildReportLines(snapshots, assetIncidenceMap, clusters, topExitPnl, topRatio, allExitPnl);

    return { assetIncidence, clusters, topExitPnlCorrelations: topExitPnl, topRatioCorrelations: topRatio, reportLines };
}
