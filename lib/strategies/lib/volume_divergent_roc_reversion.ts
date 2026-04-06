import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getVolumes,
  getOpens,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRateOfChange,
  buildRollingCorrelation
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    rocExtreme: Number(params.rocExtreme ?? 3.0),
    corrLimit: Number(params.corrLimit ?? -0.6)
  };
}

export const volume_divergent_roc_reversion: Strategy = {
  name: 'Volume Divergent ROC Reversion',
  description: 'Maximizes Sharpe by fading momentum extremes exclusively when the price-volume correlation is heavily negative, indicating a ghost-move unsupported by liquidity.',
  defaultParams: {
    lookback: 20,
    rocExtreme: 3.0,
    corrLimit: -0.6
  },
  paramLabels: {
    lookback: 'Lookback Period',
    rocExtreme: 'ROC Extreme %',
    corrLimit: 'Correlation Limit'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'rocExtreme', 'corrLimit']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, rocExtreme, corrLimit } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    const opens = getOpens(cleanData);
    
    // Scale ROC by 100 for percentage
    const roc = buildRateOfChange(closes, lookback).map(v => v !== null ? v * 100 : null);
    const correlation = buildRollingCorrelation(closes, volumes, lookback);

    return createSignalLoop(
      cleanData,
      [roc, correlation],
      (i) => {
        if (roc[i] === null || correlation[i] === null) return null;

        const currentClose = closes[i];
        const currentOpen = opens[i];

        if (roc[i]! < -rocExtreme && correlation[i]! < corrLimit && currentClose > currentOpen) {
          return createBuySignal(cleanData, i, 'Volume Divergent ROC Buy');
        }

        if (roc[i]! > rocExtreme && correlation[i]! < corrLimit && currentClose < currentOpen) {
          return createSellSignal(cleanData, i, 'Volume Divergent ROC Sell');
        }

        return null;
      }
    );
  }
};

