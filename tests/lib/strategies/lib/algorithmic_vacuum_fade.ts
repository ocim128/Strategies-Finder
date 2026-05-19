import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeAlgorithmicVacuumFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 5)),
    entropy_threshold: Math.max(0, Number(params.entropy_threshold ?? 0.01)),
  };
}

export const algorithmic_vacuum_fade: Strategy = {
  name: "Algorithmic Vacuum Fade",
  description: "When sequence entropy drops to absolute zero on a micro timeframe, algorithms are perfectly walking the price. Fade when this breaks.",
  defaultParams: {
    lookback: 5,
    entropy_threshold: 0.01,
  },
  paramLabels: {
    lookback: "Entropy Lookback",
    entropy_threshold: "Entropy Threshold",
  },
  normalizeParams: normalizeAlgorithmicVacuumFadeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeAlgorithmicVacuumFadeParams(params);
    const lookback = p.lookback as number;
    const entropyThreshold = p.entropy_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const entropy = buildRollingEntropy(closes, lookback);

    return createSignalLoop(cleanData, [entropy], (i) => {
      // Need i-2 for the previous close logic
      if (i < lookback + 1) return null;
      
      const prevEntropy = entropy[i - 1];
      if (prevEntropy === null) return null;

      const currClose = closes[i];
      const prevClose = closes[i - 1];
      const prevPrevClose = closes[i - 2];

      // Buy: Prev Entropy < threshold AND Close < prev Close (downward walk) AND current Close > prev Close
      if (prevEntropy < entropyThreshold && prevClose < prevPrevClose && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Vacuum fade (downward algo walk broken)");
      }

      // Sell: Prev Entropy < threshold AND Close > prev Close (upward walk) AND current Close < prev Close
      if (prevEntropy < entropyThreshold && prevClose > prevPrevClose && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Vacuum fade (upward algo walk broken)");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "entropy_threshold"],
  },
};