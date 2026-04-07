import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';

export const wick_rejection_level_bounce: Strategy = {
  name: 'Wick Rejection Level Bounce',
  description: 'Bars with extreme wick-to-range ratios (long wicks, tiny bodies) are rejection bars — the market probed a level and was forcefully rejected. The extreme of that wick creates a dynamic S/R level. When price returns to a recent rejection level and bounces, it confirms the level is defended. This builds S/R purely from rejection geometry, not from any indicator.',
  defaultParams: { rejectionWindow: 20, wickRatio: 0.7 },
  paramLabels: { rejectionWindow: 'Rejection Window', wickRatio: 'Wick Ratio' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['rejectionWindow', 'wickRatio'] },
  execute: (data, params) => {
    const { rejectionWindow, wickRatio } = params as { rejectionWindow: number; wickRatio: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const supportLevels: (number | null)[] = new Array(cleanData.length).fill(null);
    const resistanceLevels: (number | null)[] = new Array(cleanData.length).fill(null);

    for (let i = 0; i < cleanData.length; i++) {
        const bar = cleanData[i];
        const range = bar.high - bar.low;
        if (range <= 0) continue;

        const bodyHigh = Math.max(bar.open, bar.close);
        const bodyLow = Math.min(bar.open, bar.close);
        
        const upperWick = bar.high - bodyHigh;
        const lowerWick = bodyLow - bar.low;

        if (lowerWick / range >= wickRatio) supportLevels[i] = bar.low;
        if (upperWick / range >= wickRatio) resistanceLevels[i] = bar.high;
    }

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < rejectionWindow) return null;
      
      const close = closes[i];
      const prevClose = closes[i - 1];

      if (close === null || prevClose === null) return null;

      let foundSupportBounce = false;
      let foundResistanceReject = false;

      for (let j = 1; j <= rejectionWindow; j++) {
          const supp = supportLevels[i - j];
          const res = resistanceLevels[i - j];

          if (supp !== null && Math.abs(prevClose - supp) / supp < 0.005 && close > prevClose) foundSupportBounce = true;
          if (res !== null && Math.abs(prevClose - res) / res < 0.005 && close < prevClose) foundResistanceReject = true;
      }

      if (foundSupportBounce) return createBuySignal(cleanData, i, 'wick_rejection_level_bounce_buy');
      if (foundResistanceReject) return createSellSignal(cleanData, i, 'wick_rejection_level_bounce_sell');
      
      return null;
    });
  }
};