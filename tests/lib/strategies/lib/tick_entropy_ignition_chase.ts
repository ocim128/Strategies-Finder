import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeTickEntropyIgnitionChaseParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 10)),
    ignition_threshold: Math.max(0, Number(params.ignition_threshold ?? 0.1)),
  };
}

export const tick_entropy_ignition_chase: Strategy = {
  name: "Tick Entropy Ignition Chase",
  description: "On micro-timeframes, the exact bar where entropy collapses to zero represents algorithmic ignition. Join the ignition instantly.",
  defaultParams: {
    lookback: 10,
    ignition_threshold: 0.1,
  },
  paramLabels: {
    lookback: "Entropy Lookback",
    ignition_threshold: "Ignition Threshold",
  },
  normalizeParams: normalizeTickEntropyIgnitionChaseParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeTickEntropyIgnitionChaseParams(params);
    const lookback = p.lookback as number;
    const ignitionThreshold = p.ignition_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const entropy = buildRollingEntropy(closes, lookback);

    return createSignalLoop(cleanData, [entropy], (i) => {
      if (i < lookback) return null;
      
      const currEntropy = entropy[i];
      const prevEntropy = entropy[i - 1];
      
      if (currEntropy === null || prevEntropy === null) return null;

      const currClose = closes[i];
      const prevClose = closes[i - 1];

      // We want to trigger when entropy drops below the threshold for the first time
      const entropyIgnition = prevEntropy >= ignitionThreshold && currEntropy < ignitionThreshold;

      // Buy: Entropy crosses below ignition_threshold AND Close > Close[1]
      if (entropyIgnition && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Chase upside algorithmic ignition");
      }

      // Sell: Entropy crosses below ignition_threshold AND Close < Close[1]
      if (entropyIgnition && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Chase downside algorithmic ignition");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "ignition_threshold"],
  },
};