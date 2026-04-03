import { Strategy, OHLCVData } from '../../types/strategies';
import { getCloses, createSignalLoop, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';
import { buildEfficiencyRatio } from './price-action-statistics-core';

export const efficiency_ratio_implosion: Strategy = {
    name: "Efficiency Ratio Implosion",
    description: "A perfectly smooth, highly efficient directional flow that suddenly prints a near-zero efficiency ratio indicates an instantaneous structural breakdown.",
    defaultParams: {
        er_lookback: 8,
        high_thresh: 0.8,
        low_thresh: 0.2
    },
    paramLabels: {
        er_lookback: "ER Lookback",
        high_thresh: "High Threshold",
        low_thresh: "Low Threshold"
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["er_lookback", "high_thresh", "low_thresh"]
    },
    execute(data: OHLCVData[], params: Record<string, number>) {
        const cleanData = ensureCleanData(data);
        const { er_lookback, high_thresh, low_thresh } = params;
        
        const closes = getCloses(cleanData);
        const erSeries = buildEfficiencyRatio(cleanData, er_lookback);
        
        return createSignalLoop(cleanData, [erSeries], (i) => {
            if (i < er_lookback + 1) return null;
            
            const prevEr = erSeries[i - 1];
            const currEr = erSeries[i];
            
            if (prevEr === null || currEr === null) return null;
            
            const prevClose = closes[i - 1];
            const historicClose = closes[i - 1 - er_lookback];
            
            if (prevEr > high_thresh && currEr < low_thresh) {
                // Down trend implosion (Buy)
                if (prevClose < historicClose) {
                    return createBuySignal(cleanData, i, 'efficiency_ratio_implosion');
                }
                // Up trend implosion (Sell)
                if (prevClose > historicClose) {
                    return createSellSignal(cleanData, i, 'efficiency_ratio_implosion');
                }
            }
            
            return null;
        });
    }
};