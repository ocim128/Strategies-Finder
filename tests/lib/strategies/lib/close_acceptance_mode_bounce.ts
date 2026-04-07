import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';

export const close_acceptance_mode_bounce: Strategy = {
  name: 'Close Acceptance Mode Bounce',
  description: 'In a rolling window, the most frequently visited close price level (the mode of the close distribution) is where the market has maximum price acceptance — the consensus fair value. When price moves away from this mode and then returns, the mode acts as dynamic S/R because market participants remember and defend the consensus level. Bounce from the mode captures reversion to the most-agreed-upon price.',
  defaultParams: { windowSize: 30, bucketPct: 0.3 },
  paramLabels: { windowSize: 'Window', bucketPct: 'Bucket %' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['windowSize', 'bucketPct'] },
  execute: (data, params) => {
    const { windowSize, bucketPct } = params as { windowSize: number; bucketPct: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < windowSize) return null;
      
      const slice = closes.slice(i - windowSize, i);
      const minClose = Math.min(...slice);
      const maxClose = Math.max(...slice);
      const range = maxClose - minClose;
      
      if (range === 0) return null;

      const bucketSize = range * bucketPct;
      const buckets: Record<number, number> = {};
      
      for (const c of slice) {
          const bucketIdx = Math.floor((c - minClose) / bucketSize);
          buckets[bucketIdx] = (buckets[bucketIdx] || 0) + 1;
      }
      
      let maxCount = 0;
      let modeIdx = 0;
      
      for (const [idx, count] of Object.entries(buckets)) {
          if (count > maxCount) {
              maxCount = count;
              modeIdx = Number(idx);
          }
      }

      const modePrice = minClose + (modeIdx * bucketSize) + (bucketSize / 2);

      const close = closes[i];
      const prevClose = closes[i - 1];

      if (close === null || prevClose === null) return null;
      
      const tolerance = range * bucketPct;

      if (prevClose < modePrice && Math.abs(close - modePrice) <= tolerance && close > prevClose) return createBuySignal(cleanData, i, 'close_acceptance_mode_bounce_buy');
      if (prevClose > modePrice && Math.abs(close - modePrice) <= tolerance && close < prevClose) return createSellSignal(cleanData, i, 'close_acceptance_mode_bounce_sell');
      
      return null;
    });
  }
};