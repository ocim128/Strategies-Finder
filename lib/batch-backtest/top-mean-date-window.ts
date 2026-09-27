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

function parseUtcDate(value: unknown, field: string): number {
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
