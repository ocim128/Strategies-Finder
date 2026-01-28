import type { WaveletResult, WaveletLevel } from "./types";
import { clamp, mean, std } from "./utils";

function ensureEven(values: number[]): number[] {
    if (values.length % 2 === 0) return values;
    if (values.length === 0) return values;
    return values.concat(values[values.length - 1]);
}

const DB4_LO = [0.4829629131445341, 0.8365163037378079, 0.2241438680420134, -0.1294095225512604];
const COIF2_LO = [
    -0.0007205494453645122,
    -0.0018232088707029932,
    0.0056114348193944995,
    0.023680171946334084,
    -0.0594344186464569,
    -0.0764885990783064,
    0.41700518442169254,
    0.8127236354455423,
    0.3861100668211622,
    -0.06737255472196302,
    -0.04146493678175915,
    0.01638733646359976,
];

function buildHighPass(low: number[]): number[] {
    const n = low.length;
    const high = new Array(n);
    for (let i = 0; i < n; i++) {
        const sign = i % 2 === 0 ? 1 : -1;
        high[i] = sign * low[n - 1 - i];
    }
    return high;
}

function getWaveletFilters(type: 'haar' | 'db4' | 'coif2') {
    const sqrt = Math.SQRT1_2;
    let loD: number[] = [];
    if (type === 'haar') {
        loD = [sqrt, sqrt];
    } else if (type === 'db4') {
        loD = DB4_LO.slice();
    } else {
        loD = COIF2_LO.slice();
    }
    const hiD = buildHighPass(loD);
    const loR = loD.slice().reverse();
    const hiR = hiD.slice().reverse();
    return { loD, hiD, loR, hiR };
}

function dwt(values: number[], loD: number[], hiD: number[]): { approximation: number[]; detail: number[] } {
    const data = ensureEven(values);
    const n = data.length;
    const half = n / 2;
    const approximation = new Array(half);
    const detail = new Array(half);
    const filterLength = loD.length;

    for (let i = 0; i < half; i++) {
        let a = 0;
        let d = 0;
        const base = 2 * i;
        for (let k = 0; k < filterLength; k++) {
            const idx = (base + k) % n;
            const value = data[idx];
            a += value * loD[k];
            d += value * hiD[k];
        }
        approximation[i] = a;
        detail[i] = d;
    }

    return { approximation, detail };
}

function idwt(approximation: number[], detail: number[], loR: number[], hiR: number[]): number[] {
    const n = approximation.length;
    const outLength = n * 2;
    const out = new Array(outLength).fill(0);
    const filterLength = loR.length;

    for (let i = 0; i < n; i++) {
        const base = 2 * i;
        const a = approximation[i];
        const d = detail[i] ?? 0;
        for (let k = 0; k < filterLength; k++) {
            const idx = (base + k) % outLength;
            out[idx] += a * loR[k] + d * hiR[k];
        }
    }

    return out;
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
    const filters = getWaveletFilters(waveletType);

    for (let level = 0; level < maxDepth; level++) {
        if (current.length < 2) break;

        const { approximation, detail } = dwt(current, filters.loD, filters.hiD);
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
        reconstruction = idwt(reconstruction, zeros, filters.loR, filters.hiR);
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

    return {
        levels,
        dominantCycle,
        noiseRatio,
        smoothedSpread,
        spreadZScore,
    };
}
