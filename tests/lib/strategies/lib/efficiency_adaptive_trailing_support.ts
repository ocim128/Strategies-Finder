import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildEfficiencyRatio } from './price-action-statistics-core';


export const efficiency_adaptive_trailing_support: Strategy = {
  name: 'Efficiency-Adaptive Trailing S/R',
  description: 'In efficient (trending) markets, S/R levels are further from price because informed flow moves price directionally. In inefficient (noisy) markets, S/R is closer because price oscillates. Use the efficiency ratio to dynamically scale the trailing high/low lookback — longer lookback in trends (stronger distant S/R), shorter in ranges (closer responsive S/R).',
  defaultParams: { baseLookback: 20, erLookback: 15 },
  paramLabels: { baseLookback: 'Base Lookback', erLookback: 'ER Window' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['baseLookback', 'erLookback'] },
  execute: (data, params) => {
    const { baseLookback, erLookback } = params as { baseLookback: number; erLookback: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const er = buildEfficiencyRatio(cleanData, erLookback); // Using map directly if it expects numbers, but standard is numbers

    // Since we must recompute trailing levels per bar because lookback changes dynamically:
    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < Math.max(baseLookback * 2, erLookback)) return null;
      
      const currEr = er[i];
      if (currEr === null) return null;

      const adaptiveLookback = Math.max(2, Math.round(baseLookback * (0.5 + currEr)));
      
      let highest = -Infinity;
      let lowest = Infinity;
      
      for (let j = 1; j <= adaptiveLookback; j++) {
          if (cleanData[i - j].high > highest) highest = cleanData[i - j].high;
          if (cleanData[i - j].low < lowest) lowest = cleanData[i - j].low;
      }

      const close = closes[i];
      const prevClose = closes[i - 1];

      if (close === null || prevClose === null) return null;

      if (prevClose <= lowest * 1.001 && close > prevClose) return createBuySignal(cleanData, i, 'efficiency_adaptive_trailing_support_buy');
      if (prevClose >= highest * 0.999 && close < prevClose) return createSellSignal(cleanData, i, 'efficiency_adaptive_trailing_support_sell');
      
      return null;
    });
  }
};