import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getVolumes,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  buildCloseAcceptanceSeries,
} from "./price-action-frequency-core";
import {
  buildRollingMedian,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    volumeThreshold: Math.max(0, Math.min(1, Number(params.volumeThreshold ?? 0.70))),
  };
}

export const volume_weighted_range_expansion: Strategy = {
  name: "Volume-Weighted Range Expansion",
  description: "Chases range expansions that are confirmed by high relative proxy volume.",
  defaultParams: {
    lookback: 20,
    volumeThreshold: 0.70,
  },
  paramLabels: {
    lookback: "Lookback Window",
    volumeThreshold: "Volume Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rollingMedianRange = buildRollingMedian(ranges, lookback);
    const volumes = getVolumes(cleanData);
    const volumePercentileRank = buildPercentileRank(volumes, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const volumeThreshold = p.volumeThreshold as number;

    return createSignalLoop(
      cleanData,
      [rollingMedianRange, volumePercentileRank, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const medRange = rollingMedianRange[i];
        const volPct = volumePercentileRank[i];
        const acceptance = closeAcceptance[i];

        if (medRange === null || volPct === null || acceptance === null) return null;

        if (ranges[i] > medRange && volPct > volumeThreshold) {
          if (acceptance > 0.5) {
            return createBuySignal(cleanData, i, "Volume weighted range expansion buy");
          }
          if (acceptance < -0.5) {
            return createSellSignal(cleanData, i, "Volume weighted range expansion sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "volumeThreshold"],
  },
};
