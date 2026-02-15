import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';

type PositionState = 'flat' | 'long' | 'short';

function clampInt(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded)) return min;
    return Math.max(min, Math.min(max, rounded));
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

function computeImbalance(candle: OHLCVData): number {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = Math.max(0, candle.high - Math.max(candle.open, candle.close));
    const lowerWick = Math.max(0, Math.min(candle.open, candle.close) - candle.low);

    const impliedBuyVol = candle.close >= candle.open ? body + lowerWick : lowerWick;
    const impliedSellVol = candle.close <= candle.open ? body + upperWick : upperWick;
    const total = impliedBuyVol + impliedSellVol;
    if (!Number.isFinite(total) || total <= 0) return 0;
    return (impliedBuyVol - impliedSellVol) / total;
}

export const tick_imbalance_pressure: Strategy = {
    name: 'Tick Imbalance Pressure',
    description: 'Uses candle-structure buy/sell pressure imbalance accumulation to enter when directional pressure reaches a threshold.',
    defaultParams: {
        imbalanceLookback: 10,
        entryThreshold: 2.0,
        exitThreshold: 0.25,
        allowShorts: 1,
        cooldownBars: 2,
    },
    paramLabels: {
        imbalanceLookback: 'Imbalance Lookback',
        entryThreshold: 'Entry Threshold',
        exitThreshold: 'Exit Threshold',
        allowShorts: 'Allow Shorts (1/0)',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const imbalanceLookback = clampInt(params.imbalanceLookback ?? 10, 3, 100);
        const entryThreshold = clamp(params.entryThreshold ?? 2.0, 0.1, 20);
        const exitThreshold = clamp(params.exitThreshold ?? 0.25, 0, entryThreshold);
        const allowShorts = (params.allowShorts ?? 1) >= 0.5;
        const cooldownBars = clampInt(params.cooldownBars ?? 2, 0, 200);

        const imbalances = cleanData.map(computeImbalance);
        const signals: Signal[] = [];
        let position: PositionState = 'flat';
        let lastSignalIndex = -10_000;

        for (let i = 1; i < cleanData.length; i++) {
            if (i - lastSignalIndex <= cooldownBars) continue;
            if (i < imbalanceLookback - 1) continue;

            let sum = 0;
            for (let j = i - imbalanceLookback + 1; j <= i; j++) {
                sum += imbalances[j];
            }

            if (position === 'flat') {
                if (sum >= entryThreshold) {
                    signals.push(createBuySignal(cleanData, i, 'Tick Imbalance Long'));
                    position = 'long';
                    lastSignalIndex = i;
                    continue;
                }
                if (allowShorts && sum <= -entryThreshold) {
                    signals.push(createSellSignal(cleanData, i, 'Tick Imbalance Short'));
                    position = 'short';
                    lastSignalIndex = i;
                }
                continue;
            }

            if (position === 'long') {
                if (allowShorts && sum <= -entryThreshold) {
                    signals.push(createSellSignal(cleanData, i, 'Tick Imbalance Flip Short'));
                    position = 'short';
                    lastSignalIndex = i;
                    continue;
                }
                if (sum <= exitThreshold) {
                    signals.push(createSellSignal(cleanData, i, 'Tick Imbalance Long Exit'));
                    position = 'flat';
                    lastSignalIndex = i;
                }
                continue;
            }

            if (sum >= entryThreshold) {
                signals.push(createBuySignal(cleanData, i, 'Tick Imbalance Flip Long'));
                position = 'long';
                lastSignalIndex = i;
                continue;
            }
            if (sum >= -exitThreshold) {
                signals.push(createBuySignal(cleanData, i, 'Tick Imbalance Short Exit'));
                position = 'flat';
                lastSignalIndex = i;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['imbalanceLookback', 'entryThreshold', 'exitThreshold', 'cooldownBars'],
    },
};

