import type { CopulaResult } from "./types";
import type { Time } from "lightweight-charts";
import { clamp, pearsonCorrelation } from "./utils";

const DEFAULT_TAIL_THRESHOLD = 0.95;

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
    windowSize?: number,
    timestamps?: Time[]
): CopulaResult {
    const clean1: number[] = [];
    const clean2: number[] = [];
    const cleanTimes: Time[] = [];
    const length = Math.min(returns1.length, returns2.length);
    for (let i = 0; i < length; i++) {
        const a = returns1[i];
        const b = returns2[i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        clean1.push(a);
        clean2.push(b);
        if (timestamps && timestamps[i] !== undefined) {
            cleanTimes.push(timestamps[i]);
        }
    }

    if (clean1.length < 5) {
        return {
            kendallTau: 0,
            tailDependence: { upper: 0, lower: 0 },
            copulaType: 'gaussian',
            opportunityScore: 0,
        };
    }

    const window = windowSize && windowSize > 10 ? Math.min(windowSize, clean1.length) : clean1.length;
    const start = clean1.length - window;
    const slice1 = clean1.slice(start);
    const slice2 = clean2.slice(start);

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

    let rollingTau: { time: Time; value: number }[] | undefined;
    if (cleanTimes.length === clean1.length && clean1.length >= 20) {
        const rollWindow = Math.max(12, Math.min(60, Math.floor(clean1.length / 3)));
        rollingTau = [];
        for (let end = rollWindow - 1; end < clean1.length; end++) {
            const startIdx = end - rollWindow + 1;
            const window1 = clean1.slice(startIdx, end + 1);
            const window2 = clean2.slice(startIdx, end + 1);
            const ranks1 = rankData(window1);
            const ranks2 = rankData(window2);
            const spearman = clamp(pearsonCorrelation(ranks1, ranks2), -1, 1);
            const tau = clamp((2 / Math.PI) * Math.asin(spearman), -1, 1);
            rollingTau.push({ time: cleanTimes[end], value: tau });
        }
    }

    return {
        kendallTau,
        tailDependence: {
            upper,
            lower,
        },
        copulaType,
        opportunityScore,
        rollingTau,
    };
}
