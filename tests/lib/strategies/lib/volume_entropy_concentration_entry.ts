import { Strategy } from "../../types/strategies";
import { getVolumes, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingEntropy } from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

export const volume_entropy_concentration_entry: Strategy = {
  name: 'Volume Entropy Concentration Entry',
  description: 'Low rolling entropy of the volume series indicates volume is concentrated at predictable levels (institutional activity). When volume entropy drops below a threshold, enter in the direction of the price trend as measured by close vs rolling average.',
  defaultParams: { entropyLookback: 20, entropyThreshold: 0.8 },
  paramLabels: { entropyLookback: 'Entropy Window', entropyThreshold: 'Threshold' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['entropyLookback', 'entropyThreshold'] },
  execute: (data, params) => {
    const { entropyLookback, entropyThreshold } = params as { entropyLookback: number; entropyThreshold: number };
    const cleanData = ensureCleanData(data);
    const volumes = getVolumes(cleanData);
    const closes = getCloses(cleanData);
    
    const volEntropy = buildRollingEntropy(volumes, entropyLookback, 5);
    const rollingAvg = buildRollingAverage(closes, entropyLookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currEnt = volEntropy[i];
      const currAvg = rollingAvg[i];
      const close = closes[i];

      if (currEnt === null || currAvg === null || close === null) return null;

      if (currEnt < entropyThreshold) {
          if (close > currAvg) return createBuySignal(cleanData, i, 'volume_entropy_concentration_entry_buy');
          if (close < currAvg) return createSellSignal(cleanData, i, 'volume_entropy_concentration_entry_sell');
      }
      
      return null;
    });
  }
};