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

function normalizeAcceptanceGatedReversionRouterParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    accept_threshold: Math.max(0, Math.min(1.0, Number(params.accept_threshold ?? 0.5))),
  };
}

export const acceptance_gated_reversion_router: Strategy = {
  name: "Acceptance Gated Reversion Router",
  description: "In high acceptance regimes, fade the VA boundaries. In low acceptance regimes, wait for a deep reversion to the POC to avoid being run over by trends.",
  defaultParams: {
    lookback: 20,
    accept_threshold: 0.5,
  },
  paramLabels: {
    lookback: "VA Lookback",
    accept_threshold: "Regime Threshold",
  },
  normalizeParams: normalizeAcceptanceGatedReversionRouterParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeAcceptanceGatedReversionRouterParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, p.lookback as number);

    return createSignalLoop(prepared.cleanData, [position, acceptance], (i) => {
      const requiredBars = (p.lookback as number) * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currAccept = acceptance[i];
      
      if (currPos === null || prevPos === null || currAccept === null) return null;

      const acceptThreshold = p.accept_threshold as number;
      const isRanging = currAccept > acceptThreshold;

      if (isRanging) {
        // Ranging Regime: Fade the boundaries (±1.0)
        // Buy: Price Position crosses above -1.0
        if (prevPos <= -1.0 && currPos > -1.0) {
          return createBuySignal(prepared.cleanData, i, "Ranging: Fading VAL boundary");
        }
        // Sell: Price Position crosses below 1.0
        if (prevPos >= 1.0 && currPos < 1.0) {
          return createSellSignal(prepared.cleanData, i, "Ranging: Fading VAH boundary");
        }
      } else {
        // Trending Regime: Deep reversion to POC (0.0)
        // Buy: Price Position crosses above 0.0
        if (prevPos <= 0.0 && currPos > 0.0) {
          return createBuySignal(prepared.cleanData, i, "Trending: Deep reversion to POC from below");
        }
        // Sell: Price Position crosses below 0.0
        if (prevPos >= 0.0 && currPos < 0.0) {
          return createSellSignal(prepared.cleanData, i, "Trending: Deep reversion to POC from above");
        }
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return acceptance_gated_reversion_router.executePrepared!(
      acceptance_gated_reversion_router.prepareFinderData!(data),
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