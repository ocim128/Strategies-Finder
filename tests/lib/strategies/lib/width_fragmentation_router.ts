import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildValueAreaWidth,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeWidthFragmentationRouterParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    va_lookback: Math.max(3, Math.round(params.va_lookback ?? 20)),
    width_z_threshold: Math.max(0.1, Number(params.width_z_threshold ?? 1.5)),
  };
}

export const width_fragmentation_router: Strategy = {
  name: "Width Fragmentation Router",
  description: "When width expands, trade momentum. When width compresses, fade the edges. If width fragments (erratic), stay out.",
  defaultParams: {
    va_lookback: 20,
    width_z_threshold: 1.5,
  },
  paramLabels: {
    va_lookback: "VA Lookback",
    width_z_threshold: "Width Z-Score Threshold",
  },
  normalizeParams: normalizeWidthFragmentationRouterParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeWidthFragmentationRouterParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.va_lookback as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);

    // Build Z-Scores
    // #COMPLETION_DRIVE: Assumed using the same lookback for the z-score calculations
    // #SUGGEST_VERIFY: Test decoupling the Z-score lookback from the VA lookback
    const widthZ = buildRollingZScore(width as number[], lookback); // width array contains nulls initially, but buildRollingZScore handles numeric arrays, so we pass it as is and the nulls are ignored in loop
    const priceZ = buildRollingZScore(prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [widthZ, priceZ], (i) => {
      // Need enough bars for both the primary VA lookback and the secondary z-score lookback
      const requiredBars = lookback * 2;
      if (i < requiredBars) return null;
      
      const currWidthZ = widthZ[i];
      const currPriceZ = priceZ[i];
      
      if (currWidthZ === null || currPriceZ === null) return null;

      const widthZThreshold = p.width_z_threshold as number;

      // Expansion Regime
      if (currWidthZ > widthZThreshold) {
        if (currPriceZ > 1.5) {
          return createBuySignal(prepared.cleanData, i, "Expansion: Buying momentum");
        }
        if (currPriceZ < -1.5) {
          return createSellSignal(prepared.cleanData, i, "Expansion: Selling momentum");
        }
      }
      // Compression Regime
      else if (currWidthZ < -widthZThreshold) {
        if (currPriceZ < -1.5) {
          return createBuySignal(prepared.cleanData, i, "Compression: Fading weakness");
        }
        if (currPriceZ > 1.5) {
          return createSellSignal(prepared.cleanData, i, "Compression: Fading strength");
        }
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return width_fragmentation_router.executePrepared!(
      width_fragmentation_router.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["va_lookback", "width_z_threshold"],
  },
};