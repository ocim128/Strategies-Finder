import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import {
  buildRollingMedian,
  buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    zScoreThreshold: Math.max(0, Number(params.zScoreThreshold ?? 1.8)),
  };
}

export const range_zscore_median_alignment: Strategy = {
  name: "Range Z-Score Median Alignment",
  description: "Fades the ratio when price distance to median is extreme but range is contracting (small).",
  defaultParams: {
    lookback: 30,
    zScoreThreshold: 1.8,
  },
  paramLabels: {
    lookback: "Lookback Window",
    zScoreThreshold: "Z-Score Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const medianCloses = buildRollingMedian(closes, lookback);

    const diff = cleanData.map((_bar, idx) =>
      medianCloses[idx] !== null ? closes[idx] - medianCloses[idx]! : 0
    );
    const diffZScore = buildRollingZScore(diff, lookback);

    const ranges = buildRangeSeries(cleanData);
    const medianRange = buildRollingMedian(ranges, lookback);

    const zScoreThreshold = p.zScoreThreshold as number;

    return createSignalLoop(
      cleanData,
      [diffZScore, medianRange],
      (i) => {
        if (i < lookback) return null;
        const z = diffZScore[i];
        const medRange = medianRange[i];

        if (z === null || medRange === null) return null;

        if (ranges[i] < medRange) {
          if (z <= -zScoreThreshold) {
            return createBuySignal(cleanData, i, "Range z-score median alignment buy");
          }
          if (z >= zScoreThreshold) {
            return createSellSignal(cleanData, i, "Range z-score median alignment sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "zScoreThreshold"],
  },
};
