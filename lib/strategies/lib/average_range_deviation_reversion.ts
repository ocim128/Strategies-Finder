import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
  checkCrossover,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  buildRollingAverage,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    rangeAvgPercentile: Math.max(0, Math.min(1, Number(params.rangeAvgPercentile ?? 0.80))),
  };
}

export const average_range_deviation_reversion: Strategy = {
  name: "Average Range Deviation Reversion",
  description: "Fades the ratio when rolling average range is extremely high and the close crosses its average.",
  defaultParams: {
    lookback: 30,
    rangeAvgPercentile: 0.80,
  },
  paramLabels: {
    lookback: "Lookback Window",
    rangeAvgPercentile: "Range Avg Percentile",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const avgRangeRaw = buildRollingAverage(ranges, lookback);
    const avgRange = avgRangeRaw.map((v) => v ?? 0);
    const avgRangePercentile = buildPercentileRank(avgRange, lookback);

    const closes = getCloses(cleanData);
    const avgCloses = buildRollingAverage(closes, lookback);

    const rangeAvgPercentile = p.rangeAvgPercentile as number;

    return createSignalLoop(
      cleanData,
      [avgRangePercentile, avgCloses],
      (i) => {
        if (
          i < lookback ||
          avgRangePercentile[i] === null ||
          avgCloses[i] === null ||
          avgCloses[i - 1] === null
        ) {
          return null;
        }

        const pct = avgRangePercentile[i]!;
        const cross = checkCrossover(closes, avgCloses, i);

        if (pct > rangeAvgPercentile) {
          if (cross === "bullish") {
            return createBuySignal(cleanData, i, "Average range deviation reversion buy");
          }
          if (cross === "bearish") {
            return createSellSignal(cleanData, i, "Average range deviation reversion sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "rangeAvgPercentile"],
  },
};
