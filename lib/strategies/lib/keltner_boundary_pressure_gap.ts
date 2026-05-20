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
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    atrMultiplier: Math.max(0.1, Number(params.atrMultiplier ?? 2.0)),
    minEdge: Math.max(0, Number(params.minEdge ?? 0.02)),
  };
}

export const keltner_boundary_pressure_gap: Strategy = {
  name: "Keltner Boundary Pressure Gap",
  description: "Fades overextended price spikes on Binance that push beyond Keltner channel boundaries, entering only when Polymarket underprices the counter-trend contract.",
  defaultParams: {
    lookback: 20,
    atrMultiplier: 2.0,
    minEdge: 0.02,
  },
  paramLabels: {
    lookback: "Lookback",
    atrMultiplier: "ATR Multiplier",
    minEdge: "Min Edge",
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

    const channels = calculateKeltnerChannels(highs, lows, closes, p.lookback, p.lookback, p.atrMultiplier);
    const upper = channels.upper;
    const lower = channels.lower;
    const pressureGap = buildPolymarket1sPressureGap(cleanData, context.polymarket1s);

    return createSignalLoop(cleanData, [upper, lower], (i) => {
      if (i < p.lookback) return null;
      
      const up = upper[i];
      const dn = lower[i];
      if (up === null || dn === null) return null;

      const close = closes[i];
      const gap = pressureGap;
      const longEdge = gap.longEdge[i];
      const shortEdge = gap.shortEdge[i];

      if (longEdge === null || shortEdge === null) return null;

      if (close < dn) {
        if (longEdge >= p.minEdge) {
            return createBuySignal(cleanData, i, "Fade oversold spike below Keltner lower band with same-side long pressure edge");
        }
      }
      if (close > up) {
        if (shortEdge >= p.minEdge) {
            return createSellSignal(cleanData, i, "Fade overbought spike above Keltner upper band with same-side short pressure edge");
        }
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "atrMultiplier", "minEdge"],
  },
};





