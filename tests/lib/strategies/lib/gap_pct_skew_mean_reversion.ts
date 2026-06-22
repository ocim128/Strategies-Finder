import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import {
  buildRollingSkewness,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 35)),
    gapPercentile: Math.max(0, Math.min(1, Number(params.gapPercentile ?? 0.95))),
  };
}

export const gap_pct_skew_mean_reversion: Strategy = {
  name: "Gap PCT Skew Mean Reversion",
  description: "Fades large opening gaps when the gap percentile is opposite to the prevailing gap skewness.",
  defaultParams: {
    lookback: 35,
    gapPercentile: 0.95,
  },
  paramLabels: {
    lookback: "Lookback Window",
    gapPercentile: "Gap Percentile Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const gapPct = extractBarMetricSeries(cleanData, "gapPct");
    const skewness = buildRollingSkewness(gapPct, lookback);
    const gapPercentileRank = buildPercentileRank(gapPct, lookback);

    const gapPercentile = p.gapPercentile as number;

    return createSignalLoop(
      cleanData,
      [skewness, gapPercentileRank],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const pct = gapPercentileRank[i];

        if (skew === null || pct === null) return null;

        if (skew > 1.0 && pct < (1 - gapPercentile)) {
          return createBuySignal(cleanData, i, "Gap PCT skew mean reversion buy");
        }
        if (skew < -1.0 && pct > gapPercentile) {
          return createSellSignal(cleanData, i, "Gap PCT skew mean reversion sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "gapPercentile"],
  },
};
