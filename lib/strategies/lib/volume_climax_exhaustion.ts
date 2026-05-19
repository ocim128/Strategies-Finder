import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeClimaxExhaustionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    vol_lookback: Math.max(3, Math.round(params.vol_lookback ?? 55)),
    vol_z_threshold: Math.max(0.1, Number(params.vol_z_threshold ?? 3.0)),
  };
}

export const volume_climax_exhaustion: Strategy = {
  name: "Volume Climax Exhaustion",
  description: "A massive, multi-sigma volume spike on a directional day usually marks the last buyer/seller entering the market, triggering an immediate reversion.",
  defaultParams: {
    vol_lookback: 55,
    vol_z_threshold: 3.0,
  },
  paramLabels: {
    vol_lookback: "Volume Lookback",
    vol_z_threshold: "Volume Z-Score Threshold",
  },
  normalizeParams: normalizeVolumeClimaxExhaustionParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeVolumeClimaxExhaustionParams(params);
    const lookback = p.vol_lookback as number;
    const volZThreshold = p.vol_z_threshold as number;

    if (cleanData.length < lookback) return [];

    const volumes = getVolumes(cleanData);
    const volZScore = buildRollingZScore(volumes, lookback);

    return createSignalLoop(cleanData, [volZScore], (i) => {
      // Need i-1 for prior close logic
      if (i < lookback + 1) return null;
      
      // We are fading on the close of the climax bar itself, so we check the climax on current bar
      // but wait, the prompt says: "triggers a fade against the climax candle's direction on the close of the climax bar."
      // BUT "Close drops below prior Close" on the same bar implies the bar is red, which is covered by Close < Open.
      // Or does it mean we wait 1 bar? 
      // Prompt logic: "Volume Z-Score > vol_z_threshold AND Close < Open (massive volume on a red day) AND Close drops below prior Close."
      // This implies checking `current_close < previous_close` to ensure the climax bar actually went down relative to the previous day.
      
      const currVolZ = volZScore[i];
      if (currVolZ === null) return null;

      const currBar = cleanData[i];
      const prevBar = cleanData[i - 1];

      // Buy: Volume Z-Score > vol_z_threshold AND Close < Open AND Close drops below prior Close
      if (currVolZ > volZThreshold && currBar.close < currBar.open && currBar.close < prevBar.close) {
        return createBuySignal(cleanData, i, "Upside reversal from red volume climax");
      }

      // Sell: Volume Z-Score > vol_z_threshold AND Close > Open AND Close rises above prior Close
      if (currVolZ > volZThreshold && currBar.close > currBar.open && currBar.close > prevBar.close) {
        return createSellSignal(cleanData, i, "Downside reversal from green volume climax");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["vol_lookback", "vol_z_threshold"],
  },
};