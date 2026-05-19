import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildPricePositionInVA,
  buildValueAreaAcceptanceRate,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeHighAcceptanceBoundaryFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    accept_threshold: Math.max(0, Math.min(1.0, Number(params.accept_threshold ?? 0.65))),
  };
}

export const high_acceptance_boundary_fade: Strategy = {
  name: "High Acceptance Boundary Fade",
  description: "A high Value Area Acceptance rate indicates a strong rotational, range-bound regime where boundary touches are low-risk mean-reversion entries.",
  defaultParams: {
    lookback: 20,
    accept_threshold: 0.65,
  },
  paramLabels: {
    lookback: "VA Lookback",
    accept_threshold: "Min Acceptance Rate",
  },
  normalizeParams: normalizeHighAcceptanceBoundaryFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeHighAcceptanceBoundaryFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    // #COMPLETION_DRIVE: Assuming standard 68% coverage for VA boundaries
    // #SUGGEST_VERIFY: Test if a tighter/looser coverage works better for boundary fading
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, p.lookback as number);

    return createSignalLoop(prepared.cleanData, [position, acceptance], (i) => {
      // Need enough bars for both the primary VA lookback and the secondary acceptance lookback
      const requiredBars = (p.lookback as number) * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const currAccept = acceptance[i];
      
      if (currPos === null || currAccept === null) return null;

      const acceptThreshold = p.accept_threshold as number;

      // Buy: Acceptance Rate > accept_threshold AND Price Position drops below -0.8
      if (currAccept > acceptThreshold && currPos < -0.8) {
        return createBuySignal(prepared.cleanData, i, "Fading VAL in high acceptance regime");
      }

      // Sell: Acceptance Rate > accept_threshold AND Price Position rises above 0.8
      if (currAccept > acceptThreshold && currPos > 0.8) {
        return createSellSignal(prepared.cleanData, i, "Fading VAH in high acceptance regime");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return high_acceptance_boundary_fade.executePrepared!(
      high_acceptance_boundary_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "accept_threshold"],
  },
};