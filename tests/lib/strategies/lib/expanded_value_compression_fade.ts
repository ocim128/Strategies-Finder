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

function normalizeExpandedValueCompressionFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    width_threshold: Math.max(0.01, Number(params.width_threshold ?? 0.15)),
  };
}

export const expanded_value_compression_fade: Strategy = {
  name: "Expanded Value Compression Fade",
  description: "When a Value Area becomes extraordinarily wide, price moving back to the Point of Control signals a reversion to compression.",
  defaultParams: {
    lookback: 20,
    width_threshold: 0.15,
  },
  paramLabels: {
    lookback: "VA Lookback",
    width_threshold: "Min VA Width",
  },
  normalizeParams: normalizeExpandedValueCompressionFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeExpandedValueCompressionFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    // #COMPLETION_DRIVE: Using standard 68% VA coverage
    // #SUGGEST_VERIFY: Test if a wider/narrower VA improves the definition of "expanded value"
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);

    return createSignalLoop(prepared.cleanData, [position, width], (i) => {
      if (i < (p.lookback as number)) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currWidth = width[i];
      
      if (currPos === null || prevPos === null || currWidth === null) return null;

      const widthThreshold = p.width_threshold as number;

      // Buy: Value Area Width > width_threshold AND Price Position crosses above -1.0
      if (currWidth > widthThreshold && prevPos <= -1.0 && currPos > -1.0) {
        return createBuySignal(prepared.cleanData, i, "Mean reversion from expanded VAL");
      }

      // Sell: Value Area Width > width_threshold AND Price Position crosses below 1.0
      if (currWidth > widthThreshold && prevPos >= 1.0 && currPos < 1.0) {
        return createSellSignal(prepared.cleanData, i, "Mean reversion from expanded VAH");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return expanded_value_compression_fade.executePrepared!(
      expanded_value_compression_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "width_threshold"],
  },
};