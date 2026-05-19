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
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeHighEntropyBoundaryFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    entropy_threshold: Math.max(0.1, Math.min(1.0, Number(params.entropy_threshold ?? 0.8))),
  };
}

export const high_entropy_boundary_fade: Strategy = {
  name: "High Entropy Boundary Fade",
  description: "When sequence entropy is exceptionally high, the market is purely random noise. In noisy environments, boundary breakouts are almost guaranteed to fail and revert.",
  defaultParams: {
    lookback: 20,
    entropy_threshold: 0.8,
  },
  paramLabels: {
    lookback: "Lookback",
    entropy_threshold: "High Entropy Threshold",
  },
  normalizeParams: normalizeHighEntropyBoundaryFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeHighEntropyBoundaryFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const entropyThreshold = p.entropy_threshold as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const entropy = buildRollingEntropy(prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [position, entropy], (i) => {
      if (i < lookback) return null;
      
      const currPos = position[i];
      const prevPos = position[i - 1];
      const currEntropy = entropy[i];
      
      if (currPos === null || prevPos === null || currEntropy === null) return null;

      // Buy: Entropy > entropy_threshold AND Price Position in VA drops below -1.0
      if (currEntropy > entropyThreshold && prevPos >= -1.0 && currPos < -1.0) {
        return createBuySignal(prepared.cleanData, i, "Fade downside boundary in high entropy regime");
      }

      // Sell: Entropy > entropy_threshold AND Price Position in VA rises above 1.0
      if (currEntropy > entropyThreshold && prevPos <= 1.0 && currPos > 1.0) {
        return createSellSignal(prepared.cleanData, i, "Fade upside boundary in high entropy regime");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return high_entropy_boundary_fade.executePrepared!(
      high_entropy_boundary_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "entropy_threshold"],
  },
};