import { Strategy } from "../../types/strategies";
import { getCloses, getOpens, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingMedian } from './price-action-statistics-core';

export const body_settlement_zone_support: Strategy = {
  name: 'Body Settlement Zone Support',
  description: 'The body high and body low of each bar define the settlement zone — the price range where actual transactions occurred. When the rolling median of body lows across N bars creates a rising floor, it marks dynamic support built from real settlement prices. When the rolling median of body highs creates a falling ceiling, it marks dynamic resistance. A bounce from these settlement-zone medians captures S/R from institutional transaction boundaries.',
  defaultParams: { lookback: 15 },
  paramLabels: { lookback: 'Window' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback'] },
  execute: (data, params) => {
    const { lookback } = params as { lookback: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const bodyHighs: number[] = new Array(cleanData.length).fill(0);
    const bodyLows: number[] = new Array(cleanData.length).fill(0);
    
    for (let i = 0; i < cleanData.length; i++) {
        bodyHighs[i] = Math.max(opens[i]!, closes[i]!);
        bodyLows[i] = Math.min(opens[i]!, closes[i]!);
    }

    const resMedian = buildRollingMedian(bodyHighs, lookback);
    const suppMedian = buildRollingMedian(bodyLows, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currRes = resMedian[i];
      const currSupp = suppMedian[i];
      const close = closes[i];
      const prevClose = closes[i - 1];

      if (currRes === null || currSupp === null || close === null || prevClose === null) return null;

      if (close <= currSupp && close > prevClose) return createBuySignal(cleanData, i, 'body_settlement_zone_support_buy');
      if (close >= currRes && close < prevClose) return createSellSignal(cleanData, i, 'body_settlement_zone_support_sell');
      
      return null;
    });
  }
};