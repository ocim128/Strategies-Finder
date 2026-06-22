import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  buildCloseLocationSeries,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 24)),
    threshold: Math.max(0, Math.min(0.5, Number(params.threshold ?? 0.20))),
  };
}

export const range_percentile_momentum_chase: Strategy = {
  name: "Range Percentile Momentum Chase",
  description: "Chases a breakout when the range is in a high percentile and the close location is extreme.",
  defaultParams: {
    lookback: 24,
    threshold: 0.20,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Threshold Percentile Offset",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rangePct = buildPercentileRank(ranges, lookback);
    const closeLoc = buildCloseLocationSeries(cleanData);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [rangePct, closeLoc],
      (i) => {
        if (i < lookback) return null;
        const pct = rangePct[i];
        const cl = closeLoc[i];

        if (pct === null || cl === null) return null;

        if (pct > (1 - threshold)) {
          if (cl > 0.80) {
            return createBuySignal(cleanData, i, "Range percentile momentum chase buy");
          }
          if (cl < 0.20) {
            return createSellSignal(cleanData, i, "Range percentile momentum chase sell");
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
