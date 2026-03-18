import type { Time } from "lightweight-charts";

export function toTimeKey(time: Time): string {
    if (typeof time === 'number') return String(time);
    if (typeof time === 'string') return time;
    if (time && typeof time === 'object' && 'year' in time) {
        const day = time as { year: number; month: number; day: number };
        const month = String(day.month).padStart(2, '0');
        const date = String(day.day).padStart(2, '0');
        return `${day.year}-${month}-${date}`;
    }
    return String(time);
}
