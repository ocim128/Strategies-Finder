import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import {
  buildPolymarket1sExecutableEdge,
  buildPolymarket1sActionabilityMask
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 25)),
    minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
  };
}

export const trailing_boundary_breakout_executable_edge: Strategy = {
  name: "Trailing Boundary Breakout Executable Edge",
  description: "Enters on breakout signals of local trailing high/low distribution boundaries on Binance, using an actionable executable price edge to lock in favorable execution terms on Polymarket.",
  defaultParams: {
    lookback: 25,
    minEdge: 0.01,
  },
  paramLabels: {
    lookback: "Lookback",
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

    const closes = getCloses(cleanData);
    const bounds = buildRollingMinMax(closes, p.lookback, false); // trailing bounds (exclude current bar)
    const trailingMin = bounds.min;
    const trailingMax = bounds.max;

    const edgeFrame = buildPolymarket1sExecutableEdge(cleanData, context.polymarket1s, { volLookback: p.lookback });
    const actionability = buildPolymarket1sActionabilityMask(cleanData, context.polymarket1s, { volLookback: p.lookback });

    return createSignalLoop(cleanData, [trailingMin, trailingMax], (i) => {
      if (i < p.lookback) return null;

      const tMin = trailingMin[i];
      const tMax = trailingMax[i];
      if (tMin === null || tMax === null) return null;

      const yesActionable = actionability.yesActionable[i];
      const noActionable = actionability.noActionable[i];
      const buyYesEdge = edgeFrame.buyYesEdge[i];
      const buyNoEdge = edgeFrame.buyNoEdge[i];

      if (buyYesEdge === null || buyNoEdge === null) return null;

      const close = closes[i];

      if (close > tMax && yesActionable && buyYesEdge >= p.minEdge) {
        return createBuySignal(cleanData, i, "Upside breakout above trailing maximum close with positive actionable yes edge");
      }
      if (close < tMin && noActionable && buyNoEdge >= p.minEdge) {
        return createSellSignal(cleanData, i, "Downside breakout below trailing minimum close with positive actionable no edge");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "minEdge"],
  },
};
