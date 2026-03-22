export type StringNumberParser = (raw: string) => number | null;

export interface NumberParseOptions {
    parseString?: StringNumberParser;
}

export function toBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    if (typeof value !== "string") return null;

    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return null;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
    return toBooleanLike(value) ?? fallback;
}

export function toFiniteNumber(value: unknown, options?: NumberParseOptions): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (options?.parseString) {
        const parsed = options.parseString(trimmed);
        return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

export function readNumber(value: unknown, fallback: number, options?: NumberParseOptions): number {
    return toFiniteNumber(value, options) ?? fallback;
}
