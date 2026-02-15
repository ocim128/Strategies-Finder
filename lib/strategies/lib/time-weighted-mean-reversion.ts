import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from '../strategy-helpers';
import { calculateSMA } from '../indicators';

type PositionDirection = 'long' | 'short';

interface OpenPosition {
    direction: PositionDirection;
    entryIndex: number;
}

function clampInt(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded)) return min;
    return Math.max(min, Math.min(max, rounded));
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

export const time_weighted_mean_reversion: Strategy = {
    name: 'Time-Weighted Mean Reversion',
    description: 'Enters on stretched deviations from mean and exits on time budget, with optional early reversion exits.',
    defaultParams: {
        meanLookback: 20,
        entryDeviationPct: 2.0,
        holdingPeriodBars: 5,
        exitOnMeanCross: 1,
        allowShorts: 1,
        cooldownBars: 1,
    },
    paramLabels: {
        meanLookback: 'Mean Lookback',
        entryDeviationPct: 'Entry Deviation (%)',
        holdingPeriodBars: 'Holding Period (bars)',
        exitOnMeanCross: 'Exit On Mean Cross (1/0)',
        allowShorts: 'Allow Shorts (1/0)',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const meanLookback = clampInt(params.meanLookback ?? 20, 5, 500);
        const entryDeviationPct = clamp(params.entryDeviationPct ?? 2.0, 0.1, 25);
        const holdingPeriodBars = clampInt(params.holdingPeriodBars ?? 5, 1, 200);
        const exitOnMeanCross = (params.exitOnMeanCross ?? 1) >= 0.5;
        const allowShorts = (params.allowShorts ?? 1) >= 0.5;
        const cooldownBars = clampInt(params.cooldownBars ?? 1, 0, 200);

        const closes = getCloses(cleanData);
        const mean = calculateSMA(closes, meanLookback);

        const signals: Signal[] = [];
        let position: OpenPosition | null = null;
        let lastSignalIndex = -10_000;

        for (let i = 1; i < cleanData.length; i++) {
            const avg = mean[i];
            if (avg === null || avg <= 0) continue;

            if (position) {
                const barsHeld = i - position.entryIndex;
                const timedExit = barsHeld >= holdingPeriodBars;
                const reverted =
                    exitOnMeanCross &&
                    ((position.direction === 'long' && closes[i] >= avg) ||
                        (position.direction === 'short' && closes[i] <= avg));

                if (timedExit || reverted) {
                    const exitSignal =
                        position.direction === 'long'
                            ? createSellSignal(cleanData, i, timedExit ? 'TWMR Time Exit Long' : 'TWMR Mean Exit Long')
                            : createBuySignal(cleanData, i, timedExit ? 'TWMR Time Exit Short' : 'TWMR Mean Exit Short');
                    signals.push(exitSignal);
                    position = null;
                    lastSignalIndex = i;
                }
                continue;
            }

            if (i - lastSignalIndex <= cooldownBars) continue;

            const deviationPct = ((closes[i] - avg) / avg) * 100;
            if (deviationPct <= -entryDeviationPct) {
                signals.push(createBuySignal(cleanData, i, 'TWMR Long Entry'));
                position = { direction: 'long', entryIndex: i };
                lastSignalIndex = i;
                continue;
            }

            if (allowShorts && deviationPct >= entryDeviationPct) {
                signals.push(createSellSignal(cleanData, i, 'TWMR Short Entry'));
                position = { direction: 'short', entryIndex: i };
                lastSignalIndex = i;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['meanLookback', 'entryDeviationPct', 'holdingPeriodBars', 'cooldownBars'],
    },
};

