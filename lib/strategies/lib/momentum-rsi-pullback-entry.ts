import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from '../strategy-helpers';
import { calculateEMA, calculateRSI } from '../indicators';

interface Config {
    rsiPeriod: number;
    rsiThreshold: number;
    exitRsi: number;
    trendEmaPeriod: number;
    momentumLookback: number;
    minMomentumPct: number;
    requireReclaim: boolean;
    reclaimWindowBars: number;
    maxHoldBars: number;
    cooldownBars: number;
    trendFailPct: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function asToggle(value: number | undefined, fallback: boolean): boolean {
    const raw = value ?? (fallback ? 1 : 0);
    return raw >= 0.5;
}

function normalizeConfig(params: StrategyParams): Config {
    const rsiThreshold = clamp(params.rsiThreshold ?? 30, 5, 50);
    const exitRsi = clamp(params.exitRsi ?? 55, Math.max(rsiThreshold + 1, 35), 90);
    return {
        rsiPeriod: Math.max(2, Math.min(100, Math.round(params.rsiPeriod ?? 14))),
        rsiThreshold,
        exitRsi,
        trendEmaPeriod: Math.max(20, Math.min(600, Math.round(params.trendEmaPeriod ?? 200))),
        momentumLookback: Math.max(5, Math.min(400, Math.round(params.momentumLookback ?? 63))),
        minMomentumPct: clamp(params.minMomentumPct ?? 8, -50, 300),
        requireReclaim: asToggle(params.requireReclaim, true),
        reclaimWindowBars: Math.max(1, Math.min(40, Math.round(params.reclaimWindowBars ?? 4))),
        maxHoldBars: Math.max(1, Math.min(500, Math.round(params.maxHoldBars ?? 20))),
        cooldownBars: Math.max(0, Math.min(200, Math.round(params.cooldownBars ?? 2))),
        trendFailPct: clamp(params.trendFailPct ?? 1.5, 0, 20),
    };
}

export const momentum_rsi_pullback_entry: Strategy = {
    name: 'Momentum RSI Pullback Entry',
    description: 'Long-only momentum pullback entry on RSI oversold crossover with optional reclaim confirmation and deterministic, close-bar exits.',
    defaultParams: {
        rsiPeriod: 14,
        rsiThreshold: 30,
        exitRsi: 55,
        trendEmaPeriod: 200,
        momentumLookback: 63,
        minMomentumPct: 8,
        requireReclaim: 1,
        reclaimWindowBars: 4,
        maxHoldBars: 20,
        cooldownBars: 2,
        trendFailPct: 1.5,
    },
    paramLabels: {
        rsiPeriod: 'RSI Period',
        rsiThreshold: 'RSI Oversold Threshold',
        exitRsi: 'RSI Exit Threshold',
        trendEmaPeriod: 'Trend EMA Period',
        momentumLookback: 'Momentum Lookback (bars)',
        minMomentumPct: 'Min Momentum (%)',
        requireReclaim: 'Require RSI Reclaim (0/1)',
        reclaimWindowBars: 'Reclaim Window (bars)',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
        trendFailPct: 'Trend Fail Buffer (%)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const closes = getCloses(cleanData);
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
        let cooldown = 0;
        let armedUntil = -1;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;

            const rsiPrev = rsi[i - 1];
            const rsiNow = rsi[i];
            const trendNow = trend[i];
            const momNow = momentum[i];
            if (rsiPrev === null || rsiNow === null || trendNow === null || momNow === null) continue;

            const trendPass = closes[i] >= trendNow;
            const momentumPass = momNow >= cfg.minMomentumPct;
            const regimePass = trendPass && momentumPass;

            if (inPosition) {
                const barsHeld = i - entryIndex;
                const trendFailLevel = trendNow * (1 - cfg.trendFailPct / 100);
                const trendFail = closes[i] < trendFailLevel;
                const rsiExit = rsiNow >= cfg.exitRsi;
                const timeExit = barsHeld >= cfg.maxHoldBars;

                if (rsiExit || trendFail || timeExit) {
                    const reason = rsiExit
                        ? 'Momentum RSI exit on RSI recovery'
                        : trendFail
                            ? 'Momentum RSI exit on trend failure'
                            : 'Momentum RSI exit on max hold';
                    signals.push(createSellSignal(cleanData, i, reason));
                    inPosition = false;
                    entryIndex = -1;
                    cooldown = cfg.cooldownBars;
                    armedUntil = -1;
                }
                continue;
            }

            if (cooldown > 0) {
                cooldown--;
                continue;
            }

            const crossedBelow = rsiPrev > cfg.rsiThreshold && rsiNow <= cfg.rsiThreshold;
            const crossedAbove = rsiPrev <= cfg.rsiThreshold && rsiNow > cfg.rsiThreshold;

            if (!cfg.requireReclaim) {
                if (crossedBelow && regimePass) {
                    signals.push(createBuySignal(cleanData, i, 'Momentum RSI pullback entry'));
                    inPosition = true;
                    entryIndex = i;
                }
                continue;
            }

            if (crossedBelow && regimePass) {
                armedUntil = i + cfg.reclaimWindowBars;
            }

            const setupActive = armedUntil >= i;
            if (!setupActive) {
                armedUntil = -1;
                continue;
            }

            if (crossedAbove && regimePass) {
                signals.push(createBuySignal(cleanData, i, 'Momentum RSI reclaim entry'));
                inPosition = true;
                entryIndex = i;
                armedUntil = -1;
            }
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
            'exitRsi',
            'trendEmaPeriod',
            'momentumLookback',
            'minMomentumPct',
            'requireReclaim',
            'reclaimWindowBars',
            'maxHoldBars',
            'cooldownBars',
            'trendFailPct',
        ],
    },
};

