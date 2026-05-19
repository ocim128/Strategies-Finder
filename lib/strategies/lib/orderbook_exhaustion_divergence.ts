import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
  getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeOrderbookExhaustionDivergenceParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    extreme_length: Math.max(3, Math.round(params.extreme_length ?? 10)),
  };
}

export const orderbook_exhaustion_divergence: Strategy = {
  name: "Orderbook Exhaustion Divergence",
  description: "When micro-timeframe price makes a new directional extreme but volume momentum collapses, the move is running on empty air and will immediately reverse.",
  defaultParams: {
    lookback: 20,
    extreme_length: 10,
  },
  paramLabels: {
    lookback: "Volume Z-Score Lookback",
    extreme_length: "Extreme Lookback",
  },
  normalizeParams: normalizeOrderbookExhaustionDivergenceParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeOrderbookExhaustionDivergenceParams(params);
    const lookback = p.lookback as number;
    const extremeLength = p.extreme_length as number;

    const maxLookback = Math.max(lookback, extremeLength);
    if (cleanData.length < maxLookback) return [];

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    const volZScore = buildRollingZScore(volumes, lookback);

    return createSignalLoop(cleanData, [volZScore], (i) => {
      if (i < maxLookback) return null;
      
      const currVolZ = volZScore[i];
      if (currVolZ === null) return null;

      const currClose = closes[i];
      
      // Calculate highest and lowest close in the past `extremeLength` bars (excluding current bar)
      let highestClose = -Infinity;
      let lowestClose = Infinity;
      for (let j = i - extremeLength; j < i; j++) {
        if (closes[j] > highestClose) highestClose = closes[j];
        if (closes[j] < lowestClose) lowestClose = closes[j];
      }

      // Buy: Close < Lowest Close of past extreme_length bars AND Volume Z-Score < -1.0
      if (currClose < lowestClose && currVolZ < -1.0) {
        return createBuySignal(cleanData, i, "Downside extreme spoof fade (low volume)");
      }

      // Sell: Close > Highest Close of past extreme_length bars AND Volume Z-Score < -1.0
      if (currClose > highestClose && currVolZ < -1.0) {
        return createSellSignal(cleanData, i, "Upside extreme spoof fade (low volume)");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "extreme_length"],
  },
};