import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingAutoCorrelation } from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

export const autocorrelation_regime_break: Strategy = {
  name: 'Autocorrelation Regime Break',
  description: 'Rolling autocorrelation of close returns measures serial dependence. When it collapses from positive to near-zero, the prevailing trend has lost coherence and mean-reversion dominates.',
  defaultParams: { lookback: 20, autocorrThreshold: 0.1 },
  paramLabels: { lookback: 'Window', autocorrThreshold: 'Autocorr Threshold' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback', 'autocorrThreshold'] },
  execute: (data, params) => {
    const { lookback, autocorrThreshold } = params as { lookback: number; autocorrThreshold: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const returns: number[] = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
        returns[i] = closes[i]! / closes[i - 1]! - 1;
    }
    
    const autocorr = buildRollingAutoCorrelation(returns, lookback);
    const rollingAvg = buildRollingAverage(closes, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currAc = autocorr[i];
      const prevAc = autocorr[i - 1];
      const currAvg = rollingAvg[i];
      const close = closes[i];

      if (currAc === null || prevAc === null || currAvg === null || close === null) return null;

      if (prevAc > autocorrThreshold && currAc < autocorrThreshold) {
          if (close < currAvg) return createBuySignal(cleanData, i, 'autocorrelation_regime_break_buy');
          if (close > currAvg) return createSellSignal(cleanData, i, 'autocorrelation_regime_break_sell');
      }
      return null;
    });
  }
};