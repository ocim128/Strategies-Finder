import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyPhiExhaustionFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_efficiency: Math.max(0.1, Math.min(1.0, Number(params.phi_efficiency ?? 0.618))),
  };
}

export const efficiency_phi_exhaustion_fade: Strategy = {
  name: "Efficiency Phi Exhaustion Fade",
  description: "When Kaufman's Efficiency Ratio exceeds the golden threshold (0.618), the trend is too perfectly linear, crowded, and fragile. It will violently revert upon the first counter-close.",
  defaultParams: {
    lookback: 20,
    phi_efficiency: 0.618,
  },
  paramLabels: {
    lookback: "Efficiency Lookback",
    phi_efficiency: "Golden Threshold",
  },
  normalizeParams: normalizeEfficiencyPhiExhaustionFadeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeEfficiencyPhiExhaustionFadeParams(params);
    const lookback = p.lookback as number;
    const phiEfficiency = p.phi_efficiency as number;

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

      // Buy: ER > phi_efficiency AND Close < Close[lookback] (downward trend) AND Close > previous Close
      if (currEr > phiEfficiency && currClose < lookbackClose && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Fade hyper-efficient downtrend on first pivot");
      }

      // Sell: ER > phi_efficiency AND Close > Close[lookback] (upward trend) AND Close < previous Close
      if (currEr > phiEfficiency && currClose > lookbackClose && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Fade hyper-efficient uptrend on first pivot");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_efficiency"],
  },
};