import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingMedian } from './price-action-statistics-core';


export const range_envelope_adaptive_rejection: Strategy = {
  name: 'Range Envelope Adaptive Rejection',
  description: 'Build an adaptive envelope: center = rolling median of closes, half-width = rolling median of ranges. This creates dynamic S/R bands that expand/contract with actual market range activity. Unlike Bollinger (standard deviation) or Keltner (ATR), the range-median envelope uses robust statistics for both center and width, making it resistant to outlier distortion on both axes.',
  defaultParams: { centerLookback: 20, widthLookback: 10 },
  paramLabels: { centerLookback: 'Center Window', widthLookback: 'Width Window' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['centerLookback', 'widthLookback'] },
  execute: (data, params) => {
    const { centerLookback, widthLookback } = params as { centerLookback: number; widthLookback: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const ranges = cleanData.map(b => b.high - b.low);
    
    const center = buildRollingMedian(closes, centerLookback);
    const halfWidth = buildRollingMedian(ranges, widthLookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < Math.max(centerLookback, widthLookback)) return null;
      
      const currCenter = center[i];
      const currWidth = halfWidth[i];
      const close = closes[i];
      const prevClose = closes[i - 1];

      if (currCenter === null || currWidth === null || close === null || prevClose === null) return null;

      const upper = currCenter + currWidth;
      const lower = currCenter - currWidth;

      if (close <= lower && close > prevClose) return createBuySignal(cleanData, i, 'range_envelope_adaptive_rejection_buy');
      if (close >= upper && close < prevClose) return createSellSignal(cleanData, i, 'range_envelope_adaptive_rejection_sell');
      
      return null;
    });
  }
};