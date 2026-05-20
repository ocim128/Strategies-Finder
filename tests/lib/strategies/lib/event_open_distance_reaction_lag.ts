import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData
} from "../strategy-helpers";
import {
  buildPolymarket1sPressureGap,
  buildPolymarket1sReactionGap
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    volLookback: Math.max(5, Math.round(params.volLookback ?? 25)),
    distanceShift: Math.max(0.01, Number(params.distanceShift ?? 0.5)),
    lagSec: Math.max(1, Math.round(params.lagSec ?? 4)),
    minLag: Math.max(0, Number(params.minLag ?? 0.015)),
  };
}

export const event_open_distance_reaction_lag: Strategy = {
  name: "Event Open Distance Reaction Lag",
  description: "Capitalizes on rapid shifts in the Binance-implied event-open boundary distance during volatile event-open periods, entering when Polymarket has lagged in incorporating the shift.",
  defaultParams: {
    volLookback: 25,
    distanceShift: 0.5,
    lagSec: 4,
    minLag: 0.015,
  },
  paramLabels: {
    volLookback: "Vol Lookback",
    distanceShift: "Distance Shift",
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

    if (cleanData.length < p.volLookback) return [];
    
    // #COMPLETION_DRIVE: Assuming Polymarket 1s context is populated when polymarket1sConfig.required is true
    // #SUGGEST_VERIFY: Ensure the caller executes this strategy only with a valid Polymarket 1s execution context
    if (!context?.polymarket1s) return [];

    const pressure = buildPolymarket1sPressureGap(cleanData, context.polymarket1s, { volLookback: p.volLookback });
    const reactionGap = buildPolymarket1sReactionGap(cleanData, context.polymarket1s, {
      volLookback: p.volLookback,
      lagSec: p.lagSec,
    });

    const distanceZ = pressure.distanceZ;

    return createSignalLoop(cleanData, [distanceZ], (i) => {
      if (i < p.volLookback || i < 1) return null;

      const currentZ = distanceZ[i];
      const prevZ = distanceZ[i - 1];
      if (currentZ === null || prevZ === null) return null;

      const gap = reactionGap;
      const longLagEdge = gap.longLagEdge[i];
      const shortLagEdge = gap.shortLagEdge[i];

      if (longLagEdge === null || shortLagEdge === null) return null;

      const shift = currentZ - prevZ;

      if (shift > p.distanceShift && longLagEdge >= p.minLag) {
        return createBuySignal(cleanData, i, "Rapid upward shift in boundary distance with same-side reaction lag edge");
      }
      if (shift < -p.distanceShift && shortLagEdge >= p.minLag) {
        return createSellSignal(cleanData, i, "Rapid downward shift in boundary distance with same-side reaction lag edge");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["volLookback", "distanceShift", "lagSec", "minLag"],
  },
};
