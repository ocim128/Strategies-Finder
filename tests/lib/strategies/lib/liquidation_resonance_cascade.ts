import { Strategy } from "../../types/strategies";
import { getVolumes, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingKurtosis } from './price-action-statistics-core';
import { extractBarMetricSeries } from './price-action-frequency-core';

export const liquidation_resonance_cascade: Strategy = {
  name: 'Liquidation Resonance Cascade',
  description: 'Surfs the algorithmic shockwaves of cascading margin calls by identifying absolute fat-tail volume extremes perfectly aligned with directional price geometry.',
  defaultParams: { lookback: 50, kurtosisTrigger: 8.0 },
  paramLabels: { lookback: 'Kurtosis Window', kurtosisTrigger: 'Kurtosis Extreme' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback', 'kurtosisTrigger'] },
  execute: (data, params) => {
    const { lookback, kurtosisTrigger } = params as { lookback: number; kurtosisTrigger: number };
    const cleanData = ensureCleanData(data);
    const volumes = getVolumes(cleanData);
    
    const volKurtosis = buildRollingKurtosis(volumes, lookback);
    const bodyDirection = extractBarMetricSeries(cleanData, 'bodyDirection');
    const closeLocation = extractBarMetricSeries(cleanData, 'closeMidpointDev');

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currKurtosis = volKurtosis[i];
      const dir = bodyDirection[i];
      const cLoc = closeLocation[i];

      if (currKurtosis === null || dir === null || cLoc === null) return null;

      if (currKurtosis > kurtosisTrigger) {
        if (dir === 1 && cLoc > 0.8) return createBuySignal(cleanData, i, 'liquidation_resonance_cascade_buy');
        if (dir === -1 && cLoc < 0.2) return createSellSignal(cleanData, i, 'liquidation_resonance_cascade_sell');
      }
      return null;
    });
  }
};