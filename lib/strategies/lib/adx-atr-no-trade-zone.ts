import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';
import { COLORS } from '../constants';

interface Config {
    diLength: number;
    adxSmoothingLength: number;
    adxThreshold: number;
    atrLength: number;
    adxRecoveryBars: number;
    adxBuffer: number;
    minAdxRise: number;
    minDiSpread: number;
    atrExpansionBars: number;
    trendEmaLength: number;
    entryConfirmBars: number;
    cooldownBars: number;
    stopAtr: number;
    targetAtr: number;
    trailAtr: number;
    maxHoldBars: number;
    recoveryLookback: number;
    bgOpacity: number;
}

interface DMIResult {
    plusDI: (number | null)[];
    minusDI: (number | null)[];
    adx: (number | null)[];
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeConfig(params: StrategyParams): Config {
    const adxThreshold = clamp(params.adxThreshold ?? 20, 1, 80);
    return {
        diLength: Math.max(2, Math.min(200, Math.round(params.diLength ?? 14))),
        adxSmoothingLength: Math.max(2, Math.min(200, Math.round(params.adxSmoothingLength ?? 14))),
        adxThreshold,
        atrLength: Math.max(2, Math.min(200, Math.round(params.atrLength ?? 14))),
        adxRecoveryBars: Math.max(1, Math.min(8, Math.round(params.adxRecoveryBars ?? 2))),
        adxBuffer: clamp(params.adxBuffer ?? 3, 0, 30),
        minAdxRise: clamp(params.minAdxRise ?? 0.15, 0, 5),
        minDiSpread: clamp(params.minDiSpread ?? 4, 0, 40),
        atrExpansionBars: Math.max(1, Math.min(8, Math.round(params.atrExpansionBars ?? 2))),
        trendEmaLength: Math.max(5, Math.min(400, Math.round(params.trendEmaLength ?? 55))),
        entryConfirmBars: Math.max(1, Math.min(6, Math.round(params.entryConfirmBars ?? 2))),
        cooldownBars: Math.max(0, Math.min(100, Math.round(params.cooldownBars ?? 4))),
        stopAtr: clamp(params.stopAtr ?? 1.5, 0.2, 8),
        targetAtr: clamp(params.targetAtr ?? 2.2, 0.3, 15),
        trailAtr: clamp(params.trailAtr ?? 1.1, 0.2, 8),
        maxHoldBars: Math.max(2, Math.min(500, Math.round(params.maxHoldBars ?? 30))),
        recoveryLookback: Math.max(1, Math.min(50, Math.round(params.recoveryLookback ?? 6))),
        bgOpacity: clamp(params.bgOpacity ?? 85, 0, 100),
    };
}

function calculateRMA(values: number[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    if (period < 1 || values.length === 0) return result;

    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (i < period) {
            sum += value;
            if (i === period - 1) {
                result[i] = sum / period;
            }
            continue;
        }

        const prev = result[i - 1];
        if (prev === null) continue;
        result[i] = ((prev * (period - 1)) + value) / period;
    }

    return result;
}

function calculateRMAFromNullable(values: (number | null)[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    if (period < 1 || values.length === 0) return result;

    let seedSum = 0;
    let seedCount = 0;
    let smoothed: number | null = null;

    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === null) continue;

        if (smoothed === null) {
            seedSum += value;
            seedCount++;
            if (seedCount >= period) {
                smoothed = seedSum / period;
                result[i] = smoothed;
            }
            continue;
        }

        smoothed = ((smoothed * (period - 1)) + value) / period;
        result[i] = smoothed;
    }

    return result;
}

function calculateDMIWithSmoothing(
    high: number[],
    low: number[],
    close: number[],
    diLength: number,
    adxSmoothingLength: number
): DMIResult {
    const length = close.length;
    const tr: number[] = new Array(length).fill(0);
    const plusDM: number[] = new Array(length).fill(0);
    const minusDM: number[] = new Array(length).fill(0);

    for (let i = 1; i < length; i++) {
        const upMove = high[i] - high[i - 1];
        const downMove = low[i - 1] - low[i];

        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
        tr[i] = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );
    }

    const trRma = calculateRMA(tr, diLength);
    const plusRma = calculateRMA(plusDM, diLength);
    const minusRma = calculateRMA(minusDM, diLength);

    const plusDI: (number | null)[] = new Array(length).fill(null);
    const minusDI: (number | null)[] = new Array(length).fill(null);
    const dx: (number | null)[] = new Array(length).fill(null);

    for (let i = 0; i < length; i++) {
        const trSmooth = trRma[i];
        const plusSmooth = plusRma[i];
        const minusSmooth = minusRma[i];

        if (trSmooth === null || plusSmooth === null || minusSmooth === null || trSmooth <= 0) {
            continue;
        }

        const plus = 100 * (plusSmooth / trSmooth);
        const minus = 100 * (minusSmooth / trSmooth);
        plusDI[i] = plus;
        minusDI[i] = minus;

        const diSum = plus + minus;
        dx[i] = diSum <= 0 ? 0 : (100 * Math.abs(plus - minus)) / diSum;
    }

    const adx = calculateRMAFromNullable(dx, adxSmoothingLength);
    return { plusDI, minusDI, adx };
}

function buildNoTradeZone(
    adx: (number | null)[],
    atr: (number | null)[],
    adxThreshold: number
): boolean[] {
    const noTradeZone: boolean[] = new Array(adx.length).fill(false);

    for (let i = 1; i < adx.length; i++) {
        const adxNow = adx[i];
        const adxPrev = adx[i - 1];
        const atrNow = atr[i];
        const atrPrev = atr[i - 1];

        if (adxNow === null || adxPrev === null || atrNow === null || atrPrev === null) continue;

        const adxSlope = adxNow - adxPrev;
        const atrFlatOrDown = atrNow <= atrPrev;
        noTradeZone[i] = adxNow < adxThreshold && adxSlope < 0 && atrFlatOrDown;
    }

    return noTradeZone;
}

function hasRecentNoTrade(noTradeZone: boolean[], index: number, lookback: number): boolean {
    const start = Math.max(0, index - lookback);
    for (let i = start; i < index; i++) {
        if (noTradeZone[i]) return true;
    }
    return false;
}

function hasRisingSeries(values: (number | null)[], index: number, bars: number): boolean {
    for (let b = 0; b < bars; b++) {
        const i = index - b;
        if (i <= 0) return false;
        const current = values[i];
        const previous = values[i - 1];
        if (current === null || previous === null || current <= previous) return false;
    }
    return true;
}

function hasAdxRecovery(adx: (number | null)[], index: number, cfg: Config): boolean {
    for (let b = 0; b < cfg.adxRecoveryBars; b++) {
        const i = index - b;
        if (i <= 0) return false;
        const current = adx[i];
        const previous = adx[i - 1];
        if (current === null || previous === null) return false;
        if (current < cfg.adxThreshold + cfg.adxBuffer) return false;
        if (current - previous < cfg.minAdxRise) return false;
    }
    return true;
}

export const adx_atr_no_trade_zone: Strategy = {
    name: 'ADX + ATR No-Trade Zone (DMI Smoothing)',
    description: 'Conservative trend-recovery system: waits for ADX recovery + ATR re-expansion + DI spread and exits aggressively on regime deterioration.',
    defaultParams: {
        diLength: 14,
        adxSmoothingLength: 14,
        adxThreshold: 20,
        atrLength: 14,
        adxRecoveryBars: 2,
        adxBuffer: 3,
        minAdxRise: 0.15,
        minDiSpread: 4,
        atrExpansionBars: 2,
        trendEmaLength: 55,
        entryConfirmBars: 2,
        cooldownBars: 4,
        stopAtr: 1.5,
        targetAtr: 2.2,
        trailAtr: 1.1,
        maxHoldBars: 30,
        recoveryLookback: 6,
        bgOpacity: 85,
    },
    paramLabels: {
        diLength: 'DI Length',
        adxSmoothingLength: 'ADX Smoothing Length',
        adxThreshold: 'ADX Threshold',
        atrLength: 'ATR Length',
        adxRecoveryBars: 'ADX Recovery Bars',
        adxBuffer: 'ADX Buffer',
        minAdxRise: 'Min ADX Rise / Bar',
        minDiSpread: 'Min DI Spread',
        atrExpansionBars: 'ATR Expansion Bars',
        trendEmaLength: 'Trend EMA Length',
        entryConfirmBars: 'Entry Confirm Bars',
        cooldownBars: 'Cooldown Bars',
        stopAtr: 'Stop ATR',
        targetAtr: 'Target ATR',
        trailAtr: 'Trail ATR',
        maxHoldBars: 'Max Hold Bars',
        recoveryLookback: 'No-Trade Recovery Lookback',
        bgOpacity: 'Grey Zone Opacity',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const dmi = calculateDMIWithSmoothing(highs, lows, closes, cfg.diLength, cfg.adxSmoothingLength);
        const atr = calculateATR(highs, lows, closes, cfg.atrLength);
        const trend = calculateEMA(closes, cfg.trendEmaLength);
        const noTradeZone = buildNoTradeZone(dmi.adx, atr, cfg.adxThreshold);

        const minBars = Math.max(
            cfg.diLength + cfg.adxSmoothingLength + cfg.adxRecoveryBars + 2,
            cfg.atrLength + cfg.atrExpansionBars + 2,
            cfg.trendEmaLength + 2,
            cfg.recoveryLookback + 2,
            20
        );
        const signals: Signal[] = [];
        let inPosition = false;
        let entryStreak = 0;
        let cooldown = 0;
        let entryPrice = 0;
        let entryAtr = 0;
        let barsHeld = 0;
        let highestSinceEntry = 0;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;

            const plus = dmi.plusDI[i];
            const minus = dmi.minusDI[i];
            const plusPrev = dmi.plusDI[i - 1];
            const minusPrev = dmi.minusDI[i - 1];
            const adxNow = dmi.adx[i];
            const adxPrev = dmi.adx[i - 1];
            const atrNow = atr[i];
            const trendNow = trend[i];
            const trendPrev = trend[i - 1];

            if (
                plus === null ||
                minus === null ||
                plusPrev === null ||
                minusPrev === null ||
                adxNow === null ||
                adxPrev === null ||
                atrNow === null ||
                atrNow <= 0 ||
                trendNow === null ||
                trendPrev === null
            ) {
                continue;
            }

            const zoneNow = noTradeZone[i];
            const zonePrev = noTradeZone[i - 1];
            const adxSlope = adxNow - adxPrev;
            const diSpread = plus - minus;
            const bullishDMI = plus > minus;
            const bearishDMI = minus > plus;
            const bearishCross = minusPrev <= plusPrev && minus > plus;
            const trendUp = closes[i] > trendNow && trendNow >= trendPrev;
            const recentNoTrade = hasRecentNoTrade(noTradeZone, i, cfg.recoveryLookback);
            const atrExpanding = hasRisingSeries(atr, i, cfg.atrExpansionBars);
            const adxRecovered = hasAdxRecovery(dmi.adx, i, cfg);

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                const entryReady =
                    !zoneNow &&
                    recentNoTrade &&
                    adxRecovered &&
                    atrExpanding &&
                    trendUp &&
                    bullishDMI &&
                    diSpread >= cfg.minDiSpread;

                entryStreak = entryReady ? entryStreak + 1 : 0;
                if (entryStreak >= cfg.entryConfirmBars) {
                    signals.push(createBuySignal(cleanData, i, 'ADX/ATR recovery long'));
                    inPosition = true;
                    entryPrice = closes[i];
                    entryAtr = atrNow;
                    barsHeld = 0;
                    highestSinceEntry = closes[i];
                    entryStreak = 0;
                }
                continue;
            }

            barsHeld++;
            if (closes[i] > highestSinceEntry) highestSinceEntry = closes[i];
            const trailStop = highestSinceEntry - cfg.trailAtr * entryAtr;
            const enteringNoTrade = !zonePrev && zoneNow;
            const hardStop = closes[i] <= entryPrice - cfg.stopAtr * entryAtr;
            const profitTarget = closes[i] >= entryPrice + cfg.targetAtr * entryAtr;
            const trailHit = barsHeld > 1 && closes[i] <= trailStop;
            const trendFail = closes[i] < trendNow;
            const momentumFail = (bearishDMI && diSpread <= -cfg.minDiSpread * 0.4) || (adxSlope < -cfg.minAdxRise);
            const timeExit = barsHeld >= cfg.maxHoldBars;

            if (hardStop || profitTarget || trailHit || enteringNoTrade || bearishCross || trendFail || momentumFail || timeExit) {
                const reason = hardStop
                    ? 'ADX/ATR stop'
                    : profitTarget
                        ? 'ADX/ATR target'
                        : trailHit
                            ? 'ADX/ATR trailing stop'
                            : enteringNoTrade
                                ? 'ADX/ATR no-trade re-entry exit'
                                : bearishCross
                                    ? 'ADX/ATR DMI bearish cross exit'
                                    : trendFail
                                        ? 'ADX/ATR trend fail exit'
                                        : momentumFail
                                            ? 'ADX/ATR momentum fade exit'
                                            : 'ADX/ATR time exit';
                signals.push(createSellSignal(cleanData, i, reason));
                inPosition = false;
                entryPrice = 0;
                entryAtr = 0;
                barsHeld = 0;
                highestSinceEntry = 0;
                cooldown = cfg.cooldownBars;
            }
        }

        if (inPosition && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'ADX/ATR no-trade zone final close'));
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const dmi = calculateDMIWithSmoothing(highs, lows, closes, cfg.diLength, cfg.adxSmoothingLength);
        const atr = calculateATR(highs, lows, closes, cfg.atrLength);
        const trend = calculateEMA(closes, cfg.trendEmaLength);
        const noTradeZone = buildNoTradeZone(dmi.adx, atr, cfg.adxThreshold);
        const zoneAlpha = Math.max(0.05, (100 - cfg.bgOpacity) / 100);

        return [
            { name: '+DI', type: 'line', values: dmi.plusDI, color: COLORS.Positive },
            { name: '-DI', type: 'line', values: dmi.minusDI, color: COLORS.Histogram },
            { name: 'ADX', type: 'line', values: dmi.adx, color: COLORS.Fast },
            { name: 'ADX Threshold', type: 'line', values: cleanData.map(() => cfg.adxThreshold), color: COLORS.Slow },
            { name: 'ATR', type: 'line', values: atr, color: COLORS.Neutral },
            { name: 'Trend EMA', type: 'line', values: trend, color: COLORS.Channel },
            { name: 'No-Trade Zone', type: 'histogram', values: noTradeZone.map(v => (v ? 1 : 0)), color: `rgba(156,163,175,${zoneAlpha})` },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'diLength',
            'adxSmoothingLength',
            'adxThreshold',
            'adxRecoveryBars',
            'minDiSpread',
            'atrExpansionBars',
            'trendEmaLength',
            'stopAtr',
            'targetAtr',
            'trailAtr',
            'maxHoldBars',
        ],
    },
};
