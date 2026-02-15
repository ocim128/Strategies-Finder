import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels } from '../indicators';

interface Config {
    lookback: number;
    compressionRatio: number;
    breakoutBufferAtr: number;
    shortAtrPeriod: number;
    longAtrPeriod: number;
    initialStopAtr: number;
    bankAtAtr: number;
    bankFractionPct: number;
    runnerTrailAtr: number;
    maxHoldBars: number;
    cooldownBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalize(params: StrategyParams): Config {
    return {
        lookback: Math.max(5, Math.min(200, Math.round(params.lookback ?? 20))),
        compressionRatio: clamp(params.compressionRatio ?? 0.7, 0.1, 1.2),
        breakoutBufferAtr: clamp(params.breakoutBufferAtr ?? 0.08, 0, 1),
        shortAtrPeriod: Math.max(2, Math.min(80, Math.round(params.shortAtrPeriod ?? 7))),
        longAtrPeriod: Math.max(4, Math.min(200, Math.round(params.longAtrPeriod ?? 28))),
        initialStopAtr: clamp(params.initialStopAtr ?? 1.5, 0.2, 10),
        bankAtAtr: clamp(params.bankAtAtr ?? 1.5, 0.2, 6),
        bankFractionPct: clamp(params.bankFractionPct ?? 50, 5, 95),
        runnerTrailAtr: clamp(params.runnerTrailAtr ?? 3, 0.2, 12),
        maxHoldBars: Math.max(5, Math.min(600, Math.round(params.maxHoldBars ?? 120))),
        cooldownBars: Math.max(0, Math.min(200, Math.round(params.cooldownBars ?? 4))),
    };
}

export const volatility_compression_break_v2: Strategy = {
    name: 'Volatility Compression Break v2',
    description: 'Compression breakout in banker mode: bank 50% at +1.5 ATR, move stop to breakeven, and trail runner by 3 ATR.',
    defaultParams: {
        lookback: 20,
        compressionRatio: 0.7,
        breakoutBufferAtr: 0.08,
        shortAtrPeriod: 7,
        longAtrPeriod: 28,
        initialStopAtr: 1.5,
        bankAtAtr: 1.5,
        bankFractionPct: 50,
        runnerTrailAtr: 3,
        maxHoldBars: 120,
        cooldownBars: 4,
    },
    paramLabels: {
        lookback: 'Range Lookback',
        compressionRatio: 'ATR Compression Ratio',
        breakoutBufferAtr: 'Breakout Buffer (ATR)',
        shortAtrPeriod: 'Short ATR Period',
        longAtrPeriod: 'Long ATR Period',
        initialStopAtr: 'Initial Stop (ATR)',
        bankAtAtr: 'Bank Trigger (ATR)',
        bankFractionPct: 'Bank Fraction (%)',
        runnerTrailAtr: 'Runner Trail (ATR)',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalize(params);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atrShort = calculateATR(highs, lows, closes, cfg.shortAtrPeriod);
        const atrLong = calculateATR(highs, lows, closes, cfg.longAtrPeriod);
        const { upper, lower } = calculateDonchianChannels(highs, lows, cfg.lookback);

        const signals: Signal[] = [];
        let side: 'flat' | 'long' | 'short' = 'flat';
        let entryPrice = 0;
        let stopPrice = 0;
        let trailRef = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let bankedHalf = false;

        for (let i = 1; i < cleanData.length; i++) {
            if (cooldown > 0) cooldown--;

            const atrS = atrShort[i];
            const atrL = atrLong[i];
            const prevUpper = upper[i - 1];
            const prevLower = lower[i - 1];
            if (atrS === null || atrL === null || prevUpper === null || prevLower === null || atrS <= 0 || atrL <= 0) {
                continue;
            }

            const bar = cleanData[i];
            const prevClose = closes[i - 1];
            const close = closes[i];
            const compressed = atrS <= atrL * cfg.compressionRatio;
            const buffer = atrS * cfg.breakoutBufferAtr;
            const upBreak = compressed && prevClose <= prevUpper + buffer && close > prevUpper + buffer;
            const downBreak = compressed && prevClose >= prevLower - buffer && close < prevLower - buffer;

            if (side === 'flat') {
                if (cooldown > 0) continue;

                if (upBreak) {
                    signals.push(createBuySignal(cleanData, i, 'VCB v2 compression break up'));
                    side = 'long';
                    entryPrice = close;
                    trailRef = bar.high;
                    stopPrice = entryPrice - cfg.initialStopAtr * atrS;
                    barsHeld = 0;
                    bankedHalf = false;
                    continue;
                }

                if (downBreak) {
                    signals.push(createSellSignal(cleanData, i, 'VCB v2 compression break down'));
                    side = 'short';
                    entryPrice = close;
                    trailRef = bar.low;
                    stopPrice = entryPrice + cfg.initialStopAtr * atrS;
                    barsHeld = 0;
                    bankedHalf = false;
                }
                continue;
            }

            barsHeld += 1;

            if (side === 'long') {
                const profitAtr = (close - entryPrice) / atrS;
                if (!bankedHalf && profitAtr >= cfg.bankAtAtr) {
                    signals.push(createSellSignal(cleanData, i, 'VCB v2 banker partial long', cfg.bankFractionPct / 100));
                    bankedHalf = true;
                    stopPrice = Math.max(stopPrice, entryPrice);
                    trailRef = bar.high;
                    continue;
                }

                if (bankedHalf) {
                    trailRef = Math.max(trailRef, bar.high);
                    stopPrice = Math.max(stopPrice, trailRef - cfg.runnerTrailAtr * atrS);
                }

                const stopHit = close <= stopPrice;
                const timeout = barsHeld >= cfg.maxHoldBars;
                const oppositeBreak = downBreak;
                if (stopHit || timeout || oppositeBreak) {
                    const reason = stopHit
                        ? 'VCB v2 long stop/trail'
                        : timeout
                            ? 'VCB v2 long max-hold'
                            : 'VCB v2 long opposite break';
                    signals.push(createSellSignal(cleanData, i, reason));
                    side = 'flat';
                    cooldown = cfg.cooldownBars;
                    bankedHalf = false;
                }
                continue;
            }

            const profitAtr = (entryPrice - close) / atrS;
            if (!bankedHalf && profitAtr >= cfg.bankAtAtr) {
                signals.push(createBuySignal(cleanData, i, 'VCB v2 banker partial short', cfg.bankFractionPct / 100));
                bankedHalf = true;
                stopPrice = Math.min(stopPrice, entryPrice);
                trailRef = bar.low;
                continue;
            }

            if (bankedHalf) {
                trailRef = Math.min(trailRef, bar.low);
                stopPrice = Math.min(stopPrice, trailRef + cfg.runnerTrailAtr * atrS);
            }

            const stopHit = close >= stopPrice;
            const timeout = barsHeld >= cfg.maxHoldBars;
            const oppositeBreak = upBreak;
            if (stopHit || timeout || oppositeBreak) {
                const reason = stopHit
                    ? 'VCB v2 short stop/trail'
                    : timeout
                        ? 'VCB v2 short max-hold'
                        : 'VCB v2 short opposite break';
                signals.push(createBuySignal(cleanData, i, reason));
                side = 'flat';
                cooldown = cfg.cooldownBars;
                bankedHalf = false;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'lookback',
            'compressionRatio',
            'breakoutBufferAtr',
            'shortAtrPeriod',
            'longAtrPeriod',
            'initialStopAtr',
            'bankAtAtr',
            'bankFractionPct',
            'runnerTrailAtr',
            'maxHoldBars',
            'cooldownBars',
        ],
    },
};
