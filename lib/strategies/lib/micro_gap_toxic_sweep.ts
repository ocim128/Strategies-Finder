import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
  getOpens,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildRangeSeries } from "./price-action-frequency-core";

function normalizeMicroGapToxicSweepParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    gap_z_threshold: Math.max(0.1, Number(params.gap_z_threshold ?? 2.0)),
  };
}

export const micro_gap_toxic_sweep: Strategy = {
  name: "Micro Gap Toxic Sweep",
  description: "On tick or 1-second data, a gap between close and open implies the entire resting limit book at that price level was swept instantly. Join the toxic sweep.",
  defaultParams: {
    lookback: 20,
    gap_z_threshold: 2.0,
  },
  paramLabels: {
    lookback: "Range Lookback",
    gap_z_threshold: "Gap Z-Score",
  },
  normalizeParams: normalizeMicroGapToxicSweepParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeMicroGapToxicSweepParams(params);
    const lookback = p.lookback as number;
    const gapZThreshold = p.gap_z_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    // Instead of using computePriceActionBarMetrics in the hot loop,
    // we use buildRangeSeries directly since we just need range for the z-score
    const ranges = buildRangeSeries(cleanData);
    
    // We get the Z-Score of the range array to compare against our current gap
    const rangeZ = buildRollingZScore(ranges, lookback);

    return createSignalLoop(cleanData, [rangeZ], (i) => {
      if (i < lookback) return null;
      
      const prevClose = closes[i - 1];
      const open = opens[i];
      const close = closes[i];
      
      const gap = Math.abs(open - prevClose);
      
      // We estimate the gap's z-score by seeing what the gap size would be 
      // in the context of recent bar ranges. We need the standard deviation 
      // of recent ranges. To avoid re-calculating, we check if the current gap 
      // exceeds (mean + zThreshold * stdDev). 
      // A more robust way is just calculating the gap Z-score directly.
      
      // Calculate local range mean and stddev
      let sum = 0;
      for (let j = i - lookback; j < i; j++) sum += ranges[j];
      const mean = sum / lookback;
      
      let sumSq = 0;
      for (let j = i - lookback; j < i; j++) sumSq += Math.pow(ranges[j] - mean, 2);
      const stdDev = Math.sqrt(sumSq / lookback) || 0.0001; // prevent div by 0
      
      const gapZ = (gap - mean) / stdDev;

      // Buy: Open > previous Close AND gap_z > gap_z_threshold AND Close > Open
      if (open > prevClose && gapZ > gapZThreshold && close > open) {
        return createBuySignal(cleanData, i, "Upside toxic sweep gap");
      }

      // Sell: Open < previous Close AND gap_z > gap_z_threshold AND Close < Open
      if (open < prevClose && gapZ > gapZThreshold && close < open) {
        return createSellSignal(cleanData, i, "Downside toxic sweep gap");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "gap_z_threshold"],
  },
};