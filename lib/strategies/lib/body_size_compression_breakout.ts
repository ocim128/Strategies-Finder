import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  extractBarMetricSeries,
  buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 12)),
    threshold: Math.max(0, Math.min(1, Number(params.threshold ?? 0.60))),
  };
}

export const body_size_compression_breakout: Strategy = {
  name: "Body Size Compression Breakout",
  description: "Chases a breakout when the body size expands significantly after a period of compressed bodies.",
  defaultParams: {
    lookback: 12,
    threshold: 0.60,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Current Body Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
    const avgBodyPct = buildRollingAverage(bodyPct, 5);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [avgBodyPct],
      (i) => {
        if (i < 5 || i < lookback) return null;
        const avgPrev = avgBodyPct[i - 1];
        if (avgPrev === null) return null;

        const bar = cleanData[i];
        const currBodyPct = bodyPct[i];

        if (avgPrev < 0.25 && currBodyPct > threshold) {
          if (bar.close > bar.open) {
            return createBuySignal(cleanData, i, "Body size compression breakout buy");
          }
          if (bar.close < bar.open) {
            return createSellSignal(cleanData, i, "Body size compression breakout sell");
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
