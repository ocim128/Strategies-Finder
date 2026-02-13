type BusinessDayLike = {
    year?: unknown;
    month?: unknown;
    day?: unknown;
};

const MAX_SECONDS_TIMESTAMP = 9_999_999_999;

function normalizeNumberToUnixSeconds(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    if (value > MAX_SECONDS_TIMESTAMP) return Math.floor(value / 1000);
    return Math.floor(value);
}

export function parseTimeToUnixSeconds(value: unknown): number | null {
    if (typeof value === 'number') {
        return normalizeNumberToUnixSeconds(value);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;

        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
            return normalizeNumberToUnixSeconds(numeric);
        }

        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) {
            return Math.floor(parsed / 1000);
        }
        return null;
    }

    if (value && typeof value === 'object' && 'year' in (value as BusinessDayLike)) {
        const day = value as BusinessDayLike;
        const year = Number(day.year);
        const month = Number(day.month);
        const date = Number(day.day);
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return null;
        return Math.floor(Date.UTC(year, month - 1, date) / 1000);
    }

    return null;
}
