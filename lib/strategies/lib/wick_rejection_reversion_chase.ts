import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  computePriceActionBarMetrics,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 24)),
    threshold: Math.max(0, Math.min(0.5, Number(params.threshold ?? 0.10))),
  };
}

export const wick_rejection_reversion_chase: Strategy = {
  name: "Wick Rejection Reversion Chase",
  description: "Enters a reversal trade on the bar following a massive wick rejection, chasing the direction of the rejection once it is confirmed.",
  defaultParams: {
    lookback: 24,
    threshold: 0.10,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Wick Threshold Percentile",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const barMetrics = cleanData.map(computePriceActionBarMetrics);
    const upperWicks = barMetrics.map((m) => m.upperWick);
    const lowerWicks = barMetrics.map((m) => m.lowerWick);

    const upperWickPct = buildPercentileRank(upperWicks, lookback);
    const lowerWickPct = buildPercentileRank(lowerWicks, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [upperWickPct, lowerWickPct],
      (i) => {
        if (i < lookback) return null;
        const prevUpPct = upperWickPct[i - 1];
        const prevDnPct = lowerWickPct[i - 1];

        if (prevUpPct === null || prevDnPct === null) return null;

        const bar = cleanData[i];

        if (prevDnPct > (1 - threshold) && bar.close > bar.open) {
          return createBuySignal(cleanData, i, "Wick rejection reversion chase buy");
        }
        if (prevUpPct > (1 - threshold) && bar.close < bar.open) {
          return createSellSignal(cleanData, i, "Wick rejection reversion chase sell");
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
