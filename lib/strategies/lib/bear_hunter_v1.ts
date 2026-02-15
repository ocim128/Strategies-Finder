import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR, calculateSMA } from "../indicators";

interface BearHunterConfig {
    fastPeriod: number;
    slowPeriod: number;
    trendSlopeBars: number;
    volWindow: number;
    volLookback: number;
    spikePercentile: number;
    coverPercentile: number;
    confirmBars: number;
    minHoldBars: number;
    cooldownBars: number;
    atrPeriod: number;
    stopAtr: number;
    trailAtr: number;
    maxHoldBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function calculateRollingStd(values: number[], period: number): (number | null)[] {
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

function calculatePercentileRank(values: (number | null)[], lookback: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current === null || i < lookback - 1) continue;

        let valid = 0;
        let belowOrEqual = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            const value = values[j];
            if (value === null) continue;
            valid++;
            if (value <= current) belowOrEqual++;
        }

        if (valid > 0) out[i] = belowOrEqual / valid;
    }

    return out;
}

function normalizeConfig(params: StrategyParams): BearHunterConfig {
    const fastPeriod = Math.max(8, Math.round(params.fastPeriod ?? 55));
    const slowPeriod = Math.max(fastPeriod + 20, Math.round(params.slowPeriod ?? 200));
    const volWindow = Math.max(8, Math.round(params.volWindow ?? 21));
    const volLookback = Math.max(volWindow + 20, Math.round(params.volLookback ?? 126));

    const rawSpikePct = clamp(params.spikePercentilePct ?? 90, 60, 99) / 100;
    const rawCoverPct = clamp(params.coverPercentilePct ?? 70, 20, 95) / 100;

    return {
        fastPeriod,
        slowPeriod,
        trendSlopeBars: Math.max(2, Math.round(params.trendSlopeBars ?? 8)),
        volWindow,
        volLookback,
        spikePercentile: rawSpikePct,
        coverPercentile: Math.min(rawCoverPct, rawSpikePct - 0.03),
        confirmBars: Math.max(1, Math.round(params.confirmBars ?? 2)),
        minHoldBars: Math.max(1, Math.round(params.minHoldBars ?? 8)),
        cooldownBars: Math.max(0, Math.round(params.cooldownBars ?? 6)),
        atrPeriod: Math.max(5, Math.round(params.atrPeriod ?? 14)),
        stopAtr: Math.max(0.4, params.stopAtr ?? 2.4),
        trailAtr: Math.max(0.6, params.trailAtr ?? 3.2),
        maxHoldBars: Math.max(5, Math.round(params.maxHoldBars ?? 80)),
    };
}

export const bear_hunter_v1: Strategy = {
    name: "Bear Hunter v1",
    description: "Short-only crash hedge: enters only on high-volatility wipeout regimes with confirmed downtrend.",
    defaultParams: {
        fastPeriod: 55,
        slowPeriod: 200,
        trendSlopeBars: 8,
        volWindow: 21,
        volLookback: 126,
        spikePercentilePct: 90,
        coverPercentilePct: 70,
        confirmBars: 2,
        minHoldBars: 8,
        cooldownBars: 6,
        atrPeriod: 14,
        stopAtr: 2.4,
        trailAtr: 3.2,
        maxHoldBars: 80,
    },
    paramLabels: {
        fastPeriod: "Fast SMA",
        slowPeriod: "Slow SMA",
        trendSlopeBars: "Trend Slope Bars",
        volWindow: "Vol Window",
        volLookback: "Vol Lookback",
        spikePercentilePct: "Spike Percentile (%)",
        coverPercentilePct: "Cover Percentile (%)",
        confirmBars: "Entry Confirm Bars",
        minHoldBars: "Min Hold Bars",
        cooldownBars: "Cooldown Bars",
        atrPeriod: "ATR Period",
        stopAtr: "Stop Loss (ATR)",
        trailAtr: "Trailing Stop (ATR)",
        maxHoldBars: "Max Hold Bars",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const config = normalizeConfig(params);
        const minBars = Math.max(
            config.slowPeriod + config.trendSlopeBars + 2,
            config.volLookback + config.volWindow + 2
        );
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const fast = calculateSMA(closes, config.fastPeriod);
        const slow = calculateSMA(closes, config.slowPeriod);
        const atr = calculateATR(highs, lows, closes, config.atrPeriod);

        const logReturns = closes.map((close, i) => {
            if (i === 0 || close <= 0 || closes[i - 1] <= 0) return 0;
            return Math.log(close / closes[i - 1]);
        });
        const realizedVol = calculateRollingStd(logReturns, config.volWindow)
            .map((value) => (value === null ? null : value * Math.sqrt(252) * 100));

        const volProxy: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < cleanData.length; i++) {
            const rv = realizedVol[i];
            const atrValue = atr[i];
            const close = closes[i];
            if (rv === null || atrValue === null || close <= 0) continue;
            const atrPct = (atrValue / close) * 100;
            volProxy[i] = rv * 0.65 + atrPct * 0.35;
        }
        const volPercentile = calculatePercentileRank(volProxy, config.volLookback);

        const signals: Signal[] = [];
        let inShort = false;
        let holdBars = 0;
        let cooldown = 0;
        let entryConfirmStreak = 0;
        let entryPrice = 0;
        let bestPrice = Number.POSITIVE_INFINITY;

        for (let i = 1; i < cleanData.length; i++) {
            const fastNow = fast[i];
            const slowNow = slow[i];
            const atrNow = atr[i];
            const volPctNow = volPercentile[i];
            const slowPast = i >= config.trendSlopeBars ? slow[i - config.trendSlopeBars] : null;
            if (fastNow === null || slowNow === null || atrNow === null || volPctNow === null || slowPast === null) continue;

            const downtrend = fastNow < slowNow && slowNow < slowPast;
            const wipeoutRegime = volPctNow >= config.spikePercentile && downtrend;
            const exitRegime = volPctNow <= config.coverPercentile || !downtrend;

            if (!inShort) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                entryConfirmStreak = wipeoutRegime ? (entryConfirmStreak + 1) : 0;
                if (entryConfirmStreak >= config.confirmBars) {
                    inShort = true;
                    holdBars = 0;
                    entryPrice = closes[i];
                    bestPrice = closes[i];
                    entryConfirmStreak = 0;
                    signals.push(createSellSignal(cleanData, i, "Bear wipeout short entry"));
                }
                continue;
            }

            holdBars++;
            bestPrice = Math.min(bestPrice, closes[i]);

            const hardStop = closes[i] >= entryPrice + config.stopAtr * atrNow;
            const trailStop = closes[i] >= bestPrice + config.trailAtr * atrNow;
            const timeout = holdBars >= config.maxHoldBars;
            const regimeExit = holdBars >= config.minHoldBars && exitRegime;

            if (hardStop || trailStop || timeout || regimeExit) {
                const reason = hardStop
                    ? "Bear short hard stop"
                    : trailStop
                        ? "Bear short trailing stop"
                        : timeout
                            ? "Bear short max-hold exit"
                            : "Bear regime cover";
                signals.push(createBuySignal(cleanData, i, reason));
                inShort = false;
                holdBars = 0;
                cooldown = config.cooldownBars;
                entryPrice = 0;
                bestPrice = Number.POSITIVE_INFINITY;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "short",
        walkForwardParams: [
            "fastPeriod",
            "slowPeriod",
            "trendSlopeBars",
            "spikePercentilePct",
            "coverPercentilePct",
            "confirmBars",
            "minHoldBars",
            "stopAtr",
            "trailAtr",
            "maxHoldBars",
        ],
    },
};
