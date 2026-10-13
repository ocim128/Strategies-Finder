/**
 * Serializable request/response contracts for the Opportunity Explorer local
 * API. Shared by the server plugin and the browser service so both sides
 * describe the same wire shapes. Types only — no runtime dependencies.
 */

/** A run's usability for the fixed-horizon heatmap. */
export type AssetOpportunityExplorerRunSupport =
    | "fixed_horizon"
    | "next_exit"
    | "mixed_modes";

export type AssetOpportunityExplorerSpacing = "all" | "horizon";

export type AssetOpportunityExplorerMetric = "actual" | "delta";

/** Fixed-horizon price basis; newer archive rows carry every basis per row. */
export type AssetOpportunityExplorerBasis = "pair" | "base_only" | "quote_only";

export interface AssetOpportunityExplorerCatalogRun {
    batchRunId: string;
    /** Newest archive export timestamp in the run; export time, not a market date. */
    latestTimestamp: string;
    /** Holdout offsets with archived blocks, ascending. */
    holdoutBars: number[];
    /** Sort metrics with archived blocks, ascending. */
    sortMetrics: string[];
    support: AssetOpportunityExplorerRunSupport;
    /** Union of fixed-horizon bars seen in baselines and rows, ascending. */
    horizons: number[];
    /** Largest archived rank (array-position fallback included); bounds top-K. */
    archiveMaximumRank: number;
    sourceBlockCount: number;
    hasBaselines: boolean;
    /** Price bases this run can be viewed on, fixed order; enables the basis selector. */
    availableBases: AssetOpportunityExplorerBasis[];
    /** Measurement-contract id from any block of the run; absent on legacy runs. */
    archiveEpoch?: string;
    /** Distinct epoch ids across the run's blocks; > 1 means mixed contracts. */
    archiveEpochCount: number;
    /** True when any block carries pool distribution summaries. */
    hasPoolDistribution: boolean;
}

export interface AssetOpportunityExplorerCatalogResponse {
    ok: true;
    /** Archive directory relative to the server root, forward slashes. */
    archiveRoot: string;
    scannedAt: string;
    fileCount: number;
    runs: AssetOpportunityExplorerCatalogRun[];
}

export interface AssetOpportunityExplorerHeatmapCell {
    holdoutBars: number;
    sortMetric: string;
    /** Equal-weight mean of selected rows' averagePnlPercent; null when unobserved. */
    actual: number | null;
    /** Matching all-candidate baseline for this exact block and horizon. */
    baseline: number | null;
    /** actual − baseline in percentage points; null when either side is unavailable. */
    delta: number | null;
    /** Rows within the requested rank limit in this block. */
    selectedRows: number;
    /** Selected rows with a finite outcome and positive sample size at the horizon. */
    observedRows: number;
    totalSamples: number;
}

export interface AssetOpportunityExplorerHeatmapResponse {
    ok: true;
    snapshotId: string;
    batchRunId: string;
    horizonBars: number;
    topK: number;
    spacing: AssetOpportunityExplorerSpacing;
    measurementMode: "fixed_horizon";
    /** Measurement basis this snapshot was re-based to; null = unknown/legacy. */
    basis: AssetOpportunityExplorerBasis | null;
    /** Column order is descending (older boundary first) and shared by every sort. */
    holdoutBars: number[];
    sorts: string[];
    cells: AssetOpportunityExplorerHeatmapCell[];
    diagnostics: {
        sourceBlockCount: number;
        retainedBlockCount: number;
        archivedRows: number;
        selectedRows: number;
        observedRows: number;
        missingRows: number;
        /** Rows without a candidateFingerprint; counted unknown, never merged. */
        unknownFingerprintRows: number;
        archiveMaximumRank: number;
        notes: string[];
    };
}

export interface AssetOpportunityExplorerDetailRow {
    holdoutBars: number;
    rank: number;
    symbol: string;
    strategyId: string;
    strategyName: string | null;
    candidateFingerprint: string | null;
    /** Archived averagePnlPercent at the horizon; null when unobserved. */
    actual: number | null;
    /** Block baseline at the horizon; null when the block carries no baseline. */
    baseline: number | null;
    sampleSize: number;
    blockTimestamp: string;
    sourceFile: string;
}

export interface AssetOpportunityExplorerDetailsResponse {
    ok: true;
    snapshotId: string;
    batchRunId: string;
    sortMetric: string;
    /** Inclusive holdout bounds; both members of the snapshot's column set. */
    holdoutFrom: number;
    holdoutTo: number;
    horizonBars: number;
    metric: AssetOpportunityExplorerMetric;
    unit: "%" | "pp";
    summary: {
        totalHoldouts: number;
        observedHoldouts: number;
        /** Equal weight per holdout over the finite cell values in range. */
        mean: number | null;
        median: number | null;
        observedRows: number;
        totalRows: number;
        missingRows: number;
        /** Distinct confirmed identities (fingerprint rows only). */
        uniqueCandidates: number;
        /** Rows without a fingerprint; counted unknown, never merged. */
        unknownFingerprintRows: number;
    };
    histogram: {
        bins: Array<{ from: number; to: number; count: number }>;
        /** Cell values counted; every finite cell value falls in exactly one bin. */
        valuesCount: number;
    };
    rows: AssetOpportunityExplorerDetailRow[];
    totalRows: number;
    offset: number;
    hasMore: boolean;
}
