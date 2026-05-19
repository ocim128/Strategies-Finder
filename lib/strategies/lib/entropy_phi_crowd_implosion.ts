import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeEntropyPhiCrowdImplosionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_conjugate: Math.max(0.1, Math.min(1.0, Number(params.phi_conjugate ?? 0.382))),
  };
}

export const entropy_phi_crowd_implosion: Strategy = {
  name: "Entropy Phi Crowd Implosion",
  description: "When information entropy collapses below the golden conjugate (0.382), the sequence is too predictable. Fade the crowd the instant this unnatural structure cracks.",
  defaultParams: {
    lookback: 20,
    phi_conjugate: 0.382,
  },
  paramLabels: {
    lookback: "Entropy Lookback",
    phi_conjugate: "Phi Conjugate Limit",
  },
  normalizeParams: normalizeEntropyPhiCrowdImplosionParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeEntropyPhiCrowdImplosionParams(params);
    const lookback = p.lookback as number;
    const phiConjugate = p.phi_conjugate as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const entropy = buildRollingEntropy(closes, lookback);

    return createSignalLoop(cleanData, [entropy], (i) => {
      if (i < lookback + 1) return null;
      
      const prevEntropy = entropy[i - 1];
      if (prevEntropy === null) return null;

      const currClose = closes[i];
      const prevClose = closes[i - 1];
      const prevPrevClose = closes[i - 2];

      // Buy: Previous Entropy < phi_conjugate AND Close < previous Close (down trend) AND current Close > previous Close
      if (prevEntropy < phiConjugate && prevClose < prevPrevClose && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Fade broken unnatural downtrend (low entropy)");
      }

      // Sell: Previous Entropy < phi_conjugate AND Close > previous Close (up trend) AND current Close < previous Close
      if (prevEntropy < phiConjugate && prevClose > prevPrevClose && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Fade broken unnatural uptrend (low entropy)");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_conjugate"],
  },
};