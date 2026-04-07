import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingMinMax } from './price-action-statistics-core';

export const close_extreme_boundary_bounce: Strategy = {
  name: 'Close Extreme Boundary Bounce',
  description: 'buildRollingMinMax on closes (not highs/lows) creates dynamic S/R from where price actually settled, not where it merely probed. The rolling maximum close is dynamic resistance that the market accepted as a closing level. The rolling minimum close is dynamic support from the same logic. Bounce from close extremes captures rejection of settlement beyond accepted boundaries.',
  defaultParams: { lookback: 20 },
  paramLabels: { lookback: 'Window' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback'] },
  execute: (data, params) => {
    const { lookback } = params as { lookback: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const { min, max } = buildRollingMinMax(closes, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currMin = min[i];
      const currMax = max[i];
      const close = closes[i];
      const prevClose = closes[i - 1];

      if (currMin === null || currMax === null || close === null || prevClose === null) return null;
      
      const tolerance = (currMax - currMin) * 0.1;

      if (close - currMin <= tolerance && close > prevClose) return createBuySignal(cleanData, i, 'close_extreme_boundary_bounce_buy');
      if (currMax - close <= tolerance && close < prevClose) return createSellSignal(cleanData, i, 'close_extreme_boundary_bounce_sell');
      
      return null;
    });
  }
};