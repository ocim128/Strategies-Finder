import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeZScorePhiExhaustionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 55)),
    phi_zscore: Math.max(0.1, Number(params.phi_zscore ?? 1.618)),
  };
}

export const volume_zscore_phi_exhaustion: Strategy = {
  name: "Volume Z-Score Phi Exhaustion",
  description: "A volume spike matching the golden extreme (Z-score > 1.618) on a directional candle represents climactic liquidation. Fade the immediate aftermath.",
  defaultParams: {
    lookback: 55,
    phi_zscore: 1.618,
  },
  paramLabels: {
    lookback: "Volume Lookback",
    phi_zscore: "Phi Z-Score Extreme",
  },
  normalizeParams: normalizeVolumeZScorePhiExhaustionParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeVolumeZScorePhiExhaustionParams(params);
    const lookback = p.lookback as number;
    const phiZScore = p.phi_zscore as number;

    if (cleanData.length < lookback) return [];

    const volumes = getVolumes(cleanData);
    const volZScore = buildRollingZScore(volumes, lookback);

    return createSignalLoop(cleanData, [volZScore], (i) => {
      if (i < lookback + 1) return null;
      
      const currVolZ = volZScore[i - 1]; // check previous bar for the climax
      if (currVolZ === null) return null;

      const prevBar = cleanData[i - 1];
      const currBar = cleanData[i];

      // Buy: Volume Z-Score > phi_zscore AND Close < Open (red day climax) AND Close crosses above prior Close
      if (currVolZ > phiZScore && prevBar.close < prevBar.open && currBar.close > prevBar.close) {
        return createBuySignal(cleanData, i, "Upside reversal from red volume climax");
      }

      // Sell: Volume Z-Score > phi_zscore AND Close > Open (green day climax) AND Close crosses below prior Close
      if (currVolZ > phiZScore && prevBar.close > prevBar.open && currBar.close < prevBar.close) {
        return createSellSignal(cleanData, i, "Downside reversal from green volume climax");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_zscore"],
  },
};