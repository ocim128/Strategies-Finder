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

function normalizeValueStretchCompositeFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    excess_position: Math.max(1.0, Number(params.excess_position ?? 1.5)),
    extreme_width: Math.max(0.01, Number(params.extreme_width ?? 0.12)),
  };
}

export const value_stretch_composite_fade: Strategy = {
  name: "Value Stretch Composite Fade",
  description: "Mean reversion is valid either when price snaps back from an extreme positional stretch, or when an over-expanded value area collapses.",
  defaultParams: {
    lookback: 20,
    excess_position: 1.5,
    extreme_width: 0.12,
  },
  paramLabels: {
    lookback: "VA Lookback",
    excess_position: "Excess Threshold",
    extreme_width: "Extreme Width",
  },
  normalizeParams: normalizeValueStretchCompositeFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueStretchCompositeFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);

    return createSignalLoop(prepared.cleanData, [position, width], (i) => {
      if (i < (p.lookback as number)) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currWidth = width[i];
      const prevWidth = width[i - 1];
      
      if (currPos === null || prevPos === null || currWidth === null || prevWidth === null) return null;

      const excessPos = p.excess_position as number;
      const extremeWidth = p.extreme_width as number;

      // Buy conditions
      const positionSnapBuy = prevPos <= -excessPos && currPos > -excessPos;
      const widthCollapseBuy = prevWidth >= extremeWidth && currWidth < extremeWidth && currPos < -1.0;

      if (positionSnapBuy || widthCollapseBuy) {
        return createBuySignal(
          prepared.cleanData, 
          i, 
          positionSnapBuy ? "Positional stretch snapback (VAL)" : "Expansion collapse at VAL"
        );
      }

      // Sell conditions
      const positionSnapSell = prevPos >= excessPos && currPos < excessPos;
      const widthCollapseSell = prevWidth >= extremeWidth && currWidth < extremeWidth && currPos > 1.0;

      if (positionSnapSell || widthCollapseSell) {
        return createSellSignal(
          prepared.cleanData, 
          i, 
          positionSnapSell ? "Positional stretch snapback (VAH)" : "Expansion collapse at VAH"
        );
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_stretch_composite_fade.executePrepared!(
      value_stretch_composite_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "excess_position", "extreme_width"],
  },
};