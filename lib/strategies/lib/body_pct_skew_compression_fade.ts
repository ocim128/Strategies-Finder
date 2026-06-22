import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  extractBarMetricSeries,
  buildCloseLocationSeries,
} from "./price-action-frequency-core";
import {
  buildRollingSkewness,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    skewThreshold: Math.max(0, Number(params.skewThreshold ?? 1.0)),
    rangePercentile: Math.max(0, Math.min(1, Number(params.rangePercentile ?? 0.85))),
  };
}

export const body_pct_skew_compression_fade: Strategy = {
  name: "Body PCT Skew Compression Fade",
  description: "Fades large-range expansions when body percentage skewness is positive but the current bar is a low-body, large-wick exhaustion.",
  defaultParams: {
    lookback: 30,
    skewThreshold: 1.0,
    rangePercentile: 0.85,
  },
  paramLabels: {
    lookback: "Lookback Window",
    skewThreshold: "Body PCT Skew Threshold",
    rangePercentile: "Range Percentile Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
    const trueRange = extractBarMetricSeries(cleanData, "trueRange");

    const bodyPctSkew = buildRollingSkewness(bodyPct, lookback);
    const rangePctSeries = buildPercentileRank(trueRange, lookback);
    const closeLocation = buildCloseLocationSeries(cleanData);

    const skewThreshold = p.skewThreshold as number;
    const rangePercentile = p.rangePercentile as number;

    return createSignalLoop(
      cleanData,
      [bodyPctSkew, rangePctSeries, closeLocation],
      (i) => {
        if (i < lookback) return null;
        const skew = bodyPctSkew[i];
        const rangePct = rangePctSeries[i];
        const closeLoc = closeLocation[i];

        if (skew === null || rangePct === null || closeLoc === null) return null;

        // current bodyPct < 0.25
        if (skew > skewThreshold && rangePct > rangePercentile && bodyPct[i] < 0.25) {
          if (closeLoc > 0.7) {
            return createBuySignal(cleanData, i, "Body PCT skew compression fade buy");
          }
          if (closeLoc < 0.3) {
            return createSellSignal(cleanData, i, "Body PCT skew compression fade sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "skewThreshold", "rangePercentile"],
  },
};
