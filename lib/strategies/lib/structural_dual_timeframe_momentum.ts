import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getTypicalPrices, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildDualTimeframeRatio,
  buildRateOfChange
} from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
    slowWindow: Math.max(10, Math.round(params.slowWindow ?? 40)),
    rocThreshold: Number(params.rocThreshold ?? 1.0)
  };
}

export const structural_dual_timeframe_momentum: Strategy = {
  name: 'Structural Dual Timeframe Momentum',
  description: 'Ensures the asset is fundamentally displacing higher on a macro scale, then executes strictly on a micro momentum-thrust cross to minimize drawdown.',
  defaultParams: {
    fastWindow: 5,
    slowWindow: 40,
    rocThreshold: 1.0
  },
  paramLabels: {
    fastWindow: 'Fast DTF Window',
    slowWindow: 'Slow DTF Window',
    rocThreshold: 'ROC Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['fastWindow', 'slowWindow', 'rocThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { fastWindow, slowWindow, rocThreshold } = normalizeParams(params);

    const typicalPrices = getTypicalPrices(cleanData);
    
    const dtfRatio = buildDualTimeframeRatio(typicalPrices, fastWindow, slowWindow, buildRollingAverage);
    // Use fastWindow as the local trigger for ROC
    const roc = buildRateOfChange(typicalPrices, fastWindow).map(v => v !== null ? v * 100 : null);

    return createSignalLoop(
      cleanData,
      [dtfRatio, roc],
      (i) => {
        if (i === 0) return null;
        if (dtfRatio[i] === null || roc[i] === null || roc[i-1] === null) return null;

        if (dtfRatio[i]! > 1.0 && roc[i]! > rocThreshold && roc[i-1]! <= rocThreshold) {
          return createBuySignal(cleanData, i, 'Dual Timeframe Momentum Buy');
        }

        if (dtfRatio[i]! < 1.0 && roc[i]! < -rocThreshold && roc[i-1]! >= -rocThreshold) {
          return createSellSignal(cleanData, i, 'Dual Timeframe Momentum Sell');
        }

        return null;
      }
    );
  }
};

