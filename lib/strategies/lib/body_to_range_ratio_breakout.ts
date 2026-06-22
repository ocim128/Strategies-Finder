import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  extractBarMetricSeries,
  buildCloseAcceptanceSeries,
} from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 25)),
    bodyRatioThreshold: Math.max(0, Math.min(1, Number(params.bodyRatioThreshold ?? 0.70))),
  };
}

export const body_to_range_ratio_breakout: Strategy = {
  name: "Body to Range Ratio Breakout",
  description: "Trades range expansions where the body makes up the vast majority of the range (minimal wicks).",
  defaultParams: {
    lookback: 25,
    bodyRatioThreshold: 0.70,
  },
  paramLabels: {
    lookback: "Lookback Window",
    bodyRatioThreshold: "Body Ratio Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rollingRangeMedian = buildRollingMedian(ranges, lookback);
    const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const bodyRatioThreshold = p.bodyRatioThreshold as number;

    return createSignalLoop(
      cleanData,
      [rollingRangeMedian, bodyPct, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const medRange = rollingRangeMedian[i];
        const bp = bodyPct[i];
        const acceptance = closeAcceptance[i];

        if (medRange === null || bp === null || acceptance === null) return null;

        if (ranges[i] > medRange && bp > bodyRatioThreshold) {
          if (acceptance > 0.5) {
            return createBuySignal(cleanData, i, "Body to range ratio breakout buy");
          }
          if (acceptance < -0.5) {
            return createSellSignal(cleanData, i, "Body to range ratio breakout sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "bodyRatioThreshold"],
  },
};
