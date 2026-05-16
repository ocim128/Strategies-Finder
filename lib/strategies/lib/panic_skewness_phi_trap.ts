import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    skew_lookback: Math.max(3, Math.round(params.skew_lookback ?? 30)),
    phi_skew: Math.max(0, Number(params.phi_skew ?? 0.382)),
    phi_acceptance: Math.max(0, Math.min(1, Number(params.phi_acceptance ?? 0.382))),
  };
}

export const panic_skewness_phi_trap: Strategy = {
  name: "Panic Skewness Phi Trap",
  description: "When rolling skewness of returns exceeds structural limit but intraday close acceptance rejects the extreme, emotional sellers are mathematically trapped.",
  defaultParams: {
    skew_lookback: 30,
    phi_skew: 0.382,
    phi_acceptance: 0.382,
  },
  paramLabels: {
    skew_lookback: "Skew Lookback",
    phi_skew: "Phi Skew",
    phi_acceptance: "Phi Acceptance",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    if (cleanData.length < p.skew_lookback) return [];

    const closes = getCloses(cleanData);
    const returns = [0];
    for (let i = 1; i < closes.length; i++) {
        returns.push(closes[i-1] !== 0 ? (closes[i] - closes[i-1]) / closes[i-1] : 0);
    }
    const skewness = buildRollingSkewness(returns, p.skew_lookback);
    const acceptance = buildCloseAcceptanceSeries(cleanData);

    return createSignalLoop(cleanData, [skewness, acceptance], (i) => {
      if (i < p.skew_lookback) return null;
      const skew = skewness[i];
      const acc = acceptance[i];
      if (skew === null || acc === null) return null;

      if (skew < -p.phi_skew && acc > (1 - p.phi_acceptance)) {
        return createBuySignal(cleanData, i, "Skewness tail rejection bottom");
      }
      if (skew > p.phi_skew && acc < p.phi_acceptance) {
        return createSellSignal(cleanData, i, "Skewness tail rejection top");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["skew_lookback", "phi_skew", "phi_acceptance"],
  },
};





