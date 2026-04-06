import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRollingKurtosis,
  extractBarMetricSeries
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    kurtosisThreshold: Number(params.kurtosisThreshold ?? 4.0)
  };
}

export const kurtosis_tail_reversion: Strategy = {
  name: 'Kurtosis Tail Reversion',
  description: 'Uses statistical kurtosis to identify fat-tailed distribution anomalies (extreme outlier bars) and fades them if the close location rejects the extreme.',
  defaultParams: {
    lookback: 30,
    kurtosisThreshold: 4.0
  },
  paramLabels: {
    lookback: 'Lookback Period',
    kurtosisThreshold: 'Kurtosis Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'kurtosisThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, kurtosisThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    
    const kurtosis = buildRollingKurtosis(closes, lookback);
    const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

    return createSignalLoop(
      cleanData,
      [kurtosis, closeLocation],
      (i) => {
        if (kurtosis[i] === null || closeLocation[i] === null) return null;

        if (kurtosis[i]! > kurtosisThreshold && closeLocation[i]! < 0.25) {
          return createBuySignal(cleanData, i, 'Kurtosis Rejection Buy');
        }

        if (kurtosis[i]! > kurtosisThreshold && closeLocation[i]! > 0.75) {
          return createSellSignal(cleanData, i, 'Kurtosis Rejection Sell');
        }

        return null;
      }
    );
  }
};

