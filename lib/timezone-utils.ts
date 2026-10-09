import type { TickMarkType, Time } from "lightweight-charts";

export const JAKARTA_TIMEZONE = "Asia/Jakarta";
const TICK_MARK_TYPE = {
    Year: 0,
    Month: 1,
    DayOfMonth: 2,
    Time: 3,
    TimeWithSeconds: 4,
} as const satisfies Record<string, TickMarkType>;

function parseTimeToDate(time: Time): Date | null {
    if (typeof time === "number") {
        return new Date(time * 1000);
    }

    if (typeof time === "string") {
        const parsed = Date.parse(time);
        return Number.isNaN(parsed) ? null : new Date(parsed);
    }

    if (typeof time === "object" && time !== null && "year" in time) {
        return new Date(Date.UTC(time.year, time.month - 1, time.day));
    }

    return null;
}

// Bounded formatter cache: constructing Intl.DateTimeFormat repeatedly is the
// hot cost of chart tick marks, trades lists, and alert formatting. Cache
// formatters (never dates or formatted results) keyed by locale plus the
// effective option entries so callers may pass fresh option objects.
const FORMATTER_CACHE_LIMIT = 32;
const jakartaFormatterCache = new Map<string, Intl.DateTimeFormat>();

function buildJakartaFormatterKey(
    locale: string | undefined,
    options: Intl.DateTimeFormatOptions
): string {
    const localeKey = locale === undefined
        // Sentinel prefix cannot collide with the explicit-locale encoding
        // below, so an omitted locale never matches an explicit one.
        ? "\u0000default"
        : `tag:${locale}`;
    const optionEntries = Object.entries(options)
        .filter(([, value]) => value !== undefined)
        .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));
    return `${localeKey}\u0001${JSON.stringify(optionEntries)}`;
}

function getJakartaFormatter(
    locale: string | undefined,
    options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
    const cacheKey = buildJakartaFormatterKey(locale, options);
    const cached = jakartaFormatterCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const formatter = new Intl.DateTimeFormat(locale, {
        ...options,
        timeZone: JAKARTA_TIMEZONE,
    });

    // Insertion-ordered Map: the first key is the oldest entry. Construction
    // failures throw before reaching this point, so failures are never cached.
    if (jakartaFormatterCache.size >= FORMATTER_CACHE_LIMIT) {
        const oldestKey = jakartaFormatterCache.keys().next().value;
        if (oldestKey !== undefined) {
            jakartaFormatterCache.delete(oldestKey);
        }
    }
    jakartaFormatterCache.set(cacheKey, formatter);
    return formatter;
}

export function formatJakartaTime(
    time: Time,
    options: Intl.DateTimeFormatOptions,
    locale?: string
): string {
    const date = parseTimeToDate(time);
    if (!date) return String(time);

    return getJakartaFormatter(locale, options).format(date);
}

export function formatJakartaTickMark(
    time: Time,
    tickMarkType: TickMarkType,
    locale: string
): string | null {
    switch (tickMarkType) {
        case TICK_MARK_TYPE.Year:
            return formatJakartaTime(time, { year: "numeric" }, locale);
        case TICK_MARK_TYPE.Month:
            return formatJakartaTime(time, { month: "short" }, locale);
        case TICK_MARK_TYPE.DayOfMonth:
            return formatJakartaTime(time, { day: "2-digit" }, locale);
        case TICK_MARK_TYPE.Time:
            return formatJakartaTime(
                time,
                { hour: "2-digit", minute: "2-digit", hour12: false },
                locale
            );
        case TICK_MARK_TYPE.TimeWithSeconds:
            return formatJakartaTime(
                time,
                { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
                locale
            );
        default:
            return null;
    }
}

export function isBusinessDayTime(time: Time): boolean {
    if (typeof time === "string") {
        return /^\d{4}-\d{2}-\d{2}$/.test(time);
    }
    return typeof time === "object" && time !== null && "year" in time;
}
