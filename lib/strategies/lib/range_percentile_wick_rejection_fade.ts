import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  computePriceActionBarMetrics,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 35)),
    rangeThreshold: Math.max(0, Math.min(1, Number(params.rangeThreshold ?? 0.80))),
    wickThreshold: Math.max(0, Math.min(1, Number(params.wickThreshold ?? 0.50))),
  };
}

export const range_percentile_wick_rejection_fade: Strategy = {
  name: "Range Percentile Wick Rejection Fade",
  description: "Fades a range breakout when the current range is high but the bar is dominated by a large upper or lower wick.",
  defaultParams: {
    lookback: 35,
    rangeThreshold: 0.80,
    wickThreshold: 0.50,
  },
  paramLabels: {
    lookback: "Lookback Window",
    rangeThreshold: "Range Percentile Threshold",
    wickThreshold: "Wick Threshold Ratio",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rangePercentileRank = buildPercentileRank(ranges, lookback);

    const barMetrics = cleanData.map(computePriceActionBarMetrics);
    const upperWicks = barMetrics.map((m) => m.upperWick);
    const lowerWicks = barMetrics.map((m) => m.lowerWick);

    const rangeThreshold = p.rangeThreshold as number;
    const wickThreshold = p.wickThreshold as number;

    return createSignalLoop(
      cleanData,
      [rangePercentileRank],
      (i) => {
        if (i < lookback) return null;
        const pct = rangePercentileRank[i];
        const range = ranges[i];

        if (pct === null || range <= 0) return null;

        const lwRatio = lowerWicks[i] / range;
        const uwRatio = upperWicks[i] / range;

        if (pct > rangeThreshold) {
          if (lwRatio > wickThreshold) {
            return createBuySignal(cleanData, i, "Range percentile wick rejection fade buy");
          }
          if (uwRatio > wickThreshold) {
            return createSellSignal(cleanData, i, "Range percentile wick rejection fade sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "rangeThreshold", "wickThreshold"],
  },
};
