import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildPricePositionInVA,
  buildValueAreaRotation,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeValueRotationDivergenceFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
  };
}

export const value_rotation_divergence_fade: Strategy = {
  name: "Value Rotation Divergence Fade",
  description: "When price breaks the Value Area High but the Value Area Rotation shift is negative, price is diverging from structural value and will revert.",
  defaultParams: {
    lookback: 20,
  },
  paramLabels: {
    lookback: "VA Lookback",
  },
  normalizeParams: normalizeValueRotationDivergenceFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueRotationDivergenceFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    // Use the same lookback period for rotation calculation
    const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, p.lookback as number);

    return createSignalLoop(prepared.cleanData, [position, rotation.shift], (i) => {
      const requiredBars = (p.lookback as number) * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const currShift = rotation.shift[i];
      
      if (currPos === null || currShift === null) return null;

      // Buy: Price Position < -1.0 (price breaking down) AND Rotation shift > 0 (value rotating up)
      if (currPos < -1.0 && currShift > 0) {
        return createBuySignal(prepared.cleanData, i, "Divergence: Price down, Value up");
      }

      // Sell: Price Position > 1.0 (price breaking out) AND Rotation shift < 0 (value rotating down)
      if (currPos > 1.0 && currShift < 0) {
        return createSellSignal(prepared.cleanData, i, "Divergence: Price up, Value down");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_rotation_divergence_fade.executePrepared!(
      value_rotation_divergence_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback"],
  },
};