import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels, calculateEMA } from '../indicators';

interface Config {
    breakoutLen: number;
    exitLen: number;
    trendLen: number;
    volLen: number;
    volMinPct: number;
    volMaxPct: number;
    maxHoldBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
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
            const v = values[j];
            if (v === null) continue;
            valid++;
            if (v <= current) belowOrEqual++;
        }

        if (valid > 0) out[i] = belowOrEqual / valid;
    }

    return out;
}

function normalize(params: StrategyParams): Config {
    const breakoutLen = Math.max(20, Math.min(180, Math.round(params.breakoutLen ?? 55)));
    const exitLenRaw = Math.max(10, Math.min(120, Math.round(params.exitLen ?? 20)));
    const exitLen = Math.min(exitLenRaw, Math.max(10, breakoutLen - 5));
    const volMinPct = clamp(params.volMinPct ?? 20, 0, 80);
    const volMaxPct = clamp(params.volMaxPct ?? 85, volMinPct + 5, 99);

    return {
        breakoutLen,
        exitLen,
        trendLen: Math.max(80, Math.min(500, Math.round(params.trendLen ?? 200))),
        volLen: Math.max(20, Math.min(200, Math.round(params.volLen ?? 100))),
        volMinPct,
        volMaxPct,
        maxHoldBars: Math.max(10, Math.min(400, Math.round(params.maxHoldBars ?? 100))),
    };
}

export const regime_donchian_breakout: Strategy = {
    name: 'Regime Donchian Breakout',
    description: 'Long-only Donchian breakout with trend and volatility regime filters, plus conservative exits for robustness.',
    defaultParams: {
        breakoutLen: 55,
        exitLen: 20,
        trendLen: 200,
        volLen: 100,
        volMinPct: 20,
        volMaxPct: 85,
        maxHoldBars: 100,
    },
    paramLabels: {
        breakoutLen: 'Breakout Length',
        exitLen: 'Exit Length',
        trendLen: 'Trend Length',
        volLen: 'Volatility Lookback',
        volMinPct: 'Volatility Min Percentile (%)',
        volMaxPct: 'Volatility Max Percentile (%)',
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
        const breakoutChannel = calculateDonchianChannels(highs, lows, cfg.breakoutLen);
        const exitChannel = calculateDonchianChannels(highs, lows, cfg.exitLen);
        const atrPeriod = Math.max(7, Math.min(30, Math.round(cfg.breakoutLen / 3)));
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const atrPct: (number | null)[] = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            const a = atr[i];
            const c = closes[i];
            if (a === null || c <= 0) continue;
            atrPct[i] = (a / c) * 100;
        }
        const volRank = percentileRank(atrPct, cfg.volLen);
        const volMin = cfg.volMinPct / 100;
        const volMax = cfg.volMaxPct / 100;

        const slopeLookback = Math.max(3, Math.min(40, Math.round(cfg.trendLen / 8)));
        const minBars = Math.max(cfg.breakoutLen + 2, cfg.trendLen + slopeLookback + 2, cfg.volLen + 2);
        const cooldownBars = Math.max(2, Math.min(40, Math.round(cfg.exitLen * 0.35)));
        const catastropheStopAtr = 2.4;

        const signals: Signal[] = [];
        let inPosition = false;
        let entryPrice = 0;
        let entryAtr = 0;
        let barsHeld = 0;
        let cooldown = 0;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;

            const t = trend[i];
            const tBase = trend[i - slopeLookback];
            const rank = volRank[i];
            const prevUpper = breakoutChannel.upper[i - 1];
            const prevLowerExit = exitChannel.lower[i - 1];
            const atrNow = atr[i];
            if (t === null || tBase === null || rank === null || prevUpper === null || prevLowerExit === null || atrNow === null || atrNow <= 0) {
                continue;
            }

            const close = closes[i];
            const trendStrength = (t - tBase) / atrNow;
            const trendUp = close > t && trendStrength > 0.1;
            const volInRegime = rank >= volMin && rank <= volMax;

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                const breakout = close > prevUpper;
                if (breakout && trendUp && volInRegime) {
                    inPosition = true;
                    entryPrice = close;
                    entryAtr = atrNow;
                    barsHeld = 0;
                    signals.push(createBuySignal(cleanData, i, 'Regime Donchian breakout entry'));
                }
                continue;
            }

            barsHeld++;
            const channelExit = close < prevLowerExit;
            const trendFail = close < t;
            const timeExit = barsHeld >= cfg.maxHoldBars;
            const stopExit = close <= entryPrice - (catastropheStopAtr * entryAtr);

            if (channelExit || trendFail || timeExit || stopExit) {
                const reason = stopExit
                    ? 'Regime Donchian catastrophe stop'
                    : channelExit
                        ? 'Regime Donchian channel exit'
                        : trendFail
                            ? 'Regime Donchian trend fail'
                            : 'Regime Donchian time exit';
                signals.push(createSellSignal(cleanData, i, reason));
                inPosition = false;
                entryPrice = 0;
                entryAtr = 0;
                barsHeld = 0;
                cooldown = cooldownBars;
            }
        }

        if (inPosition && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'Regime Donchian final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'breakoutLen',
            'exitLen',
            'trendLen',
            'volLen',
            'volMinPct',
            'volMaxPct',
            'maxHoldBars',
        ],
    },
};


