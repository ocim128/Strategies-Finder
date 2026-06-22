import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    threshold: Math.max(0, Math.min(0.5, Number(params.threshold ?? 0.20))),
  };
}

export const initiative_pressure_surge_follow: Strategy = {
  name: "Initiative Pressure Surge Follow",
  description: "Chases a trend when the initiative pressure percentile rank spikes, confirming volume-backed commitment.",
  defaultParams: {
    lookback: 20,
    threshold: 0.20,
  },
  paramLabels: {
    lookback: "Lookback Window",
    threshold: "Threshold Percentile",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const initPressureRaw = buildInitiativePressureSeries(cleanData, lookback);
    const initiativePressure = initPressureRaw.map((v) => v ?? 0);
    const initPressurePct = buildPercentileRank(initiativePressure, lookback);

    const threshold = p.threshold as number;

    return createSignalLoop(
      cleanData,
      [initPressurePct],
      (i) => {
        if (i < lookback) return null;
        const pct = initPressurePct[i];
        if (pct === null) return null;

        if (pct > (1 - threshold)) {
          return createBuySignal(cleanData, i, "Initiative pressure surge follow buy");
        }
        if (pct < threshold) {
          return createSellSignal(cleanData, i, "Initiative pressure surge follow sell");
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "threshold"],
  },
};
