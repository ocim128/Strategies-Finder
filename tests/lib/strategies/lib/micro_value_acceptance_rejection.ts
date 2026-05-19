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

function normalizeMicroValueAcceptanceRejectionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 10)),
    accept_threshold: Math.max(0.1, Math.min(1.0, Number(params.accept_threshold ?? 0.7))),
  };
}

export const micro_value_acceptance_rejection: Strategy = {
  name: "Micro Value Acceptance Rejection",
  description: "On sub-minute data, if price attempts to migrate outside a short-term rolling Value Area but Acceptance Rate remains high (balanced), market makers will pull it back to the POC.",
  defaultParams: {
    lookback: 10,
    accept_threshold: 0.7,
  },
  paramLabels: {
    lookback: "Micro VA Lookback",
    accept_threshold: "High Acceptance Threshold",
  },
  normalizeParams: normalizeMicroValueAcceptanceRejectionParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeMicroValueAcceptanceRejectionParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const acceptThreshold = p.accept_threshold as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);

    return createSignalLoop(prepared.cleanData, [position, acceptance], (i) => {
      // Need enough bars for both the primary VA lookback and the secondary acceptance lookback
      const requiredBars = lookback * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currAccept = acceptance[i];
      
      if (currPos === null || prevPos === null || currAccept === null) return null;

      // Buy: Acceptance > accept_threshold AND Price Position in VA drops below -1.0
      if (currAccept > acceptThreshold && prevPos >= -1.0 && currPos < -1.0) {
        return createBuySignal(prepared.cleanData, i, "Fade downside micro VA expansion");
      }

      // Sell: Acceptance > accept_threshold AND Price Position in VA rises above 1.0
      if (currAccept > acceptThreshold && prevPos <= 1.0 && currPos > 1.0) {
        return createSellSignal(prepared.cleanData, i, "Fade upside micro VA expansion");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return micro_value_acceptance_rejection.executePrepared!(
      micro_value_acceptance_rejection.prepareFinderData!(data),
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