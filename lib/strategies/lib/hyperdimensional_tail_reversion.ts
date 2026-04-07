import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingSkewness, buildRollingKurtosis } from './price-action-statistics-core';

export const hyperdimensional_tail_reversion: Strategy = {
  name: 'Hyperdimensional Tail Reversion',
  description: 'Fades market shocks only when both the tail thickness (Kurtosis) and the asymmetry (Skewness) simultaneously reach mathematical limits, signaling a maximum-entropy exhaustion print.',
  defaultParams: { lookback: 40, skewThreshold: 2.5, kurtosisThreshold: 5.0 },
  paramLabels: { lookback: 'Moments Window', skewThreshold: 'Skew Limit', kurtosisThreshold: 'Kurtosis Limit' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback', 'skewThreshold', 'kurtosisThreshold'] },
  execute: (data, params) => {
    const { lookback, skewThreshold, kurtosisThreshold } = params as { lookback: number; skewThreshold: number; kurtosisThreshold: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const skewness = buildRollingSkewness(closes, lookback);
    const kurtosis = buildRollingKurtosis(closes, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currSkew = skewness[i];
      const currKurtosis = kurtosis[i];

      if (currSkew === null || currKurtosis === null) return null;

      if (currKurtosis > kurtosisThreshold) {
        if (currSkew < -skewThreshold) return createBuySignal(cleanData, i, 'hyperdimensional_tail_reversion_buy');
        if (currSkew > skewThreshold) return createSellSignal(cleanData, i, 'hyperdimensional_tail_reversion_sell');
      }
      return null;
    });
  }
};