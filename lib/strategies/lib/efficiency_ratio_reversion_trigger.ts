import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildRollingMinMax } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    threshold: Math.max(0, Math.min(1, Number(params.threshold ?? 0.15))),
  };
}

export const efficiency_ratio_reversion_trigger: Strategy = {
  name: "Efficiency Ratio Reversion Trigger",
  description: "Fades price extremes when the rolling efficiency ratio is extremely low (choppy market).",
  defaultParams: {
    lookback: 20,
    threshold: 0.15,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Efficiency Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const efficiency = buildEfficiencyRatio(cleanData, lookback);
    const minMax = buildRollingMinMax(closes, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [efficiency, minMax.min, minMax.max],
      (i) => {
        if (i < lookback) return null;
        const eff = efficiency[i];
        const minClose = minMax.min[i];
        const maxClose = minMax.max[i];

        if (eff === null || minClose === null || maxClose === null) return null;

        const close = closes[i];

        if (eff < threshold) {
          if (close <= minClose) {
            return createBuySignal(cleanData, i, "Efficiency ratio reversion trigger buy");
          }
          if (close >= maxClose) {
            return createSellSignal(cleanData, i, "Efficiency ratio reversion trigger sell");
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
