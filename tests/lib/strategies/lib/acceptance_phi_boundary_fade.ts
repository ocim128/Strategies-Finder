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

function normalizeAcceptancePhiBoundaryFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_acceptance: Math.max(0.1, Math.min(1.0, Number(params.phi_acceptance ?? 0.618))),
  };
}

export const acceptance_phi_boundary_fade: Strategy = {
  name: "Acceptance Phi Boundary Fade",
  description: "When the Value Area Acceptance Rate exceeds the golden ratio (0.618), the market is in a state of perfect structural equilibrium. Boundaries will hold. Fade them.",
  defaultParams: {
    lookback: 20,
    phi_acceptance: 0.618,
  },
  paramLabels: {
    lookback: "VA Lookback",
    phi_acceptance: "Golden Acceptance",
  },
  normalizeParams: normalizeAcceptancePhiBoundaryFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeAcceptancePhiBoundaryFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const phiAcceptance = p.phi_acceptance as number;
    
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

      // Buy: Acceptance Rate > phi_acceptance AND Price Position in VA crosses above -1.0
      if (currAccept > phiAcceptance && prevPos <= -1.0 && currPos > -1.0) {
        return createBuySignal(prepared.cleanData, i, "Fading VAL in golden acceptance equilibrium");
      }

      // Sell: Acceptance Rate > phi_acceptance AND Price Position in VA crosses below 1.0
      if (currAccept > phiAcceptance && prevPos >= 1.0 && currPos < 1.0) {
        return createSellSignal(prepared.cleanData, i, "Fading VAH in golden acceptance equilibrium");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return acceptance_phi_boundary_fade.executePrepared!(
      acceptance_phi_boundary_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_acceptance"],
  },
};