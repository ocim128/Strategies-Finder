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

function normalizeValueBoundaryRejectionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
  };
}

export const value_boundary_rejection: Strategy = {
  name: "Value Boundary Rejection",
  description: "When price breaks out of the Value Area but fails to find new acceptance, it reliably reverts to the Point of Control.",
  defaultParams: {
    lookback: 20,
  },
  paramLabels: {
    lookback: "VA Lookback",
  },
  normalizeParams: normalizeValueBoundaryRejectionParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueBoundaryRejectionParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    // #COMPLETION_DRIVE: Assuming 68% coverage (1 std dev) and 12 bins are optimal defaults
    // #SUGGEST_VERIFY: Expose coveragePct and numBins as StrategyParams if behavior needs tuning
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

    return createSignalLoop(prepared.cleanData, [position], (i) => {
      if (i < (p.lookback as number)) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      
      if (currPos === null || prevPos === null) return null;

      // Buy: Price Position crosses above -1.0 (closing back inside VA from below)
      if (prevPos <= -1.0 && currPos > -1.0) {
        return createBuySignal(prepared.cleanData, i, "Re-entering VA from below (failed breakdown)");
      }

      // Sell: Price Position crosses below 1.0 (closing back inside VA from above)
      if (prevPos >= 1.0 && currPos < 1.0) {
        return createSellSignal(prepared.cleanData, i, "Re-entering VA from above (failed breakout)");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_boundary_rejection.executePrepared!(
      value_boundary_rejection.prepareFinderData!(data),
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