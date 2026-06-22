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
  buildRollingAverage,
} from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    closeLocThreshold: Math.max(0.5, Math.min(1, Number(params.closeLocThreshold ?? 0.85))),
  };
}

export const compressed_range_close_location_chase: Strategy = {
  name: "Compressed Range Close Location Chase",
  description: "Enters a trade when the range is compressed (rolling average below median) and a bar prints an extreme close location.",
  defaultParams: {
    lookback: 30,
    closeLocThreshold: 0.85,
  },
  paramLabels: {
    lookback: "Lookback Window",
    closeLocThreshold: "Close Location Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const avgRange = buildRollingAverage(ranges, lookback);
    const medianRange = buildRollingMedian(ranges, lookback);
    const closeLocation = buildCloseLocationSeries(cleanData);

    const closeLocThreshold = p.closeLocThreshold as number;

    return createSignalLoop(
      cleanData,
      [avgRange, medianRange, closeLocation],
      (i) => {
        if (i < lookback) return null;
        const avgR = avgRange[i];
        const medR = medianRange[i];
        const closeLoc = closeLocation[i];

        if (avgR === null || medR === null || closeLoc === null) return null;

        if (avgR < medR) {
          if (closeLoc > closeLocThreshold) {
            return createBuySignal(cleanData, i, "Compressed range close location chase buy");
          }
          if (closeLoc < (1 - closeLocThreshold)) {
            return createSellSignal(cleanData, i, "Compressed range close location chase sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "closeLocThreshold"],
  },
};
