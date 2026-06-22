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
import {
  buildRollingMedian,
  buildEfficiencyRatio,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 25)),
    efficiencyThreshold: Math.max(0, Math.min(1, Number(params.efficiencyThreshold ?? 0.40))),
  };
}

export const range_ratio_efficiency_breakout: Strategy = {
  name: "Range Ratio Efficiency Breakout",
  description: "Chases a range breakout only when the efficiency ratio is high.",
  defaultParams: {
    lookback: 25,
    efficiencyThreshold: 0.40,
  },
  paramLabels: {
    lookback: "Lookback Window",
    efficiencyThreshold: "Efficiency Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rollingMedianRange = buildRollingMedian(ranges, lookback);
    const efficiency = buildEfficiencyRatio(cleanData, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const efficiencyThreshold = p.efficiencyThreshold as number;

    return createSignalLoop(
      cleanData,
      [rollingMedianRange, efficiency, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const medRange = rollingMedianRange[i];
        const eff = efficiency[i];
        const acceptance = closeAcceptance[i];

        if (medRange === null || eff === null || acceptance === null) return null;

        if (ranges[i] > medRange && eff > efficiencyThreshold) {
          if (acceptance > 0.5) {
            return createBuySignal(cleanData, i, "Range ratio efficiency breakout buy");
          }
          if (acceptance < -0.5) {
            return createSellSignal(cleanData, i, "Range ratio efficiency breakout sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "efficiencyThreshold"],
  },
};
