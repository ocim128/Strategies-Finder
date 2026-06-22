import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  extractBarMetricSeries,
  buildCloseAcceptanceSeries,
} from "./price-action-frequency-core";
import {
  buildRateOfChange,
  buildRollingSkewness,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    velocityPercentile: Math.max(0, Math.min(1, Number(params.velocityPercentile ?? 0.85))),
  };
}

export const range_velocity_skew_breakout: Strategy = {
  name: "Range Velocity Skew Breakout",
  description: "Chases a breakout when range velocity (rate of change of true range) skewness spikes, confirming that range expansion is accelerating rapidly.",
  defaultParams: {
    lookback: 30,
    velocityPercentile: 0.85,
  },
  paramLabels: {
    lookback: "Lookback Window",
    velocityPercentile: "Velocity Percentile Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const trueRange = extractBarMetricSeries(cleanData, "trueRange");
    const rangeVelocity = buildRateOfChange(trueRange, 1).map((v) => v ?? 0);

    const skewness = buildRollingSkewness(rangeVelocity, lookback);
    const velocityPercentileRank = buildPercentileRank(rangeVelocity, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const velocityPercentile = p.velocityPercentile as number;

    return createSignalLoop(
      cleanData,
      [skewness, velocityPercentileRank, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const pct = velocityPercentileRank[i];
        const acceptance = closeAcceptance[i];

        if (skew === null || pct === null || acceptance === null) return null;

        if (skew > 1.0 && pct > velocityPercentile) {
          if (acceptance > 0.6) {
            return createBuySignal(cleanData, i, "Range velocity skew breakout buy");
          }
          if (acceptance < -0.6) {
            return createSellSignal(cleanData, i, "Range velocity skew breakout sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "velocityPercentile"],
  },
};
