import { TickMarkType, Time } from "lightweight-charts";

export const JAKARTA_TIMEZONE = "Asia/Jakarta";

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

export function formatJakartaTime(
    time: Time,
    options: Intl.DateTimeFormatOptions,
    locale?: string
): string {
    const date = parseTimeToDate(time);
    if (!date) return String(time);

    return new Intl.DateTimeFormat(locale, {
        ...options,
        timeZone: JAKARTA_TIMEZONE,
    }).format(date);
}

export function formatJakartaTickMark(
    time: Time,
    tickMarkType: TickMarkType,
    locale: string
): string | null {
    switch (tickMarkType) {
        case TickMarkType.Year:
            return formatJakartaTime(time, { year: "numeric" }, locale);
        case TickMarkType.Month:
            return formatJakartaTime(time, { month: "short" }, locale);
        case TickMarkType.DayOfMonth:
            return formatJakartaTime(time, { day: "2-digit" }, locale);
        case TickMarkType.Time:
            return formatJakartaTime(
                time,
                { hour: "2-digit", minute: "2-digit", hour12: false },
                locale
            );
        case TickMarkType.TimeWithSeconds:
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
