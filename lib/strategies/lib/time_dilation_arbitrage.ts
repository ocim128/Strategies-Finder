import { Strategy } from "../../types/strategies";
import { getTypicalPrices, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildDualTimeframeRatio, buildRollingAutoCorrelation, buildRollingMedian } from './price-action-statistics-core';

export const time_dilation_arbitrage: Strategy = {
  name: 'Time Dilation Arbitrage',
  description: 'Quantifies multi-timeframe distortion by ensuring the macro structural drift is intact, but the micro time-series has collapsed into perfect noise (zero autocorrelation), buying the noise.',
  defaultParams: { fastWindow: 5, slowWindow: 50, autoCorrThreshold: 0.05 },
  paramLabels: { fastWindow: 'Fast Trend', slowWindow: 'Slow Trend', autoCorrThreshold: 'Max Auto-Correlation' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['fastWindow', 'slowWindow', 'autoCorrThreshold'] },
  execute: (data, params) => {
    const { fastWindow, slowWindow, autoCorrThreshold } = params as { fastWindow: number; slowWindow: number; autoCorrThreshold: number };
    const cleanData = ensureCleanData(data);
    const typicalPrices = getTypicalPrices(cleanData);
    
    const dtRatio = buildDualTimeframeRatio(typicalPrices, fastWindow, slowWindow, buildRollingMedian);
    const autoCorr = buildRollingAutoCorrelation(typicalPrices, fastWindow);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < slowWindow) return null;
      
      const currRatio = dtRatio[i];
      const currAuto = autoCorr[i];

      if (currRatio === null || currAuto === null) return null;

      if (Math.abs(currAuto) < autoCorrThreshold) {
        if (currRatio > 1.02) return createBuySignal(cleanData, i, 'time_dilation_arbitrage_buy');
        if (currRatio < 0.98) return createSellSignal(cleanData, i, 'time_dilation_arbitrage_sell');
      }
      return null;
    });
  }
};