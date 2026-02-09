import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function calculateMomentum(closes: number[], lookback: number): (number | null)[] {
    const out: (number | null)[] = new Array(closes.length).fill(null);
    const lb = Math.max(1, Math.round(lookback));
    for (let i = lb; i < closes.length; i++) {
        const prev = closes[i - lb];
        if (prev <= 0) continue;
        out[i] = closes[i] / prev - 1;
    }
    return out;
}

function calculateRollingStd(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    const p = Math.max(2, Math.round(period));
    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        sum += v;
        sumSq += v * v;

        if (i >= p) {
            const old = values[i - p];
            sum -= old;
            sumSq -= old * old;
        }

        if (i >= p - 1) {
            const mean = sum / p;
            const variance = Math.max(0, sumSq / p - mean * mean);
            out[i] = Math.sqrt(variance);
        }
    }

    return out;
}

function calculateRollingZScore(values: (number | null)[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    const p = Math.max(3, Math.round(period));
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current !== null) {
            sum += current;
            sumSq += current * current;
            count++;
        }

        if (i >= p) {
            const leaving = values[i - p];
            if (leaving !== null) {
                sum -= leaving;
                sumSq -= leaving * leaving;
                count--;
            }
        }

        if (i >= p - 1 && count === p && current !== null) {
            const mean = sum / p;
            const variance = Math.max(0, sumSq / p - mean * mean);
            const std = Math.sqrt(variance);
            out[i] = std > 0 ? (current - mean) / std : 0;
        }
    }

    return out;
}

function buildScoreSeries(cleanData: OHLCVData[], params: StrategyParams): {
    score: (number | null)[];
    rebalanceMask: boolean[];
} {
    const closes = getCloses(cleanData);
    const momentumLookback = Math.max(10, Math.round(params.momentumLookback ?? 72));
    const volLookback = Math.max(5, Math.round(params.volLookback ?? 20));
    const scoreLookback = Math.max(60, Math.round(momentumLookback * 1.75));
    const rebalanceBars = Math.max(5, Math.round(params.rebalanceBars ?? 21));

    const momentum = calculateMomentum(closes, momentumLookback);

    const logReturns: number[] = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
        const prev = closes[i - 1];
        const curr = closes[i];
        if (prev > 0 && curr > 0) {
            logReturns[i] = Math.log(curr / prev);
        }
    }

    const vol = calculateRollingStd(logReturns, volLookback);
    const volScale = Math.sqrt(momentumLookback / volLookback);
    const scaledVol: (number | null)[] = vol.map(v => (v === null ? null : v * volScale));

    const zMom = calculateRollingZScore(momentum, scoreLookback);
    const zVol = calculateRollingZScore(scaledVol, scoreLookback);

    const score: (number | null)[] = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
        const m = zMom[i];
        const v = zVol[i];
        if (m === null || v === null) continue;
        score[i] = 0.7 * m - 0.3 * v;
    }

    const rebalanceMask: boolean[] = new Array(closes.length).fill(false);
    for (let i = 0; i < closes.length; i++) {
        if (i % rebalanceBars === 0) rebalanceMask[i] = true;
    }

    return { score, rebalanceMask };
}

export const momentum_volatility_rotation: Strategy = {
    name: 'Momentum-Volatility Rotation',
    description: 'Monthly-style rebalance that goes long when momentum beats volatility on a rolling z-score basis.',
    defaultParams: {
        momentumLookback: 72,
        volLookback: 20,
        rebalanceBars: 21,
        entryZ: 0.2,
        exitZ: -0.1,
    },
    paramLabels: {
        momentumLookback: 'Momentum Lookback (bars)',
        volLookback: 'Volatility Lookback (bars)',
        rebalanceBars: 'Rebalance Interval (bars)',
        entryZ: 'Entry Z-Score',
        exitZ: 'Exit Z-Score',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const { score, rebalanceMask } = buildScoreSeries(cleanData, params);
        const entryZ = clamp(params.entryZ ?? 0.2, -5, 5);
        const exitZ = clamp(params.exitZ ?? -0.1, -5, 5);

        let inPosition = false;

        return createSignalLoop(cleanData, [score], (i) => {
            if (!rebalanceMask[i]) return null;

            const currScore = score[i]!;

            if (!inPosition && currScore >= entryZ) {
                inPosition = true;
                return createBuySignal(cleanData, i, 'Momentum/volatility rotation entry');
            }

            if (inPosition && currScore <= exitZ) {
                inPosition = false;
                return createSellSignal(cleanData, i, 'Momentum/volatility rotation exit');
            }

            return null;
        });
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'momentumLookback',
            'volLookback',
            'rebalanceBars',
            'entryZ',
            'exitZ',
        ],
    },
};


