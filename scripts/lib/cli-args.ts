export function toFinite(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function toPositiveInt(value: string | undefined, fallback: number, min = 1): number {
    const parsed = Math.floor(toFinite(value, fallback));
    return Math.max(min, parsed);
}

export function toBoolean(value: string | undefined, fallback: boolean): boolean {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return fallback;
}

/** Value following `flag` in `argv`, or `undefined` when the flag is absent. */
export function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}
