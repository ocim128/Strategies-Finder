import { Strategy, OHLCVData } from '../../types/strategies';
import { getCloses, createSignalLoop, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';
import { buildRateOfChange, buildRollingZScore } from './price-action-statistics-core';

export const single_bar_roc_snapback: Strategy = {
    name: "Single Bar ROC Snapback",
    description: "A single bar that prints a completely outsized, statistically anomalous rate of change relative to the immediate localized environment is practically guaranteed to see immediate counter-flow.",
    defaultParams: {
        z_lookback: 50,
        zscore_thresh: 3.5
    },
    paramLabels: {
        z_lookback: "Z-Score Lookback",
        zscore_thresh: "Z-Score Threshold"
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["z_lookback", "zscore_thresh"]
    },
    execute(data: OHLCVData[], params: Record<string, number>) {
        const cleanData = ensureCleanData(data);
        const { z_lookback, zscore_thresh } = params;
        
        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, 1);
        const validRoc = roc.map(r => r === null ? 0 : r);
        const zscores = buildRollingZScore(validRoc, z_lookback);
        
        return createSignalLoop(cleanData, [zscores], (i) => {
            if (i < z_lookback) return null;
            
            const z = zscores[i];
            if (z === null) return null;
            
            if (z < -zscore_thresh) {
                return createBuySignal(cleanData, i, 'single_bar_roc_snapback');
            }
            
            if (z > zscore_thresh) {
                return createSellSignal(cleanData, i, 'single_bar_roc_snapback');
            }
            
            return null;
        });
    }
};