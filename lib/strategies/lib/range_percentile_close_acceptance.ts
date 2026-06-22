import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  buildCloseAcceptanceSeries,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    rangeThreshold: Math.max(0, Math.min(1, Number(params.rangeThreshold ?? 0.80))),
  };
}

export const range_percentile_close_acceptance: Strategy = {
  name: "Range Percentile Close Acceptance",
  description: "Chases a breakout when the current bar's true range is in a high percentile and close acceptance is highly directional.",
  defaultParams: {
    lookback: 20,
    rangeThreshold: 0.80,
  },
  paramLabels: {
    lookback: "Lookback Window",
    rangeThreshold: "Range Percentile Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rangePercentile = buildPercentileRank(ranges, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const rangeThreshold = p.rangeThreshold as number;

    return createSignalLoop(
      cleanData,
      [rangePercentile, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const pct = rangePercentile[i];
        const acceptance = closeAcceptance[i];

        if (pct === null || acceptance === null) return null;

        if (pct > rangeThreshold) {
          if (acceptance > 0.5) {
            return createBuySignal(cleanData, i, "Range percentile close acceptance buy");
          }
          if (acceptance < -0.5) {
            return createSellSignal(cleanData, i, "Range percentile close acceptance sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "rangeThreshold"],
  },
};
