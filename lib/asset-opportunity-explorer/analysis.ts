import type {
    AssetOpportunityArchiveRecord,
    AssetOpportunityArchiveRow,
} from "./archive-parser";
import type {
    AssetOpportunityExplorerCatalogRun,
    AssetOpportunityExplorerDetailRow,
    AssetOpportunityExplorerDetailsResponse,
    AssetOpportunityExplorerHeatmapCell,
    AssetOpportunityExplorerHeatmapResponse,
    AssetOpportunityExplorerMetric,
    AssetOpportunityExplorerRunSupport,
    AssetOpportunityExplorerSpacing,
} from "./types";

/**
 * Deterministic cell/range calculations for the Opportunity Explorer.
 *
 * Pure leaf: parses nothing, reads no filesystem, and throws plain errors
 * (with an optional HTTP status hint) that the server plugin maps onto
 * responses. Everything here treats archived values as descriptive evidence —
 * no verdicts, no thresholds, no ranking of sorts.
 */

/** Error with a suggested HTTP status; the server maps it onto the response. */
export class ExplorerAnalysisError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "ExplorerAnalysisError";
    }
}

interface CompactHorizon {
    bars: number;
    averagePnlPercent: number;
    sampleSize: number;
}

/** One deduplicated (holdoutBars, sortMetric) block with only the fields the UI needs. */
export interface ExplorerViewBlock {
    holdoutBars: number;
    sortMetric: string;
    timestamp: string;
    sourceFile: string;
    measurementMode?: string;
    /** Block baseline horizon values; only bars present in the archived baseline. */
    baselineHorizons: Array<{ bars: number; averagePnlPercent: number | null }>;
    /** Every horizon bar archived in this block, including unobservable entries. */
    horizonBars: number[];
    /** Explicit forward measurement basis carried by this block's rows; null = unknown. */
    basis: "pair" | "base_only" | null;
    /** Rows in archive order; horizons keep observable entries only. */
    rows: Array<{
        rank: number;
        symbol: string;
        strategyId: string;
        strategyName: string | null;
        candidateFingerprint: string | null;
        horizons: CompactHorizon[];
    }>;
}

/** Compact per-run view: everything controls and details need, nothing else. */
export interface ExplorerView {
    batchRunId: string;
    blocks: ExplorerViewBlock[];
    /** Holdout offsets with retained blocks, ascending. */
    holdoutBars: number[];
    /** Sort metrics with retained blocks, ascending (stable display order). */
    sortMetrics: string[];
    /** Horizon bars archived anywhere in the run, including unobservable entries. */
    horizons: number[];
    support: AssetOpportunityExplorerRunSupport;
    /** Largest archived rank (array-position fallback included); bounds top-K. */
    archiveMaximumRank: number;
}

function normalizeMode(measurementMode: string | undefined): "fixed_horizon" | "next_exit" {
    // Legacy blocks without a header follow the CLI's fixed-horizon convention.
    return measurementMode === "next_exit" ? "next_exit" : "fixed_horizon";
}

function rankOfRow(row: AssetOpportunityArchiveRow, index: number): number {
    return row.rank ?? index + 1;
}

/** Max archived rank across rows, using the array-position fallback for missing ranks. */
function maxRankOfRows(rows: AssetOpportunityArchiveRow[]): number {
    let max = 0;
    for (let index = 0; index < rows.length; index += 1) {
        max = Math.max(max, rankOfRow(rows[index]!, index));
    }
    return max;
}

/** Group records per batch run and summarize catalog metadata. Runs come back newest-first. */
export function summarizeRunCatalog(records: AssetOpportunityArchiveRecord[]): AssetOpportunityExplorerCatalogRun[] {
    const groups = new Map<string, {
        latestTimestamp: string;
        holdoutBars: Set<number>;
        sortMetrics: Set<string>;
        modes: Set<"fixed_horizon" | "next_exit">;
        horizons: Set<number>;
        archiveMaximumRank: number;
        sourceBlockCount: number;
        hasBaselines: boolean;
    }>();
    for (const record of records) {
        let group = groups.get(record.batchRunId);
        if (!group) {
            group = {
                latestTimestamp: record.timestamp,
                holdoutBars: new Set(),
                sortMetrics: new Set(),
                modes: new Set(),
                horizons: new Set(),
                archiveMaximumRank: 0,
                sourceBlockCount: 0,
                hasBaselines: false,
            };
            groups.set(record.batchRunId, group);
        }
        group.latestTimestamp = record.timestamp.localeCompare(group.latestTimestamp) > 0
            ? record.timestamp
            : group.latestTimestamp;
        group.holdoutBars.add(record.holdoutBars);
        group.sortMetrics.add(record.sortMetric);
        group.modes.add(normalizeMode(record.measurementMode));
        for (const horizon of record.baseline?.horizons ?? []) group.horizons.add(horizon.bars);
        for (const row of record.topResults) {
            for (const horizon of row.forwardOosPerformance?.horizons ?? []) group.horizons.add(horizon.bars);
        }
        group.archiveMaximumRank = Math.max(group.archiveMaximumRank, maxRankOfRows(record.topResults));
        group.sourceBlockCount += 1;
        if (record.baseline) group.hasBaselines = true;
    }
    return [...groups.entries()]
        .map(([batchRunId, group]) => {
            const support: AssetOpportunityExplorerRunSupport = group.modes.size > 1
                ? "mixed_modes"
                : group.modes.has("next_exit")
                    ? "next_exit"
                    : "fixed_horizon";
            return {
                batchRunId,
                latestTimestamp: group.latestTimestamp,
                holdoutBars: [...group.holdoutBars].sort((left, right) => left - right),
                sortMetrics: [...group.sortMetrics].sort((left, right) => left.localeCompare(right)),
                support,
                horizons: [...group.horizons].sort((left, right) => left - right),
                archiveMaximumRank: group.archiveMaximumRank,
                sourceBlockCount: group.sourceBlockCount,
                hasBaselines: group.hasBaselines,
            };
        })
        .sort((left, right) => right.latestTimestamp.localeCompare(left.latestTimestamp)
            || left.batchRunId.localeCompare(right.batchRunId));
}

function compactHorizons(row: AssetOpportunityArchiveRow): CompactHorizon[] {
    const compact: CompactHorizon[] = [];
    for (const horizon of row.forwardOosPerformance?.horizons ?? []) {
        if (horizon.sampleSize < 1 || horizon.averagePnlPercent === null || !Number.isFinite(horizon.averagePnlPercent)) {
            continue;
        }
        compact.push({ bars: horizon.bars, averagePnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize });
    }
    return compact;
}

function blockBasis(rows: AssetOpportunityArchiveRow[]): "pair" | "base_only" | null {
    let basis: "pair" | "base_only" | null = null;
    for (const row of rows) {
        const rowBasis = row.forwardOosPerformance?.basis ?? null;
        if (rowBasis === null) continue;
        if (basis !== null && basis !== rowBasis) {
            throw new ExplorerAnalysisError(422, `Conflicting measurement bases within one archive block: "${basis}" and "${rowBasis}".`);
        }
        basis = rowBasis;
    }
    return basis;
}

/** Compact one archive record to the block fields the UI needs; drops unobservable horizon entries. */
export function compactRunRecord(record: AssetOpportunityArchiveRecord): ExplorerViewBlock {
    const basis = blockBasis(record.topResults);
    const rows: ExplorerViewBlock["rows"] = [];
    let archiveRank = 0;
    for (let index = 0; index < record.topResults.length; index += 1) {
        const row = record.topResults[index]!;
        if (!row.symbol || !row.strategyId) continue;
        const rank = rankOfRow(row, index);
        archiveRank = Math.max(archiveRank, rank);
        rows.push({
            rank,
            symbol: row.symbol,
            strategyId: row.strategyId,
            strategyName: row.strategyName ?? null,
            candidateFingerprint: row.candidateFingerprint ?? null,
            horizons: compactHorizons(row),
        });
    }
    rows.sort((left, right) => left.rank - right.rank);
    const horizonBars = new Set<number>();
    for (const horizon of record.baseline?.horizons ?? []) horizonBars.add(horizon.bars);
    for (const row of record.topResults) {
        for (const horizon of row.forwardOosPerformance?.horizons ?? []) horizonBars.add(horizon.bars);
    }
    return {
        holdoutBars: record.holdoutBars,
        sortMetric: record.sortMetric,
        timestamp: record.timestamp,
        sourceFile: record.sourceFile,
        measurementMode: record.measurementMode,
        baselineHorizons: (record.baseline?.horizons ?? []).map((horizon) => ({
            bars: horizon.bars,
            averagePnlPercent: horizon.averagePnlPercent,
        })),
        horizonBars: [...horizonBars].sort((left, right) => left - right),
        basis,
        rows,
    };
}

/**
 * Keep the latest compact block per (holdoutBars, sortMetric); equal timestamps
 * keep the last-encountered block under deterministic filename order (same tie
 * behavior as the CLI dedupe).
 */
export function keepLatestCompactBlock(
    blocksByCell: Map<string, ExplorerViewBlock>,
    block: ExplorerViewBlock,
): void {
    const key = `${block.holdoutBars}|${block.sortMetric}`;
    const previous = blocksByCell.get(key);
    if (!previous || block.timestamp.localeCompare(previous.timestamp) >= 0) {
        blocksByCell.set(key, block);
    }
}

/** Assemble the retained view from compact blocks (already deduplicated per run). */
export function buildViewFromCompactBlocks(batchRunId: string, blocks: ExplorerViewBlock[]): ExplorerView {
    const horizons = new Set<number>();
    let archiveMaximumRank = 0;
    for (const block of blocks) {
        for (const bars of block.horizonBars) horizons.add(bars);
        for (const row of block.rows) archiveMaximumRank = Math.max(archiveMaximumRank, row.rank);
    }
    const modes = new Set<"fixed_horizon" | "next_exit">();
    for (const block of blocks) modes.add(normalizeMode(block.measurementMode));
    return {
        batchRunId,
        blocks,
        holdoutBars: [...new Set(blocks.map((block) => block.holdoutBars))].sort((left, right) => left - right),
        sortMetrics: [...new Set(blocks.map((block) => block.sortMetric))].sort((left, right) => left.localeCompare(right)),
        horizons: [...horizons].sort((left, right) => left - right),
        support: modes.size > 1 ? "mixed_modes" : modes.has("next_exit") ? "next_exit" : "fixed_horizon",
        archiveMaximumRank,
    };
}

/**
 * Build the compact retained view for one run: filter by run BEFORE dedupe,
 * then keep only blocks and row fields the controls/detail calculations need.
 */
export function buildExplorerView(records: AssetOpportunityArchiveRecord[], batchRunId: string): ExplorerView {
    const blocksByCell = new Map<string, ExplorerViewBlock>();
    for (const record of records) {
        if (record.batchRunId !== batchRunId) continue;
        keepLatestCompactBlock(blocksByCell, compactRunRecord(record));
    }
    return buildViewFromCompactBlocks(batchRunId, [...blocksByCell.values()]);
}

/**
 * Display columns: descending holdout offsets. "all" keeps every offset;
 * "horizon" starts at the largest offset and greedily keeps the next offset at
 * least `horizonBars` lower. Built once per snapshot so brushing never moves
 * the sampling anchor.
 */
export function resolveExplorerColumns(
    holdoutBars: number[],
    spacing: AssetOpportunityExplorerSpacing,
    horizonBars: number,
): number[] {
    const descending = [...new Set(holdoutBars)].sort((left, right) => right - left);
    if (spacing !== "horizon" || descending.length === 0) return descending;
    const columns: number[] = [descending[0]!];
    for (const offset of descending.slice(1)) {
        if (columns[columns.length - 1]! - offset >= horizonBars) columns.push(offset);
    }
    return columns;
}

interface CellSummary {
    /** Equal-weight mean over observed selected rows; null when nothing observed. */
    actual: number | null;
    baseline: number | null;
    selectedRows: number;
    observedRows: number;
    totalSamples: number;
}

/** One sort/holdout/horizon cell: equal weight per selected candidate (rank <= topK). */
function summarizeCell(block: ExplorerViewBlock, topK: number, horizonBars: number): CellSummary {
    let actualSum = 0;
    let observedRows = 0;
    let totalSamples = 0;
    let selectedRows = 0;
    for (const row of block.rows) {
        if (row.rank > topK) continue;
        selectedRows += 1;
        const horizon = row.horizons.find((candidate) => candidate.bars === horizonBars);
        if (!horizon) continue;
        observedRows += 1;
        totalSamples += horizon.sampleSize;
        actualSum += horizon.averagePnlPercent;
    }
    return {
        // Equal weight per selected candidate; no observations means null, never zero.
        actual: observedRows > 0 ? actualSum / observedRows : null,
        baseline: block.baselineHorizons.find((horizon) => horizon.bars === horizonBars)?.averagePnlPercent ?? null,
        selectedRows,
        observedRows,
        totalSamples,
    };
}

export interface SnapshotParams {
    batchRunId: string;
    horizonBars: number;
    topK: number;
    spacing: AssetOpportunityExplorerSpacing;
    snapshotId: string;
}

function medianOf(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
}

/**
 * Build the full heatmap snapshot for one run. Rejects next-exit and mixed
 * measurement runs (v1 is fixed-horizon only) and conflicting explicit bases.
 */
export function buildHeatmapSnapshot(view: ExplorerView, params: SnapshotParams): AssetOpportunityExplorerHeatmapResponse {
    if (view.support === "next_exit") {
        throw new ExplorerAnalysisError(409, `Batch run "${view.batchRunId}" uses next-exit measurement; the Opportunity Explorer heatmap currently supports fixed_horizon runs only.`);
    }
    if (view.support === "mixed_modes") {
        throw new ExplorerAnalysisError(409, `Batch run "${view.batchRunId}" contains mixed forward measurement modes; split it into separate runs before exploring.`);
    }
    const columns = resolveExplorerColumns(view.holdoutBars, params.spacing, params.horizonBars);
    // The horizon is a forward measurement length, not a holdout offset; validate
    // it against the horizons actually archived for this run. A horizon with zero
    // observable outcomes still renders (as all-missing cells).
    if (!view.horizons.includes(params.horizonBars)) {
        throw new ExplorerAnalysisError(400, `Horizon ${params.horizonBars} bars has no archived outcomes in run "${view.batchRunId}".`);
    }
    const blocksByCell = new Map<string, ExplorerViewBlock>();
    for (const block of view.blocks) {
        blocksByCell.set(`${block.sortMetric}|${block.holdoutBars}`, block);
    }
    const cells: AssetOpportunityExplorerHeatmapCell[] = [];
    const knownBases = new Set<"pair" | "base_only">();
    let archivedRows = 0;
    let selectedRows = 0;
    let observedRows = 0;
    let missingRows = 0;
    let unknownFingerprintRows = 0;
    for (const sortMetric of view.sortMetrics) {
        for (const holdoutBars of columns) {
            const block = blocksByCell.get(`${sortMetric}|${holdoutBars}`);
            if (!block) continue;
            if (block.basis !== null) knownBases.add(block.basis);
            const cell = summarizeCell(block, params.topK, params.horizonBars);
            archivedRows += block.rows.length;
            selectedRows += cell.selectedRows;
            observedRows += cell.observedRows;
            missingRows += cell.selectedRows - cell.observedRows;
            for (const row of block.rows) {
                if (row.rank > params.topK) continue;
                if (row.candidateFingerprint === null) unknownFingerprintRows += 1;
            }
            cells.push({
                holdoutBars,
                sortMetric,
                actual: cell.actual,
                baseline: cell.baseline,
                delta: cell.actual !== null && cell.baseline !== null ? cell.actual - cell.baseline : null,
                selectedRows: cell.selectedRows,
                observedRows: cell.observedRows,
                totalSamples: cell.totalSamples,
            });
        }
    }
    if (knownBases.size > 1) {
        throw new ExplorerAnalysisError(422, `Batch run "${view.batchRunId}" mixes measurement bases (${[...knownBases].sort().join(" vs ")}); compare only rows measured on the same price series.`);
    }
    const notes: string[] = [];
    if (knownBases.size === 0) notes.push("Measurement basis is unknown (archive rows predate the basis field).");
    if (params.topK > view.archiveMaximumRank) {
        notes.push(`Requested top-K ${params.topK} exceeds the archived rank limit ${view.archiveMaximumRank}; ranks beyond the shortlist do not exist in the archive.`);
    }
    notes.push("Holdout offsets are archive export windows in bars, not calendar dates or independent samples.");
    return {
        ok: true,
        snapshotId: params.snapshotId,
        batchRunId: view.batchRunId,
        horizonBars: params.horizonBars,
        topK: params.topK,
        spacing: params.spacing,
        measurementMode: "fixed_horizon",
        basis: knownBases.size === 1 ? [...knownBases][0]! : null,
        holdoutBars: columns,
        sorts: view.sortMetrics,
        cells,
        diagnostics: {
            sourceBlockCount: view.blocks.length,
            retainedBlockCount: cells.length,
            archivedRows,
            selectedRows,
            observedRows,
            missingRows,
            unknownFingerprintRows,
            archiveMaximumRank: view.archiveMaximumRank,
            notes,
        },
    };
}

export interface RangeDetailParams {
    snapshotId: string;
    view: ExplorerView;
    /** The snapshot's column set; bounds must select from it. */
    columns: number[];
    topK: number;
    horizonBars: number;
    sortMetric: string;
    holdoutFrom: number;
    holdoutTo: number;
    metric: AssetOpportunityExplorerMetric;
    offset: number;
    limit: number;
}

const HISTOGRAM_BIN_COUNT = 12;

/**
 * Full-range summaries plus one page of candidate rows for a brushed sort
 * range. Range summaries weight each holdout equally over the finite cell
 * values; this deliberately differs from a pooled all-row mean when cell
 * coverage varies.
 */
export function buildRangeDetails(params: RangeDetailParams): AssetOpportunityExplorerDetailsResponse {
    const { view } = params;
    if (!view.sortMetrics.includes(params.sortMetric)) {
        throw new ExplorerAnalysisError(400, `Unknown sort "${params.sortMetric}" for run "${view.batchRunId}".`);
    }
    const columns = [...params.columns].sort((left, right) => right - left);
    const low = Math.min(params.holdoutFrom, params.holdoutTo);
    const high = Math.max(params.holdoutFrom, params.holdoutTo);
    const rangeColumns = columns.filter((offset) => offset >= low && offset <= high);
    if (rangeColumns.length === 0) {
        throw new ExplorerAnalysisError(400, `Holdout bounds ${params.holdoutFrom}–${params.holdoutTo} select no archived columns.`);
    }
    const blocksByCell = new Map<string, ExplorerViewBlock>();
    for (const block of view.blocks) {
        blocksByCell.set(`${block.sortMetric}|${block.holdoutBars}`, block);
    }
    const finiteCellValues: number[] = [];
    const rows: AssetOpportunityExplorerDetailRow[] = [];
    let observedRows = 0;
    let totalRows = 0;
    let unknownFingerprintRows = 0;
    // Only rows with a fingerprint confirm a parameter identity; unknown
    // identities are counted separately, never merged into a claimed match.
    const confirmedIdentities = new Set<string>();
    for (const holdoutBars of rangeColumns) {
        const block = blocksByCell.get(`${params.sortMetric}|${holdoutBars}`);
        const cell = block ? summarizeCell(block, params.topK, params.horizonBars) : null;
        const metricValue = cell === null || cell.actual === null
            ? null
            : params.metric === "delta"
                ? (cell.baseline === null ? null : cell.actual - cell.baseline)
                : cell.actual;
        if (metricValue !== null && Number.isFinite(metricValue)) finiteCellValues.push(metricValue);
        const baseline = block?.baselineHorizons
            .find((horizon) => horizon.bars === params.horizonBars)?.averagePnlPercent ?? null;
        for (const row of block?.rows ?? []) {
            if (row.rank > params.topK) continue;
            totalRows += 1;
            if (row.candidateFingerprint === null) unknownFingerprintRows += 1;
            else confirmedIdentities.add(`${row.symbol}\u0000${row.strategyId}\u0000${row.candidateFingerprint}`);
            const horizon = row.horizons.find((candidate) => candidate.bars === params.horizonBars);
            if (horizon) observedRows += 1;
            rows.push({
                holdoutBars,
                rank: row.rank,
                symbol: row.symbol,
                strategyId: row.strategyId,
                strategyName: row.strategyName,
                candidateFingerprint: row.candidateFingerprint,
                actual: horizon?.averagePnlPercent ?? null,
                baseline,
                sampleSize: horizon?.sampleSize ?? 0,
                blockTimestamp: block?.timestamp ?? "",
                sourceFile: block?.sourceFile ?? "",
            });
        }
    }
    const observedHoldouts = finiteCellValues.length;
    const mean = observedHoldouts > 0
        ? finiteCellValues.reduce((sum, value) => sum + value, 0) / observedHoldouts
        : null;
    const median = medianOf(finiteCellValues);
    const histogramBins: Array<{ from: number; to: number; count: number }> = [];
    if (observedHoldouts > 0) {
        const min = Math.min(...finiteCellValues);
        const max = Math.max(...finiteCellValues);
        if (min === max) {
            // Constant values (including a single observation) get one valid
            // bin; spreading them over a synthetic range would force an
            // inverted last interval (to < from).
            histogramBins.push({ from: min, to: max, count: observedHoldouts });
        } else {
            const span = max - min;
            const width = span / HISTOGRAM_BIN_COUNT;
            for (let index = 0; index < HISTOGRAM_BIN_COUNT; index += 1) {
                histogramBins.push({
                    from: min + width * index,
                    to: index === HISTOGRAM_BIN_COUNT - 1 ? max : min + width * (index + 1),
                    count: 0,
                });
            }
            for (const value of finiteCellValues) {
                const binIndex = Math.min(HISTOGRAM_BIN_COUNT - 1, Math.floor((value - min) / width));
                histogramBins[binIndex]!.count += 1;
            }
        }
    }
    const start = Math.min(params.offset, rows.length);
    const page = rows.slice(start, start + params.limit);
    return {
        ok: true,
        snapshotId: params.snapshotId,
        batchRunId: view.batchRunId,
        sortMetric: params.sortMetric,
        holdoutFrom: low,
        holdoutTo: high,
        horizonBars: params.horizonBars,
        metric: params.metric,
        unit: params.metric === "delta" ? "pp" : "%",
        summary: {
            totalHoldouts: rangeColumns.length,
            observedHoldouts,
            mean,
            median,
            observedRows,
            totalRows,
            missingRows: totalRows - observedRows,
            uniqueCandidates: confirmedIdentities.size,
            unknownFingerprintRows,
        },
        histogram: {
            bins: histogramBins,
            valuesCount: observedHoldouts,
        },
        rows: page,
        totalRows,
        offset: start,
        hasMore: start + params.limit < rows.length,
    };
}
