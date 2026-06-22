import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  checkCrossover,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import {
  buildRollingSkewness,
  buildRollingMedian,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    skewLimit: Math.max(0, Number(params.skewLimit ?? 1.5)),
  };
}

export const close_acceptance_skew_reversal_fade: Strategy = {
  name: "Close Acceptance Skew Reversal Fade",
  description: "Fades the ratio when rolling close acceptance skewness is extreme and the current close acceptance crosses its rolling median.",
  defaultParams: {
    lookback: 30,
    skewLimit: 1.5,
  },
  paramLabels: {
    lookback: "Lookback Window",
    skewLimit: "Skew Limit",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
    const skewness = buildRollingSkewness(closeAcceptance, lookback);
    const medianCloseAcceptance = buildRollingMedian(closeAcceptance, lookback);

    const skewLimit = p.skewLimit as number;

    return createSignalLoop(
      cleanData,
      [skewness, medianCloseAcceptance],
      (i) => {
        if (
          i < lookback ||
          skewness[i] === null ||
          medianCloseAcceptance[i] === null ||
          medianCloseAcceptance[i - 1] === null
        ) {
          return null;
        }

        const skew = skewness[i]!;
        const cross = checkCrossover(closeAcceptance, medianCloseAcceptance, i);

        if (skew < -skewLimit && cross === "bullish") {
          return createBuySignal(cleanData, i, "Close acceptance skew reversal fade buy");
        }
        if (skew > skewLimit && cross === "bearish") {
          return createSellSignal(cleanData, i, "Close acceptance skew reversal fade sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "skewLimit"],
  },
};
