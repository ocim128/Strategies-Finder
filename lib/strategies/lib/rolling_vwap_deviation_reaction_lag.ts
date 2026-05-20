import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getHighs,
  getLows,
  getCloses,
  getVolumes
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingStdDev } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    stdDevThreshold: Math.max(0, Number(params.stdDevThreshold ?? 1.5)),
    lagSec: Math.max(1, Math.round(params.lagSec ?? 3)),
    minLag: Math.max(0, Number(params.minLag ?? 0.01)),
  };
}

export const rolling_vwap_deviation_reaction_lag: Strategy = {
  name: "Rolling VWAP Deviation Reaction Lag",
  description: "Captures strong, institutionally-significant deviations from the rolling volume-weighted average price (VWAP) on Binance, gating entries on a confirmed Polymarket reaction lag.",
  defaultParams: {
    lookback: 30,
    stdDevThreshold: 1.5,
    lagSec: 3,
    minLag: 0.01,
  },
  paramLabels: {
    lookback: "Lookback",
    stdDevThreshold: "StdDev Threshold",
    lagSec: "Lag Seconds",
    minLag: "Min Lag Edge",
  },
  normalizeParams,
  polymarket1sConfig: {
    required: true,
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);

    if (cleanData.length < p.lookback) return [];
    
    // #COMPLETION_DRIVE: Assuming Polymarket 1s context is populated when polymarket1sConfig.required is true
    // #SUGGEST_VERIFY: Ensure the caller executes this strategy only with a valid Polymarket 1s execution context
    if (!context?.polymarket1s) return [];

    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);

    const vwap = calculateVWAP(highs, lows, closes, volumes, p.lookback);
    const stdDev = buildRollingStdDev(closes, p.lookback);
    const reactionGap = buildPolymarket1sReactionGap(cleanData, context.polymarket1s, {
      volLookback: p.lookback,
      lagSec: p.lagSec,
    });

    return createSignalLoop(cleanData, [vwap, stdDev], (i) => {
      if (i < p.lookback) return null;

      const vwapVal = vwap[i];
      const sd = stdDev[i];
      if (vwapVal === null || sd === null) return null;

      const close = closes[i];
      const gap = reactionGap;
      const longLagEdge = gap.longLagEdge[i];
      const shortLagEdge = gap.shortLagEdge[i];

      if (longLagEdge === null || shortLagEdge === null) return null;

      if (close > (vwapVal + p.stdDevThreshold * sd)) {
        if (longLagEdge >= p.minLag) {
          return createBuySignal(cleanData, i, "Deviation above VWAP with same-side reaction lag edge");
        }
      }
      if (close < (vwapVal - p.stdDevThreshold * sd)) {
        if (shortLagEdge >= p.minLag) {
          return createSellSignal(cleanData, i, "Deviation below VWAP with same-side reaction lag edge");
        }
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "stdDevThreshold", "lagSec", "minLag"],
  },
};
