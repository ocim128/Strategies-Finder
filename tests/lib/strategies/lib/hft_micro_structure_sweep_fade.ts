import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeHftMicroStructureSweepFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    sweep_threshold: Math.max(0.1, Math.min(1.0, Number(params.sweep_threshold ?? 0.6))),
  };
}

export const hft_micro_structure_sweep_fade: Strategy = {
  name: "HFT Micro Structure Sweep Fade",
  description: "An extreme wick that penetrates a short-term moving median but closes back across the open represents a failed liquidity sweep by market makers. Fade the sweep immediately.",
  defaultParams: {
    lookback: 20,
    sweep_threshold: 0.6,
  },
  paramLabels: {
    lookback: "Median Lookback",
    sweep_threshold: "Wick Threshold",
  },
  normalizeParams: normalizeHftMicroStructureSweepFadeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeHftMicroStructureSweepFadeParams(params);
    const lookback = p.lookback as number;
    const sweepThreshold = p.sweep_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const median = buildRollingMedian(closes, lookback);
    
    const ranges = extractBarMetricSeries(cleanData, "range");
    const lowerWicks = extractBarMetricSeries(cleanData, "lowerWick");
    const upperWicks = extractBarMetricSeries(cleanData, "upperWick");

    return createSignalLoop(cleanData, [median], (i) => {
      if (i < lookback) return null;
      
      const currMed = median[i];
      const range = ranges[i];
      const lowerWick = lowerWicks[i];
      const upperWick = upperWicks[i];
      
      if (currMed === null || range === null || lowerWick === null || upperWick === null || range === 0) return null;

      const lowerWickPct = lowerWick / range;
      const upperWickPct = upperWick / range;
      
      const bar = cleanData[i];

      // Buy: Low < Median AND Close > Open AND lowerWickPct > sweep_threshold
      if (bar.low < currMed && bar.close > bar.open && lowerWickPct > sweepThreshold) {
        return createBuySignal(cleanData, i, "Upside fade of downside liquidity sweep");
      }

      // Sell: High > Median AND Close < Open AND upperWickPct > sweep_threshold
      if (bar.high > currMed && bar.close < bar.open && upperWickPct > sweepThreshold) {
        return createSellSignal(cleanData, i, "Downside fade of upside liquidity sweep");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "sweep_threshold"],
  },
};