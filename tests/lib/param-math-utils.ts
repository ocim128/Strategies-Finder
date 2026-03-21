export type StepRange = {
    min: number;
    max: number;
    step: number;
};

export function roundRangeValue(value: number): number {
    return Math.round(value * 1000) / 1000;
}

export function snapValueToStepRange(range: StepRange, value: number): number {
    if (!Number.isFinite(value)) {
        return roundRangeValue(range.min);
    }

    const span = range.max - range.min;
    const maxIndex = Math.max(0, Math.round(span / range.step));
    const relativeIndex = (value - range.min) / range.step;
    const snappedIndex = Math.max(0, Math.min(maxIndex, Math.round(relativeIndex)));
    const snappedValue = range.min + snappedIndex * range.step;
    const clampedValue = Math.max(range.min, Math.min(range.max, snappedValue));
    return roundRangeValue(clampedValue);
}

export function createSeededRandom(seed: number = 42): () => number {
    let state = (Math.floor(seed) >>> 0) || 1;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
