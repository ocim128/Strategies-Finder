import type {
    AssetOpportunityForwardOosBaseline,
    AssetOpportunityNextExitOosBaseline,
} from "../finder/finder-asset-opportunity-metadata";
import type { FinderAssetOosNextExitUnavailableReason } from "../finder/finder-asset-opportunity-oos";

/**
 * Leaf parser for Asset Opportunity holdout archive files.
 *
 * Extracted from `scripts/analyze-asset-opportunity-holdouts.ts` so the
 * Opportunity Explorer server routes can parse archive blocks without
 * importing the CLI entrypoint (its `import.meta.url` argument handling and
 * node:fs sync reader stay in the script). Filesystem access lives with the
 * callers: the CLI keeps its synchronous whole-directory reader and the
 * Explorer server plugin streams one file at a time.
 *
 * Imports types only — this module is safe to include in Vite's server
 * configuration bundle (no transitive `lightweight-charts` reach).
 */

/** Matching regular files directly inside the archive directory (no recursion). */
export const ARCHIVE_FILE_PATTERN = /^oos-holdout-(\d+)-bars\.txt$/;

const BLOCK_SEPARATOR = "=".repeat(80);

/** Fixed-horizon price basis recorded on newer archive rows; absent = unknown legacy row. */
export type AssetOpportunityArchiveHorizonBasis = "pair" | "base_only";

export interface ArchiveHorizon {
    bars: number;
    averagePnlPercent: number | null;
    sampleSize: number;
}

export interface ArchiveHorizonPerformance {
    ignoreLastBars?: number;
    basis?: AssetOpportunityArchiveHorizonBasis;
    horizons?: ArchiveHorizon[];
}

export interface AssetOpportunityArchiveRow {
    scope?: string;
    rank?: number;
    symbol?: string;
    strategyId?: string;
    strategyName?: string;
    candidateFingerprint?: string;
    signalCandleHourUtc?: number | null;
    signalCandleHourJakarta?: number | null;
    /** Compact in-sample scalars used to verify whether a thesis sort had data. */
    selectionPerformance?: Record<string, number | null>;
    /** Present on fresh-signal-library resort representatives in newer archives. */
    freshSignalLibraryCount?: number | null;
    /** Exact capped trade-count thesis value in newer archives. */
    totalTradesCappedValue?: number | null;
    strategyCoverageCount?: number | null;
    forwardOosPerformance?: ArchiveHorizonPerformance | null;
    nextExitOosPerformance?: {
        ignoreLastBars?: number;
        status?: "exited" | "censored" | "unavailable";
        pnlPercent?: number | null;
        exitReason?: string | null;
        unavailableReason?: FinderAssetOosNextExitUnavailableReason | null;
        barsHeld?: number | null;
    } | null;
}

export interface AssetOpportunityArchiveRecord {
    sourceFile: string;
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    sortMetric: string;
    measurementMode?: string;
    topResults: AssetOpportunityArchiveRow[];
    baseline?: AssetOpportunityForwardOosBaseline | null;
    nextExitBaseline?: AssetOpportunityNextExitOosBaseline | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function asFiniteNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
}

export function asPositiveInteger(value: unknown): number | null {
    const number = asFiniteNumber(value);
    if (number === null || !Number.isInteger(number) || number < 1) return null;
    return number;
}

export function asNonNegativeInteger(value: unknown): number | null {
    const number = asFiniteNumber(value);
    if (number === null || !Number.isInteger(number) || number < 0) return null;
    return number;
}

export function asHour(value: unknown): number | null {
    const number = asNonNegativeInteger(value);
    return number !== null && number <= 23 ? number : null;
}

export function parseArchiveBaseline(value: unknown, sourceFile: string): AssetOpportunityForwardOosBaseline | null {
    if (value === undefined) return null;
    if (!isRecord(value) || !Array.isArray(value.horizons)) {
        throw new Error(`Invalid archive baseline in ${sourceFile}`);
    }
    const eligibleCandidateCount = asNonNegativeInteger(value.eligibleCandidateCount);
    if (eligibleCandidateCount === null) {
        throw new Error(`Invalid archive baseline candidate count in ${sourceFile}`);
    }
    const horizons = value.horizons.flatMap((item) => {
        if (!isRecord(item)) return [];
        const bars = asPositiveInteger(item.bars);
        const observedResults = asNonNegativeInteger(item.observedResults);
        const positiveResults = asNonNegativeInteger(item.positiveResults);
        const totalSamples = asNonNegativeInteger(item.totalSamples);
        const averagePnlPercent = item.averagePnlPercent === null ? null : asFiniteNumber(item.averagePnlPercent);
        const sampleWeightedAveragePnlPercent = item.sampleWeightedAveragePnlPercent === null
            ? null
            : asFiniteNumber(item.sampleWeightedAveragePnlPercent);
        if (bars === null || observedResults === null || positiveResults === null || totalSamples === null
            || (averagePnlPercent === null && item.averagePnlPercent !== null)
            || (sampleWeightedAveragePnlPercent === null && item.sampleWeightedAveragePnlPercent !== null)) {
            return [];
        }
        return [{
            bars,
            averagePnlPercent,
            sampleWeightedAveragePnlPercent,
            positiveResults,
            observedResults,
            totalSamples,
        }];
    });
    return { eligibleCandidateCount, horizons };
}

export function parseNextExitBaseline(value: unknown, sourceFile: string): AssetOpportunityNextExitOosBaseline | null {
    if (value === undefined) return null;
    if (!isRecord(value) || !isRecord(value.exitReasonCounts)) {
        throw new Error(`Invalid next-exit archive baseline in ${sourceFile}`);
    }
    const eligibleCandidateCount = asNonNegativeInteger(value.eligibleCandidateCount);
    const observedExits = asNonNegativeInteger(value.observedExits);
    const censoredResults = asNonNegativeInteger(value.censoredResults);
    const unavailableResults = asNonNegativeInteger(value.unavailableResults);
    const averagePnlPercent = value.averagePnlPercent === null ? null : asFiniteNumber(value.averagePnlPercent);
    if (eligibleCandidateCount === null || observedExits === null || censoredResults === null
        || unavailableResults === null
        || (averagePnlPercent === null && value.averagePnlPercent !== null)) {
        throw new Error(`Invalid next-exit archive baseline values in ${sourceFile}`);
    }
    const exitReasonCounts: Record<string, number> = {};
    for (const [reason, count] of Object.entries(value.exitReasonCounts)) {
        const parsed = asNonNegativeInteger(count);
        if (parsed === null) throw new Error(`Invalid next-exit reason count in ${sourceFile}`);
        exitReasonCounts[reason] = parsed;
    }
    const unavailableReasonCounts: Record<string, number> = {};
    if (value.unavailableReasonCounts !== undefined) {
        if (!isRecord(value.unavailableReasonCounts)) {
            throw new Error(`Invalid next-exit unavailable reason counts in ${sourceFile}`);
        }
        for (const [reason, count] of Object.entries(value.unavailableReasonCounts)) {
            const parsed = asNonNegativeInteger(count);
            if (parsed === null) throw new Error(`Invalid next-exit unavailable reason count in ${sourceFile}`);
            unavailableReasonCounts[reason] = parsed;
        }
    } else if (unavailableResults > 0) {
        unavailableReasonCounts.unknown_legacy = unavailableResults;
    }
    return {
        eligibleCandidateCount,
        observedExits,
        censoredResults,
        unavailableResults,
        averagePnlPercent,
        exitReasonCounts,
        unavailableReasonCounts,
    };
}

export function parseArchiveScalarRecord(value: unknown): Record<string, number | null> | undefined {
    if (!isRecord(value)) return undefined;
    const parsed: Record<string, number | null> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw === null) {
            parsed[key] = null;
            continue;
        }
        const number = asFiniteNumber(raw);
        if (number !== null) parsed[key] = number;
    }
    return parsed;
}

function parseArchiveHorizonPerformance(value: unknown): ArchiveHorizonPerformance | null {
    if (!isRecord(value)) return null;
    const horizonsValue = value.horizons;
    const horizons = Array.isArray(horizonsValue)
        ? horizonsValue.flatMap((horizon) => {
            if (!isRecord(horizon)) return [];
            const bars = asPositiveInteger(horizon.bars);
            const sampleSize = asPositiveInteger(horizon.sampleSize) ?? 0;
            const averagePnlPercent = horizon.averagePnlPercent === null
                ? null
                : asFiniteNumber(horizon.averagePnlPercent);
            if (bars === null || (averagePnlPercent === null && horizon.averagePnlPercent !== null)) {
                return [];
            }
            return [{ bars, averagePnlPercent, sampleSize }];
        })
        : [];
    return {
        ignoreLastBars: asPositiveInteger(value.ignoreLastBars) ?? undefined,
        // Newer rows record the measured price series; unknown on older rows and
        // surfaced as "unknown" rather than guessed.
        basis: value.basis === "pair" || value.basis === "base_only" ? value.basis : undefined,
        horizons,
    };
}

function parseArchiveRows(value: unknown, sourceFile: string): AssetOpportunityArchiveRow[] {
    if (!Array.isArray(value)) {
        throw new Error(`Expected a JSON array in ${sourceFile}`);
    }
    return value.map((row, index) => {
        if (!isRecord(row)) {
            throw new Error(`Expected an object at row ${index + 1} in ${sourceFile}`);
        }
        const forwardOosPerformance = parseArchiveHorizonPerformance(row.forwardOosPerformance)
            ?? parseArchiveHorizonPerformance(row.activePositionContinuationPerformance);
        const nextExit = row.nextExitOosPerformance;
        let nextExitOosPerformance: AssetOpportunityArchiveRow["nextExitOosPerformance"] = null;
        if (isRecord(nextExit)) {
            const status = nextExit.status === "exited"
                || nextExit.status === "censored"
                || nextExit.status === "unavailable"
                ? nextExit.status
                : undefined;
            nextExitOosPerformance = {
                ignoreLastBars: asPositiveInteger(nextExit.ignoreLastBars) ?? undefined,
                status,
                pnlPercent: nextExit.pnlPercent === null
                    ? null
                    : asFiniteNumber(nextExit.pnlPercent),
                exitReason: nextExit.exitReason === null
                    ? null
                    : typeof nextExit.exitReason === "string"
                        ? nextExit.exitReason
                        : null,
                unavailableReason: nextExit.unavailableReason === "no_boundary_trade"
                    || nextExit.unavailableReason === "missing_exit_reason"
                    || nextExit.unavailableReason === "replay_error"
                    ? nextExit.unavailableReason
                    : null,
                barsHeld: nextExit.barsHeld === null
                    ? null
                    : asNonNegativeInteger(nextExit.barsHeld),
            };
        }
        return {
            scope: typeof row.scope === "string" ? row.scope : undefined,
            rank: asPositiveInteger(row.rank) ?? undefined,
            symbol: typeof row.symbol === "string" ? row.symbol : undefined,
            strategyId: typeof row.strategyId === "string" ? row.strategyId : undefined,
            strategyName: typeof row.strategyName === "string" ? row.strategyName : undefined,
            candidateFingerprint: typeof row.candidateFingerprint === "string" ? row.candidateFingerprint : undefined,
            signalCandleHourUtc: row.signalCandleHourUtc === null
                ? null
                : asHour(row.signalCandleHourUtc),
            signalCandleHourJakarta: row.signalCandleHourJakarta === null
                ? null
                : asHour(row.signalCandleHourJakarta),
            selectionPerformance: parseArchiveScalarRecord(row.selectionPerformance),
            ...(row.freshSignalLibraryCount !== undefined ? {
                freshSignalLibraryCount: row.freshSignalLibraryCount === null
                    ? null
                    : asNonNegativeInteger(row.freshSignalLibraryCount),
            } : {}),
            ...(row.totalTradesCappedValue !== undefined ? {
                totalTradesCappedValue: row.totalTradesCappedValue === null
                    ? null
                    : asFiniteNumber(row.totalTradesCappedValue),
            } : {}),
            strategyCoverageCount: row.strategyCoverageCount === null
                ? null
                : asFiniteNumber(row.strategyCoverageCount),
            forwardOosPerformance,
            nextExitOosPerformance,
        };
    });
}

/** Parse all delimited blocks from one archive file. */
export function parseAssetOpportunityArchiveText(text: string, sourceFile = "archive file"): AssetOpportunityArchiveRecord[] {
    const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
    const blockPattern = new RegExp(
        `^${BLOCK_SEPARATOR}\\nTimestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nArchive sort: ([^\\n]+)\\n(?:Forward measurement: ([^\\n]+)\\n)?(?:Archive baseline: ([^\\n]+)\\n)?(?:Next-exit archive baseline: ([^\\n]+)\\n)?${BLOCK_SEPARATOR}\\n([\\s\\S]*?)(?=\\n${BLOCK_SEPARATOR}\\n|$)`,
        "gm",
    );
    const records: AssetOpportunityArchiveRecord[] = [];
    for (const match of normalized.matchAll(blockPattern)) {
        const holdoutBars = Number(match[3]);
        if (!Number.isInteger(holdoutBars) || holdoutBars < 1) {
            throw new Error(`Invalid holdout value in ${sourceFile}`);
        }
        let parsedRows: unknown;
        try {
            parsedRows = JSON.parse(match[8]!);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid JSON in ${sourceFile}: ${detail}`);
        }
        records.push({
            sourceFile,
            timestamp: match[1]!,
            batchRunId: match[2]!,
            holdoutBars,
            sortMetric: match[4]!,
            measurementMode: match[5] || undefined,
            topResults: parseArchiveRows(parsedRows, sourceFile),
            baseline: match[6] ? parseArchiveBaseline(JSON.parse(match[6]), sourceFile) : null,
            nextExitBaseline: match[7] ? parseNextExitBaseline(JSON.parse(match[7]), sourceFile) : null,
        });
    }
    if (records.length === 0 && normalized.length > 0) {
        throw new Error(`No valid archive blocks found in ${sourceFile}`);
    }
    return records;
}
