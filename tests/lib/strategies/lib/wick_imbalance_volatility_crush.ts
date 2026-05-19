import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeWickImbalanceVolatilityCrushParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 10)),
    crush_z: Math.min(-0.1, Number(params.crush_z ?? -1.5)),
    body_dominance: Math.max(0.5, Math.min(1.0, Number(params.body_dominance ?? 0.9))),
  };
}

export const wick_imbalance_volatility_crush: Strategy = {
  name: "Wick Imbalance Volatility Crush",
  description: "When a sequence of high-wick 'pinging' bars abruptly transitions into a tiny, solid-body 'marubozu' bar, algorithmic indecision has ended.",
  defaultParams: {
    lookback: 10,
    crush_z: -1.5,
    body_dominance: 0.9,
  },
  paramLabels: {
    lookback: "Range Lookback",
    crush_z: "Crush Z-Score",
    body_dominance: "Min Body Pct",
  },
  normalizeParams: normalizeWickImbalanceVolatilityCrushParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeWickImbalanceVolatilityCrushParams(params);
    const lookback = p.lookback as number;
    const crushZ = p.crush_z as number;
    const bodyDominance = p.body_dominance as number;

    if (cleanData.length < lookback) return [];

    const ranges = extractBarMetricSeries(cleanData, "range");
    const rangeZ = buildRollingZScore(ranges, lookback);
    const bodyPcts = extractBarMetricSeries(cleanData, "bodyPct");

    return createSignalLoop(cleanData, [rangeZ], (i) => {
      if (i < lookback) return null;
      
      const currRangeZ = rangeZ[i];
      const currBodyPct = bodyPcts[i];
      
      if (currRangeZ === null || currBodyPct === null) return null;

      const bar = cleanData[i];

      // Buy: Range Z-Score < crush_z AND bodyPct > body_dominance AND Close > Open
      if (currRangeZ < crushZ && currBodyPct > bodyDominance && bar.close > bar.open) {
        return createBuySignal(cleanData, i, "Upside breakout on volatility crush");
      }

      // Sell: Range Z-Score < crush_z AND bodyPct > body_dominance AND Close < Open
      if (currRangeZ < crushZ && currBodyPct > bodyDominance && bar.close < bar.open) {
        return createSellSignal(cleanData, i, "Downside breakdown on volatility crush");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "crush_z", "body_dominance"],
  },
};