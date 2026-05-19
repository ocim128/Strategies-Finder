import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeRangeZScorePhiSnapbackParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_zscore: Math.max(0.1, Number(params.phi_zscore ?? 1.618)),
    rejection_pct: Math.max(0.1, Math.min(1.0, Number(params.rejection_pct ?? 0.618))),
  };
}

export const range_zscore_phi_snapback: Strategy = {
  name: "Range Z-Score Phi Snapback",
  description: "A single daily bar expanding its true range by a golden Z-score is an emotional capitulation. If that bar closes near its origin, the emotional energy failed. Fade the wick.",
  defaultParams: {
    lookback: 20,
    phi_zscore: 1.618,
    rejection_pct: 0.618,
  },
  paramLabels: {
    lookback: "Range Lookback",
    phi_zscore: "Phi Z-Score Limit",
    rejection_pct: "Min Rejection Pct",
  },
  normalizeParams: normalizeRangeZScorePhiSnapbackParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeRangeZScorePhiSnapbackParams(params);
    const lookback = p.lookback as number;
    const phiZscore = p.phi_zscore as number;
    const rejectionPct = p.rejection_pct as number;

    if (cleanData.length < lookback) return [];

    const ranges = extractBarMetricSeries(cleanData, "range");
    const lowerWicks = extractBarMetricSeries(cleanData, "lowerWick");
    const upperWicks = extractBarMetricSeries(cleanData, "upperWick");
    
    const rangeZ = buildRollingZScore(ranges, lookback);

    return createSignalLoop(cleanData, [rangeZ], (i) => {
      if (i < lookback) return null;
      
      const currRangeZ = rangeZ[i];
      const range = ranges[i];
      const lowerWick = lowerWicks[i];
      const upperWick = upperWicks[i];
      
      if (currRangeZ === null || range === null || lowerWick === null || upperWick === null || range === 0) return null;

      const lowerWickPct = lowerWick / range;
      const upperWickPct = upperWick / range;

      // Buy: Range Z-Score > phi_zscore AND lowerWickPct > rejection_pct
      if (currRangeZ > phiZscore && lowerWickPct > rejectionPct) {
        return createBuySignal(cleanData, i, "Upside snapback from golden range expansion");
      }

      // Sell: Range Z-Score > phi_zscore AND upperWickPct > rejection_pct
      if (currRangeZ > phiZscore && upperWickPct > rejectionPct) {
        return createSellSignal(cleanData, i, "Downside snapback from golden range expansion");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_zscore", "rejection_pct"],
  },
};