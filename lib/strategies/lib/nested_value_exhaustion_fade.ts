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

function normalizeNestedValueExhaustionFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    short_lookback: Math.max(3, Math.round(params.short_lookback ?? 10)),
    long_lookback: Math.max(10, Math.round(params.long_lookback ?? 63)),
  };
}

export const nested_value_exhaustion_fade: Strategy = {
  name: "Nested Value Exhaustion Fade",
  description: "When short-term value fails and collapses back to its Point of Control, but price remains extended relative to long-term value, it signals a broader multi-week mean reversion.",
  defaultParams: {
    short_lookback: 10,
    long_lookback: 63,
  },
  paramLabels: {
    short_lookback: "Short VA Lookback",
    long_lookback: "Long VA Lookback",
  },
  normalizeParams: normalizeNestedValueExhaustionFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeNestedValueExhaustionFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    // Ensure long lookback is strictly greater than short lookback
    const shortLookback = Math.min(p.short_lookback as number, (p.long_lookback as number) - 1);
    const longLookback = Math.max(p.long_lookback as number, (p.short_lookback as number) + 1);
    
    const shortVa = getValueAreaSeries(prepared, shortLookback, 0.68, 12);
    const longVa = getValueAreaSeries(prepared, longLookback, 0.68, 12);
    
    const shortPosition = buildPricePositionInVA(prepared.closes, shortVa.vah, shortVa.val, shortVa.poc);
    const longPosition = buildPricePositionInVA(prepared.closes, longVa.vah, longVa.val, longVa.poc);

    return createSignalLoop(prepared.cleanData, [shortPosition, longPosition], (i) => {
      if (i < longLookback) return null;
      
      const currShortPos = shortPosition[i];
      const prevShortPos = shortPosition[i - 1];
      const currLongPos = longPosition[i];
      
      if (currShortPos === null || prevShortPos === null || currLongPos === null) return null;

      // Buy: Long-term Price Position < -1.0 AND Short-term Price Position crosses above 0.0.
      if (currLongPos < -1.0 && prevShortPos <= 0.0 && currShortPos > 0.0) {
        return createBuySignal(prepared.cleanData, i, "Macro breakdown exhausted (short-term POC reversion)");
      }

      // Sell: Long-term Price Position > 1.0 AND Short-term Price Position crosses below 0.0.
      if (currLongPos > 1.0 && prevShortPos >= 0.0 && currShortPos < 0.0) {
        return createSellSignal(prepared.cleanData, i, "Macro breakout exhausted (short-term POC reversion)");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return nested_value_exhaustion_fade.executePrepared!(
      nested_value_exhaustion_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["short_lookback", "long_lookback"],
  },
};