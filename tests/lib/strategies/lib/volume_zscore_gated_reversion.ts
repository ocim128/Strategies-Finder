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

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    threshold: Math.max(0, Number(params.threshold ?? 2.0)),
  };
}

export const volume_zscore_gated_reversion: Strategy = {
  name: "Volume Z-Score Gated Reversion",
  description: "Fades price extremes that occur on massive volume spikes.",
  defaultParams: {
    lookback: 30,
    threshold: 2.0,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Price Z-Score Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    const closeZ = buildRollingZScore(closes, lookback);
    const volumeZ = buildRollingZScore(volumes, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [closeZ, volumeZ],
      (i) => {
        if (i < lookback) return null;
        const cz = closeZ[i];
        const vz = volumeZ[i];

        if (cz === null || vz === null) return null;

        if (vz > 2.0) {
          if (cz <= -threshold) {
            return createBuySignal(cleanData, i, "Volume z-score gated reversion buy");
          }
          if (cz >= threshold) {
            return createSellSignal(cleanData, i, "Volume z-score gated reversion sell");
          }
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
