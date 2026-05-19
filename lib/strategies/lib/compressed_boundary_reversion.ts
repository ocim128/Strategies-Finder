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
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeCompressedBoundaryReversionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    range_z_threshold: Math.min(-0.1, Number(params.range_z_threshold ?? -1.5)),
  };
}

export const compressed_boundary_reversion: Strategy = {
  name: "Compressed Boundary Reversion",
  description: "When daily range violently contracts while price sits at a structural boundary, it signals a complete lack of interest in breaking out; price will drift back to center.",
  defaultParams: {
    lookback: 20,
    range_z_threshold: -1.5,
  },
  paramLabels: {
    lookback: "VA & Range Lookback",
    range_z_threshold: "Max Range Z-Score",
  },
  normalizeParams: normalizeCompressedBoundaryReversionParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeCompressedBoundaryReversionParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const rangeZThreshold = p.range_z_threshold as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    
    const ranges = extractBarMetricSeries(prepared.cleanData, "range");
    const rangeZScore = buildRollingZScore(ranges, lookback);

    return createSignalLoop(prepared.cleanData, [position, rangeZScore], (i) => {
      if (i < lookback) return null;
      
      const currPos = position[i];
      const currRangeZ = rangeZScore[i];
      
      if (currPos === null || currRangeZ === null) return null;

      const currBar = prepared.cleanData[i];

      // Buy: Range Z-Score < range_z_threshold AND Price Position in VA < -0.8 AND Close > Open
      if (currRangeZ < rangeZThreshold && currPos < -0.8 && currBar.close > currBar.open) {
        return createBuySignal(prepared.cleanData, i, "Upside reversion from compressed VAL");
      }

      // Sell: Range Z-Score < range_z_threshold AND Price Position in VA > 0.8 AND Close < Open
      if (currRangeZ < rangeZThreshold && currPos > 0.8 && currBar.close < currBar.open) {
        return createSellSignal(prepared.cleanData, i, "Downside reversion from compressed VAH");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return compressed_boundary_reversion.executePrepared!(
      compressed_boundary_reversion.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "range_z_threshold"],
  },
};