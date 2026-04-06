import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRollingAutoCorrelation
} from './price-action-statistics-core';
import { calculateMomentum } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    autoCorrThreshold: Number(params.autoCorrThreshold ?? 0.6)
  };
}

export const autocorrelation_momentum_surge: Strategy = {
  name: 'Autocorrelation Momentum Surge',
  description: 'Uses high autocorrelation to confirm a structural trend regime, entering only when short-term momentum triggers in the trend\'s direction.',
  defaultParams: {
    lookback: 30,
    autoCorrThreshold: 0.6
  },
  paramLabels: {
    lookback: 'Lookback Period',
    autoCorrThreshold: 'Autocorrelation Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'autoCorrThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, autoCorrThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    
    const autocorrelation = buildRollingAutoCorrelation(closes, lookback);
    const momentum = calculateMomentum(closes, 10); // Standard momentum lookback

    return createSignalLoop(
      cleanData,
      [autocorrelation, momentum],
      (i) => {
        if (i === 0) return null;
        if (autocorrelation[i] === null || momentum[i] === null || momentum[i-1] === null) return null;

        if (autocorrelation[i]! > autoCorrThreshold && momentum[i]! > 0 && momentum[i-1]! <= 0) {
          return createBuySignal(cleanData, i, 'Autocorrelation Momentum Buy');
        }

        if (autocorrelation[i]! > autoCorrThreshold && momentum[i]! < 0 && momentum[i-1]! >= 0) {
          return createSellSignal(cleanData, i, 'Autocorrelation Momentum Sell');
        }

        return null;
      }
    );
  }
};
