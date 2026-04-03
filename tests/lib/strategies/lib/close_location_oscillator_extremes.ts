import { Strategy, OHLCVData } from '../../types/strategies';
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';
import { buildCloseLocationSeries } from './price-action-frequency-core';
import { buildStreakCount } from './price-action-statistics-core';

export const close_location_oscillator_extremes: Strategy = {
    name: "Close Location Oscillator Extremes",
    description: "When price repeatedly closes at the extreme edge of its range over consecutive bars, mean reversion is imminent.",
    defaultParams: {
        clo_threshold: 0.1,
        streak_len: 3
    },
    paramLabels: {
        clo_threshold: "CLO Threshold",
        streak_len: "Streak Length"
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["clo_threshold", "streak_len"]
    },
    execute(data: OHLCVData[], params: Record<string, number>) {
        const cleanData = ensureCleanData(data);
        const { clo_threshold, streak_len } = params;
        
        const cloSeries = buildCloseLocationSeries(cleanData);
        
        const lowExtremes = cloSeries.map(clo => (clo !== null && clo < clo_threshold) ? 1 : 0);
        const highExtremes = cloSeries.map(clo => (clo !== null && clo > (1.0 - clo_threshold)) ? 1 : 0);
        
        const lowStreaks = buildStreakCount(lowExtremes);
        const highStreaks = buildStreakCount(highExtremes);
        
        return createSignalLoop(cleanData, [lowStreaks], (i) => {
            if (lowStreaks[i] >= streak_len) {
                return createBuySignal(cleanData, i, 'close_location_oscillator_extremes');
            }
            if (highStreaks[i] >= streak_len) {
                return createSellSignal(cleanData, i, 'close_location_oscillator_extremes');
            }
            return null;
        });
    }
};
