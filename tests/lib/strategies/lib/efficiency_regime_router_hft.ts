import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeEfficiencyRegimeRouterHftParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    er_lookback: Math.max(3, Math.round(params.er_lookback ?? 10)),
    er_threshold: Math.max(0.1, Math.min(1.0, Number(params.er_threshold ?? 0.5))),
    z_threshold: Math.max(0.1, Number(params.z_threshold ?? 2.0)),
  };
}

export const efficiency_regime_router_hft: Strategy = {
  name: "Efficiency Regime Router HFT",
  description: "HFT markets rapidly alternate between random walk and directional toxic flow. Use Efficiency Ratio to route to the correct logic instantly.",
  defaultParams: {
    er_lookback: 10,
    er_threshold: 0.5,
    z_threshold: 2.0,
  },
  paramLabels: {
    er_lookback: "ER Lookback",
    er_threshold: "ER Threshold",
    z_threshold: "Z-Score Threshold",
  },
  normalizeParams: normalizeEfficiencyRegimeRouterHftParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeEfficiencyRegimeRouterHftParams(params);
    const lookback = p.er_lookback as number;
    const erThreshold = p.er_threshold as number;
    const zThreshold = p.z_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const er = buildEfficiencyRatio(cleanData, lookback);
    const zScore = buildRollingZScore(closes, lookback);

    return createSignalLoop(cleanData, [er, zScore], (i) => {
      if (i < lookback) return null;
      
      const currEr = er[i];
      const currZ = zScore[i];
      
      if (currEr === null || currZ === null) return null;

      // Noise Regime (Fade extreme Z-Scores)
      if (currEr < erThreshold) {
        if (currZ < -zThreshold) {
          return createBuySignal(cleanData, i, "Noise Regime: Fading downside extreme");
        }
        if (currZ > zThreshold) {
          return createSellSignal(cleanData, i, "Noise Regime: Fading upside extreme");
        }
      } 
      // Toxic Flow Regime (Chase breaking Z-Scores)
      else {
        if (currZ > zThreshold) {
          return createBuySignal(cleanData, i, "Toxic Flow Regime: Chasing upside breakout");
        }
        if (currZ < -zThreshold) {
          return createSellSignal(cleanData, i, "Toxic Flow Regime: Chasing downside breakdown");
        }
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["er_lookback", "er_threshold", "z_threshold"],
  },
};