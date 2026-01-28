export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

export function std(values: number[], avg: number): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) {
        const diff = v - avg;
        sum += diff * diff;
    }
    return Math.sqrt(sum / values.length);
}

export function pearsonCorrelation(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const avgA = mean(a);
    const avgB = mean(b);
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - avgA;
        const db = b[i] - avgB;
        num += da * db;
        denA += da * da;
        denB += db * db;
    }
    if (denA <= 0 || denB <= 0) return 0;
    return num / Math.sqrt(denA * denB);
}
