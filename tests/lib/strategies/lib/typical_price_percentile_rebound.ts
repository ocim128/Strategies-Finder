import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getTypicalPrices,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 24)),
    threshold: Math.max(0, Math.min(0.5, Number(params.threshold ?? 0.05))),
  };
}

export const typical_price_percentile_rebound: Strategy = {
  name: "Typical Price Percentile Rebound",
  description: "Fades extreme typical price stretches when the current bar shows a directional rejection (close > open for long, close < open for short).",
  defaultParams: {
    lookback: 24,
    threshold: 0.05,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Threshold Percentile",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const typical = getTypicalPrices(cleanData);
    const typicalPct = buildPercentileRank(typical, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [typicalPct],
      (i) => {
        if (i < lookback) return null;
        const pct = typicalPct[i];
        if (pct === null) return null;

        const bar = cleanData[i];
        if (pct <= threshold && bar.close > bar.open) {
          return createBuySignal(cleanData, i, "Typical price percentile rebound buy");
        }
        if (pct >= (1 - threshold) && bar.close < bar.open) {
          return createSellSignal(cleanData, i, "Typical price percentile rebound sell");
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
