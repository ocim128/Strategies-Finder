import { Strategy } from "../../types/strategies";
import { getCloses, getOpens, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingMinMax } from './price-action-statistics-core';

export const body_midpoint_trailing_support_resistance: Strategy = {
  name: 'Body Midpoint Trailing S/R',
  description: 'The body midpoint (open+close)/2 is where capital actually changed hands. The rolling min and max of body midpoints create dynamic S/R from real settlement activity, ignoring wick noise entirely. When price bounces off a body-midpoint extreme, it is bouncing off the boundary of where real transactions occurred — structurally stronger S/R than close-only levels.',
  defaultParams: { lookback: 15 },
  paramLabels: { lookback: 'Window' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback'] },
  execute: (data, params) => {
    const { lookback } = params as { lookback: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const bmp: number[] = new Array(cleanData.length).fill(0);
    for (let i = 0; i < cleanData.length; i++) {
        bmp[i] = (opens[i]! + closes[i]!) / 2;
    }

    const { min, max } = buildRollingMinMax(bmp, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currMin = min[i];
      const currMax = max[i];
      const currBmp = bmp[i];
      const prevBmp = bmp[i - 1];

      if (currMin === null || currMax === null || currBmp === null || prevBmp === null) return null;

      if (currBmp <= currMin && currBmp > prevBmp) return createBuySignal(cleanData, i, 'body_midpoint_trailing_support_resistance_buy');
      if (currBmp >= currMax && currBmp < prevBmp) return createSellSignal(cleanData, i, 'body_midpoint_trailing_support_resistance_sell');
      
      return null;
    });
  }
};