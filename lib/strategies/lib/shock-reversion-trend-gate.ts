import { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA, calculateSMA } from '../indicators';

interface Config {
    shockLookback: number;
    shockZ: number;
    trendLen: number;
    volSpikePct: number;
    reversionLen: number;
    stopAtr: number;
    maxHoldBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
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
            const variance = Math.max(0, sumSq / period - mean * mean);
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
        if (valid > 0) out[i] = belowOrEqual / valid;
    }

    return out;
}

function normalize(params: StrategyParams): Config {
    return {
        shockLookback: Math.max(30, Math.min(180, Math.round(params.shockLookback ?? 50))),
        shockZ: clamp(params.shockZ ?? 1.8, 1.2, 3.5),
        trendLen: Math.max(100, Math.min(600, Math.round(params.trendLen ?? 200))),
        volSpikePct: clamp(params.volSpikePct ?? 82, 65, 99),
        reversionLen: Math.max(8, Math.min(180, Math.round(params.reversionLen ?? 20))),
        stopAtr: clamp(params.stopAtr ?? 1.8, 0.8, 4.5),
        maxHoldBars: Math.max(8, Math.min(200, Math.round(params.maxHoldBars ?? 20))),
    };
}

export const shock_reversion_trend_gate: Strategy = {
    name: 'Shock Reversion Trend Gate',
    description: 'Buys panic selloffs only in long-term uptrends with volatility spike confirmation, then exits on mean reversion, ATR stop, or time stop.',
    defaultParams: {
        shockLookback: 50,
        shockZ: 1.8,
        trendLen: 200,
        volSpikePct: 82,
        reversionLen: 20,
        stopAtr: 1.8,
        maxHoldBars: 20,
    },
    paramLabels: {
        shockLookback: 'Shock Lookback (bars)',
        shockZ: 'Shock Z-Score Threshold',
        trendLen: 'Trend Length',
        volSpikePct: 'Volatility Spike Percentile (%)',
        reversionLen: 'Mean Reversion Length',
        stopAtr: 'Stop Loss (ATR)',
        maxHoldBars: 'Max Hold Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalize(params);
        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const trend = calculateEMA(closes, cfg.trendLen);
        const meanRev = calculateSMA(closes, cfg.reversionLen);
        const atrPeriod = Math.max(5, Math.min(30, Math.round(cfg.shockLookback / 2)));
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const returns: number[] = new Array(closes.length).fill(0);
        for (let i = 1; i < closes.length; i++) {
            const prev = closes[i - 1];
            const curr = closes[i];
            if (prev > 0 && curr > 0) returns[i] = Math.log(curr / prev);
        }

        const retMean = calculateSMA(returns, cfg.shockLookback);
        const retStd = rollingStd(returns, cfg.shockLookback);
        const atrPct: (number | null)[] = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            const a = atr[i];
            if (a === null || closes[i] <= 0) continue;
            atrPct[i] = (a / closes[i]) * 100;
        }
        const volRank = percentileRank(atrPct, cfg.shockLookback);
        const volThreshold = cfg.volSpikePct / 100;

        const signals: Signal[] = [];
        let inPosition = false;
        let entryPrice = 0;
        let entryAtr = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let setupActiveUntil = -1;

        const cooldownBars = Math.max(4, Math.min(64, Math.round(cfg.reversionLen * 0.4)));
        const setupArmBars = Math.max(1, Math.min(6, Math.round(cfg.reversionLen * 0.15)));
        const slopeLookback = Math.max(2, Math.min(30, Math.round(cfg.trendLen / 10)));
        const minHoldBeforeExit = Math.max(1, Math.min(12, Math.round(cfg.maxHoldBars * 0.2)));

        const minBars = Math.max(cfg.trendLen + slopeLookback + 2, cfg.shockLookback + 2, cfg.reversionLen + 1);
        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;

            const t = trend[i];
            const tPrev = trend[i - 1];
            const tSlopeBase = trend[i - slopeLookback];
            const m = meanRev[i];
            const atrNow = atr[i];
            const mean = retMean[i];
            const std = retStd[i];
            const rank = volRank[i];
            if (t === null || tPrev === null || tSlopeBase === null || m === null || atrNow === null || mean === null || std === null || std <= 0 || rank === null) {
                continue;
            }

            const close = closes[i];
            const trendSlope = (t - tSlopeBase) / Math.max(atrNow, 1e-8);
            const trendUp = close >= t * 0.985 && trendSlope > -0.1 && t >= tPrev * 0.999;
            const shockScore = (returns[i] - mean) / std;
            const panicShock = shockScore <= -cfg.shockZ;
            const volSpike = rank >= volThreshold;
            const pullbackDepthAtr = (m - close) / Math.max(atrNow, 1e-8);
            const deepPullback = pullbackDepthAtr >= 0.35;
            const stabilization = close > closes[i - 1];

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                if (setupActiveUntil >= i) {
                    const stillValidTrend = close >= t * 0.98;
                    const stillValidVol = rank >= Math.max(0.5, volThreshold - 0.1);
                    if (stillValidTrend && stillValidVol && stabilization) {
                        inPosition = true;
                        entryPrice = close;
                        entryAtr = atrNow;
                        barsHeld = 0;
                        setupActiveUntil = -1;
                        signals.push(createBuySignal(cleanData, i, 'Shock reversion entry'));
                    }
                    continue;
                }

                setupActiveUntil = -1;

                if (trendUp && panicShock && volSpike && deepPullback) {
                    setupActiveUntil = i + setupArmBars;
                }
                continue;
            }

            barsHeld++;
            const stopHit = close <= entryPrice - (cfg.stopAtr * entryAtr);
            const meanReversionHit = close >= m || close >= entryPrice + (0.8 * entryAtr);
            const trendFail = barsHeld >= minHoldBeforeExit && close < t * 0.965;
            const timeStop = barsHeld >= cfg.maxHoldBars;

            if (stopHit || meanReversionHit || trendFail || timeStop) {
                const reason = stopHit
                    ? 'Shock reversion stop'
                    : meanReversionHit
                        ? 'Shock reversion mean target'
                        : trendFail
                            ? 'Shock reversion trend fail'
                            : 'Shock reversion time stop';
                signals.push(createSellSignal(cleanData, i, reason));
                inPosition = false;
                entryPrice = 0;
                entryAtr = 0;
                barsHeld = 0;
                cooldown = cooldownBars;
                setupActiveUntil = -1;
            }
        }

        if (inPosition && cleanData.length > 0) {
            const last = cleanData.length - 1;
            signals.push(createSellSignal(cleanData, last, 'Shock reversion final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'shockLookback',
            'shockZ',
            'trendLen',
            'volSpikePct',
            'reversionLen',
            'stopAtr',
            'maxHoldBars',
        ],
    },
};
