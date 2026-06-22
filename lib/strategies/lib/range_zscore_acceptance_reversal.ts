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
  extractBarMetricSeries,
} from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    rangeZThreshold: Math.max(0, Number(params.rangeZThreshold ?? 2.0)),
  };
}

export const range_zscore_acceptance_reversal: Strategy = {
  name: "Range Z-Score Acceptance Reversal",
  description: "Fades extreme range expansions when the close fails to validate the breakout direction, indicating intraday exhaustion.",
  defaultParams: {
    lookback: 30,
    rangeZThreshold: 2.0,
  },
  paramLabels: {
    lookback: "Lookback Window",
    rangeZThreshold: "Range Z-Score Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const rangeZScore = buildRollingZScore(ranges, lookback);
    const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
    const closeLocation = buildCloseLocationSeries(cleanData);

    const rangeZThreshold = p.rangeZThreshold as number;

    return createSignalLoop(
      cleanData,
      [rangeZScore, bodyDirection, closeLocation],
      (i) => {
        if (i < lookback) return null;
        const z = rangeZScore[i];
        const bodyDir = bodyDirection[i];
        const closeLoc = closeLocation[i];

        if (z === null || bodyDir === null || closeLoc === null) return null;

        if (z > rangeZThreshold) {
          if (bodyDir === -1 && closeLoc > 0.7) {
            return createBuySignal(cleanData, i, "Range z-score acceptance reversal buy");
          }
          if (bodyDir === 1 && closeLoc < 0.3) {
            return createSellSignal(cleanData, i, "Range z-score acceptance reversal sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "rangeZThreshold"],
  },
};
