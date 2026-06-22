import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 12)),
    threshold: Math.max(-1, Math.min(1, Number(params.threshold ?? -0.20))),
  };
}

export const short_term_autocorrelation_reversal: Strategy = {
  name: "Short-Term Autocorrelation Reversal",
  description: "Fades the previous bar's return when the short-term autocorrelation is highly negative.",
  defaultParams: {
    lookback: 12,
    threshold: -0.20,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Autocorrelation Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const returnsRaw = buildRateOfChange(closes, 1);
    const returns = returnsRaw.map((v) => v ?? 0);
    const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [autoCorr],
      (i) => {
        if (i < lookback) return null;
        const ac = autoCorr[i];
        if (ac === null) return null;

        const prevReturn = returns[i - 1];
        const bar = cleanData[i];

        if (ac < threshold) {
          if (prevReturn < 0 && bar.close > bar.open) {
            return createBuySignal(cleanData, i, "Short-term autocorrelation reversal buy");
          }
          if (prevReturn > 0 && bar.close < bar.open) {
            return createSellSignal(cleanData, i, "Short-term autocorrelation reversal sell");
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
