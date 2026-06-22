import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildCloseLocationSeries,
  computePriceActionBarMetrics,
  extractBarMetricSeries,
} from "./price-action-frequency-core";
import {
  buildRollingSkewness,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 25)),
    wickPercentile: Math.max(0, Math.min(1, Number(params.wickPercentile ?? 0.90))),
  };
}

export const wick_imbalance_skew_exhaustion: Strategy = {
  name: "Wick Imbalance Skew Exhaustion",
  description: "Fades extreme wicks in the direction of the dominant wick skewness when the close fails to validate the push.",
  defaultParams: {
    lookback: 25,
    wickPercentile: 0.90,
  },
  paramLabels: {
    lookback: "Lookback Window",
    wickPercentile: "Wick Percentile Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
    const skewness = buildRollingSkewness(wickImbalance, lookback);

    const barMetrics = cleanData.map(computePriceActionBarMetrics);
    const upperWicks = barMetrics.map((m) => m.upperWick);
    const lowerWicks = barMetrics.map((m) => m.lowerWick);

    const upperWickPct = buildPercentileRank(upperWicks, lookback);
    const lowerWickPct = buildPercentileRank(lowerWicks, lookback);
    const closeLocation = buildCloseLocationSeries(cleanData);

    const wickPercentile = p.wickPercentile as number;

    return createSignalLoop(
      cleanData,
      [skewness, upperWickPct, lowerWickPct, closeLocation],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const upPct = upperWickPct[i];
        const dnPct = lowerWickPct[i];
        const closeLoc = closeLocation[i];

        if (
          skew === null ||
          upPct === null ||
          dnPct === null ||
          closeLoc === null
        ) {
          return null;
        }

        if (skew < -1.0 && dnPct > wickPercentile && closeLoc > 0.6) {
          return createBuySignal(cleanData, i, "Wick Imbalance skew exhaustion buy");
        }
        if (skew > 1.0 && upPct > wickPercentile && closeLoc < 0.4) {
          return createSellSignal(cleanData, i, "Wick Imbalance skew exhaustion sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "wickPercentile"],
  },
};
