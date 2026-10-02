export interface TopMeanDateWindowInput {
    mode: "full" | "date_range";
    from?: unknown;
    to?: unknown;
}

export interface TopMeanDateWindow {
    mode: "full" | "date_range";
    sampleFromSec?: number;
    sampleToSec?: number;
}

export function parseUtcDate(value: unknown, field: string): number {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${field} must be a date in YYYY-MM-DD format.`);
    }
    const [yearText, monthText, dayText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const milliseconds = Date.UTC(year, month - 1, day);
    const date = new Date(milliseconds);
    if (
        date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day
    ) {
        throw new Error(`${field} is not a valid UTC date.`);
    }
    return Math.floor(milliseconds / 1000);
}

/** Optional Batch boundaries; blank sides stay unbounded, To includes its UTC day. */
export function parseOptionalReplayDateWindow(input: { sampleFrom?: unknown; sampleTo?: unknown }): {
    sampleFromSec?: number;
    sampleToSec?: number;
} {
    const parseOptional = (value: unknown, field: string): number | undefined => {
        if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
            return undefined;
        }
        try {
            return parseUtcDate(typeof value === "string" ? value.trim() : value, field);
        } catch (error) {
            throw new Error(`Invalid ${field} date: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const sampleFromSec = parseOptional(input.sampleFrom, "sampleFrom");
    const endDateStartSec = parseOptional(input.sampleTo, "sampleTo");
    const sampleToSec = endDateStartSec === undefined ? undefined : endDateStartSec + 24 * 3600 - 1;
    if (sampleFromSec !== undefined && sampleToSec !== undefined && sampleFromSec > sampleToSec) {
        throw new Error("Replay date window is reversed; From must not be after To.");
    }
    return { sampleFromSec, sampleToSec };
}

/** Validate the Finder's explicit Full / Date range replay-window contract. */
export function parseTopMeanDateWindow(input: TopMeanDateWindowInput): TopMeanDateWindow {
    if (input.mode === "full") return { mode: "full" };
    if (input.mode !== "date_range") throw new Error("dateMode must be 'full' or 'date_range'.");
    const sampleFromSec = parseUtcDate(input.from, "dataRangeFrom");
    const endDateStartSec = parseUtcDate(input.to, "dataRangeTo");
    const sampleToSec = endDateStartSec + 24 * 60 * 60 - 1;
    if (sampleFromSec > sampleToSec) {
        throw new Error("Finder date window is reversed; From must not be after To.");
    }
    return { mode: "date_range", sampleFromSec, sampleToSec };
}
