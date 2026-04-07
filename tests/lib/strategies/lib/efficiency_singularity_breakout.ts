import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildEfficiencyRatio, buildRateOfChange } from './price-action-statistics-core';

export const efficiency_singularity_breakout: Strategy = {
  name: 'Efficiency Singularity Breakout',
  description: 'Waits for the market to achieve a state of perfect inefficiency (ER near 0), acting as a singularity. Buys the exact bar the rate of change violently fractures this equilibrium.',
  defaultParams: { erLookback: 20, erThreshold: 0.05, rocThreshold: 1.5 },
  paramLabels: { erLookback: 'ER Window', erThreshold: 'ER Threshold', rocThreshold: 'ROC Breakout (%)' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['erLookback', 'erThreshold', 'rocThreshold'] },
  execute: (data, params) => {
    const { erLookback, erThreshold, rocThreshold } = params as { erLookback: number; erThreshold: number; rocThreshold: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const er = buildEfficiencyRatio(cleanData, erLookback);
    const roc = buildRateOfChange(closes, erLookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < erLookback) return null;
      
      const currEr = er[i];
      const currRoc = roc[i];

      if (currEr === null || currRoc === null) return null;

      if (currEr < erThreshold) {
        if (currRoc > rocThreshold) return createBuySignal(cleanData, i, 'efficiency_singularity_breakout_buy');
        if (currRoc < -rocThreshold) return createSellSignal(cleanData, i, 'efficiency_singularity_breakout_sell');
      }
      return null;
    });
  }
};