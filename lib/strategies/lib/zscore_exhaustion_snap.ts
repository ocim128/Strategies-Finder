import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeZscoreExhaustionSnapParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    z_threshold: Math.max(0.1, Number(params.z_threshold ?? 2.5)),
  };
}

export const zscore_exhaustion_snap: Strategy = {
  name: "Z-Score Exhaustion Snap",
  description: "Price traversing > 2.5 standard deviations from its rolling mean is a statistical anomaly from forced liquidations, which revert swiftly.",
  defaultParams: {
    lookback: 20,
    z_threshold: 2.5,
  },
  paramLabels: {
    lookback: "Z-Score Lookback",
    z_threshold: "Z-Score Limit",
  },
  normalizeParams: normalizeZscoreExhaustionSnapParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeZscoreExhaustionSnapParams(params);
    const lookback = p.lookback as number;
    const zThreshold = p.z_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const zScore = buildRollingZScore(closes, lookback);

    return createSignalLoop(cleanData, [zScore], (i) => {
      if (i < lookback) return null;
      
      const currZ = zScore[i];
      const prevZ = zScore[i - 1];
      
      if (currZ === null || prevZ === null) return null;

      // Buy: Price Z-Score crosses above -z_threshold after spending at least 1 bar below it
      if (prevZ <= -zThreshold && currZ > -zThreshold) {
        return createBuySignal(cleanData, i, "Upside snapback from downside z-score exhaustion");
      }

      // Sell: Price Z-Score crosses below z_threshold after spending at least 1 bar above it
      if (prevZ >= zThreshold && currZ < zThreshold) {
        return createSellSignal(cleanData, i, "Downside snapback from upside z-score exhaustion");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "z_threshold"],
  },
};