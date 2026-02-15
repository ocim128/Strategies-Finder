import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR, calculateRSI, calculateSMA } from "../indicators";

interface BearHunterV4Config {
    fastPeriod: number;
    slowPeriod: number;
    macroSmaPeriod: number;
    trendSlopeBars: number;
    rsiPeriod: number;
    oversoldGuardRsi: number;
    volWindow: number;
    volLookback: number;
    spikePercentile: number;
    coverPercentile: number;
    confirmBars: number;
    minHoldBars: number;
    cooldownBars: number;
    atrPeriod: number;
    stopAtr: number;
    activatedTrailAtr: number;
    trailActivationProfitPct: number;
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

function normalizeConfig(params: StrategyParams): BearHunterV4Config {
    const fastPeriod = Math.max(8, Math.round(params.fastPeriod ?? 34));
    const slowPeriod = Math.max(fastPeriod + 16, Math.round(params.slowPeriod ?? 89));
    const macroSmaPeriod = Math.max(80, Math.round(params.macroSmaPeriod ?? 200));
    const volWindow = Math.max(8, Math.round(params.volWindow ?? 21));
    const volLookback = Math.max(volWindow + 20, Math.round(params.volLookback ?? 126));
    const rawSpike = clamp(params.spikePercentilePct ?? 90, 60, 99) / 100;
    const rawCover = clamp(params.coverPercentilePct ?? 70, 20, 95) / 100;

    return {
        fastPeriod,
        slowPeriod,
        macroSmaPeriod,
        trendSlopeBars: Math.max(2, Math.round(params.trendSlopeBars ?? 8)),
        rsiPeriod: Math.max(4, Math.round(params.rsiPeriod ?? 14)),
        oversoldGuardRsi: clamp(params.oversoldGuardRsi ?? 30, 10, 45),
        volWindow,
        volLookback,
        spikePercentile: rawSpike,
        coverPercentile: Math.min(rawCover, rawSpike - 0.03),
        confirmBars: Math.max(1, Math.round(params.confirmBars ?? 2)),
        minHoldBars: Math.max(1, Math.round(params.minHoldBars ?? 2)),
        cooldownBars: Math.max(0, Math.round(params.cooldownBars ?? 8)),
        atrPeriod: Math.max(5, Math.round(params.atrPeriod ?? 14)),
        stopAtr: Math.max(0.2, params.stopAtr ?? 1.1),
        activatedTrailAtr: Math.max(0.6, params.activatedTrailAtr ?? 3.0),
        trailActivationProfitPct: Math.max(0.5, params.trailActivationProfitPct ?? 5.0),
        maxHoldBars: Math.max(8, Math.round(params.maxHoldBars ?? 72)),
    };
}

export const bear_hunter_v4: Strategy = {
    name: "Bear Hunter v4",
    description: "Short crash shield with macro gate, no quick-kill exits, and trailing stop activated only after meaningful profit.",
    defaultParams: {
        fastPeriod: 34,
        slowPeriod: 89,
        macroSmaPeriod: 200,
        trendSlopeBars: 8,
        rsiPeriod: 14,
        oversoldGuardRsi: 30,
        volWindow: 21,
        volLookback: 126,
        spikePercentilePct: 90,
        coverPercentilePct: 70,
        confirmBars: 2,
        minHoldBars: 2,
        cooldownBars: 8,
        atrPeriod: 14,
        stopAtr: 1.1,
        activatedTrailAtr: 3.0,
        trailActivationProfitPct: 5.0,
        maxHoldBars: 72,
    },
    paramLabels: {
        fastPeriod: "Fast SMA",
        slowPeriod: "Slow SMA",
        macroSmaPeriod: "Macro SMA Period",
        trendSlopeBars: "Trend Slope Bars",
        rsiPeriod: "RSI Period",
        oversoldGuardRsi: "Oversold Guard RSI",
        volWindow: "Vol Window",
        volLookback: "Vol Lookback",
        spikePercentilePct: "Spike Percentile (%)",
        coverPercentilePct: "Cover Percentile (%)",
        confirmBars: "Entry Confirm Bars",
        minHoldBars: "Min Hold Bars",
        cooldownBars: "Cooldown Bars",
        atrPeriod: "ATR Period",
        stopAtr: "Hard Stop (ATR)",
        activatedTrailAtr: "Activated Trail (ATR)",
        trailActivationProfitPct: "Trail Activation Profit %",
        maxHoldBars: "Max Hold Bars",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const minBars = Math.max(
            cfg.macroSmaPeriod + cfg.trendSlopeBars + 2,
            cfg.volLookback + cfg.volWindow + 2
        );
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const fast = calculateSMA(closes, cfg.fastPeriod);
        const slow = calculateSMA(closes, cfg.slowPeriod);
        const macro = calculateSMA(closes, cfg.macroSmaPeriod);
        const atr = calculateATR(highs, lows, closes, cfg.atrPeriod);
        const rsi = calculateRSI(closes, cfg.rsiPeriod);

        const logReturns = closes.map((close, i) => {
            if (i === 0 || close <= 0 || closes[i - 1] <= 0) return 0;
            return Math.log(close / closes[i - 1]);
        });
        const realizedVol = calculateRollingStd(logReturns, cfg.volWindow)
            .map((value) => (value === null ? null : value * Math.sqrt(252) * 100));

        const volProxy: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < cleanData.length; i++) {
            const rv = realizedVol[i];
            const atrNow = atr[i];
            const closeNow = closes[i];
            if (rv === null || atrNow === null || closeNow <= 0) continue;
            const atrPct = (atrNow / closeNow) * 100;
            volProxy[i] = rv * 0.65 + atrPct * 0.35;
        }
        const volPct = calculatePercentileRank(volProxy, cfg.volLookback);

        const signals: Signal[] = [];
        let inShort = false;
        let holdBars = 0;
        let cooldown = 0;
        let confirmStreak = 0;
        let entryPrice = 0;
        let bestPrice = Number.POSITIVE_INFINITY;
        let hardStopPrice = Number.POSITIVE_INFINITY;
        let trailActive = false;

        for (let i = 1; i < cleanData.length; i++) {
            const fastNow = fast[i];
            const slowNow = slow[i];
            const macroNow = macro[i];
            const slowPast = i >= cfg.trendSlopeBars ? slow[i - cfg.trendSlopeBars] : null;
            const atrNow = atr[i];
            const volNow = volPct[i];
            const rsiNow = rsi[i];
            if (
                fastNow === null ||
                slowNow === null ||
                macroNow === null ||
                slowPast === null ||
                atrNow === null ||
                volNow === null ||
                rsiNow === null
            ) {
                continue;
            }

            const macroBear = closes[i] < macroNow;
            const localDowntrend = fastNow < slowNow && slowNow < slowPast && closes[i] < fastNow;
            const highVolWipeout = volNow >= cfg.spikePercentile;
            const notOversold = rsiNow > cfg.oversoldGuardRsi;
            const entryRegime = macroBear && localDowntrend && highVolWipeout && notOversold;
            const deRiskRegime = volNow <= cfg.coverPercentile || !macroBear || !localDowntrend;

            if (!inShort) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                confirmStreak = entryRegime ? (confirmStreak + 1) : 0;
                if (confirmStreak >= cfg.confirmBars) {
                    inShort = true;
                    holdBars = 0;
                    entryPrice = closes[i];
                    bestPrice = closes[i];
                    hardStopPrice = entryPrice + cfg.stopAtr * atrNow;
                    trailActive = false;
                    confirmStreak = 0;
                    signals.push(createSellSignal(cleanData, i, "Bear v4 wipeout short entry"));
                }
                continue;
            }

            holdBars++;
            bestPrice = Math.min(bestPrice, closes[i]);
            const profitPct = ((entryPrice - closes[i]) / entryPrice) * 100;
            if (!trailActive && profitPct >= cfg.trailActivationProfitPct) {
                trailActive = true;
            }

            const hardStop = closes[i] >= hardStopPrice;
            const trailStop = trailActive && closes[i] >= bestPrice + cfg.activatedTrailAtr * atrNow;
            const timeout = holdBars >= cfg.maxHoldBars;
            const regimeExit = holdBars >= cfg.minHoldBars && deRiskRegime;

            if (hardStop || trailStop || timeout || regimeExit) {
                const reason = hardStop
                    ? "Bear v4 hard stop"
                    : trailStop
                        ? "Bear v4 activated trailing stop"
                        : timeout
                            ? "Bear v4 max-hold exit"
                            : "Bear v4 regime cover";
                signals.push(createBuySignal(cleanData, i, reason));
                inShort = false;
                holdBars = 0;
                cooldown = cfg.cooldownBars;
                entryPrice = 0;
                bestPrice = Number.POSITIVE_INFINITY;
                hardStopPrice = Number.POSITIVE_INFINITY;
                trailActive = false;
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
            "macroSmaPeriod",
            "trendSlopeBars",
            "oversoldGuardRsi",
            "spikePercentilePct",
            "coverPercentilePct",
            "confirmBars",
            "stopAtr",
            "activatedTrailAtr",
            "trailActivationProfitPct",
            "maxHoldBars",
        ],
    },
};
