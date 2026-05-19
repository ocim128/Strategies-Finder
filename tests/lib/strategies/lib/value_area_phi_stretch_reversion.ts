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

function normalizeValueAreaPhiStretchReversionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_stretch: Math.max(1.0, Number(params.phi_stretch ?? 1.618)),
  };
}

export const value_area_phi_stretch_reversion: Strategy = {
  name: "Value Area Phi Stretch Reversion",
  description: "Price extending beyond the Value Area boundary by exactly the golden ratio relative to the core distribution represents mathematically unsustainable positional excess.",
  defaultParams: {
    lookback: 20,
    phi_stretch: 1.618,
  },
  paramLabels: {
    lookback: "VA Lookback",
    phi_stretch: "Phi Stretch Limit",
  },
  normalizeParams: normalizeValueAreaPhiStretchReversionParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeValueAreaPhiStretchReversionParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const phiStretch = p.phi_stretch as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

    return createSignalLoop(prepared.cleanData, [position], (i) => {
      if (i < lookback) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      
      if (currPos === null || prevPos === null) return null;

      // Buy: Price Position in VA crosses above -phi_stretch after being below it
      if (prevPos <= -phiStretch && currPos > -phiStretch) {
        return createBuySignal(prepared.cleanData, i, "Snapback from downside golden stretch");
      }

      // Sell: Price Position in VA crosses below phi_stretch after being above it
      if (prevPos >= phiStretch && currPos < phiStretch) {
        return createSellSignal(prepared.cleanData, i, "Snapback from upside golden stretch");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return value_area_phi_stretch_reversion.executePrepared!(
      value_area_phi_stretch_reversion.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_stretch"],
  },
};