import { Strategy, OHLCVData } from '../../types/strategies';
import { getVolumes, createSignalLoop, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';
import { buildCloseLocationSeries } from './price-action-frequency-core';
import { buildRollingZScore } from './price-action-statistics-core';

export const volume_thrust_zscore_continuation: Strategy = {
    name: "Volume Thrust Z-Score Continuation",
    description: "Classic volume climax strategies try to pick tops. This uses extreme volume z-scores combined with aggressive closing locations to trade *with* the newly established institutional thrust.",
    defaultParams: {
        z_lookback: 50,
        z_thresh: 3.0,
        clo_thresh: 0.8
    },
    paramLabels: {
        z_lookback: "Z-Score Lookback",
        z_thresh: "Z-Score Threshold",
        clo_thresh: "CLO Threshold"
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["z_lookback", "z_thresh", "clo_thresh"]
    },
    execute(data: OHLCVData[], params: Record<string, number>) {
        const cleanData = ensureCleanData(data);
        const { z_lookback, z_thresh, clo_thresh } = params;
        
        const volumes = getVolumes(cleanData);
        const validVolumes = volumes.map(v => v === undefined || v === null ? 0 : v);
        
        const zscores = buildRollingZScore(validVolumes, z_lookback);
        const cloSeries = buildCloseLocationSeries(cleanData);
        
        return createSignalLoop(cleanData, [zscores, cloSeries], (i) => {
            if (i < z_lookback) return null;
            
            const currZ = zscores[i];
            const clo = cloSeries[i];
            
            if (currZ === null || clo === null) return null;
            
            if (currZ > z_thresh && clo > clo_thresh) {
                return createBuySignal(cleanData, i, 'volume_thrust_zscore_continuation');
            }
            
            if (currZ > z_thresh && clo < (1.0 - clo_thresh)) {
                return createSellSignal(cleanData, i, 'volume_thrust_zscore_continuation');
            }
            
            return null;
        });
    }
};