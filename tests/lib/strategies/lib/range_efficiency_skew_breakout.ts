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
  buildEfficiencyRatio,
  buildRollingSkewness,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    efficiencySkewThreshold: Math.max(0, Number(params.efficiencySkewThreshold ?? 0.50)),
  };
}

export const range_efficiency_skew_breakout: Strategy = {
  name: "Range Efficiency Skew Breakout",
  description: "Chases breakouts when rolling efficiency skewness is positive, indicating clean trends over chop.",
  defaultParams: {
    lookback: 30,
    efficiencySkewThreshold: 0.50,
  },
  paramLabels: {
    lookback: "Lookback Window",
    efficiencySkewThreshold: "Efficiency Skew Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const efficiencyRaw = buildEfficiencyRatio(cleanData, lookback);
    const efficiencyClean = efficiencyRaw.map((v) => v ?? 0);

    const skewness = buildRollingSkewness(efficiencyClean, lookback);
    const ranges = buildRangeSeries(cleanData);
    const rangePercentile = buildPercentileRank(ranges, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const efficiencySkewThreshold = p.efficiencySkewThreshold as number;

    return createSignalLoop(
      cleanData,
      [skewness, rangePercentile, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const pct = rangePercentile[i];
        const acceptance = closeAcceptance[i];

        if (skew === null || pct === null || acceptance === null) return null;

        if (skew > efficiencySkewThreshold && pct > 0.75) {
          if (acceptance > 0.6) {
            return createBuySignal(cleanData, i, "Range efficiency skew breakout buy");
          }
          if (acceptance < -0.6) {
            return createSellSignal(cleanData, i, "Range efficiency skew breakout sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "efficiencySkewThreshold"],
  },
};
