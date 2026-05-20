import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { calculateEMA } from "../indicators";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    fastWindow: Math.max(1, Math.round(params.fastWindow ?? 10)),
    slowWindow: Math.max(2, Math.round(params.slowWindow ?? 30)),
    volLookback: Math.max(5, Math.round(params.volLookback ?? 20)),
    minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
  };
}

export const gamma_consensus_regime_alignment: Strategy = {
  name: "Gamma Consensus Regime Alignment",
  description: "Enters trend-following regimes on Binance, utilizing a consensus filter where both underlying pressure and Gamma pricing agree that the contract is underpriced.",
  defaultParams: {
    fastWindow: 10,
    slowWindow: 30,
    volLookback: 20,
    minEdge: 0.015,
  },
  paramLabels: {
    fastWindow: "Fast EMA Window",
    slowWindow: "Slow EMA Window",
    volLookback: "Vol Lookback",
    minEdge: "Min Edge",
  },
  normalizeParams,
  polymarket1sConfig: {
    required: true,
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);

    const maxWarmup = Math.max(p.fastWindow, p.slowWindow, p.volLookback);
    if (cleanData.length < maxWarmup) return [];
    
    // #COMPLETION_DRIVE: Assuming Polymarket 1s context is populated when polymarket1sConfig.required is true
    // #SUGGEST_VERIFY: Ensure the caller executes this strategy only with a valid Polymarket 1s execution context
    if (!context?.polymarket1s) return [];

    const closes = getCloses(cleanData);
    const fastEma = calculateEMA(closes, p.fastWindow);
    const slowEma = calculateEMA(closes, p.slowWindow);
    const gammaAgreement = buildPolymarket1sGammaAgreement(cleanData, context.polymarket1s, { volLookback: p.volLookback });

    return createSignalLoop(cleanData, [fastEma, slowEma], (i) => {
      if (i < maxWarmup || i < 1) return null;

      const fastVal = fastEma[i];
      const slowVal = slowEma[i];
      const prevFast = fastEma[i - 1];
      const prevSlow = slowEma[i - 1];

      if (fastVal === null || slowVal === null || prevFast === null || prevSlow === null) return null;

      const agreement = gammaAgreement;
      const consensusLongEdge = agreement.consensusLongEdge[i];
      const consensusShortEdge = agreement.consensusShortEdge[i];

      if (consensusLongEdge === null || consensusShortEdge === null) return null;

      const crossedUp = prevFast <= prevSlow && fastVal > slowVal;
      const crossedDown = prevFast >= prevSlow && fastVal < slowVal;

      if (crossedUp && consensusLongEdge >= p.minEdge) {
        return createBuySignal(cleanData, i, "Fast EMA crossed above slow EMA with positive consensus long gamma edge");
      }
      if (crossedDown && consensusShortEdge >= p.minEdge) {
        return createSellSignal(cleanData, i, "Fast EMA crossed below slow EMA with positive consensus short gamma edge");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["fastWindow", "slowWindow", "volLookback", "minEdge"],
  },
};
