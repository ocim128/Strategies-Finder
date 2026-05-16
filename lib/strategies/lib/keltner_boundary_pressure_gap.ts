import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getHighs,
  getLows,
  getCloses
} from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    keltnerPeriod: Math.max(2, Math.round(params.keltnerPeriod ?? 20)),
    keltnerMultiplier: Math.max(0.1, Number(params.keltnerMultiplier ?? 2.0)),
    minPressureEdge: Math.max(0, Number(params.minPressureEdge ?? 0.02)),
  };
}

export const keltner_boundary_pressure_gap: Strategy = {
  name: "Keltner Boundary Pressure Gap",
  description: "Trades true boundary expansions when Binance price accepts outside Keltner channels and Polymarket directly agrees the move is underpriced.",
  defaultParams: {
    keltnerPeriod: 20,
    keltnerMultiplier: 2.0,
    minPressureEdge: 0.02,
  },
  paramLabels: {
    keltnerPeriod: "Keltner Period",
    keltnerMultiplier: "Keltner Multiplier",
    minPressureEdge: "Min Pressure Edge",
  },
  normalizeParams,
  polymarket1sConfig: {
    required: true,
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);

    if (cleanData.length < p.keltnerPeriod) return [];
    if (!context?.polymarket1s) return [];

    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);

    const channels = calculateKeltnerChannels(highs, lows, closes, p.keltnerPeriod, p.keltnerPeriod, p.keltnerMultiplier);
    const upper = channels.upper;
    const lower = channels.lower;
    const pressureGap = buildPolymarket1sPressureGap(cleanData, context.polymarket1s);

    return createSignalLoop(cleanData, [upper, lower], (i) => {
      if (i < p.keltnerPeriod) return null;
      
      const up = upper[i];
      const dn = lower[i];
      if (up === null || dn === null) return null;

      const close = closes[i];
      const gap = pressureGap;
      const longEdge = gap.longEdge[i];
      const shortEdge = gap.shortEdge[i];

      if (longEdge === null || shortEdge === null) return null;

      if (close > up) {
        if (longEdge >= p.minPressureEdge) {
            return createBuySignal(cleanData, i, "Acceptance above Keltner Channel with pressure edge");
        }
      }
      if (close < dn) {
        if (shortEdge >= p.minPressureEdge) {
            return createSellSignal(cleanData, i, "Acceptance below Keltner Channel with pressure edge");
        }
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["keltnerPeriod", "keltnerMultiplier", "minPressureEdge"],
  },
};





