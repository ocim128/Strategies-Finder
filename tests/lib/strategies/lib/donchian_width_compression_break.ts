import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { calculateDonchianChannels } from '../indicators';
import { buildRollingAverage } from './price-action-frequency-core';

export const donchian_width_compression_break: Strategy = {
  name: 'Donchian Width Compression Break',
  description: 'Donchian channel width (highest high - lowest low over N bars) measures realized range. When width compresses far below its own rolling average and price then breaks the channel boundary, the compression-then-breakout pattern signals a volatility expansion with direction.',
  defaultParams: { channelPeriod: 20, compressionRatio: 0.7 },
  paramLabels: { channelPeriod: 'Channel Window', compressionRatio: 'Compression Target' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['channelPeriod', 'compressionRatio'] },
  execute: (data, params) => {
    const { channelPeriod, compressionRatio } = params as { channelPeriod: number; compressionRatio: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    
    const donchian = calculateDonchianChannels(highs, lows, channelPeriod);
    const width: number[] = new Array(cleanData.length).fill(0);
    
    for (let i = 0; i < cleanData.length; i++) {
        if (donchian.upper[i] !== null && donchian.lower[i] !== null) {
            width[i] = donchian.upper[i]! - donchian.lower[i]!;
        }
    }

    const avgWidth = buildRollingAverage(width, channelPeriod * 2);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currWidth = width[i];
      const currAvgWidth = avgWidth[i];
      const close = closes[i];
      const prevClose = closes[i - 1];
      const upper = donchian.upper[i];
      const lower = donchian.lower[i];
      const prevUpper = donchian.upper[i - 1];
      const prevLower = donchian.lower[i - 1];

      if (currWidth === null || currAvgWidth === null || close === null || upper === null || lower === null || prevClose === null || prevUpper === null || prevLower === null) return null;

      if (currWidth < currAvgWidth * compressionRatio) {
          if (prevClose <= prevUpper && close > upper) return createBuySignal(cleanData, i, 'donchian_width_compression_break_buy');
          if (prevClose >= prevLower && close < lower) return createSellSignal(cleanData, i, 'donchian_width_compression_break_sell');
      }
      
      return null;
    });
  }
};