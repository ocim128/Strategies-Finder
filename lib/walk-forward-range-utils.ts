export function resolveFiniteRangeReferenceValue(
    currentValue: number | undefined,
    defaultValue: number | undefined,
    fallback: number
): number {
    if (Number.isFinite(currentValue)) return Number(currentValue);
    if (Number.isFinite(defaultValue)) return Number(defaultValue);
    return fallback;
}

export function shouldTreatParamAsWholeNumber(name: string, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (!Number.isInteger(Math.round(value))) return false;
    return /(lookback|window|period|bars|bins|length|len|lag|count|crossings|hour|hours)/i.test(name);
}

export function deriveAutoWalkForwardRange(
    name: string,
    baseValue: number
): { min: number; max: number; step: number } {
    const treatAsWholeNumber = shouldTreatParamAsWholeNumber(name, baseValue);
    const shouldUseDecimalRange = !treatAsWholeNumber && (baseValue === 0 || !Number.isInteger(baseValue) || Math.abs(baseValue) < 2);

    if (shouldUseDecimalRange) {
        if (baseValue === 0) {
            return {
                min: 0,
                max: 0.2,
                step: 0.05,
            };
        }

        const lower = baseValue * 0.5;
        const upper = baseValue * 1.5;
        const min = Math.min(lower, upper);
        const max = Math.max(lower, upper);
        const rawStep = (max - min) / 4;
        const step = Math.max(0.001, rawStep);

        return {
            min: Math.round(min * 1000) / 1000,
            max: Math.round(max * 1000) / 1000,
            step: Math.round(step * 1000) / 1000,
        };
    }

    const min = Math.max(1, Math.floor(baseValue * 0.5));
    const max = Math.max(min + 1, Math.ceil(baseValue * 1.5));
    const rawStep = (max - min) / 4;
    const step = Math.max(1, Math.floor(rawStep));

    return { min, max, step };
}
