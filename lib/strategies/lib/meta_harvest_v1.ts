import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateADX, calculateATR, calculateDonchianChannels, calculateEMA, calculateRSI } from '../indicators';

interface Config {
    trendEmaPeriod: number;
    fastEmaPeriod: number;
    adxPeriod: number;
    adxMin: number;
    minTrendSpreadPct: number;
    atrPeriod: number;
    compressionLookback: number;
    compressionRatio: number;
    compressionArmedBars: number;
    breakoutLookback: number;
    breakoutBufferAtr: number;
    pullbackAtr: number;
    extensionAtr: number;
    rsiPeriod: number;
    rsiLongMax: number;
    rsiShortMin: number;
    stopAtr: number;
    trailAtr: number;
    targetAtr: number;
    maxHoldBars: number;
    cooldownBars: number;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

function intClamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeConfig(params: StrategyParams): Config {
    return {
        trendEmaPeriod: intClamp(params.trendEmaPeriod ?? 200, 20, 800),
        fastEmaPeriod: intClamp(params.fastEmaPeriod ?? 55, 5, 300),
        adxPeriod: intClamp(params.adxPeriod ?? 14, 5, 100),
        adxMin: clamp(params.adxMin ?? 20, 5, 60),
        minTrendSpreadPct: clamp(params.minTrendSpreadPct ?? 0.15, 0, 3),
        atrPeriod: intClamp(params.atrPeriod ?? 14, 2, 100),
        compressionLookback: intClamp(params.compressionLookback ?? 24, 5, 300),
        compressionRatio: clamp(params.compressionRatio ?? 0.5, 0.05, 1),
        compressionArmedBars: intClamp(params.compressionArmedBars ?? 8, 1, 100),
        breakoutLookback: intClamp(params.breakoutLookback ?? 20, 3, 300),
        breakoutBufferAtr: clamp(params.breakoutBufferAtr ?? 0.08, 0, 1),
        pullbackAtr: clamp(params.pullbackAtr ?? 0.8, 0.1, 4),
        extensionAtr: clamp(params.extensionAtr ?? 1.6, 0.2, 6),
        rsiPeriod: intClamp(params.rsiPeriod ?? 14, 2, 60),
        rsiLongMax: clamp(params.rsiLongMax ?? 45, 5, 80),
        rsiShortMin: clamp(params.rsiShortMin ?? 62, 20, 95),
        stopAtr: clamp(params.stopAtr ?? 1.6, 0.2, 10),
        trailAtr: clamp(params.trailAtr ?? 2.2, 0.2, 12),
        targetAtr: clamp(params.targetAtr ?? 2.4, 0.2, 15),
        maxHoldBars: intClamp(params.maxHoldBars ?? 48, 2, 500),
        cooldownBars: intClamp(params.cooldownBars ?? 4, 0, 200),
    };
}

export const meta_harvest_v1: Strategy = {
    name: 'Meta Harvest v1',
    description: 'Hybrid of fan-speed pullback, volatility compression breakout, and harvest exhaustion fades with ADX+trend regime filtering.',
    defaultParams: {
        trendEmaPeriod: 200,
        fastEmaPeriod: 55,
        adxPeriod: 14,
        adxMin: 20,
        minTrendSpreadPct: 0.15,
        atrPeriod: 14,
        compressionLookback: 24,
        compressionRatio: 0.5,
        compressionArmedBars: 8,
        breakoutLookback: 20,
        breakoutBufferAtr: 0.08,
        pullbackAtr: 0.8,
        extensionAtr: 1.6,
        rsiPeriod: 14,
        rsiLongMax: 45,
        rsiShortMin: 62,
        stopAtr: 1.6,
        trailAtr: 2.2,
        targetAtr: 2.4,
        maxHoldBars: 48,
        cooldownBars: 4,
    },
    paramLabels: {
        trendEmaPeriod: 'Trend EMA',
        fastEmaPeriod: 'Fast EMA',
        adxPeriod: 'ADX Period',
        adxMin: 'ADX Min',
        minTrendSpreadPct: 'Min Trend Spread %',
        atrPeriod: 'ATR Period',
        compressionLookback: 'Compression Lookback',
        compressionRatio: 'Compression Ratio',
        compressionArmedBars: 'Compression Armed Bars',
        breakoutLookback: 'Breakout Lookback',
        breakoutBufferAtr: 'Breakout Buffer ATR',
        pullbackAtr: 'Pullback ATR',
        extensionAtr: 'Extension ATR',
        rsiPeriod: 'RSI Period',
        rsiLongMax: 'RSI Long Max',
        rsiShortMin: 'RSI Short Min',
        stopAtr: 'Stop ATR',
        trailAtr: 'Trail ATR',
        targetAtr: 'Target ATR',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const emaTrend = calculateEMA(closes, cfg.trendEmaPeriod);
        const emaFast = calculateEMA(closes, cfg.fastEmaPeriod);
        const atr = calculateATR(highs, lows, closes, cfg.atrPeriod);
        const adx = calculateADX(highs, lows, closes, cfg.adxPeriod);
        const rsi = calculateRSI(closes, cfg.rsiPeriod);
        const donchian = calculateDonchianChannels(highs, lows, cfg.breakoutLookback);

        const minBars = Math.max(
            cfg.trendEmaPeriod,
            cfg.fastEmaPeriod,
            cfg.atrPeriod,
            cfg.adxPeriod * 2,
            cfg.breakoutLookback,
            cfg.compressionLookback
        );

        const signals: Signal[] = [];
        let side: 'flat' | 'long' | 'short' = 'flat';
        let entryPrice = 0;
        let entryAtr = 0;
        let stop = 0;
        let trailRef = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let armedUntilLong = -1;
        let armedUntilShort = -1;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;
            if (cooldown > 0) cooldown--;

            const close = closes[i];
            const prevClose = closes[i - 1];
            const atrNow = atr[i];
            const adxNow = adx[i];
            const rsiNow = rsi[i];
            const trendNow = emaTrend[i];
            const fastNow = emaFast[i];
            const fastPrev = emaFast[i - 1];
            const upperPrev = donchian.upper[i - 1];
            const lowerPrev = donchian.lower[i - 1];
            if (
                atrNow === null ||
                atrNow <= 0 ||
                adxNow === null ||
                rsiNow === null ||
                trendNow === null ||
                fastNow === null ||
                fastPrev === null ||
                upperPrev === null ||
                lowerPrev === null
            ) {
                continue;
            }

            let windowMaxAtr = 0;
            const compStart = i - cfg.compressionLookback + 1;
            for (let j = compStart; j <= i; j++) {
                const v = atr[j];
                if (v !== null && v > windowMaxAtr) windowMaxAtr = v;
            }
            if (windowMaxAtr > 0 && atrNow <= windowMaxAtr * cfg.compressionRatio) {
                armedUntilLong = Math.max(armedUntilLong, i + cfg.compressionArmedBars);
                armedUntilShort = Math.max(armedUntilShort, i + cfg.compressionArmedBars);
            }

            const trendSpreadPct = Math.abs(fastNow - trendNow) / close * 100;
            const regimeOn = adxNow >= cfg.adxMin && trendSpreadPct >= cfg.minTrendSpreadPct;
            const trendUp = close > trendNow && fastNow >= trendNow;
            const trendDown = close < trendNow && fastNow <= trendNow;

            if (side !== 'flat') {
                barsHeld += 1;

                if (side === 'long') {
                    trailRef = Math.max(trailRef, highs[i]);
                    const hardStop = entryPrice - cfg.stopAtr * entryAtr;
                    const trailStop = trailRef - cfg.trailAtr * entryAtr;
                    stop = Math.max(stop, hardStop, trailStop);

                    const hitStop = close <= stop;
                    const hitTarget = close >= entryPrice + cfg.targetAtr * entryAtr;
                    const lostRegime = !regimeOn || !trendUp || adxNow < cfg.adxMin * 0.75;
                    const timedOut = barsHeld >= cfg.maxHoldBars;

                    if (hitStop || hitTarget || lostRegime || timedOut) {
                        signals.push(createSellSignal(cleanData, i, 'Meta v1 long exit'));
                        side = 'flat';
                        cooldown = cfg.cooldownBars;
                        continue;
                    }
                } else {
                    trailRef = Math.min(trailRef, lows[i]);
                    const hardStop = entryPrice + cfg.stopAtr * entryAtr;
                    const trailStop = trailRef + cfg.trailAtr * entryAtr;
                    stop = Math.min(stop, hardStop, trailStop);

                    const hitStop = close >= stop;
                    const hitTarget = close <= entryPrice - cfg.targetAtr * entryAtr;
                    const lostRegime = !regimeOn || !trendDown || adxNow < cfg.adxMin * 0.75;
                    const timedOut = barsHeld >= cfg.maxHoldBars;

                    if (hitStop || hitTarget || lostRegime || timedOut) {
                        signals.push(createBuySignal(cleanData, i, 'Meta v1 short exit'));
                        side = 'flat';
                        cooldown = cfg.cooldownBars;
                        continue;
                    }
                }
            }

            if (side !== 'flat' || cooldown > 0 || !regimeOn) continue;

            const breakoutBuffer = atrNow * cfg.breakoutBufferAtr;
            const compressionLongArmed = i <= armedUntilLong;
            const compressionShortArmed = i <= armedUntilShort;

            const breakoutLong =
                compressionLongArmed &&
                prevClose <= upperPrev + breakoutBuffer &&
                close > upperPrev + breakoutBuffer;
            const breakoutShort =
                compressionShortArmed &&
                prevClose >= lowerPrev - breakoutBuffer &&
                close < lowerPrev - breakoutBuffer;

            const pullbackLong =
                trendUp &&
                rsiNow <= cfg.rsiLongMax &&
                lows[i] <= fastNow - cfg.pullbackAtr * atrNow &&
                prevClose <= fastPrev &&
                close > fastNow;

            const exhaustionShort =
                trendDown &&
                rsiNow >= cfg.rsiShortMin &&
                highs[i] >= fastNow + cfg.extensionAtr * atrNow &&
                close < prevClose;

            if (trendUp && (breakoutLong || pullbackLong)) {
                signals.push(createBuySignal(cleanData, i, breakoutLong ? 'Meta v1 compression breakout long' : 'Meta v1 fan pullback long'));
                side = 'long';
                entryPrice = close;
                entryAtr = atrNow;
                stop = entryPrice - cfg.stopAtr * entryAtr;
                trailRef = highs[i];
                barsHeld = 0;
                continue;
            }

            if (trendDown && (breakoutShort || exhaustionShort)) {
                signals.push(createSellSignal(cleanData, i, breakoutShort ? 'Meta v1 compression breakout short' : 'Meta v1 harvest fade short'));
                side = 'short';
                entryPrice = close;
                entryAtr = atrNow;
                stop = entryPrice + cfg.stopAtr * entryAtr;
                trailRef = lows[i];
                barsHeld = 0;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'trendEmaPeriod',
            'fastEmaPeriod',
            'adxPeriod',
            'adxMin',
            'atrPeriod',
            'compressionLookback',
            'compressionRatio',
            'breakoutLookback',
            'breakoutBufferAtr',
            'pullbackAtr',
            'extensionAtr',
            'rsiPeriod',
            'rsiLongMax',
            'rsiShortMin',
            'stopAtr',
            'trailAtr',
            'targetAtr',
            'maxHoldBars',
        ],
    },
};
