/**
 * Sort-concentration decomposition for Asset Opportunity holdout archives.
 *
 * The companion `analyze-asset-opportunity-holdouts.ts` reports each archive
 * sort's mean forward-OOS PnL. A high mean can be driven by a few outlier
 * symbols rather than a broad selection edge. This script decomposes each
 * sort's forward-OOS mean into per-symbol contributions so "broad-based edge"
 * and "a handful of names that happened to rip" are distinguishable.
 *
 * This is the feasible archive-only answer to "is the sort's delta real or a
 * few outliers?" A true price-volatility-matched control needs each pair's
 * ratio series, which the durable archive does not store (it carries only
 * forward-OOS PnL + symbol). Reusing the batch artifact ratio series requires
 * a live 10-min-TTL artifact; recomputing it requires the full synthetic-pair
 * seed pipeline. Neither belongs here.
 *
 * Methodology (mirrors the FORWARD OOS SUMMARY population exactly):
 *   - For each (sortMetric, horizon), gather one observation per archived
 *     top-N row per holdout: { symbol, pnlPercent = horizon.averagePnlPercent }.
 *   - The "Sort avg" reproduces the existing report's Average PnL.
 *   - "Ex-top-K avg" recomputes the mean after dropping every observation from
 *     the K highest-contributing symbols. If the edge survives ex-top-K it is
 *     broad-based; if it collapses toward the baseline it was outlier-driven.
 *   - "Top-K share" = sum(top-K symbols' pnl) / sum(all pnl) × 100 — can exceed
 *     100% when the remaining symbols net negative.
 *
 * Descriptive evidence only. Holdout windows overlap; do not treat shares or
 * averages as independent probabilities.
 *
 * Usage:
 *   npm exec -- esno scripts/analyze-asset-opportunity-sort-concentration.ts
 *   npm exec -- esno scripts/analyze-asset-opportunity-sort-concentration.ts -- --batch-run-id <id>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    readAssetOpportunityArchive,
    type AssetOpportunityArchiveRecord,
} from "./analyze-asset-opportunity-holdouts";

interface SortObservation {
    symbol: string;
    pnlPercent: number;
}

interface SymbolContribution {
    symbol: string;
    observations: number;
    sumPnl: number;
    averagePnl: number;
    /** This symbol's contribution to the overall mean = (sumPnl) / totalObservations. */
    contributionToMean: number;
}

interface SortConcentration {
    sortMetric: string;
    horizonBars: number;
    totalObservations: number;
    distinctSymbols: number;
    sortAveragePnl: number | null;
    exTop3AveragePnl: number | null;
    exTop5AveragePnl: number | null;
    top3SharePercent: number | null;
    top5SharePercent: number | null;
    baselineAveragePnl: number | null;
    topContributors: SymbolContribution[];
}

function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

function defaultArchiveDirectory(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "archive", "asset opportunity");
}

interface BatchRunGroup {
    batchRunId: string;
    records: AssetOpportunityArchiveRecord[];
    holdoutBars: Set<number>;
    latestTimestamp: string;
}

/** Mirror analyze-asset-opportunity-holdouts.ts: dedupe by holdout|sort, keep latest. */
function deduplicateRecords(records: AssetOpportunityArchiveRecord[]): AssetOpportunityArchiveRecord[] {
    const latest = new Map<string, AssetOpportunityArchiveRecord>();
    for (const record of records) {
        const key = `${record.holdoutBars}|${record.sortMetric}`;
        const previous = latest.get(key);
        if (!previous || record.timestamp.localeCompare(previous.timestamp) >= 0) {
            latest.set(key, record);
        }
    }
    return [...latest.values()];
}

function selectBatchRun(records: AssetOpportunityArchiveRecord[], requested?: string): BatchRunGroup {
    const groups = new Map<string, BatchRunGroup>();
    for (const record of records) {
        let group = groups.get(record.batchRunId);
        if (!group) {
            group = { batchRunId: record.batchRunId, records: [], holdoutBars: new Set(), latestTimestamp: record.timestamp };
            groups.set(record.batchRunId, group);
        }
        group.records.push(record);
        group.holdoutBars.add(record.holdoutBars);
        if (record.timestamp.localeCompare(group.latestTimestamp) > 0) group.latestTimestamp = record.timestamp;
    }
    const selected = requested
        ? groups.get(requested)
        : [...groups.values()].sort((a, b) => b.holdoutBars.size - a.holdoutBars.size
            || b.latestTimestamp.localeCompare(a.latestTimestamp))[0];
    if (!selected) throw new Error(`Batch run not found: ${requested ?? "<auto>"}`);
    return { ...selected, records: deduplicateRecords(selected.records) };
}

/** Collect per-horizon observations for one sort, mirroring the report population. */
function collectSortObservations(
    records: AssetOpportunityArchiveRecord[],
    horizonBars: number,
    topK: number,
): SortObservation[] {
    const observations: SortObservation[] = [];
    for (const record of records) {
        for (const row of record.topResults.slice(0, topK)) {
            const horizon = row.forwardOosPerformance?.horizons?.find((h) => h.bars === horizonBars);
            if (!horizon || horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
            if (!row.symbol) continue;
            observations.push({ symbol: row.symbol, pnlPercent: horizon.averagePnlPercent });
        }
    }
    return observations;
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function buildSymbolContributions(observations: SortObservation[]): SymbolContribution[] {
    const totals = new Map<string, { sum: number; count: number }>();
    for (const obs of observations) {
        const entry = totals.get(obs.symbol) ?? { sum: 0, count: 0 };
        entry.sum += obs.pnlPercent;
        entry.count += 1;
        totals.set(obs.symbol, entry);
    }
    const totalObservations = observations.length;
    return [...totals.entries()]
        .map(([symbol, entry]) => ({
            symbol,
            observations: entry.count,
            sumPnl: entry.sum,
            averagePnl: entry.sum / entry.count,
            contributionToMean: totalObservations > 0 ? entry.sum / totalObservations : 0,
        }))
        .sort((a, b) => b.sumPnl - a.sumPnl || b.observations - a.observations || a.symbol.localeCompare(b.symbol));
}

function buildSortConcentration(
    records: AssetOpportunityArchiveRecord[],
    sortMetric: string,
    horizonBars: number,
    topK: number,
    baselineAveragePnl: number | null,
): SortConcentration | null {
    const sortRecords = records.filter((r) => r.sortMetric === sortMetric);
    const observations = collectSortObservations(sortRecords, horizonBars, topK);
    if (observations.length === 0) return null;

    const contributions = buildSymbolContributions(observations);
    const overall = observations.map((o) => o.pnlPercent);
    const totalSum = overall.reduce((s, v) => s + v, 0);
    const sortAverage = mean(overall);

    const excludeTop = (k: number): { exAvg: number | null; sharePercent: number | null } => {
        const excluded = new Set(contributions.slice(0, k).map((c) => c.symbol));
        const remaining = observations.filter((o) => !excluded.has(o.symbol)).map((o) => o.pnlPercent);
        const topSum = contributions.slice(0, k).reduce((s, c) => s + c.sumPnl, 0);
        return {
            exAvg: mean(remaining),
            sharePercent: totalSum !== 0 ? (topSum / totalSum) * 100 : null,
        };
    };
    const top3 = excludeTop(3);
    const top5 = excludeTop(5);

    return {
        sortMetric,
        horizonBars,
        totalObservations: observations.length,
        distinctSymbols: contributions.length,
        sortAveragePnl: sortAverage,
        exTop3AveragePnl: top3.exAvg,
        exTop5AveragePnl: top5.exAvg,
        top3SharePercent: top3.sharePercent,
        top5SharePercent: top5.sharePercent,
        baselineAveragePnl,
        topContributors: contributions.slice(0, 5),
    };
}

function formatPercent(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}%`;
}

function baselineByHorizon(records: AssetOpportunityArchiveRecord[]): Map<number, number | null> {
    // Average the per-holdout baseline horizon averages (one per holdout record),
    // mirroring analyze-asset-opportunity-holdouts.ts buildBaselineHorizonAnalysis.
    const byHorizon = new Map<number, number[]>();
    const seen = new Set<string>(); // one baseline per holdoutBars
    for (const record of records) {
        if (!record.baseline) continue;
        const key = String(record.holdoutBars);
        if (seen.has(key)) continue;
        seen.add(key);
        for (const h of record.baseline.horizons) {
            if (h.averagePnlPercent === null || !Number.isFinite(h.averagePnlPercent)) continue;
            const list = byHorizon.get(h.bars) ?? [];
            list.push(h.averagePnlPercent);
            byHorizon.set(h.bars, list);
        }
    }
    const result = new Map<number, number | null>();
    for (const [bars, list] of byHorizon) result.set(bars, list.length > 0 ? list.reduce((s, v) => s + v, 0) / list.length : null);
    return result;
}

function render(concentrations: SortConcentration[], batchRunId: string, holdoutBars: number[]): string {
    const lines: string[] = [
        "Asset Opportunity Sort Concentration Report",
        "============================================",
        `Selected batch run: ${batchRunId}`,
        `Holdout bars: ${holdoutBars.join(", ")}`,
        "",
        "Interpretation: each sort's forward-OOS mean is decomposed by symbol. If the mean",
        "collapses toward the baseline after dropping the top-K symbols (Ex-top-K avg), the",
        "'edge' was outlier-driven, not broad-based selection skill. Shares can exceed 100%",
        "when the remaining symbols net negative. Descriptive only; windows overlap.",
        "",
        "SORT CONCENTRATION SUMMARY",
        "Sort | Horizon | Sort avg | Baseline | Ex-top3 avg | Ex-top5 avg | Top3 share | Top5 share | Symbols | Obs",
    ];
    for (const c of concentrations) {
        lines.push([
            c.sortMetric,
            `${c.horizonBars} bars`,
            formatPercent(c.sortAveragePnl),
            formatPercent(c.baselineAveragePnl),
            formatPercent(c.exTop3AveragePnl),
            formatPercent(c.exTop5AveragePnl),
            formatPercent(c.top3SharePercent),
            formatPercent(c.top5SharePercent),
            String(c.distinctSymbols),
            String(c.totalObservations),
        ].join(" | "));
    }
    lines.push("", "TOP CONTRIBUTORS PER SORT (by total PnL contribution; one row per symbol)",
        "Sort | Horizon | Symbol | Obs | Avg PnL | Contribution to mean");
    for (const c of concentrations) {
        for (const contrib of c.topContributors) {
            lines.push([
                c.sortMetric,
                `${c.horizonBars} bars`,
                contrib.symbol,
                String(contrib.observations),
                formatPercent(contrib.averagePnl),
                formatPercent(contrib.contributionToMean),
            ].join(" | "));
        }
    }
    return `${lines.join("\n")}\n`;
}

function main(): void {
    const archiveDirectory = path.resolve(getArgument(process.argv.slice(2), "--archive-dir") ?? defaultArchiveDirectory());
    const requestedBatchRunId = getArgument(process.argv.slice(2), "--batch-run-id");
    const topKValue = Number(getArgument(process.argv.slice(2), "--top-k") ?? 10);
    const topK = Number.isInteger(topKValue) && topKValue > 0 ? topKValue : 10;
    try {
        const allRecords = readAssetOpportunityArchive(archiveDirectory);
        const selected = selectBatchRun(allRecords, requestedBatchRunId);
        const records = selected.records;
        const sortMetrics = [...new Set(records.map((r) => r.sortMetric))].sort();
        const horizonBars = [...new Set(records.flatMap((r) => (r.topResults ?? []).flatMap((row) => row.forwardOosPerformance?.horizons?.map((h) => h.bars) ?? [])))].sort((a, b) => a - b);
        const baselines = baselineByHorizon(records);
        const concentrations: SortConcentration[] = [];
        for (const sortMetric of sortMetrics) {
            for (const horizon of horizonBars) {
                const c = buildSortConcentration(records, sortMetric, horizon, topK, baselines.get(horizon) ?? null);
                if (c) concentrations.push(c);
            }
        }
        const output = render(concentrations, selected.batchRunId, [...selected.holdoutBars].sort((a, b) => a - b));
        console.log(output);
    } catch (error) {
        console.error(`[asset-opportunity-concentration] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedScript === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
