import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getTypicalPrices,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import {
  buildStreakCount,
  buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    threshold: Math.max(0, Number(params.threshold ?? 1.8)),
  };
}

export const close_acceptance_streak_reversal: Strategy = {
  name: "Close Acceptance Streak Reversal",
  description: "Fades the typical price when close acceptance has been consistently in one direction for 3 bars and typical price is extreme.",
  defaultParams: {
    lookback: 20,
    threshold: 1.8,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Typical Price Z-Score Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
    const flags = closeAcceptance.map((v) =>
      v <= -0.3 ? -1 : v >= 0.3 ? 1 : 0
    );
    const streak = buildStreakCount(flags);

    const typical = getTypicalPrices(cleanData);
    const typicalZ = buildRollingZScore(typical, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [typicalZ, streak],
      (i) => {
        if (i < lookback) return null;
        const tz = typicalZ[i];
        const str = streak[i];

        if (tz === null || str === null) return null;

        if (tz <= -threshold && str <= -3) {
          return createBuySignal(cleanData, i, "Close acceptance streak reversal buy");
        }
        if (tz >= threshold && str >= 3) {
          return createSellSignal(cleanData, i, "Close acceptance streak reversal sell");
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
