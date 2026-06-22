import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildInitiativePressureSeries,
  buildCloseAcceptanceSeries,
} from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    acceptanceThreshold: Math.max(0, Math.min(1, Number(params.acceptanceThreshold ?? 0.60))),
  };
}

export const initiative_pressure_skew_divergence: Strategy = {
  name: "Initiative Pressure Skew Divergence",
  description: "Enters a breakout when rolling skewness of initiative pressure is opposite to the strong close acceptance.",
  defaultParams: {
    lookback: 20,
    acceptanceThreshold: 0.60,
  },
  paramLabels: {
    lookback: "Lookback Window",
    acceptanceThreshold: "Acceptance Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const initPressureRaw = buildInitiativePressureSeries(cleanData, lookback);
    const initiativePressure = initPressureRaw.map((v) => v ?? 0);

    const skewness = buildRollingSkewness(initiativePressure, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const acceptanceThreshold = p.acceptanceThreshold as number;

    return createSignalLoop(
      cleanData,
      [skewness, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const acceptance = closeAcceptance[i];

        if (skew === null || acceptance === null) return null;

        if (skew < -0.8 && acceptance > acceptanceThreshold) {
          return createBuySignal(cleanData, i, "Initiative pressure skew divergence buy");
        }
        if (skew > 0.8 && acceptance < -acceptanceThreshold) {
          return createSellSignal(cleanData, i, "Initiative pressure skew divergence sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "acceptanceThreshold"],
  },
};
