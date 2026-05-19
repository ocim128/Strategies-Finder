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

function normalizeValueAreaExcessSnapbackParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 55)),
    excess_threshold: Math.max(1.0, Number(params.excess_threshold ?? 1.5)),
  };
}

export const value_area_excess_snapback: Strategy = {
  name: "Value Area Excess Snapback",
  description: "Extreme positional excess beyond the Value Area acts as a rubber band. Once price loses momentum at these extremes, it violently snaps back.",
  defaultParams: {
    lookback: 55,
    excess_threshold: 1.5,
  },
  paramLabels: {
    lookback: "VA Lookback",
    excess_threshold: "Excess Threshold",
  },
  normalizeParams: normalizeValueAreaExcessSnapbackParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueAreaExcessSnapbackParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

    return createSignalLoop(prepared.cleanData, [position], (i) => {
      if (i < (p.lookback as number)) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      
      if (currPos === null || prevPos === null) return null;

      const excessThreshold = p.excess_threshold as number;

      // Buy: Price Position in VA crosses above -excess_threshold after being below it.
      if (prevPos <= -excessThreshold && currPos > -excessThreshold) {
        return createBuySignal(prepared.cleanData, i, "Snapback from deep VAL excess");
      }

      // Sell: Price Position in VA crosses below excess_threshold after being above it.
      if (prevPos >= excessThreshold && currPos < excessThreshold) {
        return createSellSignal(prepared.cleanData, i, "Snapback from deep VAH excess");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_area_excess_snapback.executePrepared!(
      value_area_excess_snapback.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "excess_threshold"],
  },
};