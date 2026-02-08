import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from '../strategy-helpers';
import { COLORS } from '../constants';

interface RegressionConfig {
    lookback: number;
    slopeThresholdPct: number;
    zEntry: number;
    zExit: number;
    maxHoldBars: number;
    cooldownBars: number;
    useShorts: boolean;
    noiseLevelPct: number;
    noiseRuns: number;
    consensusPct: number;
}

interface RegressionSeries {
    line: (number | null)[];
    std: (number | null)[];
    slopePct: (number | null)[];
}

interface RegressionActions {
    buy: boolean[];
    sell: boolean[];
    series: RegressionSeries;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeConfig(params: StrategyParams): RegressionConfig {
    const lookback = Math.max(20, Math.min(300, Math.round(params.lookback ?? 80)));
    const slopeThresholdPct = clamp(params.slopeThresholdPct ?? 0.03, 0.005, 0.4);
    const zEntry = clamp(params.zEntry ?? 1.25, 0.6, 3);
    const zExitRaw = clamp(params.zExit ?? 0.35, 0.05, 2);
    const zExit = Math.min(zEntry - 0.05, zExitRaw);

    return {
        lookback,
        slopeThresholdPct,
        zEntry,
        zExit: Math.max(0.05, zExit),
        maxHoldBars: Math.max(5, Math.min(300, Math.round(params.maxHoldBars ?? 60))),
        cooldownBars: Math.max(0, Math.min(80, Math.round(params.cooldownBars ?? 5))),
        useShorts: (params.useShorts ?? 1) >= 0.5,
        noiseLevelPct: clamp(params.noiseLevelPct ?? 0.6, 0, 3),
        noiseRuns: Math.max(0, Math.min(6, Math.round(params.noiseRuns ?? 3))),
        consensusPct: clamp(params.consensusPct ?? 50, 25, 100),
    };
}

function seededRandom(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussianSample(rng: () => number): number {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function makeNoisyCloses(baseCloses: number[], noiseLevelPct: number, runIndex: number): number[] {
    if (noiseLevelPct <= 0) {
        return [...baseCloses];
    }

    const out: number[] = new Array(baseCloses.length);
    const noiseScale = noiseLevelPct / 100;
    const rng = seededRandom((runIndex * 0x9E3779B1) ^ 0x85EBCA6B);

    let smoothShock = 0;
    for (let i = 0; i < baseCloses.length; i++) {
        const rawShock = gaussianSample(rng) * noiseScale;
        smoothShock = (0.65 * smoothShock) + (0.35 * rawShock);
        out[i] = Math.max(1e-8, baseCloses[i] * (1 + smoothShock));
    }

    return out;
}

function buildRegressionSeries(closes: number[], lookback: number): RegressionSeries {
    const length = closes.length;
    const line: (number | null)[] = new Array(length).fill(null);
    const std: (number | null)[] = new Array(length).fill(null);
    const slopePct: (number | null)[] = new Array(length).fill(null);

    if (length < lookback || lookback < 2) {
        return { line, std, slopePct };
    }

    const sumX = ((lookback - 1) * lookback) / 2;
    const sumX2 = ((lookback - 1) * lookback * ((2 * lookback) - 1)) / 6;
    const denominator = (lookback * sumX2) - (sumX * sumX);
    if (denominator <= 0) {
        return { line, std, slopePct };
    }

    let sumY = 0;
    let sumSq = 0;
    let sumXY = 0;
    for (let i = 0; i < lookback; i++) {
        const value = closes[i];
        sumY += value;
        sumSq += value * value;
        sumXY += i * value;
    }

    for (let end = lookback - 1; end < length; end++) {
        if (end > lookback - 1) {
            const leaving = closes[end - lookback];
            const incoming = closes[end];
            const prevSumY = sumY;
            sumY = prevSumY - leaving + incoming;
            sumSq = sumSq - (leaving * leaving) + (incoming * incoming);
            sumXY = sumXY - prevSumY + leaving + ((lookback - 1) * incoming);
        }

        const slope = ((lookback * sumXY) - (sumX * sumY)) / denominator;
        const intercept = (sumY - (slope * sumX)) / lookback;
        const regAtBar = intercept + (slope * (lookback - 1));
        const mean = sumY / lookback;
        const variance = Math.max(0, (sumSq / lookback) - (mean * mean));
        const sigma = Math.sqrt(variance);

        line[end] = regAtBar;
        std[end] = sigma > 1e-10 ? sigma : null;
        slopePct[end] = Math.abs(regAtBar) > 1e-10
            ? (slope / Math.abs(regAtBar)) * 100
            : null;
    }

    return { line, std, slopePct };
}

function runRegressionActions(closes: number[], config: RegressionConfig): RegressionActions {
    const length = closes.length;
    const buy = new Array(length).fill(false);
    const sell = new Array(length).fill(false);
    const series = buildRegressionSeries(closes, config.lookback);

    let position: 'flat' | 'long' | 'short' = 'flat';
    let barsHeld = 0;
    let cooldown = 0;

    for (let i = 1; i < length; i++) {
        const line = series.line[i];
        const std = series.std[i];
        const slopePct = series.slopePct[i];
        if (line === null || std === null || slopePct === null) continue;

        const zScore = (closes[i] - line) / std;

        if (position === 'flat') {
            if (cooldown > 0) {
                cooldown--;
                continue;
            }

            const longEntry = slopePct >= config.slopeThresholdPct && zScore <= -config.zEntry;
            const shortEntry = config.useShorts
                && slopePct <= -config.slopeThresholdPct
                && zScore >= config.zEntry;

            if (longEntry) {
                buy[i] = true;
                position = 'long';
                barsHeld = 0;
                continue;
            }

            if (shortEntry) {
                sell[i] = true;
                position = 'short';
                barsHeld = 0;
            }
            continue;
        }

        barsHeld++;
        if (position === 'long') {
            const meanRevertExit = zScore >= config.zExit;
            const trendFlipExit = slopePct <= -(config.slopeThresholdPct * 0.5);
            const timeExit = barsHeld >= config.maxHoldBars;
            if (meanRevertExit || trendFlipExit || timeExit) {
                sell[i] = true;
                position = 'flat';
                barsHeld = 0;
                cooldown = config.cooldownBars;
            }
            continue;
        }

        const meanRevertExit = zScore <= -config.zExit;
        const trendFlipExit = slopePct >= (config.slopeThresholdPct * 0.5);
        const timeExit = barsHeld >= config.maxHoldBars;
        if (meanRevertExit || trendFlipExit || timeExit) {
            buy[i] = true;
            position = 'flat';
            barsHeld = 0;
            cooldown = config.cooldownBars;
        }
    }

    if (position !== 'flat' && length > 0) {
        const lastIndex = length - 1;
        if (position === 'long') {
            sell[lastIndex] = true;
        } else {
            buy[lastIndex] = true;
        }
    }

    return { buy, sell, series };
}

export const simple_regression_line: Strategy = {
    name: 'Simple Regression Line',
    description: 'Trend-following regression pullback with base + noisy reruns and consensus voting.',
    defaultParams: {
        lookback: 80,
        slopeThresholdPct: 0.03,
        zEntry: 1.25,
        zExit: 0.35,
        maxHoldBars: 60,
        cooldownBars: 5,
        useShorts: 1,
        noiseLevelPct: 0.6,
        noiseRuns: 3,
        consensusPct: 50,
    },
    paramLabels: {
        lookback: 'Regression Lookback',
        slopeThresholdPct: 'Slope Threshold (%/bar)',
        zEntry: 'Entry Z-Score',
        zExit: 'Exit Z-Score',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
        useShorts: 'Enable Shorts (0/1)',
        noiseLevelPct: 'Noise Level (%)',
        noiseRuns: 'Noise Runs',
        consensusPct: 'Consensus Threshold (%)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const config = normalizeConfig(params);
        if (cleanData.length < config.lookback + 2) return [];

        const baseCloses = getCloses(cleanData);
        const signals: Signal[] = [];

        const runs: RegressionActions[] = [];
        runs.push(runRegressionActions(baseCloses, config));

        for (let noiseRun = 1; noiseRun <= config.noiseRuns; noiseRun++) {
            const noisyCloses = makeNoisyCloses(baseCloses, config.noiseLevelPct, noiseRun);
            runs.push(runRegressionActions(noisyCloses, config));
        }

        const totalRuns = runs.length;
        const minVotes = Math.max(1, Math.min(
            totalRuns,
            Math.ceil((config.consensusPct / 100) * totalRuns)
        ));

        const buyVotes: number[] = new Array(cleanData.length).fill(0);
        const sellVotes: number[] = new Array(cleanData.length).fill(0);
        for (const run of runs) {
            for (let i = 0; i < cleanData.length; i++) {
                if (run.buy[i]) buyVotes[i]++;
                if (run.sell[i]) sellVotes[i]++;
            }
        }

        let position: 'flat' | 'long' | 'short' = 'flat';
        for (let i = 1; i < cleanData.length; i++) {
            const buyCount = buyVotes[i];
            const sellCount = sellVotes[i];
            const longBias = buyCount > sellCount;
            const shortBias = sellCount > buyCount;

            if (position === 'flat') {
                const longEntry = buyCount >= minVotes && longBias;
                const shortEntry = config.useShorts && sellCount >= minVotes && shortBias;

                if (longEntry) {
                    signals.push(
                        createBuySignal(cleanData, i, `Regression robust long entry (${buyCount}/${totalRuns} votes)`)
                    );
                    position = 'long';
                    continue;
                }

                if (shortEntry) {
                    signals.push(
                        createSellSignal(cleanData, i, `Regression robust short entry (${sellCount}/${totalRuns} votes)`)
                    );
                    position = 'short';
                }
                continue;
            }

            if (position === 'long') {
                if (sellCount >= minVotes) {
                    signals.push(
                        createSellSignal(cleanData, i, `Regression robust long exit (${sellCount}/${totalRuns} votes)`)
                    );
                    position = 'flat';
                }
                continue;
            }

            if (buyCount >= minVotes) {
                signals.push(
                    createBuySignal(cleanData, i, `Regression robust short exit (${buyCount}/${totalRuns} votes)`)
                );
                position = 'flat';
            }
        }

        if (position !== 'flat' && cleanData.length > 0) {
            const lastIndex = cleanData.length - 1;
            signals.push(
                position === 'long'
                    ? createSellSignal(cleanData, lastIndex, 'Regression final close')
                    : createBuySignal(cleanData, lastIndex, 'Regression final close')
            );
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const config = normalizeConfig(params);
        const closes = getCloses(cleanData);
        const series = runRegressionActions(closes, config).series;
        const upperBand: (number | null)[] = new Array(cleanData.length).fill(null);
        const lowerBand: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < cleanData.length; i++) {
            const line = series.line[i];
            const std = series.std[i];
            if (line === null || std === null) continue;
            upperBand[i] = line + (config.zEntry * std);
            lowerBand[i] = line - (config.zEntry * std);
        }

        return [
            { name: 'Regression Line', type: 'line', values: series.line, color: COLORS.Fast },
            { name: 'Regression Upper', type: 'line', values: upperBand, color: COLORS.Channel },
            { name: 'Regression Lower', type: 'line', values: lowerBand, color: COLORS.Channel },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'lookback',
            'slopeThresholdPct',
            'zEntry',
            'zExit',
            'maxHoldBars',
            'cooldownBars',
            'useShorts',
            'noiseLevelPct',
            'noiseRuns',
            'consensusPct',
        ],
    },
};
