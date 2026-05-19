import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildPricePositionInVA,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeGoldenExtremeCompositeFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_extreme: Math.max(1.0, Number(params.phi_extreme ?? 1.618)),
  };
}

export const golden_extreme_composite_fade: Strategy = {
  name: "Golden Extreme Composite Fade",
  description: "Markets snap back when they hit golden ratio extremes, either from pure statistical standard deviation (Z-score) or from positional volume-at-price stretch (Value Area).",
  defaultParams: {
    lookback: 20,
    phi_extreme: 1.618,
  },
  paramLabels: {
    lookback: "Unified Lookback",
    phi_extreme: "Phi Extreme Target",
  },
  normalizeParams: normalizeGoldenExtremeCompositeFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeGoldenExtremeCompositeFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const phiExtreme = p.phi_extreme as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const zScore = buildRollingZScore(prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [position, zScore], (i) => {
      if (i < lookback) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currZ = zScore[i];
      const prevZ = zScore[i - 1];
      
      if (currPos === null || prevPos === null || currZ === null || prevZ === null) return null;

      // Buy conditions
      const statisticalBuy = prevZ <= -phiExtreme && currZ > -phiExtreme;
      const structuralBuy = prevPos <= -phiExtreme && currPos > -phiExtreme;

      if (statisticalBuy || structuralBuy) {
        return createBuySignal(
          prepared.cleanData, 
          i, 
          structuralBuy ? "Snapback from structural phi extreme (VAL)" : "Snapback from statistical phi extreme (Z-score)"
        );
      }

      // Sell conditions
      const statisticalSell = prevZ >= phiExtreme && currZ < phiExtreme;
      const structuralSell = prevPos >= phiExtreme && currPos < phiExtreme;

      if (statisticalSell || structuralSell) {
        return createSellSignal(
          prepared.cleanData, 
          i, 
          structuralSell ? "Snapback from structural phi extreme (VAH)" : "Snapback from statistical phi extreme (Z-score)"
        );
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return golden_extreme_composite_fade.executePrepared!(
      golden_extreme_composite_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_extreme"],
  },
};