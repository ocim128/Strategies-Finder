import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getTypicalPrices,
  checkCrossover,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 24)),
    threshold: Math.max(0, Number(params.threshold ?? 1.5)),
  };
}

export const typical_price_deviation_crossover: Strategy = {
  name: "Typical Price Deviation Crossover",
  description: "Triggers a mean-reversion trade when typical price deviates from its rolling average by more than a standard deviation threshold, and typical price crosses back over the average.",
  defaultParams: {
    lookback: 24,
    threshold: 1.5,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Deviation Z-Score Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const typical = getTypicalPrices(cleanData);
    const typicalZ = buildRollingZScore(typical, lookback);
    const avgTypical = buildRollingAverage(typical, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [typicalZ, avgTypical],
      (i) => {
        if (
          i < lookback ||
          typicalZ[i - 1] === null ||
          avgTypical[i] === null ||
          avgTypical[i - 1] === null
        ) {
          return null;
        }

        const prevZ = typicalZ[i - 1]!;
        const cross = checkCrossover(typical, avgTypical, i);

        if (prevZ <= -threshold && cross === "bullish") {
          return createBuySignal(cleanData, i, "Typical price deviation crossover buy");
        }
        if (prevZ >= threshold && cross === "bearish") {
          return createSellSignal(cleanData, i, "Typical price deviation crossover sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "threshold"],
  },
};
