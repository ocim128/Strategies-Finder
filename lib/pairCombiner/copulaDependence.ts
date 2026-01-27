import type { CopulaResult } from "./types";

const DEFAULT_TAIL_THRESHOLD = 0.95;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function pearsonCorrelation(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    let sumA = 0;
    let sumB = 0;
    let sumA2 = 0;
    let sumB2 = 0;
    let sumAB = 0;

    for (let i = 0; i < n; i++) {
        const x = a[i];
        const y = b[i];
        sumA += x;
        sumB += y;
        sumA2 += x * x;
        sumB2 += y * y;
        sumAB += x * y;
    }

    const numerator = (n * sumAB) - (sumA * sumB);
    const denomA = (n * sumA2) - (sumA * sumA);
    const denomB = (n * sumB2) - (sumB * sumB);
    if (denomA <= 0 || denomB <= 0) return 0;
    return numerator / Math.sqrt(denomA * denomB);
}

function rankData(values: number[]): number[] {
    const indexed = values.map((value, index) => ({ value, index }));
    indexed.sort((a, b) => a.value - b.value);

    const ranks = new Array(values.length).fill(0);
    let i = 0;
    while (i < indexed.length) {
        let j = i + 1;
        while (j < indexed.length && indexed[j].value === indexed[i].value) {
            j++;
        }
        const avgRank = (i + j - 1) / 2 + 1;
        for (let k = i; k < j; k++) {
            ranks[indexed[k].index] = avgRank;
        }
        i = j;
    }

    return ranks;
}

function toPseudoObservations(ranks: number[]): number[] {
    const n = ranks.length;
    if (n === 0) return [];
    const denom = n + 1;
    return ranks.map(rank => rank / denom);
}

export function calculateCopulaDependence(
    returns1: number[],
    returns2: number[],
    windowSize?: number
): CopulaResult {
    const length = Math.min(returns1.length, returns2.length);
    if (length < 5) {
        return {
            kendallTau: 0,
            tailDependence: { upper: 0, lower: 0 },
            copulaType: 'gaussian',
            opportunityScore: 0,
        };
    }

    const window = windowSize && windowSize > 10 ? Math.min(windowSize, length) : length;
    const start = length - window;
    const slice1 = returns1.slice(start);
    const slice2 = returns2.slice(start);

    const ranks1 = rankData(slice1);
    const ranks2 = rankData(slice2);
    const spearman = clamp(pearsonCorrelation(ranks1, ranks2), -1, 1);
    const kendallTau = clamp((2 / Math.PI) * Math.asin(spearman), -1, 1);

    const u1 = toPseudoObservations(ranks1);
    const u2 = toPseudoObservations(ranks2);
    const upperThreshold = DEFAULT_TAIL_THRESHOLD;
    const lowerThreshold = 1 - DEFAULT_TAIL_THRESHOLD;

    let upperCount = 0;
    let lowerCount = 0;
    for (let i = 0; i < u1.length; i++) {
        if (u1[i] > upperThreshold && u2[i] > upperThreshold) {
            upperCount++;
        }
        if (u1[i] < lowerThreshold && u2[i] < lowerThreshold) {
            lowerCount++;
        }
    }

    const upper = clamp(upperCount / (u1.length * (1 - upperThreshold)), 0, 1);
    const lower = clamp(lowerCount / (u1.length * lowerThreshold), 0, 1);

    let copulaType: 'gaussian' | 'clayton' | 'gumbel' = 'gaussian';
    if (upper - lower > 0.08) {
        copulaType = 'gumbel';
    } else if (lower - upper > 0.08) {
        copulaType = 'clayton';
    }

    const tailAsymmetry = Math.abs(upper - lower);
    const opportunityScore = clamp(
        (1 - Math.abs(kendallTau)) * 60 + clamp(tailAsymmetry, 0, 1) * 40,
        0,
        100
    );

    return {
        kendallTau,
        tailDependence: {
            upper,
            lower,
        },
        copulaType,
        opportunityScore,
    };
}
