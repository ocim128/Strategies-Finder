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

/** Canonical iteration order for per-basis archive maps (forward rows and baselines). */
const ARCHIVE_BASES = ["pair", "base_only", "quote_only"] as const;

/** Fixed-horizon price basis recorded on newer archive rows; absent = unknown legacy row. */
export type AssetOpportunityArchiveHorizonBasis = "pair" | "base_only" | "quote_only";

export interface ArchiveHorizon {
    bars: number;
    averagePnlPercent: number | null;
    sampleSize: number;
    /** Measured at the last available candle because the horizon exceeded the holdout. */
    ongoing?: boolean;
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
    /** Per-basis forward measurements captured in the same pass; absent on single-basis (older) rows. */
    forwardOosPerformanceByBasis?: Partial<Record<AssetOpportunityArchiveHorizonBasis, ArchiveHorizonPerformance>> | null;
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
    /** All-result baseline per price basis; absent on single-basis (older) blocks. */
    baselineByBasis?: Partial<Record<AssetOpportunityArchiveHorizonBasis, AssetOpportunityForwardOosBaseline>> | null;
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
            return [{
                bars,
                averagePnlPercent,
                sampleSize,
                ...(horizon.ongoing === true ? { ongoing: true } : {}),
            }];
        })
        : [];
    return {
        ignoreLastBars: asPositiveInteger(value.ignoreLastBars) ?? undefined,
        // Newer rows record the measured price series; unknown on older rows and
        // surfaced as "unknown" rather than guessed.
        basis: value.basis === "pair" || value.basis === "base_only" || value.basis === "quote_only" ? value.basis : undefined,
        horizons,
    };
}

/** Parse the per-basis forward map; unknown basis keys and unusable entries are dropped. */
function parseArchiveForwardOosByBasis(value: unknown): AssetOpportunityArchiveRow["forwardOosPerformanceByBasis"] {
    if (!isRecord(value)) return undefined;
    const parsed: NonNullable<AssetOpportunityArchiveRow["forwardOosPerformanceByBasis"]> = {};
    for (const basis of ARCHIVE_BASES) {
        const entry = parseArchiveHorizonPerformance(value[basis]);
        if (entry) parsed[basis] = entry;
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/** Options that bound how much of an archive block is materialized. */
export interface ArchiveParseOptions {
    /**
     * Keep full measurement data only on the first N ranked rows of every
     * fixed-horizon block; deeper rows become small rank/fingerprint/signal-hour
     * stubs. The archive must list rows in rank order, as the Finder writer
     * does. next_exit blocks ignore the cap because the thesis audit reads
     * every archived row. Default: keep every row (Explorer parity).
     */
    maxFullRows?: number;
}

function parseArchiveRows(
    value: unknown,
    sourceFile: string,
    maxFullRows?: number,
): AssetOpportunityArchiveRow[] {
    if (!Array.isArray(value)) {
        throw new Error(`Expected a JSON array in ${sourceFile}`);
    }
    return value.map((row, index) => {
        if (!isRecord(row)) {
            throw new Error(`Expected an object at row ${index + 1} in ${sourceFile}`);
        }
        const rank = asPositiveInteger(row.rank) ?? undefined;
        const signalCandleHourUtc = row.signalCandleHourUtc === null ? null : asHour(row.signalCandleHourUtc);
        const signalCandleHourJakarta = row.signalCandleHourJakarta === null ? null : asHour(row.signalCandleHourJakarta);
        if (maxFullRows !== undefined && index >= maxFullRows) {
            // Stubs keep exactly the fields scanned beyond the aggregation top-K:
            // archive maximum rank, fingerprint availability, signal-hour availability.
            return {
                rank,
                signalCandleHourUtc,
                signalCandleHourJakarta,
                ...(typeof row.candidateFingerprint === "string" ? { candidateFingerprint: row.candidateFingerprint } : {}),
            };
        }
        const forwardOosPerformance = parseArchiveHorizonPerformance(row.forwardOosPerformance)
            ?? parseArchiveHorizonPerformance(row.activePositionContinuationPerformance);
        const forwardOosPerformanceByBasis = parseArchiveForwardOosByBasis(row.forwardOosPerformanceByBasis);
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
            rank,
            symbol: typeof row.symbol === "string" ? row.symbol : undefined,
            strategyId: typeof row.strategyId === "string" ? row.strategyId : undefined,
            strategyName: typeof row.strategyName === "string" ? row.strategyName : undefined,
            candidateFingerprint: typeof row.candidateFingerprint === "string" ? row.candidateFingerprint : undefined,
            signalCandleHourUtc,
            signalCandleHourJakarta,
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
            ...(forwardOosPerformanceByBasis ? { forwardOosPerformanceByBasis } : {}),
            nextExitOosPerformance,
        };
    });
}

/**
 * Flatten a regex capture before storing it on a record. Captures of 13+
 * characters are V8 sliced strings that reference the whole normalized file
 * text, so keeping one alive pins the file's full text in the heap for the
 * process lifetime.
 */
function flatCapture(value: string): string {
    return (" " + value).slice(1);
}

/** Header lines of one archive block, between the two separator lines. */
const ARCHIVE_BLOCK_HEADER_PATTERN = new RegExp(
    `^Timestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nArchive sort: ([^\\n]+)\\n(?:Forward measurement: ([^\\n]+)\\n)?(?:Archive baseline: ([^\\n]+)\\n)?(?:Archive baseline by basis: ([^\\n]+)\\n)?(?:Next-exit archive baseline: ([^\\n]+)\\n)?$`,
);

/** Parse all delimited blocks from one archive file. */
export function parseAssetOpportunityArchiveText(
    text: string,
    sourceFile = "archive file",
    options: ArchiveParseOptions = {},
): AssetOpportunityArchiveRecord[] {
    const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
    const records: AssetOpportunityArchiveRecord[] = [];
    // Split on newline-wrapped separator lines instead of scanning the whole
    // text with a lookahead regex. Block bodies are single-line JSON (see
    // buildAssetOpportunityArchiveBlockText), so every real block boundary is
    // a `\n<sep>\n` occurrence and the split pairs each header part (even
    // index) with its body part (odd index). A block whose writer closed its
    // frame with a bare trailing separator leaves that separator on the last
    // body part, which the suffix strip below absorbs.
    const blockDelimiter = `\n${BLOCK_SEPARATOR}\n`;
    const leadingSeparator = `${BLOCK_SEPARATOR}\n`;
    const trailingSeparator = `\n${BLOCK_SEPARATOR}`;
    const parts = normalized.split(blockDelimiter);
    for (let index = 0; index < parts.length; index += 2) {
        const headerPart = parts[index]!;
        const header = headerPart.startsWith(leadingSeparator)
            ? headerPart.slice(leadingSeparator.length)
            : headerPart;
        const rawBody = index + 1 < parts.length ? parts[index + 1]! : "";
        const body = rawBody.endsWith(trailingSeparator)
            ? rawBody.slice(0, rawBody.length - trailingSeparator.length)
            : rawBody;
        // The split consumed the newline that terminated the header's last
        // line; restore it so the header pattern's line terminators stay
        // identical to the block format the writer emits.
        const headerMatch = ARCHIVE_BLOCK_HEADER_PATTERN.exec(`${header}\n`);
        if (!headerMatch) continue;
        const holdoutBars = Number(headerMatch[3]);
        if (!Number.isInteger(holdoutBars) || holdoutBars < 1) {
            throw new Error(`Invalid holdout value in ${sourceFile}`);
        }
        let parsedRows: unknown;
        try {
            parsedRows = JSON.parse(body);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid JSON in ${sourceFile}: ${detail}`);
        }
        let baselineByBasis: AssetOpportunityArchiveRecord["baselineByBasis"];
        if (headerMatch[7]) {
            const parsedMap = JSON.parse(headerMatch[7]) as Record<string, unknown>;
            const map: NonNullable<AssetOpportunityArchiveRecord["baselineByBasis"]> = {};
            for (const basis of ARCHIVE_BASES) {
                const baseline = parseArchiveBaseline(parsedMap[basis], sourceFile);
                if (baseline) map[basis] = baseline;
            }
            baselineByBasis = Object.keys(map).length > 0 ? map : undefined;
        }
        records.push({
            sourceFile,
            timestamp: flatCapture(headerMatch[1]!),
            batchRunId: flatCapture(headerMatch[2]!),
            holdoutBars,
            sortMetric: flatCapture(headerMatch[4]!),
            measurementMode: headerMatch[5] ? flatCapture(headerMatch[5]) : undefined,
            topResults: parseArchiveRows(
                parsedRows,
                sourceFile,
                options.maxFullRows !== undefined && headerMatch[5] !== "next_exit" ? options.maxFullRows : undefined,
            ),
            baseline: headerMatch[6] ? parseArchiveBaseline(JSON.parse(headerMatch[6]), sourceFile) : null,
            ...(baselineByBasis ? { baselineByBasis } : {}),
            nextExitBaseline: headerMatch[8] ? parseNextExitBaseline(JSON.parse(headerMatch[8]), sourceFile) : null,
        });
    }
    if (records.length === 0 && normalized.length > 0) {
        throw new Error(`No valid archive blocks found in ${sourceFile}`);
    }
    return records;
}
