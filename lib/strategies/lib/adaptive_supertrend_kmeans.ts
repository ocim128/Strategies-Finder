import { Strategy, OHLCVData, StrategyParams, StrategyIndicator, Signal } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';
import { COLORS } from '../constants';

type Cluster = {
    centroid: number;
    values: number[];
    factors: number[];
};

function percentileLinear(values: number[], percentile: number): number {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (percentile / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const weight = idx - lo;
    return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function kMeans1d(values: number[], factors: number[], maxIter: number): Cluster[] {
    const initialCentroids = [
        percentileLinear(values, 25),
        percentileLinear(values, 50),
        percentileLinear(values, 75)
    ];

    let centroids = initialCentroids.map(c => (Number.isFinite(c) ? c : 0));
    let clusters: Cluster[] = [
        { centroid: centroids[0], values: [], factors: [] },
        { centroid: centroids[1], values: [], factors: [] },
        { centroid: centroids[2], values: [], factors: [] }
    ];

    for (let iter = 0; iter < maxIter; iter++) {
        clusters = [
            { centroid: centroids[0], values: [], factors: [] },
            { centroid: centroids[1], values: [], factors: [] },
            { centroid: centroids[2], values: [], factors: [] }
        ];

        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            let bestIdx = 0;
            let bestDist = Math.abs(value - centroids[0]);
            const dist1 = Math.abs(value - centroids[1]);
            if (dist1 < bestDist) {
                bestIdx = 1;
                bestDist = dist1;
            }
            const dist2 = Math.abs(value - centroids[2]);
            if (dist2 < bestDist) {
                bestIdx = 2;
            }
            clusters[bestIdx].values.push(value);
            clusters[bestIdx].factors.push(factors[i]);
        }

        const newCentroids = centroids.map((prev, idx) => {
            const valuesInCluster = clusters[idx].values;
            if (valuesInCluster.length === 0) return prev;
            const sum = valuesInCluster.reduce((acc, v) => acc + v, 0);
            return sum / valuesInCluster.length;
        });

        const unchanged = newCentroids.every((val, idx) => Math.abs(val - centroids[idx]) < 1e-8);
        centroids = newCentroids;
        if (unchanged) break;
    }

    return clusters.map((cluster, idx) => ({
        centroid: centroids[idx],
        values: cluster.values,
        factors: cluster.factors
    }));
}

function mean(values: number[]): number {
    if (values.length === 0) return NaN;
    return values.reduce((acc, v) => acc + v, 0) / values.length;
}

type SupertrendFactorState = {
    upper: number;
    lower: number;
    output: number;
    perf: number;
    trend: 0 | 1;
    initialized: boolean;
};

export const adaptive_supertrend_kmeans: Strategy = {
    name: 'Adaptive Supertrend (K-Means)',
    description: 'Adaptive Supertrend that clusters factor performance and trades trend flips.',
    defaultParams: {
        atrPeriod: 10,
        minFactor: 1,
        maxFactor: 13,
        factorStep: 0.5,
        perfAlpha: 10,
        kMeansIterations: 50,
        kMeansInterval: 3,
        clusterChoice: 2,
        warmupBars: 50
    },
    paramLabels: {
        atrPeriod: 'ATR Period',
        minFactor: 'Min Factor',
        maxFactor: 'Max Factor',
        factorStep: 'Factor Step',
        perfAlpha: 'Performance EMA',
        kMeansIterations: 'K-Means Iterations',
        kMeansInterval: 'K-Means Interval',
        clusterChoice: 'Cluster (0 Worst, 1 Avg, 2 Best)',
        warmupBars: 'Warmup Bars'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const atrPeriod = Math.max(1, Math.round(params.atrPeriod ?? 10));
        const minFactor = Math.max(0.1, params.minFactor ?? 1);
        const maxFactor = Math.max(minFactor, params.maxFactor ?? 13);
        const factorStep = Math.max(0.1, params.factorStep ?? 0.5);
        const perfAlpha = Math.max(1, Math.round(params.perfAlpha ?? 10));
        const kMeansIterations = Math.max(1, Math.round(params.kMeansIterations ?? 50));
        const kMeansInterval = Math.max(1, Math.round(params.kMeansInterval ?? 3));
        const clusterChoice = Math.min(2, Math.max(0, Math.round(params.clusterChoice ?? 2)));
        const warmupBars = Math.max(0, Math.round(params.warmupBars ?? 50));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const factorValues: number[] = [];
        for (let f = minFactor; f <= maxFactor + 1e-8; f += factorStep) {
            factorValues.push(Number(f.toFixed(4)));
        }

        const states: SupertrendFactorState[] = factorValues.map(() => ({
            upper: 0,
            lower: 0,
            output: 0,
            perf: 0,
            trend: 1,
            initialized: false
        }));

        const direction: (1 | -1 | null)[] = new Array(cleanData.length).fill(null);

        let targetFactor = (minFactor + maxFactor) / 2;
        let finalUpper: number | null = null;
        let finalLower: number | null = null;
        let os: 0 | 1 = 1;
        let lastClusterFactor = targetFactor;

        for (let i = 0; i < cleanData.length; i++) {
            const atrVal = atr[i];
            if (atrVal === null) {
                direction[i] = null;
                continue;
            }

            const hl2 = (highs[i] + lows[i]) / 2;
            const prevClose = i > 0 ? closes[i - 1] : closes[i];
            const delta = i > 0 ? closes[i] - closes[i - 1] : 0;

            for (let fIdx = 0; fIdx < factorValues.length; fIdx++) {
                const factor = factorValues[fIdx];
                const state = states[fIdx];
                if (!state.initialized) {
                    state.upper = hl2;
                    state.lower = hl2;
                    state.output = hl2;
                    state.perf = 0;
                    state.trend = closes[i] >= hl2 ? 1 : 0;
                    state.initialized = true;
                }

                const up = hl2 + atrVal * factor;
                const dn = hl2 - atrVal * factor;

                state.trend = closes[i] > state.upper ? 1 : closes[i] < state.lower ? 0 : state.trend;
                state.upper = prevClose < state.upper ? Math.min(up, state.upper) : up;
                state.lower = prevClose > state.lower ? Math.max(dn, state.lower) : dn;

                const diff = Math.sign(prevClose - state.output) || 0;
                const alpha = 2 / (perfAlpha + 1);
                state.perf = state.perf + alpha * (delta * diff - state.perf);
                state.output = state.trend === 1 ? state.lower : state.upper;
            }

            if (i >= warmupBars && i % kMeansInterval === 0) {
                const perfValues = states.map(s => s.perf);
                const clusters = kMeans1d(perfValues, factorValues, kMeansIterations);
                const ranked = clusters
                    .map((cluster, idx) => ({ idx, centroid: cluster.centroid }))
                    .sort((a, b) => a.centroid - b.centroid);

                const selectedIdx = ranked[Math.min(clusterChoice, ranked.length - 1)]?.idx ?? 0;
                const selected = clusters[selectedIdx];
                const factorAvg = mean(selected.factors);
                if (Number.isFinite(factorAvg)) {
                    targetFactor = factorAvg;
                    lastClusterFactor = factorAvg;
                } else if (Number.isFinite(lastClusterFactor)) {
                    targetFactor = lastClusterFactor;
                }
            }

            if (!Number.isFinite(targetFactor)) {
                targetFactor = lastClusterFactor;
            }

            const up = hl2 + atrVal * targetFactor;
            const dn = hl2 - atrVal * targetFactor;

            if (finalUpper === null || finalLower === null) {
                finalUpper = up;
                finalLower = dn;
            } else {
                finalUpper = prevClose < finalUpper ? Math.min(up, finalUpper) : up;
                finalLower = prevClose > finalLower ? Math.max(dn, finalLower) : dn;
            }

            os = closes[i] > finalUpper ? 1 : closes[i] < finalLower ? 0 : os;
            direction[i] = os === 1 ? 1 : -1;

        }

        return createSignalLoop(cleanData, [direction], (i) => {
            if (direction[i - 1] === -1 && direction[i] === 1) {
                return createBuySignal(cleanData, i, 'Adaptive Supertrend Buy');
            }
            if (direction[i - 1] === 1 && direction[i] === -1) {
                return createSellSignal(cleanData, i, 'Adaptive Supertrend Sell');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const atrPeriod = Math.max(1, Math.round(params.atrPeriod ?? 10));
        const minFactor = Math.max(0.1, params.minFactor ?? 1);
        const maxFactor = Math.max(minFactor, params.maxFactor ?? 13);
        const factorStep = Math.max(0.1, params.factorStep ?? 0.5);
        const perfAlpha = Math.max(1, Math.round(params.perfAlpha ?? 10));
        const kMeansIterations = Math.max(1, Math.round(params.kMeansIterations ?? 50));
        const kMeansInterval = Math.max(1, Math.round(params.kMeansInterval ?? 3));
        const clusterChoice = Math.min(2, Math.max(0, Math.round(params.clusterChoice ?? 2)));
        const warmupBars = Math.max(0, Math.round(params.warmupBars ?? 50));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const factorValues: number[] = [];
        for (let f = minFactor; f <= maxFactor + 1e-8; f += factorStep) {
            factorValues.push(Number(f.toFixed(4)));
        }

        const states: SupertrendFactorState[] = factorValues.map(() => ({
            upper: 0,
            lower: 0,
            output: 0,
            perf: 0,
            trend: 1,
            initialized: false
        }));

        const absDelta = closes.map((c, i) => (i === 0 ? 0 : Math.abs(c - closes[i - 1])));
        const perfDen = calculateEMA(absDelta, perfAlpha);

        const ts: (number | null)[] = new Array(cleanData.length).fill(null);
        const perfIdxSeries: (number | null)[] = new Array(cleanData.length).fill(null);

        let targetFactor = (minFactor + maxFactor) / 2;
        let finalUpper: number | null = null;
        let finalLower: number | null = null;
        let os: 0 | 1 = 1;
        let lastClusterPerf = 0;
        let lastClusterFactor = targetFactor;

        for (let i = 0; i < cleanData.length; i++) {
            const atrVal = atr[i];
            if (atrVal === null) {
                ts[i] = null;
                perfIdxSeries[i] = null;
                continue;
            }

            const hl2 = (highs[i] + lows[i]) / 2;
            const prevClose = i > 0 ? closes[i - 1] : closes[i];
            const delta = i > 0 ? closes[i] - closes[i - 1] : 0;

            for (let fIdx = 0; fIdx < factorValues.length; fIdx++) {
                const factor = factorValues[fIdx];
                const state = states[fIdx];
                if (!state.initialized) {
                    state.upper = hl2;
                    state.lower = hl2;
                    state.output = hl2;
                    state.perf = 0;
                    state.trend = closes[i] >= hl2 ? 1 : 0;
                    state.initialized = true;
                }

                const up = hl2 + atrVal * factor;
                const dn = hl2 - atrVal * factor;

                state.trend = closes[i] > state.upper ? 1 : closes[i] < state.lower ? 0 : state.trend;
                state.upper = prevClose < state.upper ? Math.min(up, state.upper) : up;
                state.lower = prevClose > state.lower ? Math.max(dn, state.lower) : dn;

                const diff = Math.sign(prevClose - state.output) || 0;
                const alpha = 2 / (perfAlpha + 1);
                state.perf = state.perf + alpha * (delta * diff - state.perf);
                state.output = state.trend === 1 ? state.lower : state.upper;
            }

            if (i >= warmupBars && i % kMeansInterval === 0) {
                const perfValues = states.map(s => s.perf);
                const clusters = kMeans1d(perfValues, factorValues, kMeansIterations);
                const ranked = clusters
                    .map((cluster, idx) => ({ idx, centroid: cluster.centroid }))
                    .sort((a, b) => a.centroid - b.centroid);

                const selectedIdx = ranked[Math.min(clusterChoice, ranked.length - 1)]?.idx ?? 0;
                const selected = clusters[selectedIdx];
                const perfAvg = mean(selected.values);
                const factorAvg = mean(selected.factors);
                if (Number.isFinite(factorAvg)) {
                    targetFactor = factorAvg;
                    lastClusterFactor = factorAvg;
                } else if (Number.isFinite(lastClusterFactor)) {
                    targetFactor = lastClusterFactor;
                }
                if (Number.isFinite(perfAvg)) {
                    lastClusterPerf = perfAvg;
                }
            }

            if (!Number.isFinite(targetFactor)) {
                targetFactor = lastClusterFactor;
            }

            const up = hl2 + atrVal * targetFactor;
            const dn = hl2 - atrVal * targetFactor;

            if (finalUpper === null || finalLower === null) {
                finalUpper = up;
                finalLower = dn;
            } else {
                finalUpper = prevClose < finalUpper ? Math.min(up, finalUpper) : up;
                finalLower = prevClose > finalLower ? Math.max(dn, finalLower) : dn;
            }

            os = closes[i] > finalUpper ? 1 : closes[i] < finalLower ? 0 : os;
            ts[i] = os === 1 ? finalLower : finalUpper;

            const den = perfDen[i];
            if (den !== null && den > 0 && Number.isFinite(lastClusterPerf)) {
                perfIdxSeries[i] = Math.max(lastClusterPerf, 0) / den;
            }
        }

        return [
            { name: 'Adaptive Supertrend', type: 'line', values: ts, color: COLORS.Trend },
            { name: 'Performance Index', type: 'histogram', values: perfIdxSeries, color: COLORS.Histogram }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['atrPeriod', 'minFactor', 'maxFactor', 'factorStep']
    }
};
