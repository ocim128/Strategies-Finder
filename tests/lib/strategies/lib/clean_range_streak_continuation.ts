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

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 15)),
    streakLen: Math.max(1, Math.round(params.streakLen ?? 3)),
  };
}

export const clean_range_streak_continuation: Strategy = {
  name: "Clean Range Streak Continuation",
  description: "Chases a breakout when the ratio prints a streak of consecutive bars with expanding ranges and directional close locations.",
  defaultParams: {
    lookback: 15,
    streakLen: 3,
  },
  paramLabels: {
    lookback: "Lookback Window",
    streakLen: "Streak Length",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    const streakLen = p.streakLen as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const closeLocation = buildCloseLocationSeries(cleanData);

    return createSignalLoop(
      cleanData,
      [ranges, closeLocation],
      (i) => {
        if (i < streakLen) return null;

        let isBuy = true;
        let isSell = true;

        for (let k = 0; k < streakLen; k++) {
          const idx = i - k;
          if (ranges[idx] <= ranges[idx - 1]) {
            isBuy = false;
            isSell = false;
            break;
          }
          if (closeLocation[idx] <= 0.5) {
            isBuy = false;
          }
          if (closeLocation[idx] >= 0.5) {
            isSell = false;
          }
        }

        if (isBuy) {
          return createBuySignal(cleanData, i, "Clean range streak continuation buy");
        }
        if (isSell) {
          return createSellSignal(cleanData, i, "Clean range streak continuation sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "streakLen"],
  },
};
