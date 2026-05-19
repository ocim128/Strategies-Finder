import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

function normalizeSpoofedMedianDivergenceParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    z_threshold: Math.max(0.1, Number(params.z_threshold ?? 3.0)),
    median_shift_max: Math.max(0.000001, Number(params.median_shift_max ?? 0.0005)),
  };
}

export const spoofed_median_divergence: Strategy = {
  name: "Spoofed Median Divergence",
  description: "If price makes a >3 sigma deviation on a micro chart but the rolling median does not shift correspondingly, the move is a spoof or low-volume sweep. Fade it aggressively.",
  defaultParams: {
    lookback: 20,
    z_threshold: 3.0,
    median_shift_max: 0.0005,
  },
  paramLabels: {
    lookback: "Lookback",
    z_threshold: "Z-Score Threshold",
    median_shift_max: "Max Median Shift",
  },
  normalizeParams: normalizeSpoofedMedianDivergenceParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeSpoofedMedianDivergenceParams(params);
    const lookback = p.lookback as number;
    const zThreshold = p.z_threshold as number;
    const medianShiftMax = p.median_shift_max as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const zScore = buildRollingZScore(closes, lookback);
    const median = buildRollingMedian(closes, lookback);

    return createSignalLoop(cleanData, [zScore, median], (i) => {
      if (i < lookback) return null;
      
      const currZ = zScore[i];
      const currMed = median[i];
      const prevMed = median[i - 1];
      
      if (currZ === null || currMed === null || prevMed === null) return null;

      const medianShift = Math.abs((currMed - prevMed) / prevMed);

      // Buy: Price Z-Score < -z_threshold AND median shift < median_shift_max
      if (currZ < -zThreshold && medianShift < medianShiftMax) {
        return createBuySignal(cleanData, i, "Fade downside spoof (median unchanged)");
      }

      // Sell: Price Z-Score > z_threshold AND median shift < median_shift_max
      if (currZ > zThreshold && medianShift < medianShiftMax) {
        return createSellSignal(cleanData, i, "Fade upside spoof (median unchanged)");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "z_threshold", "median_shift_max"],
  },
};