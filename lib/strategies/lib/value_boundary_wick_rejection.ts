import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeValueBoundaryWickRejectionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    wick_threshold: Math.max(0.1, Math.min(1.0, Number(params.wick_threshold ?? 0.5))),
  };
}

export const value_boundary_wick_rejection: Strategy = {
  name: "Value Boundary Wick Rejection",
  description: "A long wick piercing outside the Value Area that closes back inside is a direct visual footprint of institutional boundary defense.",
  defaultParams: {
    lookback: 20,
    wick_threshold: 0.5,
  },
  paramLabels: {
    lookback: "VA Lookback",
    wick_threshold: "Min Wick Proportion",
  },
  normalizeParams: normalizeValueBoundaryWickRejectionParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueBoundaryWickRejectionParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const wickThreshold = p.wick_threshold as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    
    const ranges = extractBarMetricSeries(prepared.cleanData, "range");
    const lowerWicks = extractBarMetricSeries(prepared.cleanData, "lowerWick");
    const upperWicks = extractBarMetricSeries(prepared.cleanData, "upperWick");

    return createSignalLoop(prepared.cleanData, [vaSeries.vah, vaSeries.val], (i) => {
      if (i < lookback) return null;
      
      const currVah = vaSeries.vah[i];
      const currVal = vaSeries.val[i];
      
      if (currVah === null || currVal === null) return null;

      const bar = prepared.cleanData[i];
      const range = ranges[i];
      const lowerWick = lowerWicks[i];
      const upperWick = upperWicks[i];

      if (range === null || lowerWick === null || upperWick === null || range === 0) return null;

      const lowerWickPct = lowerWick / range;
      const upperWickPct = upperWick / range;

      // Buy: Low < VAL AND Close > VAL AND lowerWickPct > wick_threshold
      if (bar.low < currVal && bar.close > currVal && lowerWickPct > wickThreshold) {
        return createBuySignal(prepared.cleanData, i, "Pinbar rejection at VAL");
      }

      // Sell: High > VAH AND Close < VAH AND upperWickPct > wick_threshold
      if (bar.high > currVah && bar.close < currVah && upperWickPct > wickThreshold) {
        return createSellSignal(prepared.cleanData, i, "Pinbar rejection at VAH");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_boundary_wick_rejection.executePrepared!(
      value_boundary_wick_rejection.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "wick_threshold"],
  },
};