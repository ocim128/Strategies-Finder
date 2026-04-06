import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getVolumes,
  getHighs,
  getLows,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  buildPivotFlags
} from '../strategy-helpers';
import { 
  buildRollingCorrelation,
  extractBarMetricSeries
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    swingLength: Math.max(2, Math.round(params.swingLength ?? 5)),
    corrLimit: Number(params.corrLimit ?? -0.5),
    closeLocThreshold: Number(params.closeLocThreshold ?? 0.5)
  };
}

export const divergent_pivot_trap: Strategy = {
  name: 'Divergent Pivot Trap',
  description: 'Fades classic Dow Theory pivot breakouts strictly when the price-volume correlation is negative, indicating no broad participation supports the new structural high/low.',
  defaultParams: {
    swingLength: 5,
    corrLimit: -0.5,
    closeLocThreshold: 0.5
  },
  paramLabels: {
    swingLength: 'Pivot Swing Length',
    corrLimit: 'Correlation Limit',
    closeLocThreshold: 'Rejection Boundary'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['swingLength', 'corrLimit', 'closeLocThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { swingLength, corrLimit, closeLocThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const volumes = getVolumes(cleanData);
    
    // Use buildPivotFlags instead of detectPivotsWithDeviation for structure
    const { pivotHighs, pivotLows } = buildPivotFlags(highs, lows, swingLength, 'strict');
    
    // Track the LAST confirmed pivot levels
    let lastPivotHigh: number | null = null;
    let lastPivotLow: number | null = null;
    const lastHighs: (number | null)[] = new Array(cleanData.length).fill(null);
    const lastLows: (number | null)[] = new Array(cleanData.length).fill(null);

    // The pivot flag is marked at the peak/trough bar, so we can track it forward
    for (let i = 0; i < cleanData.length; i++) {
      if (pivotHighs[i]) lastPivotHigh = highs[i];
      if (pivotLows[i]) lastPivotLow = lows[i];
      lastHighs[i] = lastPivotHigh;
      lastLows[i] = lastPivotLow;
    }

    const correlation = buildRollingCorrelation(closes, volumes, 20); // standard 20 lookback for correlation
    const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

    return createSignalLoop(
      cleanData,
      [correlation, closeLocation, lastHighs, lastLows],
      (i) => {
        if (i === 0) return null;
        if (correlation[i] === null || closeLocation[i] === null) return null;
        if (lastHighs[i-1] === null || lastLows[i-1] === null) return null;

        const currentClose = closes[i];
        const lastH = lastHighs[i-1]!;
        const lastL = lastLows[i-1]!;

        if (currentClose < lastL && correlation[i]! < corrLimit && closeLocation[i]! > closeLocThreshold) {
          return createBuySignal(cleanData, i, 'Divergent Pivot Trap Buy');
        }

        if (currentClose > lastH && correlation[i]! < corrLimit && closeLocation[i]! < closeLocThreshold) {
          return createSellSignal(cleanData, i, 'Divergent Pivot Trap Sell');
        }

        return null;
      }
    );
  }
};

