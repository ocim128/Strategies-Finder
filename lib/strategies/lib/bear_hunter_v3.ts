import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR, calculateRSI, calculateSMA } from "../indicators";

interface BearHunterV3Config {
    fastPeriod: number;
    slowPeriod: number;
    macroSmaPeriod: number;
    trendSlopeBars: number;
    rsiPeriod: number;
    oversoldGuardRsi: number;
    panicExitRsi: number;
    recoveryExitRsi: number;
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
    timeDecayBars: number;
    timeDecayMinProfitPct: number;
    breakEvenTriggerProfitPct: number;
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

function normalizeConfig(params: StrategyParams): BearHunterV3Config {
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
        panicExitRsi: clamp(params.panicExitRsi ?? 30, 10, 50),
        recoveryExitRsi: clamp(params.recoveryExitRsi ?? 52, 35, 80),
        volWindow,
        volLookback,
        spikePercentile: rawSpike,
        coverPercentile: Math.min(rawCover, rawSpike - 0.03),
        confirmBars: Math.max(1, Math.round(params.confirmBars ?? 2)),
        minHoldBars: Math.max(1, Math.round(params.minHoldBars ?? 2)),
        cooldownBars: Math.max(0, Math.round(params.cooldownBars ?? 8)),
        atrPeriod: Math.max(5, Math.round(params.atrPeriod ?? 14)),
        stopAtr: Math.max(0.2, params.stopAtr ?? 1.0),
        trailAtr: Math.max(0.4, params.trailAtr ?? 1.2),
        maxHoldBars: Math.max(4, Math.round(params.maxHoldBars ?? 24)),
        timeDecayBars: Math.max(1, Math.round(params.timeDecayBars ?? 6)),
        timeDecayMinProfitPct: Math.max(0, params.timeDecayMinProfitPct ?? 0.5),
        breakEvenTriggerProfitPct: Math.max(0.1, params.breakEvenTriggerProfitPct ?? 3.0),
    };
}

export const bear_hunter_v3: Strategy = {
    name: "Bear Hunter v3",
    description: "Short crash shield with macro gate, quick-kill exits, breakeven ratchet, and oversold RSI panic exit.",
    defaultParams: {
        fastPeriod: 34,
        slowPeriod: 89,
        macroSmaPeriod: 200,
        trendSlopeBars: 8,
        rsiPeriod: 14,
        oversoldGuardRsi: 30,
        panicExitRsi: 30,
        recoveryExitRsi: 52,
        volWindow: 21,
        volLookback: 126,
        spikePercentilePct: 90,
        coverPercentilePct: 70,
        confirmBars: 2,
        minHoldBars: 2,
        cooldownBars: 8,
        atrPeriod: 14,
        stopAtr: 1.0,
        trailAtr: 1.2,
        maxHoldBars: 24,
        timeDecayBars: 6,
        timeDecayMinProfitPct: 0.5,
        breakEvenTriggerProfitPct: 3.0,
    },
    paramLabels: {
        fastPeriod: "Fast SMA",
        slowPeriod: "Slow SMA",
        macroSmaPeriod: "Macro SMA Period",
        trendSlopeBars: "Trend Slope Bars",
        rsiPeriod: "RSI Period",
        oversoldGuardRsi: "Oversold Guard RSI",
        panicExitRsi: "Panic Exit RSI Cross",
        recoveryExitRsi: "Recovery Exit RSI",
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
        timeDecayBars: "Time-Decay Bars",
        timeDecayMinProfitPct: "Min Profit % by Decay Time",
        breakEvenTriggerProfitPct: "Break-Even Trigger Profit %",
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
        let breakEvenArmed = false;

        for (let i = 1; i < cleanData.length; i++) {
            const fastNow = fast[i];
            const slowNow = slow[i];
            const macroNow = macro[i];
            const slowPast = i >= cfg.trendSlopeBars ? slow[i - cfg.trendSlopeBars] : null;
            const atrNow = atr[i];
            const volNow = volPct[i];
            const rsiNow = rsi[i];
            const rsiPrev = rsi[i - 1];
            if (
                fastNow === null ||
                slowNow === null ||
                macroNow === null ||
                slowPast === null ||
                atrNow === null ||
                volNow === null ||
                rsiNow === null ||
                rsiPrev === null
            ) {
                continue;
            }

            const macroBear = closes[i] < macroNow;
            const localDowntrend = fastNow < slowNow && slowNow < slowPast && closes[i] < fastNow;
            const highVolWipeout = volNow >= cfg.spikePercentile;
            const notOversold = rsiNow > cfg.oversoldGuardRsi;

            const entryRegime = macroBear && localDowntrend && highVolWipeout && notOversold;
            const deRiskRegime = volNow <= cfg.coverPercentile || !macroBear || !localDowntrend;
            const vShapeRecovery = rsiNow >= cfg.recoveryExitRsi || closes[i] > fastNow || closes[i] > macroNow;
            const panicRsiCross = rsiPrev <= cfg.panicExitRsi && rsiNow > cfg.panicExitRsi;

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
                    breakEvenArmed = false;
                    confirmStreak = 0;
                    signals.push(createSellSignal(cleanData, i, "Bear v3 wipeout short entry"));
                }
                continue;
            }

            holdBars++;
            bestPrice = Math.min(bestPrice, closes[i]);
            const profitPct = ((entryPrice - closes[i]) / entryPrice) * 100;

            if (!breakEvenArmed && profitPct >= cfg.breakEvenTriggerProfitPct) {
                breakEvenArmed = true;
                hardStopPrice = Math.min(hardStopPrice, entryPrice);
            }

            const hardStop = closes[i] >= hardStopPrice;
            const trailStop = closes[i] >= bestPrice + cfg.trailAtr * atrNow;
            const timeout = holdBars >= cfg.maxHoldBars;
            const regimeExit = holdBars >= cfg.minHoldBars && (deRiskRegime || vShapeRecovery);
            const timeDecayExit = holdBars >= cfg.timeDecayBars && profitPct <= cfg.timeDecayMinProfitPct;

            if (hardStop || trailStop || timeout || regimeExit || timeDecayExit || panicRsiCross) {
                const reason = hardStop
                    ? "Bear v3 hard stop"
                    : trailStop
                        ? "Bear v3 trailing stop"
                        : timeout
                            ? "Bear v3 max-hold exit"
                            : timeDecayExit
                                ? "Bear v3 time-decay exit"
                                : panicRsiCross
                                    ? "Bear v3 panic RSI exit"
                                    : "Bear v3 regime recovery cover";
                signals.push(createBuySignal(cleanData, i, reason));
                inShort = false;
                holdBars = 0;
                cooldown = cfg.cooldownBars;
                entryPrice = 0;
                bestPrice = Number.POSITIVE_INFINITY;
                hardStopPrice = Number.POSITIVE_INFINITY;
                breakEvenArmed = false;
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
            "panicExitRsi",
            "recoveryExitRsi",
            "spikePercentilePct",
            "coverPercentilePct",
            "confirmBars",
            "stopAtr",
            "trailAtr",
            "timeDecayBars",
            "timeDecayMinProfitPct",
            "breakEvenTriggerProfitPct",
            "maxHoldBars",
        ],
    },
};
