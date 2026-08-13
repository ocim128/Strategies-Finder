/**
 * Volatility-matched control for Asset Opportunity sort edges.
 *
 * Purpose: decide whether a sort's forward-OOS edge (especially
 * `freshSignalLibraries`) is real selection skill or just concentration into
 * high-volatility pairs that swing more in a trending regime.
 *
 * Data source: the durable holdout archive only — each archived top-N row now
 * carries `pairVolatility` (stdev of the pair's in-sample close-to-close log
 * returns), attached by the Asset Opportunity runner. The Finder writes no
 * batch artifacts, so this scalar is the durable record of each pair's risk.
 *
 * Method:
 *   1. Read the newest batch run in the archive. Collect each pair's
 *      `pairVolatility` (per-symbol, identical across its rows).
 *   2. For each sort, derive per-symbol mean forward-OOS PnL across the
 *      holdouts where it was selected, plus the all-candidate baseline.
 *   3. Bucket pairs into volatility quintiles. Report each sort's selected mean
 *      volatility vs the universe mean, and how much of its edge lives in the
 *      top volatility quintile.
 *
 * Reading the verdict:
 *   - A sort whose selected mean vol ≈ universe mean vol but still beats
 *     baseline is NOT a volatility proxy (skill-like).
 *   - A sort whose selected mean vol >> universe mean vol, with its edge
 *     concentrated in the top quintile, IS beta.
 *
 * Caveat: the archive stores only selected top-N rows, so the "universe" here
 * is the union of pairs ever selected by any sort/holdout — a close proxy for
 * the traded universe but not the full pair set. Descriptive only; holdout
 * windows overlap.
 *
 * Requires a batch run archived with `pairVolatility` populated (re-run a batch
 * if your archive predates the field).
 *
 * Usage:
 *   npm run validate:fresh-signal-vol-control
 *   npm run validate:fresh-signal-vol-control -- --batch-run-id <id>
 *   npm run validate:fresh-signal-vol-control -- --sorts freshSignalLibraries,totalTrades
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    readAssetOpportunityArchive,
    type AssetOpportunityArchiveRecord,
    type AssetOpportunityArchiveRow,
} from "./analyze-asset-opportunity-holdouts";

const PRIMARY_HORIZON = 12;
const VOLATILITY_QUINTILES = 5;
const TOP_K = 10;

interface SymbolForwardOos {
    observations: number;
    meanPnlByHorizon: Map<number, number>;
}

function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

// ============================================================================
// Archive reading
// ============================================================================

function deduplicateRecords(records: AssetOpportunityArchiveRecord[]): AssetOpportunityArchiveRecord[] {
    const latest = new Map<string, AssetOpportunityArchiveRecord>();
    for (const record of records) {
        const key = `${record.holdoutBars}|${record.sortMetric}`;
        const previous = latest.get(key);
        if (!previous || record.timestamp.localeCompare(previous.timestamp) >= 0) latest.set(key, record);
    }
    return [...latest.values()];
}

interface BatchRunGroup {
    batchRunId: string;
    records: AssetOpportunityArchiveRecord[];
    latestTimestamp: string;
}

function selectNewestBatchRun(records: AssetOpportunityArchiveRecord[], requested?: string): BatchRunGroup {
    const groups = new Map<string, BatchRunGroup>();
    for (const record of records) {
        let group = groups.get(record.batchRunId);
        if (!group) {
            group = { batchRunId: record.batchRunId, records: [], latestTimestamp: record.timestamp };
            groups.set(record.batchRunId, group);
        }
        group.records.push(record);
        if (record.timestamp.localeCompare(group.latestTimestamp) > 0) group.latestTimestamp = record.timestamp;
    }
    const selected = requested
        ? groups.get(requested)
        : [...groups.values()].sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp))[0];
    if (!selected) throw new Error(`Batch run not found: ${requested ?? "<auto>"}`);
    return { ...selected, records: deduplicateRecords(selected.records) };
}

/** Per-symbol pair volatility: first non-null value seen across any sort/holdout. */
function loadPairVolatilities(records: AssetOpportunityArchiveRecord[]): Map<string, number> {
    const volatilities = new Map<string, number>();
    for (const record of records) {
        for (const row of record.topResults.slice(0, TOP_K)) {
            if (!row.symbol) continue;
            if (volatilities.has(row.symbol)) continue;
            if (typeof row.pairVolatility === "number" && Number.isFinite(row.pairVolatility)) {
                volatilities.set(row.symbol, row.pairVolatility);
            }
        }
    }
    return volatilities;
}

/** Per (sortMetric, symbol): forward-OOS mean by horizon + selection count. */
function buildSortForwardOos(
    records: AssetOpportunityArchiveRecord[],
): Map<string, Map<string, SymbolForwardOos>> {
    const bySort = new Map<string, Map<string, { counts: Map<number, number>; sums: Map<number, number> }>>();
    for (const record of records) {
        const inner = bySort.get(record.sortMetric) ?? new Map();
        for (const row of record.topResults.slice(0, TOP_K) as AssetOpportunityArchiveRow[]) {
            if (!row.symbol) continue;
            const acc = inner.get(row.symbol) ?? { counts: new Map<number, number>(), sums: new Map<number, number>() };
            for (const horizon of row.forwardOosPerformance?.horizons ?? []) {
                if (horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
                acc.sums.set(horizon.bars, (acc.sums.get(horizon.bars) ?? 0) + horizon.averagePnlPercent);
                acc.counts.set(horizon.bars, (acc.counts.get(horizon.bars) ?? 0) + 1);
            }
            inner.set(row.symbol, acc);
            bySort.set(record.sortMetric, inner);
        }
    }
    const result = new Map<string, Map<string, SymbolForwardOos>>();
    for (const [sortMetric, inner] of bySort) {
        const symbolMap = new Map<string, SymbolForwardOos>();
        for (const [symbol, acc] of inner) {
            const meanPnlByHorizon = new Map<number, number>();
            let observations = 0;
            for (const [bars, sum] of acc.sums) {
                const count = acc.counts.get(bars) ?? 0;
                meanPnlByHorizon.set(bars, sum / count);
                observations = Math.max(observations, count);
            }
            symbolMap.set(symbol, { observations, meanPnlByHorizon });
        }
        result.set(sortMetric, symbolMap);
    }
    return result;
}

function buildBaseline(records: AssetOpportunityArchiveRecord[]): Map<number, number> {
    const byHorizon = new Map<number, number[]>();
    const seen = new Set<string>();
    for (const record of records) {
        if (!record.baseline || seen.has(String(record.holdoutBars))) continue;
        seen.add(String(record.holdoutBars));
        for (const h of record.baseline.horizons) {
            if (h.averagePnlPercent === null || !Number.isFinite(h.averagePnlPercent)) continue;
            const list = byHorizon.get(h.bars) ?? [];
            list.push(h.averagePnlPercent);
            byHorizon.set(h.bars, list);
        }
    }
    const result = new Map<number, number>();
    for (const [bars, list] of byHorizon) result.set(bars, list.reduce((s, v) => s + v, 0) / list.length);
    return result;
}

// ============================================================================
// Stats
// ============================================================================

function mean(values: number[]): number {
    return values.reduce((s, v) => s + v, 0) / values.length;
}
function quantileValue(sortedAsc: number[], q: number): number {
    if (sortedAsc.length === 0) return NaN;
    const pos = (sortedAsc.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sortedAsc[lo]!;
    return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}
function fmtPct(v: number | null | undefined): string {
    return v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v.toFixed(2)}%`;
}

// ============================================================================
// Per-sort summary
// ============================================================================

interface SortSummary {
    sortMetric: string;
    selectedCount: number;
    selectedMeanVol: number | null;
    universeMeanVol: number;
    selectedMeanPnl: number | null;
    baselinePnl: number | null;
    topQuintileShare: number | null;
    topQuintilePnl: number | null;
}

function buildSortSummary(
    sortMetric: string,
    forwardOos: Map<string, SymbolForwardOos> | undefined,
    volatilities: Map<string, number>,
    quintileCutoffs: number[],
    universeMeanVol: number,
    baselinePnl: number | null,
): SortSummary | null {
    if (!forwardOos || forwardOos.size === 0) return null;
    let volSum = 0;
    let volCount = 0;
    let pnlSum = 0;
    let pnlCount = 0;
    let topQuintile = 0;
    let topQuintilePnlSum = 0;
    let topQuintilePnlCount = 0;
    for (const [symbol, oos] of forwardOos) {
        const vol = volatilities.get(symbol);
        if (vol === undefined) continue;
        volSum += vol;
        volCount += 1;
        const pnl = oos.meanPnlByHorizon.get(PRIMARY_HORIZON);
        if (pnl !== undefined) {
            pnlSum += pnl;
            pnlCount += 1;
        }
        if (quintileCutoffs.length >= 4 && vol >= quintileCutoffs[3]!) {
            topQuintile += 1;
            if (pnl !== undefined) {
                topQuintilePnlSum += pnl;
                topQuintilePnlCount += 1;
            }
        }
    }
    if (volCount === 0) return null;
    return {
        sortMetric,
        selectedCount: volCount,
        selectedMeanVol: volSum / volCount,
        universeMeanVol,
        selectedMeanPnl: pnlCount > 0 ? pnlSum / pnlCount : null,
        baselinePnl,
        topQuintileShare: topQuintile / volCount,
        topQuintilePnl: topQuintilePnlCount > 0 ? topQuintilePnlSum / topQuintilePnlCount : null,
    };
}

function render(
    summaries: SortSummary[],
    volDistribution: { q20: number; q40: number; q60: number; q80: number; min: number; max: number; universeSize: number },
    batchRunId: string,
    horizon: number,
): string {
    const lines: string[] = [
        "Asset Opportunity Volatility-Matched Control",
        "=============================================",
        `Archive batch run: ${batchRunId}`,
        `Primary horizon: ${horizon} bars | Volatility quintiles: 5`,
        "",
        "Universe pair volatility (log-ratio return stdev): "
        + `min ${volDistribution.min.toExponential(3)}, Q1 ${(volDistribution.q20).toExponential(3)}, `
        + `Q2 ${(volDistribution.q40).toExponential(3)}, Q3 ${(volDistribution.q60).toExponential(3)}, `
        + `Q4 ${(volDistribution.q80).toExponential(3)}, max ${volDistribution.max.toExponential(3)} | `
        + `pairs: ${volDistribution.universeSize}`,
        "",
        "Universe = union of pairs ever selected by any sort/holdout in this batch run's archive",
        "(a proxy for the traded universe; the archive stores only selected top-N rows).",
        "",
        "Verdict keys: 'Vol ratio' (selected/universe mean vol) near 1.0 = does NOT chase volatility.",
        "Edge concentrated in 'Q5 share'/'Q5-only PnL' = beta (volatility-driven), not skill.",
        "",
        `Sort | Selected | Sel mean vol | Universe mean vol | Vol ratio | ${horizon}-bar PnL | Baseline | Δ | Q5 share | Q5-only PnL`,
    ];
    for (const s of summaries) {
        const volRatio = s.universeMeanVol > 0 ? s.selectedMeanVol! / s.universeMeanVol : NaN;
        const delta = s.selectedMeanPnl !== null && s.baselinePnl !== null ? s.selectedMeanPnl - s.baselinePnl : null;
        lines.push([
            s.sortMetric,
            String(s.selectedCount),
            s.selectedMeanVol!.toExponential(3),
            s.universeMeanVol.toExponential(3),
            `${volRatio.toFixed(2)}x`,
            fmtPct(s.selectedMeanPnl),
            fmtPct(s.baselinePnl),
            fmtPct(delta),
            fmtPct((s.topQuintileShare ?? 0) * 100),
            fmtPct(s.topQuintilePnl),
        ].join(" | "));
    }
    return `${lines.join("\n")}\n`;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
    const argv = process.argv.slice(2);
    const requestedBatchRunId = getArgument(argv, "--batch-run-id");
    const sortsArg = getArgument(argv, "--sorts");
    const requestedSorts = sortsArg ? sortsArg.split(",").map((s) => s.trim()).filter(Boolean) : null;

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const archiveDir = path.resolve(scriptDir, "..", "archive", "asset opportunity");
    let records: AssetOpportunityArchiveRecord[];
    try {
        records = readAssetOpportunityArchive(archiveDir);
    } catch (error) {
        console.error(`[vol-control] Could not read archive: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }
    const selected = selectNewestBatchRun(records, requestedBatchRunId);
    const volatilities = loadPairVolatilities(selected.records);
    if (volatilities.size === 0) {
        console.error(
            `[vol-control] No pairVolatility found in archive batch ${selected.batchRunId}. `
            + "Re-run a batch with the current code (pairVolatility is attached at search time).",
        );
        process.exitCode = 1;
        return;
    }
    const sortForwardOos = buildSortForwardOos(selected.records);
    const baseline = buildBaseline(selected.records);

    const universeVols = [...volatilities.values()].sort((a, b) => a - b);
    const universeMeanVol = mean(universeVols);
    const quintileCutoffs = Array.from({ length: VOLATILITY_QUINTILES - 1 }, (_, i) => quantileValue(universeVols, (i + 1) / VOLATILITY_QUINTILES));

    const sortMetrics = requestedSorts ?? [...sortForwardOos.keys()].sort();
    const summaries: SortSummary[] = [];
    for (const sortMetric of sortMetrics) {
        const summary = buildSortSummary(
            sortMetric,
            sortForwardOos.get(sortMetric),
            volatilities,
            quintileCutoffs,
            universeMeanVol,
            baseline.get(PRIMARY_HORIZON) ?? null,
        );
        if (summary) summaries.push(summary);
    }

    if (summaries.length === 0) {
        console.error(
            `[vol-control] No sorts matched (archive batch ${selected.batchRunId}). `
            + `Available: ${[...sortForwardOos.keys()].join(", ")}`,
        );
        process.exitCode = 1;
        return;
    }

    const output = render(
        summaries,
        {
            q20: quintileCutoffs[0]!,
            q40: quintileCutoffs[1]!,
            q60: quintileCutoffs[2]!,
            q80: quintileCutoffs[3]!,
            min: universeVols[0]!,
            max: universeVols[universeVols.length - 1]!,
            universeSize: volatilities.size,
        },
        selected.batchRunId,
        PRIMARY_HORIZON,
    );
    console.log(output);
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly === thisFile) main();
