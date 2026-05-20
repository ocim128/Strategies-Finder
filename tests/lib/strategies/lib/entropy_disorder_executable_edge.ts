import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { buildRollingEntropy } from "./price-action-statistics-core";
import {
  buildPolymarket1sExecutableEdge,
  buildPolymarket1sActionabilityMask
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    entropyThreshold: Math.max(0, Number(params.entropyThreshold ?? 1.2)),
    minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
  };
}

export const entropy_disorder_executable_edge: Strategy = {
  name: "Entropy Disorder Executable Edge",
  description: "Identifies high-order, low-entropy structural regimes on Binance and applies an executable pricing edge filter to enter high-probability positions when spot price directionality is clean.",
  defaultParams: {
    lookback: 30,
    entropyThreshold: 1.2,
    minEdge: 0.01,
  },
  paramLabels: {
    lookback: "Lookback",
    entropyThreshold: "Entropy Threshold",
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
    const entropy = buildRollingEntropy(closes, p.lookback);
    const edgeFrame = buildPolymarket1sExecutableEdge(cleanData, context.polymarket1s, { volLookback: p.lookback });
    const actionability = buildPolymarket1sActionabilityMask(cleanData, context.polymarket1s, { volLookback: p.lookback });

    return createSignalLoop(cleanData, [entropy], (i) => {
      if (i < p.lookback) return null;

      const ent = entropy[i];
      if (ent === null) return null;

      const yesActionable = actionability.yesActionable[i];
      const noActionable = actionability.noActionable[i];
      const buyYesEdge = edgeFrame.buyYesEdge[i];
      const buyNoEdge = edgeFrame.buyNoEdge[i];

      if (buyYesEdge === null || buyNoEdge === null) return null;

      const currentClose = closes[i];
      const prevClose = closes[i - 1];

      if (ent < p.entropyThreshold && currentClose > prevClose && yesActionable && buyYesEdge >= p.minEdge) {
        return createBuySignal(cleanData, i, "Low entropy transition with rising close price and positive actionable yes edge");
      }
      if (ent < p.entropyThreshold && currentClose < prevClose && noActionable && buyNoEdge >= p.minEdge) {
        return createSellSignal(cleanData, i, "Low entropy transition with falling close price and positive actionable no edge");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "entropyThreshold", "minEdge"],
  },
};
