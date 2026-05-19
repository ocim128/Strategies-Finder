import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildPricePositionInVA,
  buildValueAreaWidth,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeValueWidthPhiClimaxFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 55)),
    phi_width: Math.max(0.01, Number(params.phi_width ?? 0.1618)),
  };
}

export const value_width_phi_climax_fade: Strategy = {
  name: "Value Width Phi Climax Fade",
  description: "If the Value Area Width violently expands to reach the golden fraction (0.1618 or 16.18%), the volatility cycle has climaxed. Fade the next boundary touch.",
  defaultParams: {
    lookback: 55,
    phi_width: 0.1618,
  },
  paramLabels: {
    lookback: "VA Lookback",
    phi_width: "Phi Width Fraction",
  },
  normalizeParams: normalizeValueWidthPhiClimaxFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueWidthPhiClimaxFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const phiWidth = p.phi_width as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);

    return createSignalLoop(prepared.cleanData, [position, width], (i) => {
      if (i < lookback) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currWidth = width[i];
      
      if (currPos === null || prevPos === null || currWidth === null) return null;

      // Buy: Value Area Width > phi_width AND Price Position in VA drops below -1.0
      if (currWidth > phiWidth && prevPos >= -1.0 && currPos < -1.0) {
        return createBuySignal(prepared.cleanData, i, "Fade maximally expanded VAL");
      }

      // Sell: Value Area Width > phi_width AND Price Position in VA rises above 1.0
      if (currWidth > phiWidth && prevPos <= 1.0 && currPos > 1.0) {
        return createSellSignal(prepared.cleanData, i, "Fade maximally expanded VAH");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_width_phi_climax_fade.executePrepared!(
      value_width_phi_climax_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_width"],
  },
};