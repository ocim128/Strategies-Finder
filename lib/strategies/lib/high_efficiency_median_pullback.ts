import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildEfficiencyRatio,
  buildRollingMedian
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    erLookback: Math.max(2, Math.round(params.erLookback ?? 20)),
    erThreshold: Number(params.erThreshold ?? 0.45),
    medianLookback: Math.max(2, Math.round(params.medianLookback ?? 20))
  };
}

export const high_efficiency_median_pullback: Strategy = {
  name: 'High Efficiency Median Pullback',
  description: 'Executes classic moving-median pullbacks strictly when Kaufman\'s Efficiency Ratio proves the regime is a frictionless, high-conviction trend.',
  defaultParams: {
    erLookback: 20,
    erThreshold: 0.45,
    medianLookback: 20
  },
  paramLabels: {
    erLookback: 'ER Lookback',
    erThreshold: 'ER Threshold',
    medianLookback: 'Median Lookback'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['erLookback', 'erThreshold', 'medianLookback']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { erLookback, erThreshold, medianLookback } = normalizeParams(params);

    const closes = getCloses(cleanData);
    
    const er = buildEfficiencyRatio(cleanData, erLookback);
    const median = buildRollingMedian(closes, medianLookback);

    return createSignalLoop(
      cleanData,
      [er, median],
      (i) => {
        if (i === 0) return null;
        if (er[i] === null || median[i] === null || median[i-1] === null) return null;

        const currentClose = closes[i];
        const prevClose = closes[i-1];
        const currentMedian = median[i]!;
        const prevMedian = median[i-1]!;

        if (er[i]! > erThreshold && currentClose > currentMedian && prevClose <= prevMedian) {
          return createBuySignal(cleanData, i, 'High Efficiency Median Cross Buy');
        }

        if (er[i]! > erThreshold && currentClose < currentMedian && prevClose >= prevMedian) {
          return createSellSignal(cleanData, i, 'High Efficiency Median Cross Sell');
        }

        return null;
      }
    );
  }
};
