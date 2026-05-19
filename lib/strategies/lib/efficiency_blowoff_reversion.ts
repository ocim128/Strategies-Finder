import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyBlowoffReversionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 14)),
    er_threshold: Math.max(0.1, Math.min(1.0, Number(params.er_threshold ?? 0.7))),
  };
}

export const efficiency_blowoff_reversion: Strategy = {
  name: "Efficiency Blowoff Reversion",
  description: "An Efficiency Ratio near 1.0 implies price moved in almost a straight line. This unnatural linear trajectory represents a blow-off top/bottom that will revert.",
  defaultParams: {
    lookback: 14,
    er_threshold: 0.7,
  },
  paramLabels: {
    lookback: "Efficiency Lookback",
    er_threshold: "Blow-off Threshold",
  },
  normalizeParams: normalizeEfficiencyBlowoffReversionParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeEfficiencyBlowoffReversionParams(params);
    const lookback = p.lookback as number;
    const erThreshold = p.er_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const er = buildEfficiencyRatio(cleanData, lookback);

    return createSignalLoop(cleanData, [er], (i) => {
      if (i < lookback) return null;
      
      const currEr = er[i];
      if (currEr === null) return null;

      const currClose = closes[i];
      const prevClose = closes[i - 1];
      const lookbackClose = closes[i - lookback];

      // Buy: ER > er_threshold AND Close[lookback] > Close (downward blow-off) AND Close > previous Close
      if (currEr > erThreshold && lookbackClose > currClose && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Upside reversal from efficient downside blow-off");
      }

      // Sell: ER > er_threshold AND Close[lookback] < Close (upward blow-off) AND Close < previous Close
      if (currEr > erThreshold && lookbackClose < currClose && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Downside reversal from efficient upside blow-off");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "er_threshold"],
  },
};