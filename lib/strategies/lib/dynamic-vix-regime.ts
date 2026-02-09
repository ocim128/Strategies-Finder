import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateSMA } from '../indicators';

interface RegimeConfig {
    useSpikeRegime: boolean;
    useRecoveryRegime: boolean;
    useLowVolDeRisk: boolean;
    useMlOverlay: boolean;
    volWindow: number;
    volLookback: number;
    fastPeriod: number;
    slowPeriod: number;
    spikePercentile: number;
    calmPercentile: number;
    oversoldRetPct: number;
    extensionPct: number;
    mlBullThreshold: number;
    entryExposure: number;
    exitExposure: number;
    entryConfirmBars: number;
    exitConfirmBars: number;
    minHoldBars: number;
    cooldownBars: number;
}

interface RegimeSeries {
    close: number[];
    fast: (number | null)[];
    slow: (number | null)[];
    volProxy: (number | null)[];
    volMean: (number | null)[];
    volZ: (number | null)[];
    volPercentile: (number | null)[];
    mlProb: (number | null)[];
    targetExposure: (number | null)[];
    regimeReason: (string | null)[];
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

function asToggle(value: number | undefined, fallback: boolean): boolean {
    const raw = value ?? (fallback ? 1 : 0);
    return raw >= 0.5;
}

function calculateRollingMean(values: (number | null)[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return result;

    let sum = 0;
    let validCount = 0;

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current !== null) {
            sum += current;
            validCount++;
        }

        if (i >= period) {
            const leaving = values[i - period];
            if (leaving !== null) {
                sum -= leaving;
                validCount--;
            }
        }

        if (i >= period - 1 && validCount === period) {
            result[i] = sum / period;
        }
    }

    return result;
}

function calculateRollingStdFromNullable(values: (number | null)[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return result;

    let sum = 0;
    let sumSq = 0;
    let validCount = 0;

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current !== null) {
            sum += current;
            sumSq += current * current;
            validCount++;
        }

        if (i >= period) {
            const leaving = values[i - period];
            if (leaving !== null) {
                sum -= leaving;
                sumSq -= leaving * leaving;
                validCount--;
            }
        }

        if (i >= period - 1 && validCount === period) {
            const mean = sum / period;
            const variance = Math.max(0, sumSq / period - mean * mean);
            result[i] = Math.sqrt(variance);
        }
    }

    return result;
}

function calculateRollingStd(values: number[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return result;

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
            const variance = Math.max(0, sumSq / period - mean * mean);
            result[i] = Math.sqrt(variance);
        }
    }

    return result;
}

function calculatePercentileRank(values: (number | null)[], lookback: number): (number | null)[] {
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

function normalizeConfig(params: StrategyParams): RegimeConfig {
    const volWindow = Math.max(10, Math.round(params.volWindow ?? 21));
    const volLookback = Math.max(volWindow + 20, Math.round(params.volLookback ?? 126));
    const fastPeriod = Math.max(10, Math.round(params.fastPeriod ?? 50));
    const slowPeriod = Math.max(fastPeriod + 20, Math.round(params.slowPeriod ?? 200));

    const spikePercentile = clamp(params.spikePercentilePct ?? 80, 45, 99) / 100;
    const calmRaw = clamp(params.calmPercentilePct ?? 25, 1, 65) / 100;
    const calmPercentile = Math.min(calmRaw, spikePercentile - 0.05);
    const entryExposureRaw = clamp(params.entryExposurePct ?? 66, 50, 95) / 100;
    const exitExposureRaw = clamp(params.exitExposurePct ?? 38, 5, 70) / 100;
    const exitExposure = Math.min(exitExposureRaw, entryExposureRaw - 0.05);

    return {
        useSpikeRegime: asToggle(params.useSpikeRegime, true),
        useRecoveryRegime: asToggle(params.useRecoveryRegime, true),
        useLowVolDeRisk: asToggle(params.useLowVolDeRisk, true),
        useMlOverlay: asToggle(params.useMlOverlay, true),
        volWindow,
        volLookback,
        fastPeriod,
        slowPeriod,
        spikePercentile,
        calmPercentile,
        oversoldRetPct: clamp(params.oversoldRetPct ?? 3, 0.5, 10),
        extensionPct: clamp(params.extensionPct ?? 5, 1, 20),
        mlBullThreshold: clamp(params.mlBullThresholdPct ?? 60, 45, 90) / 100,
        entryExposure: entryExposureRaw,
        exitExposure,
        entryConfirmBars: Math.max(1, Math.round(params.entryConfirmBars ?? 2)),
        exitConfirmBars: Math.max(1, Math.round(params.exitConfirmBars ?? 2)),
        minHoldBars: Math.max(1, Math.round(params.minHoldBars ?? 10)),
        cooldownBars: Math.max(1, Math.round(params.cooldownBars ?? 6)),
    };
}

function buildRegimeSeries(cleanData: OHLCVData[], config: RegimeConfig): RegimeSeries {
    const close = getCloses(cleanData);
    const high = getHighs(cleanData);
    const low = getLows(cleanData);

    const fast = calculateSMA(close, config.fastPeriod);
    const slow = calculateSMA(close, config.slowPeriod);

    const atrPeriod = Math.max(5, Math.round(config.volWindow / 2));
    const atr = calculateATR(high, low, close, atrPeriod);

    const logReturns = close.map((c, i) => {
        if (i === 0 || c <= 0 || close[i - 1] <= 0) return 0;
        return Math.log(c / close[i - 1]);
    });
    const realizedVolRaw = calculateRollingStd(logReturns, config.volWindow);
    const realizedVol = realizedVolRaw.map(v => (v === null ? null : v * Math.sqrt(252) * 100));

    const volProxy: (number | null)[] = new Array(cleanData.length).fill(null);
    for (let i = 0; i < cleanData.length; i++) {
        const rv = realizedVol[i];
        const atrVal = atr[i];
        const closeVal = close[i];
        if (rv === null || atrVal === null || closeVal <= 0) continue;
        const atrPct = (atrVal / closeVal) * 100;
        volProxy[i] = (0.65 * rv) + (0.35 * atrPct);
    }

    const volMean = calculateRollingMean(volProxy, config.volWindow);
    const volStd = calculateRollingStdFromNullable(volProxy, config.volWindow);
    const volZ: (number | null)[] = volProxy.map((value, i) => {
        const mean = volMean[i];
        const std = volStd[i];
        if (value === null || mean === null || std === null || std <= 0) return null;
        return (value - mean) / std;
    });

    const volPercentile = calculatePercentileRank(volProxy, config.volLookback);
    const mlProb: (number | null)[] = new Array(cleanData.length).fill(null);
    const targetExposure: (number | null)[] = new Array(cleanData.length).fill(null);
    const regimeReason: (string | null)[] = new Array(cleanData.length).fill(null);

    const oversoldThreshold = config.oversoldRetPct / 100;
    const extensionThreshold = config.extensionPct / 100;

    for (let i = 0; i < cleanData.length; i++) {
        const f = fast[i];
        const s = slow[i];
        const vol = volProxy[i];
        const volAvg = volMean[i];
        const volZScore = volZ[i];
        const volRank = volPercentile[i];

        if (f === null || s === null || vol === null || volAvg === null || volZScore === null || volRank === null) {
            continue;
        }

        const closeNow = close[i];
        const ret5 = i >= 5 ? (closeNow / close[i - 5]) - 1 : 0;
        const ret21 = i >= 21 ? (closeNow / close[i - 21]) - 1 : 0;
        const trendSlow = closeNow > 0 && s > 0 ? (closeNow / s) - 1 : 0;
        const volStretch = volAvg > 0 ? (vol / volAvg) - 1 : 0;

        const volZNorm = clamp(volZScore / 3, -1, 1);
        const oversoldNorm = clamp((-ret5 - 0.01) / 0.06, -1, 1);
        const trendNorm = clamp(trendSlow / 0.1, -1, 1);
        const momentumNorm = clamp(ret21 / 0.12, -1, 1);
        const complacencyPenalty = clamp((0.2 - volRank) / 0.2, -1, 1);
        const stretchPenalty = clamp(volStretch / 0.45, -1, 1);

        const score = (
            0.95 * volZNorm +
            0.75 * oversoldNorm +
            0.55 * trendNorm +
            0.35 * momentumNorm -
            0.5 * complacencyPenalty -
            0.3 * stretchPenalty
        );
        const prob = sigmoid(score);
        mlProb[i] = prob;

        const mlBullish = config.useMlOverlay && prob >= config.mlBullThreshold;
        const trendBull = closeNow > s;
        const spikeRegime = config.useSpikeRegime
            && volRank >= config.spikePercentile
            && ret5 <= -oversoldThreshold;
        const lowVolExtended = config.useLowVolDeRisk
            && volRank <= config.calmPercentile
            && closeNow > f * (1 + extensionThreshold);
        const recoveryRegime = config.useRecoveryRegime
            && volZScore > 0.2
            && vol < volAvg
            && closeNow > f;
        const risingVolRisk = volZScore >= 1.15;

        let exposure = trendBull ? 0.62 : 0.3;
        let reason = trendBull ? 'Trend-following base' : 'Defensive base';

        if (spikeRegime) {
            exposure = mlBullish ? 1.0 : 0.85;
            reason = mlBullish ? 'Volatility spike + ML boost' : 'Volatility spike mean reversion';
        } else if (lowVolExtended) {
            exposure = 0.35;
            reason = 'Low-vol extension de-risk';
        } else if (recoveryRegime) {
            exposure = mlBullish ? 0.85 : 0.72;
            reason = mlBullish ? 'Vol recovery + ML confirmation' : 'Volatility recovery';
        } else if (risingVolRisk) {
            exposure = 0.28;
            reason = 'Rising volatility defense';
        } else if (mlBullish && trendBull) {
            exposure = Math.min(0.8, exposure + 0.08);
            reason = 'Trend with ML tilt';
        }

        targetExposure[i] = clamp(exposure, 0, 1);
        regimeReason[i] = reason;
    }

    return {
        close,
        fast,
        slow,
        volProxy,
        volMean,
        volZ,
        volPercentile,
        mlProb,
        targetExposure,
        regimeReason,
    };
}

export const dynamic_vix_regime: Strategy = {
    name: 'Dynamic VIX Regime',
    description: 'Volatility-regime allocator inspired by VIX spike/recovery logic, adapted for single-symbol backtests with an ML-style probability overlay.',
    defaultParams: {
        useSpikeRegime: 1,
        useRecoveryRegime: 1,
        useLowVolDeRisk: 1,
        useMlOverlay: 1,
        volWindow: 21,
        volLookback: 126,
        fastPeriod: 50,
        slowPeriod: 200,
        spikePercentilePct: 80,
        calmPercentilePct: 25,
        oversoldRetPct: 3,
        extensionPct: 5,
        mlBullThresholdPct: 60,
        entryExposurePct: 66,
        exitExposurePct: 38,
        entryConfirmBars: 2,
        exitConfirmBars: 2,
        minHoldBars: 10,
        cooldownBars: 6,
    },
    paramLabels: {
        useSpikeRegime: 'Use Spike Regime (0/1)',
        useRecoveryRegime: 'Use Recovery Regime (0/1)',
        useLowVolDeRisk: 'Use Low-Vol DeRisk (0/1)',
        useMlOverlay: 'Use ML Overlay (0/1)',
        volWindow: 'Volatility Window',
        volLookback: 'Volatility Lookback',
        fastPeriod: 'Fast SMA Period',
        slowPeriod: 'Slow SMA Period',
        spikePercentilePct: 'Spike Percentile (%)',
        calmPercentilePct: 'Calm Percentile (%)',
        oversoldRetPct: '5-Bar Oversold Return (%)',
        extensionPct: 'Extension Above Fast SMA (%)',
        mlBullThresholdPct: 'ML Bull Threshold (%)',
        entryExposurePct: 'Entry Exposure Threshold (%)',
        exitExposurePct: 'Exit Exposure Threshold (%)',
        entryConfirmBars: 'Entry Confirm Bars',
        exitConfirmBars: 'Exit Confirm Bars',
        minHoldBars: 'Min Hold Bars',
        cooldownBars: 'Signal Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const config = normalizeConfig(params);
        const minBars = Math.max(config.slowPeriod + 1, config.volWindow + config.volLookback);
        if (cleanData.length < minBars) return [];

        const series = buildRegimeSeries(cleanData, config);
        const signals: Signal[] = [];

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

                if (exposure >= config.entryExposure) {
                    entryStreak++;
                } else {
                    entryStreak = 0;
                }

                if (entryStreak >= config.entryConfirmBars) {
                    const reason = series.regimeReason[i] ?? 'Regime long entry';
                    signals.push(createBuySignal(cleanData, i, reason));
                    inPosition = true;
                    barsInPosition = 0;
                    cooldown = config.cooldownBars;
                    entryStreak = 0;
                    exitStreak = 0;
                }
                continue;
            }

            barsInPosition++;
            if (barsInPosition < config.minHoldBars) {
                continue;
            }

            if (exposure <= config.exitExposure) {
                exitStreak++;
            } else {
                exitStreak = 0;
            }

            if (exitStreak >= config.exitConfirmBars) {
                const reason = series.regimeReason[i] ?? 'Regime de-risk exit';
                signals.push(createSellSignal(cleanData, i, reason));
                inPosition = false;
                barsInPosition = 0;
                cooldown = config.cooldownBars;
                exitStreak = 0;
                entryStreak = 0;
            }
        }

        return signals;
    },
    metadata: {
        direction: 'long',
        walkForwardParams: [
            'volWindow',
            'volLookback',
            'fastPeriod',
            'slowPeriod',
            'spikePercentilePct',
            'calmPercentilePct',
            'oversoldRetPct',
            'extensionPct',
            'mlBullThresholdPct',
            'entryExposurePct',
            'exitExposurePct',
            'entryConfirmBars',
            'exitConfirmBars',
            'minHoldBars',
            'cooldownBars',
            'useSpikeRegime',
            'useRecoveryRegime',
            'useLowVolDeRisk',
            'useMlOverlay',
        ],
    },
};


