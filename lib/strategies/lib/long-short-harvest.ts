import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';

interface HarvestConfig {
    fastPeriod: number;
    slowPeriod: number;
    atrPeriod: number;
    rsiPeriod: number;
    smaLen: number;
    momentumBars: number;
    volWindow: number;
    volLookback: number;
    panicVolPercentile: number;
    calmVolPercentile: number;
    pullbackAtr: number;
    extK: number;
    momK: number;
    scoreThreshold: number;
    rsiLongMax: number;
    rsiShortMin: number;
    stopAtrLong: number;
    stopAtrShort: number;
    trailAtrLong: number;
    trailAtrShort: number;
    targetAtrLong: number;
    targetAtrShort: number;
    minTrendStrength: number;
    entryCooldownBars: number;
    setupExpiryBars: number;
    maxHoldBars: number;
}

interface HarvestSeries {
    closes: number[];
    highs: number[];
    lows: number[];
    emaFast: (number | null)[];
    emaSlow: (number | null)[];
    sma: (number | null)[];
    atr: (number | null)[];
    rsi: (number | null)[];
    volPercentile: (number | null)[];
    shortScore: (number | null)[];
}

const HURST_WINDOWS = [10, 20, 40, 60, 90, 100];

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeConfig(params: StrategyParams): HarvestConfig {
    const fastPeriod = Math.max(3, Math.round(params.fastPeriod ?? 50));
    const slowPeriod = Math.max(fastPeriod + 5, Math.round(params.slowPeriod ?? 200));
    const atrPeriod = Math.max(2, Math.round(params.atrPeriod ?? 20));
    const rsiPeriod = Math.max(2, Math.round(params.rsiPeriod ?? 14));
    const smaLen = Math.max(20, Math.round(params.smaLen ?? Math.max(60, Math.round(slowPeriod * 0.95))));
    const momentumBars = Math.max(2, Math.round(params.momentumBars ?? 5));
    const volWindow = Math.max(5, Math.round(params.volWindow ?? 20));
    const volLookback = Math.max(30, Math.round(params.volLookback ?? 252));

    const rawPanicVol = clamp(params.panicVolPercentile ?? 0.85, 0.05, 0.99);
    const rawCalmVol = clamp(params.calmVolPercentile ?? 0.35, 0.01, 0.95);
    const calmVolPercentile = Math.min(rawCalmVol, rawPanicVol - 0.05);
    const panicVolPercentile = Math.max(rawPanicVol, calmVolPercentile + 0.05);

    const rsiLongMax = clamp(params.rsiLongMax ?? 45, 5, 70);
    const rsiShortMin = clamp(Math.max(params.rsiShortMin ?? 62, rsiLongMax + 6), 30, 95);

    const baseRiskAtr = Math.max(0.4, params.riskAtr ?? params.stopAtrLong ?? params.stopAtrShort ?? 1.8);
    const targetRR = Math.max(1.0, params.targetRR ?? 1.55);
    const stopAtrLong = Math.max(0.2, params.stopAtrLong ?? baseRiskAtr);
    const stopAtrShort = Math.max(0.2, params.stopAtrShort ?? baseRiskAtr);
    const trailAtrLong = Math.max(stopAtrLong, params.trailAtrLong ?? 2.2);
    const trailAtrShort = Math.max(stopAtrShort, params.trailAtrShort ?? 2.2);
    const targetAtrLong = Math.max(stopAtrLong * 1.15, params.targetAtrLong ?? (stopAtrLong * targetRR));
    const targetAtrShort = Math.max(stopAtrShort * 1.15, params.targetAtrShort ?? (stopAtrShort * Math.max(1.2, targetRR - 0.1)));

    return {
        fastPeriod,
        slowPeriod,
        atrPeriod,
        rsiPeriod,
        smaLen,
        momentumBars,
        volWindow,
        volLookback,
        panicVolPercentile,
        calmVolPercentile,
        pullbackAtr: Math.max(0.1, params.pullbackAtr ?? 1.15),
        extK: clamp(params.extK ?? 2.0, 0.1, 4.5),
        momK: clamp(params.momK ?? Math.max(0.8, (params.extK ?? 2.0) * 0.9), 0.1, 4.5),
        scoreThreshold: Math.max(0.2, params.scoreThreshold ?? 0.85),
        rsiLongMax,
        rsiShortMin,
        stopAtrLong,
        stopAtrShort,
        trailAtrLong,
        trailAtrShort,
        targetAtrLong,
        targetAtrShort,
        minTrendStrength: Math.max(0, params.minTrendStrength ?? 0.45),
        entryCooldownBars: Math.max(0, Math.round(params.entryCooldownBars ?? 5)),
        setupExpiryBars: Math.max(1, Math.round(params.setupExpiryBars ?? 6)),
        maxHoldBars: Math.max(5, Math.round(params.maxHoldBars ?? 50))
    };
}

function calculateRollingStd(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return out;

    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        sum += v;
        sumSq += v * v;

        if (i >= period) {
            const old = values[i - period];
            sum -= old;
            sumSq -= old * old;
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
            const val = values[j];
            if (val === null) continue;
            valid++;
            if (val <= current) belowOrEqual++;
        }

        if (valid > 0) out[i] = belowOrEqual / valid;
    }

    return out;
}

function hurstLikeAtIndex(highs: number[], lows: number[], closes: number[], index: number, n: number): number | null {
    if (index < n || n <= 1) return null;

    let trSum = 0;
    let highMax = -Infinity;
    let lowMin = Infinity;
    const start = index - n + 1;

    for (let i = start; i <= index; i++) {
        const prevClose = i > 0 ? closes[i - 1] : closes[i];
        const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - prevClose),
            Math.abs(lows[i] - prevClose)
        );
        trSum += tr;
        if (highs[i] > highMax) highMax = highs[i];
        if (lows[i] < lowMin) lowMin = lows[i];
    }

    const atr = trSum / n;
    const span = highMax - lowMin;
    if (atr <= 0 || span <= 0) return null;

    const bump = 0.01 + 0.0002 * n;
    let h = (Math.log(span) - Math.log(atr)) / Math.log(n);
    if (!Number.isFinite(h)) return null;

    if (h > 0.45) h += bump;
    else h -= bump;

    return h;
}

function calculateShortScoreSeries(highs: number[], lows: number[], closes: number[]): (number | null)[] {
    const scores: (number | null)[] = new Array(closes.length).fill(null);

    for (let i = 0; i < closes.length; i++) {
        const hvals: number[] = [];
        let agreement = 0;

        for (const n of HURST_WINDOWS) {
            const hv = hurstLikeAtIndex(highs, lows, closes, i, n);
            if (hv === null) continue;
            hvals.push(hv);
            if (hv > 0.6) agreement++;
        }

        if (hvals.length < 4) continue;

        const avg = hvals.reduce((acc, v) => acc + v, 0) / hvals.length;
        scores[i] = avg + 0.02 * Math.max(0, agreement - 3);
    }

    return scores;
}

function buildSeries(cleanData: OHLCVData[], config: HarvestConfig): HarvestSeries {
    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);

    const emaFast = calculateEMA(closes, config.fastPeriod);
    const emaSlow = calculateEMA(closes, config.slowPeriod);
    const sma = calculateSMA(closes, config.smaLen);
    const atr = calculateATR(highs, lows, closes, config.atrPeriod);
    const rsi = calculateRSI(closes, config.rsiPeriod);

    const returns = closes.map((close, i) => {
        if (i === 0) return 0;
        const prev = closes[i - 1];
        if (close <= 0 || prev <= 0) return 0;
        return Math.log(close / prev);
    });

    const realizedVol = calculateRollingStd(returns, config.volWindow);
    const volPercentile = calculatePercentileRank(realizedVol, config.volLookback);
    const shortScore = calculateShortScoreSeries(highs, lows, closes);

    return {
        closes,
        highs,
        lows,
        emaFast,
        emaSlow,
        sma,
        atr,
        rsi,
        volPercentile,
        shortScore
    };
}

export const long_short_harvest: Strategy = {
    name: 'Long/Short Harvest',
    description: 'Regime-aware long pullback entries with exhaustion-based short fades and ATR risk controls.',
    defaultParams: {
        fastPeriod: 50,
        slowPeriod: 200,
        atrPeriod: 20,
        pullbackAtr: 1.15,
        extK: 2.0,
        scoreThreshold: 0.85,
        riskAtr: 1.8,
        targetRR: 1.55,
        maxHoldBars: 50
    },
    paramLabels: {
        fastPeriod: 'Fast EMA',
        slowPeriod: 'Slow EMA',
        atrPeriod: 'ATR Period',
        pullbackAtr: 'Long Pullback (ATR)',
        extK: 'Short Extension (ATR)',
        scoreThreshold: 'Short Score Threshold',
        riskAtr: 'Base Risk (ATR)',
        targetRR: 'Target RR',
        maxHoldBars: 'Max Hold Bars'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const config = normalizeConfig(params);
        const minBars = Math.max(
            config.slowPeriod,
            config.smaLen,
            config.volWindow + config.volLookback,
            HURST_WINDOWS[HURST_WINDOWS.length - 1] + 2
        );
        if (cleanData.length < minBars) return [];

        const series = buildSeries(cleanData, config);
        const signals: Signal[] = [];

        let side: 'flat' | 'long' | 'short' = 'flat';
        let entryPrice = 0;
        let entryAtr = 0;
        let stop = 0;
        let trailRef = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let longSetupBar: number | null = null;
        let shortSetupBar: number | null = null;

        for (let i = 1; i < cleanData.length; i++) {
            if (cooldown > 0) cooldown--;

            const atr = series.atr[i];
            const emaFast = series.emaFast[i];
            const emaSlow = series.emaSlow[i];
            const rsi = series.rsi[i];
            const volRank = series.volPercentile[i];
            const score = series.shortScore[i];
            const sma = series.sma[i];
            const prevRsi = series.rsi[i - 1];

            if (atr === null || atr <= 0 || emaFast === null || emaSlow === null || rsi === null || volRank === null || sma === null) {
                continue;
            }

            const close = series.closes[i];
            const prevClose = series.closes[i - 1];
            const trendUp = emaFast > emaSlow;
            const trendDown = emaFast < emaSlow;
            const trendStrength = Math.abs(emaFast - emaSlow) / atr;
            const strongTrend = trendStrength >= config.minTrendStrength;
            const extensionAtr = (close - sma) / atr;
            const momentumAtr = i >= config.momentumBars ? (close - series.closes[i - config.momentumBars]) / atr : 0;
            const bullishConfirm = close > prevClose && close > emaFast && (prevRsi === null || rsi > prevRsi);
            const bearishConfirm = close < prevClose && close < emaFast && (prevRsi === null || rsi < prevRsi);

            const panicLong = trendUp
                && strongTrend
                && volRank >= config.panicVolPercentile
                && close < emaFast - config.pullbackAtr * atr
                && rsi <= config.rsiLongMax;

            const riskOnLong = trendUp
                && strongTrend
                && volRank <= config.calmVolPercentile
                && prevClose <= emaFast
                && close > emaFast
                && rsi >= 50;

            const shortReady = (trendUp || close > emaSlow)
                && strongTrend
                && score !== null
                && score >= config.scoreThreshold
                && extensionAtr >= config.extK
                && momentumAtr >= config.momK
                && rsi >= config.rsiShortMin;

            if (panicLong) {
                longSetupBar = i;
            } else if (longSetupBar !== null && i - longSetupBar > config.setupExpiryBars) {
                longSetupBar = null;
            }

            if (shortReady) {
                shortSetupBar = i;
            } else if (shortSetupBar !== null && i - shortSetupBar > config.setupExpiryBars) {
                shortSetupBar = null;
            }

            if (side === 'flat') {
                if (cooldown > 0) continue;

                const canShort = shortSetupBar !== null && bearishConfirm && !panicLong;
                const canLong = (longSetupBar !== null && bullishConfirm) || (riskOnLong && bullishConfirm);

                if (canShort) {
                    side = 'short';
                    entryPrice = close;
                    entryAtr = atr;
                    stop = entryPrice + config.stopAtrShort * entryAtr;
                    trailRef = close;
                    barsHeld = 0;
                    shortSetupBar = null;
                    longSetupBar = null;
                    signals.push(createSellSignal(cleanData, i, 'Harvest short entry'));
                    continue;
                }

                if (canLong) {
                    side = 'long';
                    entryPrice = close;
                    entryAtr = atr;
                    stop = entryPrice - config.stopAtrLong * entryAtr;
                    trailRef = close;
                    barsHeld = 0;
                    shortSetupBar = null;
                    longSetupBar = null;
                    signals.push(createBuySignal(cleanData, i, panicLong ? 'Harvest panic long entry' : 'Harvest trend long entry'));
                }
                continue;
            }

            barsHeld++;

            if (side === 'long') {
                trailRef = Math.max(trailRef, close);
                stop = Math.max(stop, trailRef - config.trailAtrLong * atr);

                const target = entryPrice + config.targetAtrLong * entryAtr;
                const stopHit = close <= stop;
                const targetHit = close >= target;
                const trendFail = trendDown && close < emaFast && rsi < 50;
                const timeStop = barsHeld >= config.maxHoldBars;

                if (stopHit || targetHit || trendFail || timeStop) {
                    signals.push(createSellSignal(cleanData, i, stopHit ? 'Harvest long stop' : targetHit ? 'Harvest long target' : trendFail ? 'Harvest long trend exit' : 'Harvest long time exit'));
                    side = 'flat';
                    cooldown = config.entryCooldownBars;
                    longSetupBar = null;
                    shortSetupBar = null;
                }
            } else {
                trailRef = Math.min(trailRef, close);
                stop = Math.min(stop, trailRef + config.trailAtrShort * atr);

                const target = entryPrice - config.targetAtrShort * entryAtr;
                const stopHit = close >= stop;
                const targetHit = close <= target;
                const trendFail = trendUp && close > emaFast && rsi > 50;
                const timeStop = barsHeld >= config.maxHoldBars;

                if (stopHit || targetHit || trendFail || timeStop) {
                    signals.push(createBuySignal(cleanData, i, stopHit ? 'Harvest short stop' : targetHit ? 'Harvest short target' : trendFail ? 'Harvest short trend exit' : 'Harvest short time exit'));
                    side = 'flat';
                    cooldown = config.entryCooldownBars;
                    longSetupBar = null;
                    shortSetupBar = null;
                }
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'fastPeriod',
            'slowPeriod',
            'atrPeriod',
            'extK',
            'scoreThreshold',
            'pullbackAtr',
            'riskAtr',
            'targetRR',
            'maxHoldBars'
        ]
    }
};


