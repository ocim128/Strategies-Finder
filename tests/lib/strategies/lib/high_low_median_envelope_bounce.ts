import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingMedian } from './price-action-statistics-core';

export const high_low_median_envelope_bounce: Strategy = {
  name: 'High-Low Median Envelope Bounce',
  description: 'The rolling median of only highs creates a dynamic resistance ceiling. The rolling median of only lows creates a dynamic support floor. These are robust, outlier-insensitive S/R envelopes that adapt to market structure independently — the upper envelope can widen while the lower tightens, capturing asymmetric distribution shifts no single-line S/R can represent.',
  defaultParams: { lookback: 20 },
  paramLabels: { lookback: 'Rolling Window' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback'] },
  execute: (data, params) => {
    const { lookback } = params as { lookback: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    
    const highMedian = buildRollingMedian(highs, lookback);
    const lowMedian = buildRollingMedian(lows, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currHighMed = highMedian[i];
      const currLowMed = lowMedian[i];
      const close = closes[i];
      const prevClose = closes[i - 1];

      if (currHighMed === null || currLowMed === null || close === null || prevClose === null) return null;

      if (close <= currLowMed && close > prevClose) return createBuySignal(cleanData, i, 'high_low_median_envelope_bounce_buy');
      if (close >= currHighMed && close < prevClose) return createSellSignal(cleanData, i, 'high_low_median_envelope_bounce_sell');
      
      return null;
    });
  }
};