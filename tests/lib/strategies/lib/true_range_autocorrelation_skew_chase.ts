import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildRangeSeries,
  buildCloseAcceptanceSeries,
} from "./price-action-frequency-core";
import {
  buildRollingAutoCorrelation,
  buildRollingSkewness,
  buildRollingMedian,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 25)),
    autoCorrThreshold: Math.max(-1, Math.min(1, Number(params.autoCorrThreshold ?? 0.25))),
    skewThreshold: Math.max(0, Number(params.skewThreshold ?? 0.50)),
  };
}

export const true_range_autocorrelation_skew_chase: Strategy = {
  name: "True Range Autocorrelation Skew Chase",
  description: "Chases breakouts when true-range autocorrelation is positive and true-range skewness is positive, indicating persistent expansions.",
  defaultParams: {
    lookback: 25,
    autoCorrThreshold: 0.25,
    skewThreshold: 0.50,
  },
  paramLabels: {
    lookback: "Lookback Window",
    autoCorrThreshold: "AutoCorrelation Threshold",
    skewThreshold: "Skew Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const autoCorr = buildRollingAutoCorrelation(ranges, lookback, 1);
    const skewness = buildRollingSkewness(ranges, lookback);
    const medianRange = buildRollingMedian(ranges, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const autoCorrThreshold = p.autoCorrThreshold as number;
    const skewThreshold = p.skewThreshold as number;

    return createSignalLoop(
      cleanData,
      [autoCorr, skewness, medianRange, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const ac = autoCorr[i];
        const skew = skewness[i];
        const medRange = medianRange[i];
        const acceptance = closeAcceptance[i];

        if (
          ac === null ||
          skew === null ||
          medRange === null ||
          acceptance === null
        ) {
          return null;
        }

        if (
          ac > autoCorrThreshold &&
          skew > skewThreshold &&
          ranges[i] > medRange
        ) {
          if (acceptance > 0.5) {
            return createBuySignal(cleanData, i, "True range autocorrelation skew chase buy");
          }
          if (acceptance < -0.5) {
            return createSellSignal(cleanData, i, "True range autocorrelation skew chase sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "autoCorrThreshold", "skewThreshold"],
  },
};
