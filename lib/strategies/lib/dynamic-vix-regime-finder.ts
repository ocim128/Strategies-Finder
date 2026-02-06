import { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';

interface FinderConfig {
    useRecoveryRegime: boolean;
    useLowVolExit: boolean;
    fastPeriod: number;
    slowPeriod: number;
    volWindow: number;
    volLookback: number;
    spikePercentile: number;
    calmPercentile: number;
    oversoldRet: number;
    entryExposure: number;
    exitExposure: number;
    minHoldBars: number;
}

interface RegimeSeries {
    targetExposure: (number | null)[];
    reason: (string | null)[];
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function asToggle(value: number | undefined, fallback: boolean): boolean {
    const raw = value ?? (fallback ? 1 : 0);
    return raw >= 0.5;
}

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

function rollingMean(values: (number | null)[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return out;

    let sum = 0;
    let count = 0;

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current !== null) {
            sum += current;
            count++;
        }

        if (i >= period) {
            const leaving = values[i - period];
            if (leaving !== null) {
                sum -= leaving;
                count--;
            }
        }

        if (i >= period - 1 && count === period) {
            out[i] = sum / period;
        }
    }

    return out;
}

function rollingStd(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return out;

    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        sum += current;
        sumSq += current * current;

        if (i >= period) {
            const leaving = values[i - period];
            sum -= leaving;
            sumSq -= leaving * leaving;
        }

        if (i >= period - 1) {
            const mean = sum / period;
            const variance = Math.max(0, (sumSq / period) - (mean * mean));
            out[i] = Math.sqrt(variance);
        }
    }

    return out;
}

function rollingStdNullable(values: (number | null)[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return out;

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

        if (i >= period) {
            const leaving = values[i - period];
            if (leaving !== null) {
                sum -= leaving;
                sumSq -= leaving * leaving;
                count--;
            }
        }

        if (i >= period - 1 && count === period) {
            const mean = sum / period;
            const variance = Math.max(0, (sumSq / period) - (mean * mean));
            out[i] = Math.sqrt(variance);
        }
    }

    return out;
}

function percentileRank(values: (number | null)[], lookback: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current === null || i < lookback - 1) continue;

        let valid = 0;
        let belowOrEqual = 0;
        const start = i - lookback + 1;

        for (let j = start; j <= i; j++) {
            const value = values[j];
            if (value === null) continue;
            valid++;
            if (value <= current) belowOrEqual++;
        }

        if (valid > 0) {
            out[i] = belowOrEqual / valid;
        }
    }

    return out;
}

function normalizeConfig(params: StrategyParams): FinderConfig {
    const fastPeriod = Math.max(20, Math.min(90, Math.round(params.fastPeriod ?? 55)));
    const slowPeriod = Math.max(fastPeriod + 40, Math.min(320, Math.round(params.slowPeriod ?? 180)));
    const volWindow = Math.max(14, Math.min(42, Math.round(params.volWindow ?? 21)));
    const volLookback = Math.max(84, volWindow * 4);

    const spikePercentile = clamp(params.spikePercentilePct ?? 82, 70, 95) / 100;
    const calmPercentile = clamp(spikePercentile - 0.50, 0.08, spikePercentile - 0.08);
    const entryExposure = clamp(params.entryExposurePct ?? 70, 60, 85) / 100;
    const exitExposureRaw = clamp(params.exitExposurePct ?? 38, 20, 58) / 100;
    const exitExposure = Math.min(exitExposureRaw, entryExposure - 0.08);

    return {
        useRecoveryRegime: asToggle(params.useRecoveryRegime, true),
        useLowVolExit: asToggle(params.useLowVolExit, true),
        fastPeriod,
        slowPeriod,
        volWindow,
        volLookback,
        spikePercentile,
        calmPercentile,
        oversoldRet: clamp(params.oversoldRetPct ?? 3.4, 2, 6) / 100,
        entryExposure,
        exitExposure,
        minHoldBars: Math.max(6, Math.min(40, Math.round(params.minHoldBars ?? 12))),
    };
}

function buildSeries(cleanData: OHLCVData[], config: FinderConfig): RegimeSeries {
    const close = getCloses(cleanData);
    const high = getHighs(cleanData);
    const low = getLows(cleanData);

    const fast = calculateEMA(close, config.fastPeriod);
    const slow = calculateEMA(close, config.slowPeriod);
    const atr = calculateATR(high, low, close, Math.max(5, Math.floor(config.volWindow / 2)));

    const returns = close.map((value, i) => {
        if (i === 0 || value <= 0 || close[i - 1] <= 0) return 0;
        return Math.log(value / close[i - 1]);
    });

    const realizedVolRaw = rollingStd(returns, config.volWindow);
    const realizedVol = realizedVolRaw.map(v => (v === null ? null : v * Math.sqrt(252) * 100));

    const volProxy: (number | null)[] = new Array(cleanData.length).fill(null);
    for (let i = 0; i < cleanData.length; i++) {
        const rv = realizedVol[i];
        const atrVal = atr[i];
        const closeVal = close[i];
        if (rv === null || atrVal === null || closeVal <= 0) continue;
        const atrPct = (atrVal / closeVal) * 100;
        volProxy[i] = (0.7 * rv) + (0.3 * atrPct);
    }

    const volMean = rollingMean(volProxy, config.volWindow);
    const volStd = rollingStdNullable(volProxy, config.volWindow);
    const volZ: (number | null)[] = volProxy.map((value, i) => {
        const mean = volMean[i];
        const std = volStd[i];
        if (value === null || mean === null || std === null || std <= 0) return null;
        return (value - mean) / std;
    });
    const volRank = percentileRank(volProxy, config.volLookback);

    const targetExposure: (number | null)[] = new Array(cleanData.length).fill(null);
    const reason: (string | null)[] = new Array(cleanData.length).fill(null);

    for (let i = 0; i < cleanData.length; i++) {
        const f = fast[i];
        const s = slow[i];
        const a = atr[i];
        const v = volProxy[i];
        const vMean = volMean[i];
        const z = volZ[i];
        const rank = volRank[i];
        if (f === null || s === null || a === null || a <= 0 || v === null || vMean === null || z === null || rank === null) {
            continue;
        }

        const closeNow = close[i];
        const ret5 = i >= 5 ? (closeNow / close[i - 5]) - 1 : 0;
        const ret21 = i >= 21 ? (closeNow / close[i - 21]) - 1 : 0;
        const trendUp = closeNow > s && f > s;
        const trendStrength = (f - s) / a;
        const spikeRegime = rank >= config.spikePercentile && ret5 <= -config.oversoldRet && z >= 0.35;
        const lowVolExtension = config.useLowVolExit
            && rank <= config.calmPercentile
            && closeNow > f * 1.04
            && ret21 > 0;
        const recoveryRegime = config.useRecoveryRegime
            && trendUp
            && z > 0
            && v < vMean
            && closeNow > f;
        const risingVolDefense = z >= 1.2 || rank >= 0.95;

        const score = (
            0.9 * clamp(z / 3, -1, 1) +
            0.8 * clamp((-ret5 - 0.01) / 0.08, -1, 1) +
            0.4 * clamp(trendStrength / 2.5, -1, 1) +
            0.35 * clamp(ret21 / 0.15, -1, 1) -
            0.35 * clamp((0.2 - rank) / 0.2, -1, 1)
        );
        const regimeProb = sigmoid(score);
        const regimeBullish = regimeProb >= 0.6 && trendStrength > 0;

        let exposure = trendUp ? 0.54 : 0.24;
        let regimeReason = trendUp ? 'Trend base' : 'Defensive base';

        if (spikeRegime) {
            exposure = regimeBullish ? 0.88 : 0.74;
            regimeReason = regimeBullish ? 'Volatility spike with confidence' : 'Volatility spike mean reversion';
        } else if (lowVolExtension) {
            exposure = 0.28;
            regimeReason = 'Low-volatility extension de-risk';
        } else if (recoveryRegime) {
            exposure = regimeBullish ? 0.76 : 0.68;
            regimeReason = regimeBullish ? 'Volatility recovery with confidence' : 'Volatility recovery';
        } else if (risingVolDefense) {
            exposure = 0.2;
            regimeReason = 'Rising volatility defense';
        } else if (trendUp && regimeBullish) {
            exposure = Math.min(0.66, exposure + 0.08);
            regimeReason = 'Trend plus regime bias';
        }

        targetExposure[i] = clamp(exposure, 0, 1);
        reason[i] = regimeReason;
    }

    return { targetExposure, reason };
}

export const dynamic_vix_regime_finder: Strategy = {
    name: 'Dynamic VIX Regime Finder',
    description: 'Robustness-focused volatility regime strategy inspired by VIX spike/recovery behavior with tighter, finder-safe parameter bounds.',
    defaultParams: {
        useRecoveryRegime: 1,
        useLowVolExit: 1,
        fastPeriod: 55,
        slowPeriod: 180,
        volWindow: 21,
        spikePercentilePct: 82,
        oversoldRetPct: 3.4,
        entryExposurePct: 70,
        exitExposurePct: 38,
        minHoldBars: 12,
    },
    paramLabels: {
        useRecoveryRegime: 'Use Recovery Regime (0/1)',
        useLowVolExit: 'Use Low-Vol Exit (0/1)',
        fastPeriod: 'Fast EMA Period',
        slowPeriod: 'Slow EMA Period',
        volWindow: 'Volatility Window',
        spikePercentilePct: 'Spike Percentile (%)',
        oversoldRetPct: '5-Bar Oversold Return (%)',
        entryExposurePct: 'Entry Exposure Threshold (%)',
        exitExposurePct: 'Exit Exposure Threshold (%)',
        minHoldBars: 'Minimum Hold Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const config = normalizeConfig(params);
        const minBars = Math.max(config.slowPeriod + 5, config.volLookback + config.volWindow + 5);
        if (cleanData.length < minBars) return [];

        const series = buildSeries(cleanData, config);
        const signals: Signal[] = [];

        const entryConfirmBars = 3;
        const exitConfirmBars = 3;
        const cooldownBars = 8;

        let inPosition = false;
        let barsInPosition = 0;
        let entryStreak = 0;
        let exitStreak = 0;
        let cooldown = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const exposure = series.targetExposure[i];
            if (exposure === null) continue;

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                entryStreak = exposure >= config.entryExposure ? entryStreak + 1 : 0;
                if (entryStreak >= entryConfirmBars) {
                    signals.push(createBuySignal(cleanData, i, series.reason[i] ?? 'Regime entry'));
                    inPosition = true;
                    barsInPosition = 0;
                    entryStreak = 0;
                    exitStreak = 0;
                    cooldown = cooldownBars;
                }
                continue;
            }

            barsInPosition++;
            if (barsInPosition < config.minHoldBars) {
                continue;
            }

            exitStreak = exposure <= config.exitExposure ? exitStreak + 1 : 0;
            if (exitStreak >= exitConfirmBars) {
                signals.push(createSellSignal(cleanData, i, series.reason[i] ?? 'Regime exit'));
                inPosition = false;
                barsInPosition = 0;
                entryStreak = 0;
                exitStreak = 0;
                cooldown = cooldownBars;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'fastPeriod',
            'slowPeriod',
            'volWindow',
            'spikePercentilePct',
            'oversoldRetPct',
            'entryExposurePct',
            'exitExposurePct',
            'minHoldBars',
            'useRecoveryRegime',
            'useLowVolExit',
        ],
    },
};
