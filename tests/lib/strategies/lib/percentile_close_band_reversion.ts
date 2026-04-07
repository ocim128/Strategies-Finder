import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';

export const percentile_close_band_reversion: Strategy = {
  name: 'Percentile Close Band Reversion',
  description: 'The rolling Nth percentile and (100-N)th percentile of closes create non-parametric dynamic S/R bands. Unlike Bollinger Bands which assume normal distribution, percentile bands adapt to the actual shape of the return distribution. Price touching the lower percentile band has closed below N% of recent bars — a genuine statistical extreme regardless of distribution shape.',
  defaultParams: { lookback: 50, bandPercentile: 10 },
  paramLabels: { lookback: 'Window', bandPercentile: 'Percentile Extreme' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback', 'bandPercentile'] },
  execute: (data, params) => {
    const { lookback, bandPercentile } = params as { lookback: number; bandPercentile: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    // Convert percentages from 0-100 to 0-1 for buildPercentileRank
    const targetLow = bandPercentile / 100;
    const targetHigh = (100 - bandPercentile) / 100;

    const rank = buildPercentileRank(closes, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currRank = rank[i];
      const close = closes[i];
      const prevClose = closes[i - 1];

      if (currRank === null || close === null || prevClose === null) return null;

      if (currRank <= targetLow && close > prevClose) return createBuySignal(cleanData, i, 'percentile_close_band_reversion_buy');
      if (currRank >= targetHigh && close < prevClose) return createSellSignal(cleanData, i, 'percentile_close_band_reversion_sell');
      
      return null;
    });
  }
};