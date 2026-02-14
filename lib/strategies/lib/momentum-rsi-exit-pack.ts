import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateEMA, calculateRSI } from '../indicators';

interface Config {
    rsiPeriod: number;
    rsiThreshold: number;
    trendEmaPeriod: number;
    momentumLookback: number;
    minMomentumPct: number;
    takeProfitPercent: number;
    stopLossPercent: number;
    maxHoldBars: number;
    cooldownBars: number;
    minBounceRsi: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeConfig(params: StrategyParams): Config {
    return {
        rsiPeriod: Math.max(2, Math.min(100, Math.round(params.rsiPeriod ?? 14))),
        rsiThreshold: clamp(params.rsiThreshold ?? 30, 5, 50),
        trendEmaPeriod: Math.max(20, Math.min(600, Math.round(params.trendEmaPeriod ?? 200))),
        momentumLookback: Math.max(5, Math.min(400, Math.round(params.momentumLookback ?? 63))),
        minMomentumPct: clamp(params.minMomentumPct ?? 8, -80, 500),
        takeProfitPercent: clamp(params.takeProfitPercent ?? 3, 0.1, 100),
        stopLossPercent: clamp(params.stopLossPercent ?? 4, 0.1, 100),
        maxHoldBars: Math.max(1, Math.min(500, Math.round(params.maxHoldBars ?? 10))),
        cooldownBars: Math.max(0, Math.min(200, Math.round(params.cooldownBars ?? 2))),
        minBounceRsi: clamp(params.minBounceRsi ?? 40, 5, 95),
    };
}

export const momentum_rsi_exit_pack: Strategy = {
    name: 'Momentum RSI Exit Pack',
    description: 'Momentum RSI dip-buy entry with conservative intrabar TP/SL ordering, RSI bounce exit, max hold, and cooldown.',
    defaultParams: {
        rsiPeriod: 14,
        rsiThreshold: 30,
        trendEmaPeriod: 200,
        momentumLookback: 63,
        minMomentumPct: 8,
        takeProfitPercent: 3,
        stopLossPercent: 4,
        maxHoldBars: 10,
        cooldownBars: 2,
        minBounceRsi: 40,
    },
    paramLabels: {
        rsiPeriod: 'RSI Period',
        rsiThreshold: 'RSI Oversold Threshold',
        trendEmaPeriod: 'Trend EMA Period',
        momentumLookback: 'Momentum Lookback (bars)',
        minMomentumPct: 'Min Momentum (%)',
        takeProfitPercent: 'Take Profit (%)',
        stopLossPercent: 'Stop Loss (%)',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
        minBounceRsi: 'Early Exit RSI Bounce',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const rsi = calculateRSI(closes, cfg.rsiPeriod);
        const trend = calculateEMA(closes, cfg.trendEmaPeriod);
        const momentum: (number | null)[] = new Array(closes.length).fill(null);

        for (let i = cfg.momentumLookback; i < closes.length; i++) {
            const prev = closes[i - cfg.momentumLookback];
            if (prev <= 0) continue;
            momentum[i] = ((closes[i] / prev) - 1) * 100;
        }

        const minBars = Math.max(cfg.trendEmaPeriod, cfg.momentumLookback, cfg.rsiPeriod + 1);
        const signals: Signal[] = [];

        let inPosition = false;
        let entryIndex = -1;
        let entryPrice = 0;
        let takeProfitPrice = 0;
        let stopLossPrice = 0;
        let cooldown = 0;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;

            const rsiPrev = rsi[i - 1];
            const rsiNow = rsi[i];
            const trendNow = trend[i];
            const momNow = momentum[i];
            if (rsiPrev === null || rsiNow === null || trendNow === null || momNow === null) continue;

            if (inPosition) {
                const barsHeld = i - entryIndex;
                const stopHit = lows[i] <= stopLossPrice;
                const targetHit = highs[i] >= takeProfitPrice;
                const timeExit = barsHeld >= cfg.maxHoldBars;
                const bounceExit = rsiNow >= cfg.minBounceRsi && closes[i] > entryPrice;

                let exitReason: string | null = null;

                // Conservative intrabar assumption when both levels are touched.
                if (stopHit) {
                    exitReason = 'Momentum RSI stop loss';
                } else if (targetHit) {
                    exitReason = 'Momentum RSI take profit';
                } else if (bounceExit) {
                    exitReason = 'Momentum RSI bounce exit';
                } else if (timeExit) {
                    exitReason = 'Momentum RSI max hold exit';
                }

                if (exitReason) {
                    signals.push(createSellSignal(cleanData, i, exitReason));
                    inPosition = false;
                    entryIndex = -1;
                    entryPrice = 0;
                    takeProfitPrice = 0;
                    stopLossPrice = 0;
                    cooldown = cfg.cooldownBars;
                }
                continue;
            }

            if (cooldown > 0) {
                cooldown--;
                continue;
            }

            const crossedBelow = rsiPrev > cfg.rsiThreshold && rsiNow <= cfg.rsiThreshold;
            const trendPass = closes[i] >= trendNow;
            const momentumPass = momNow >= cfg.minMomentumPct;
            if (!crossedBelow || !trendPass || !momentumPass) continue;

            inPosition = true;
            entryIndex = i;
            entryPrice = closes[i];
            takeProfitPrice = entryPrice * (1 + cfg.takeProfitPercent / 100);
            stopLossPrice = entryPrice * (1 - cfg.stopLossPercent / 100);
            signals.push(createBuySignal(cleanData, i, 'Momentum RSI dip entry'));
        }

        if (inPosition && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'Momentum RSI final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'rsiPeriod',
            'rsiThreshold',
            'trendEmaPeriod',
            'momentumLookback',
            'minMomentumPct',
            'takeProfitPercent',
            'stopLossPercent',
            'maxHoldBars',
            'cooldownBars',
            'minBounceRsi',
        ],
    },
};

