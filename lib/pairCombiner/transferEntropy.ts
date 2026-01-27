import type { TransferEntropyResult } from "./types";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function pearsonCorrelation(a: number[], b: number[]): number {
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

function quantileThresholds(values: number[], bins: number): number[] {
    if (values.length === 0) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const thresholds: number[] = [];
    for (let i = 1; i < bins; i++) {
        const idx = Math.floor((i / bins) * (sorted.length - 1));
        thresholds.push(sorted[idx]);
    }
    return thresholds;
}

function discretize(values: number[], thresholds: number[]): number[] {
    return values.map(value => {
        let bin = 0;
        while (bin < thresholds.length && value > thresholds[bin]) {
            bin++;
        }
        return bin;
    });
}

function computeTransferEntropy(xBins: number[], yBins: number[], bins: number): number {
    const n = Math.min(xBins.length, yBins.length);
    if (n < 3) return 0;
    const total = n - 1;

    const count3 = new Array(bins * bins * bins).fill(0);
    const count2 = new Array(bins * bins).fill(0);
    const countYtY1 = new Array(bins * bins).fill(0);
    const countY1 = new Array(bins).fill(0);

    for (let t = 1; t < n; t++) {
        const yt = yBins[t];
        const y1 = yBins[t - 1];
        const x1 = xBins[t - 1];
        count3[(yt * bins + y1) * bins + x1]++;
        count2[y1 * bins + x1]++;
        countYtY1[yt * bins + y1]++;
        countY1[y1]++;
    }

    const alpha = 1e-6;
    let te = 0;

    for (let yt = 0; yt < bins; yt++) {
        for (let y1 = 0; y1 < bins; y1++) {
            const baseYtY1 = yt * bins + y1;
            const countYY = countYtY1[baseYtY1];
            const countY = countY1[y1];
            for (let x1 = 0; x1 < bins; x1++) {
                const idx3 = baseYtY1 * bins + x1;
                const c3 = count3[idx3];
                if (c3 === 0) continue;
                const joint = c3 / total;

                const countYX = count2[y1 * bins + x1];
                const p1 = (c3 + alpha) / (countYX + alpha * bins);
                const p2 = (countYY + alpha) / (countY + alpha * bins);

                te += joint * Math.log2(p1 / p2);
            }
        }
    }

    return Math.max(0, te);
}

function estimateLag(returns1: number[], returns2: number[], maxLag: number): { lag: number; correlation: number } {
    const n = Math.min(returns1.length, returns2.length);
    if (n < 5) return { lag: 0, correlation: 0 };

    let bestLag = 0;
    let bestCorr = 0;

    for (let lag = -maxLag; lag <= maxLag; lag++) {
        if (lag === 0) continue;
        const xs: number[] = [];
        const ys: number[] = [];

        if (lag > 0) {
            for (let i = lag; i < n; i++) {
                xs.push(returns1[i - lag]);
                ys.push(returns2[i]);
            }
        } else {
            const offset = Math.abs(lag);
            for (let i = offset; i < n; i++) {
                xs.push(returns1[i]);
                ys.push(returns2[i - offset]);
            }
        }

        if (xs.length < 5) continue;
        const corr = pearsonCorrelation(xs, ys);
        if (Math.abs(corr) > Math.abs(bestCorr)) {
            bestCorr = corr;
            bestLag = lag;
        }
    }

    return { lag: Math.abs(bestLag), correlation: bestCorr };
}

export function calculateTransferEntropy(
    returns1: number[],
    returns2: number[],
    historyLength: number = 1,
    bins: number = 8
): TransferEntropyResult {
    const length = Math.min(returns1.length, returns2.length);
    if (length < 6) {
        return {
            te_1_to_2: 0,
            te_2_to_1: 0,
            netFlow: 0,
            leadingAsset: 'neutral',
            lagBars: 0,
            significance: 0,
        };
    }

    if (historyLength !== 1) {
        // Current implementation uses historyLength=1. Additional history can be added later.
    }

    const clean1 = returns1.slice(-length);
    const clean2 = returns2.slice(-length);

    const thresholds1 = quantileThresholds(clean1, bins);
    const thresholds2 = quantileThresholds(clean2, bins);
    const bins1 = discretize(clean1, thresholds1);
    const bins2 = discretize(clean2, thresholds2);

    const te_1_to_2 = computeTransferEntropy(bins1, bins2, bins);
    const te_2_to_1 = computeTransferEntropy(bins2, bins1, bins);

    const denom = te_1_to_2 + te_2_to_1 + 1e-9;
    const netFlow = clamp((te_1_to_2 - te_2_to_1) / denom, -1, 1);

    let leadingAsset: 'primary' | 'secondary' | 'neutral' = 'neutral';
    if (Math.abs(netFlow) > 0.1) {
        leadingAsset = netFlow > 0 ? 'primary' : 'secondary';
    }

    const { lag } = estimateLag(clean1, clean2, 10);
    const significance = clamp((te_1_to_2 + te_2_to_1) / 0.5, 0, 1);

    return {
        te_1_to_2,
        te_2_to_1,
        netFlow,
        leadingAsset,
        lagBars: lag,
        significance,
    };
}
