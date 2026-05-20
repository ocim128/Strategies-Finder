import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    pressureThreshold: Math.max(0, Number(params.pressureThreshold ?? 0.6)),
    lagSec: Math.max(1, Math.round(params.lagSec ?? 5)),
    minLag: Math.max(0, Number(params.minLag ?? 0.02)),
  };
}

export const initiative_pressure_lag_exhaustion: Strategy = {
  name: "Initiative Pressure Lag Exhaustion",
  description: "Enters trades when a high-conviction buying or selling sweep occurs on Binance, provided that the Polymarket executable price is underreacting and exhibits a lag in adjusting to the sudden spot pressure.",
  defaultParams: {
    lookback: 20,
    pressureThreshold: 0.6,
    lagSec: 5,
    minLag: 0.02,
  },
  paramLabels: {
    lookback: "Lookback",
    pressureThreshold: "Pressure Threshold",
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

    const spotPressure = buildInitiativePressureSeries(cleanData, p.lookback);
    const reactionGap = buildPolymarket1sReactionGap(cleanData, context.polymarket1s, {
      volLookback: p.lookback,
      lagSec: p.lagSec,
    });

    return createSignalLoop(cleanData, [spotPressure], (i) => {
      if (i < p.lookback) return null;

      const pressure = spotPressure[i];
      if (pressure === null) return null;

      const gap = reactionGap;
      const longLagEdge = gap.longLagEdge[i];
      const shortLagEdge = gap.shortLagEdge[i];

      if (longLagEdge === null || shortLagEdge === null) return null;

      if (pressure > p.pressureThreshold) {
        if (longLagEdge >= p.minLag) {
          return createBuySignal(cleanData, i, "Initiative buying pressure dominance with Polymarket long reaction lag");
        }
      }
      if (pressure < -p.pressureThreshold) {
        if (shortLagEdge >= p.minLag) {
          return createSellSignal(cleanData, i, "Initiative selling pressure dominance with Polymarket short reaction lag");
        }
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "pressureThreshold", "lagSec", "minLag"],
  },
};
