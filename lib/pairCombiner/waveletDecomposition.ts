import type { WaveletResult, WaveletLevel } from "./types";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function ensureEven(values: number[]): number[] {
    if (values.length % 2 === 0) return values;
    if (values.length === 0) return values;
    return values.concat(values[values.length - 1]);
}

function haarDwt(values: number[]): { approximation: number[]; detail: number[] } {
    const data = ensureEven(values);
    const n = data.length;
    const half = n / 2;
    const approximation = new Array(half);
    const detail = new Array(half);
    const scale = Math.SQRT1_2;

    for (let i = 0; i < half; i++) {
        const a = data[2 * i];
        const b = data[2 * i + 1];
        approximation[i] = (a + b) * scale;
        detail[i] = (a - b) * scale;
    }

    return { approximation, detail };
}

function haarInverse(approximation: number[], detail: number[]): number[] {
    const n = approximation.length;
    const out = new Array(n * 2);
    const scale = Math.SQRT1_2;

    for (let i = 0; i < n; i++) {
        const a = approximation[i];
        const d = detail[i] ?? 0;
        out[2 * i] = (a + d) * scale;
        out[2 * i + 1] = (a - d) * scale;
    }

    return out;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function std(values: number[], avg: number): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) {
        const diff = v - avg;
        sum += diff * diff;
    }
    return Math.sqrt(sum / values.length);
}

export function waveletDecompose(
    spread: number[],
    waveletType: 'haar' | 'db4' | 'coif2' = 'haar',
    maxLevels: number = 4
): WaveletResult {
    const clean = spread.filter(v => Number.isFinite(v));
    if (clean.length < 4) {
        return {
            levels: [],
            dominantCycle: 0,
            noiseRatio: 0,
            smoothedSpread: clean.slice(),
            spreadZScore: 0,
        };
    }

    const originalLength = clean.length;
    const levels: WaveletLevel[] = [];
    let current = clean.slice();
    const totalEnergy = Math.max(1e-12, current.reduce((sum, v) => sum + v * v, 0));
    const maxDepth = Math.max(1, maxLevels);

    for (let level = 0; level < maxDepth; level++) {
        if (current.length < 2) break;

        const { approximation, detail } = haarDwt(current);
        const detailEnergy = detail.reduce((sum, v) => sum + v * v, 0);
        levels.push({
            scale: Math.pow(2, level + 1),
            detail,
            approximation,
            energy: detailEnergy / totalEnergy,
        });

        current = approximation;
    }

    let reconstruction = levels.length ? levels[levels.length - 1].approximation.slice() : clean.slice();
    for (let i = levels.length - 1; i >= 0; i--) {
        const zeros = new Array(reconstruction.length).fill(0);
        reconstruction = haarInverse(reconstruction, zeros);
    }
    const smoothedSpread = reconstruction.slice(0, originalLength);

    let dominantCycle = 0;
    let dominantEnergy = 0;
    for (const level of levels) {
        if (level.energy > dominantEnergy) {
            dominantEnergy = level.energy;
            dominantCycle = level.scale * 2;
        }
    }

    const noiseLevels = levels.slice(0, Math.min(2, levels.length));
    const noiseRatio = clamp(noiseLevels.reduce((sum, lvl) => sum + lvl.energy, 0), 0, 1);

    const avg = mean(smoothedSpread);
    const deviation = std(smoothedSpread, avg);
    const spreadZScore = deviation > 0
        ? (smoothedSpread[smoothedSpread.length - 1] - avg) / deviation
        : 0;

    if (waveletType !== 'haar') {
        // Future extension: additional wavelets. For now, we use Haar under the hood.
    }

    return {
        levels,
        dominantCycle,
        noiseRatio,
        smoothedSpread,
        spreadZScore,
    };
}
