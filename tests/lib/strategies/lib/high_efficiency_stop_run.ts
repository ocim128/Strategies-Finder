import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeHighEfficiencyStopRunParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    er_lookback: Math.max(3, Math.round(params.er_lookback ?? 10)),
    er_threshold: Math.max(0.1, Math.min(1.0, Number(params.er_threshold ?? 0.8))),
    wick_threshold: Math.max(0.1, Math.min(1.0, Number(params.wick_threshold ?? 0.6))),
  };
}

export const high_efficiency_stop_run: Strategy = {
  name: "High Efficiency Stop Run",
  description: "When a micro-trend exhibits extreme straight-line efficiency, but suddenly prints a massive rejection wick against that trend, it was a pure stop-run. Fade it instantly.",
  defaultParams: {
    er_lookback: 10,
    er_threshold: 0.8,
    wick_threshold: 0.6,
  },
  paramLabels: {
    er_lookback: "ER Lookback",
    er_threshold: "ER Threshold",
    wick_threshold: "Wick Threshold",
  },
  normalizeParams: normalizeHighEfficiencyStopRunParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeHighEfficiencyStopRunParams(params);
    const lookback = p.er_lookback as number;
    const erThreshold = p.er_threshold as number;
    const wickThreshold = p.wick_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const er = buildEfficiencyRatio(cleanData, lookback);
    
    // Instead of computing all metrics on every bar inside the loop, extract the wick arrays upfront.
    // The extractor string uses "upperWick" and "lowerWick" directly, but those are absolute amounts.
    // We want percentages, so we map them dividing by range.
    const ranges = extractBarMetricSeries(cleanData, "range");
    const lowerWicks = extractBarMetricSeries(cleanData, "lowerWick");
    const upperWicks = extractBarMetricSeries(cleanData, "upperWick");

    return createSignalLoop(cleanData, [er], (i) => {
      if (i < lookback) return null;
      
      const currEr = er[i];
      if (currEr === null) return null;

      const currClose = closes[i];
      const lookbackClose = closes[i - lookback];
      
      const range = ranges[i];
      const lowerWick = lowerWicks[i];
      const upperWick = upperWicks[i];
      
      if (range === null || lowerWick === null || upperWick === null || range === 0) return null;

      const lowerWickPct = lowerWick / range;
      const upperWickPct = upperWick / range;

      // Buy: ER > er_threshold AND Close < Close[er_lookback] (down trend) AND lowerWickPct > wick_threshold
      if (currEr > erThreshold && currClose < lookbackClose && lowerWickPct > wickThreshold) {
        return createBuySignal(cleanData, i, "V-bottom rejection on efficient downtrend");
      }

      // Sell: ER > er_threshold AND Close > Close[er_lookback] (up trend) AND upperWickPct > wick_threshold
      if (currEr > erThreshold && currClose > lookbackClose && upperWickPct > wickThreshold) {
        return createSellSignal(cleanData, i, "V-top rejection on efficient uptrend");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["er_lookback", "er_threshold", "wick_threshold"],
  },
};