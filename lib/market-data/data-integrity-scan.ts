import { extractCandlesFromCsvPayload } from "../candle-cache";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";

export const THIRTY_MINUTES_SECONDS = 30 * 60;
export const WARN_LAST_BAR_AGE_DAYS = 7;
export const BLOCK_LAST_BAR_AGE_DAYS = 30;
export const WARN_MAX_GAP_BARS = 240;
export const WARN_FRESHNESS_SPREAD_DAYS = 2;
export const SPLIT_JUMP_PERCENT = 0.3;
export const SPLIT_JUMP_VOLUME_RATIO = 1.5;
export const DEFAULT_UNPARSABLE_ROW_THRESHOLD = 0;

export type IntegrityVerdict = "PASS" | "WARN" | "BLOCK";

export type QuoteOverlap = {
    quoteSymbol: string;
    sharedTimestamps: number;
    symbolTimestamps: number;
    coveragePercent: number | null;
    warning: boolean;
};

export type DataIntegrityScan = {
    symbol: string;
    verdict: IntegrityVerdict;
    lastBarTimestamp: number | null;
    lastBarAgeDays: number | null;
    barCount: number;
    rawRowCount: number;
    unparsableRows: number;
    maxGapBars: number;
    duplicateTimestamps: number;
    nonMonotonic: boolean;
    splitJumpCandidates: number;
    historyDepthCohort: "empty" | "<2k" | "2k-5k" | "5k-10k" | ">10k";
    universeFreshnessSpreadDays: number | null;
    overlapWithQuotes: QuoteOverlap[];
    warnings: string[];
    blockingIssues: string[];
};

export type DataIntegritySummary = {
    verdict: IntegrityVerdict;
    universeMaxLastTimestamp: number | null;
    symbols: number;
    pass: number;
    warn: number;
    block: number;
    scans: DataIntegrityScan[];
};

export type DataIntegrityScanOptions = {
    nowTimestamp?: number;
    quoteTimestampSets?: ReadonlyMap<string, ReadonlySet<number>>;
    designatedQuoteLegs?: readonly string[];
    unparsableRowThreshold?: number;
};

type ParsedCsvRows = {
    timestamps: number[];
    candles: OHLCVData[];
    rawRowCount: number;
    unparsableRows: number;
};

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (character === "," && !inQuotes) {
            values.push(current.trim());
            current = "";
            continue;
        }
        current += character;
    }

    values.push(current.trim());
    return values;
}

function getCsvLines(payload: string): string[] {
    return payload
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function parseCsvRows(payload: string): ParsedCsvRows {
    const lines = getCsvLines(payload);
    if (lines.length <= 1) {
        return { timestamps: [], candles: [], rawRowCount: Math.max(0, lines.length - 1), unparsableRows: 0 };
    }

    const header = parseCsvLine(lines[0]!).map((value) => value.toLowerCase());
    const dateIndex = header.findIndex((value) => value === "date" || value === "time" || value === "timestamp");
    const openIndex = header.indexOf("open");
    const highIndex = header.indexOf("high");
    const lowIndex = header.indexOf("low");
    const closeIndex = header.indexOf("close");
    const hasRequiredColumns = dateIndex >= 0 && openIndex >= 0 && highIndex >= 0 && lowIndex >= 0 && closeIndex >= 0;

    if (!hasRequiredColumns) {
        return {
            timestamps: [],
            candles: [],
            rawRowCount: lines.length - 1,
            unparsableRows: lines.length - 1,
        };
    }

    const timestamps: number[] = [];
    let unparsableRows = 0;
    for (const line of lines.slice(1)) {
        const columns = parseCsvLine(line);
        const time = parseTimeToUnixSeconds(columns[dateIndex] ?? "");
        const open = Number(columns[openIndex]);
        const high = Number(columns[highIndex]);
        const low = Number(columns[lowIndex]);
        const close = Number(columns[closeIndex]);
        const valid = time !== null
            && Number.isFinite(time)
            && Number.isFinite(open)
            && Number.isFinite(high)
            && Number.isFinite(low)
            && Number.isFinite(close);
        if (!valid) {
            unparsableRows += 1;
            continue;
        }
        timestamps.push(time);
    }

    return {
        timestamps,
        candles: extractCandlesFromCsvPayload(payload),
        rawRowCount: lines.length - 1,
        unparsableRows,
    };
}

export function extractValidTimestampsFromCsvPayload(payload: string): number[] {
    return parseCsvRows(payload).timestamps;
}

function historyDepthCohort(barCount: number): DataIntegrityScan["historyDepthCohort"] {
    if (barCount === 0) return "empty";
    if (barCount < 2_000) return "<2k";
    if (barCount < 5_000) return "2k-5k";
    if (barCount < 10_000) return "5k-10k";
    return ">10k";
}

function countDuplicateTimestamps(timestamps: readonly number[]): number {
    const seen = new Set<number>();
    let duplicates = 0;
    for (const timestamp of timestamps) {
        if (seen.has(timestamp)) duplicates += 1;
        seen.add(timestamp);
    }
    return duplicates;
}

function hasDecreasingTimestamp(timestamps: readonly number[]): boolean {
    for (let index = 1; index < timestamps.length; index += 1) {
        if (timestamps[index]! < timestamps[index - 1]!) return true;
    }
    return false;
}

function calculateMaxGapBars(timestamps: readonly number[]): number {
    const uniqueSorted = Array.from(new Set(timestamps)).sort((left, right) => left - right);
    let maxGapBars = 0;
    for (let index = 1; index < uniqueSorted.length; index += 1) {
        maxGapBars = Math.max(
            maxGapBars,
            (uniqueSorted[index]! - uniqueSorted[index - 1]!) / THIRTY_MINUTES_SECONDS,
        );
    }
    return maxGapBars;
}

function countSplitJumpCandidates(candles: readonly OHLCVData[]): number {
    let candidates = 0;
    for (let index = 1; index < candles.length; index += 1) {
        const previous = candles[index - 1]!;
        const current = candles[index]!;
        if (!Number.isFinite(previous.close) || previous.close === 0 || !Number.isFinite(current.close)) continue;
        const move = Math.abs(current.close / previous.close - 1);
        const volumeRatio = previous.volume > 0 ? current.volume / previous.volume : 0;
        if (move > SPLIT_JUMP_PERCENT && volumeRatio < SPLIT_JUMP_VOLUME_RATIO) {
            candidates += 1;
        }
    }
    return candidates;
}

function createScan(
    symbol: string,
    rows: ParsedCsvRows,
    options: DataIntegrityScanOptions,
): DataIntegrityScan {
    const nowTimestamp = options.nowTimestamp ?? Math.floor(Date.now() / 1000);
    const sortedTimestamps = [...rows.timestamps].sort((left, right) => left - right);
    const lastBarTimestamp = sortedTimestamps.length > 0 ? sortedTimestamps[sortedTimestamps.length - 1]! : null;
    const lastBarAgeDays = lastBarTimestamp === null
        ? null
        : Math.max(0, (nowTimestamp - lastBarTimestamp) / 86_400);
    const duplicateTimestamps = countDuplicateTimestamps(rows.timestamps);
    const nonMonotonic = hasDecreasingTimestamp(rows.timestamps);
    const maxGapBars = calculateMaxGapBars(rows.timestamps);
    const splitJumpCandidates = countSplitJumpCandidates(rows.candles);
    const barCount = rows.candles.length;
    const warnings: string[] = [];
    const blockingIssues: string[] = [];
    const unparsableRowThreshold = Math.max(0, Math.floor(options.unparsableRowThreshold ?? DEFAULT_UNPARSABLE_ROW_THRESHOLD));

    if (barCount === 0) blockingIssues.push("empty file");
    if (rows.unparsableRows > unparsableRowThreshold) {
        blockingIssues.push(`unparsable rows=${rows.unparsableRows} > ${unparsableRowThreshold}`);
    }
    if (nonMonotonic) blockingIssues.push("timestamps are non-monotonic");
    if (lastBarAgeDays !== null && lastBarAgeDays > BLOCK_LAST_BAR_AGE_DAYS) {
        blockingIssues.push(`last bar age=${lastBarAgeDays.toFixed(2)}d > ${BLOCK_LAST_BAR_AGE_DAYS}d`);
    } else if (lastBarAgeDays !== null && lastBarAgeDays > WARN_LAST_BAR_AGE_DAYS) {
        warnings.push(`last bar age=${lastBarAgeDays.toFixed(2)}d > ${WARN_LAST_BAR_AGE_DAYS}d`);
    }
    if (maxGapBars > WARN_MAX_GAP_BARS) {
        warnings.push(`max gap=${maxGapBars.toFixed(2)} bars > ${WARN_MAX_GAP_BARS}`);
    }
    if (duplicateTimestamps > 0) warnings.push(`duplicate timestamps=${duplicateTimestamps}`);
    if (splitJumpCandidates > 0) {
        warnings.push(
            `split-jump candidates=${splitJumpCandidates} (jumpPct>${SPLIT_JUMP_PERCENT * 100}% & volRatio<${SPLIT_JUMP_VOLUME_RATIO})`,
        );
    }

    const overlapWithQuotes: QuoteOverlap[] = [];
    const quoteTimestampSets = options.quoteTimestampSets;
    const designatedQuoteLegs = options.designatedQuoteLegs ?? ["SPY", "NVDA"];
    const ownTimestamps = new Set(rows.timestamps);
    for (const quoteSymbol of designatedQuoteLegs) {
        const quoteTimestamps = quoteTimestampSets?.get(quoteSymbol.toUpperCase());
        if (!quoteTimestamps) continue;
        // Overlap is measured over the RECENT shared window only (last 180 days before
        // the earlier series end): full-history overlap penalizes deep-history symbols
        // whose early timestamps predate the quote leg.
        const quoteLastBarTimestamp = quoteTimestamps.size > 0 ? Math.max(...quoteTimestamps) : 0;
        const recentWindowStart = Math.min(lastBarTimestamp ?? 0, quoteLastBarTimestamp) - 180 * 24 * 3600 * 1000;
        let sharedTimestamps = 0;
        let recentOwnTimestamps = 0;
        for (const timestamp of ownTimestamps) {
            if (timestamp < recentWindowStart) continue;
            recentOwnTimestamps += 1;
            if (quoteTimestamps.has(timestamp)) sharedTimestamps += 1;
        }
        const coveragePercent = recentOwnTimestamps > 0 ? (sharedTimestamps / recentOwnTimestamps) * 100 : null;
        // Informational only: extended-hours bar asymmetry between symbol and quote
        // feeds (symbols can carry ~4x SPY timestamps per day) makes an absolute
        // overlap threshold a persistent false positive. Stale quotes are caught by
        // the universe freshness spread instead.
        const warning = false;
        overlapWithQuotes.push({
            quoteSymbol: quoteSymbol.toUpperCase(),
            sharedTimestamps,
            symbolTimestamps: ownTimestamps.size,
            coveragePercent,
            warning,
        });

    }

    return {
        symbol,
        verdict: blockingIssues.length > 0 ? "BLOCK" : warnings.length > 0 ? "WARN" : "PASS",
        lastBarTimestamp,
        lastBarAgeDays,
        barCount,
        rawRowCount: rows.rawRowCount,
        unparsableRows: rows.unparsableRows,
        maxGapBars,
        duplicateTimestamps,
        nonMonotonic,
        splitJumpCandidates,
        historyDepthCohort: historyDepthCohort(barCount),
        universeFreshnessSpreadDays: null,
        overlapWithQuotes,
        warnings,
        blockingIssues,
    };
}

export function scanDataIntegrity(
    symbol: string,
    csvPayload: string,
    options: DataIntegrityScanOptions = {},
): DataIntegrityScan {
    return createScan(symbol, parseCsvRows(csvPayload), options);
}

export function summarizeDataIntegrity(scans: readonly DataIntegrityScan[]): DataIntegritySummary {
    const universeMaxLastTimestamp = scans.reduce<number | null>((currentMax, scan) => {
        if (scan.lastBarTimestamp === null) return currentMax;
        return currentMax === null ? scan.lastBarTimestamp : Math.max(currentMax, scan.lastBarTimestamp);
    }, null);
    const withFreshness = scans.map((scan) => {
        const spreadDays = universeMaxLastTimestamp === null || scan.lastBarTimestamp === null
            ? null
            : Math.max(0, (universeMaxLastTimestamp - scan.lastBarTimestamp) / 86_400);
        if (spreadDays === null || spreadDays <= WARN_FRESHNESS_SPREAD_DAYS) {
            return { ...scan, universeFreshnessSpreadDays: spreadDays };
        }
        const warnings = [...scan.warnings, `universe freshness spread=${spreadDays.toFixed(2)}d > ${WARN_FRESHNESS_SPREAD_DAYS}d`];
        const verdict: IntegrityVerdict = scan.verdict === "BLOCK" ? "BLOCK" : "WARN";
        return {
            ...scan,
            universeFreshnessSpreadDays: spreadDays,
            verdict,
            warnings,
        };
    });

    const pass = withFreshness.filter((scan) => scan.verdict === "PASS").length;
    const warn = withFreshness.filter((scan) => scan.verdict === "WARN").length;
    const block = withFreshness.filter((scan) => scan.verdict === "BLOCK").length;
    return {
        verdict: block > 0 ? "BLOCK" : warn > 0 ? "WARN" : "PASS",
        universeMaxLastTimestamp,
        symbols: withFreshness.length,
        pass,
        warn,
        block,
        scans: withFreshness,
    };
}
