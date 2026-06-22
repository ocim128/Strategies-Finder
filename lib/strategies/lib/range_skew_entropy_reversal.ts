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
  buildRollingSkewness,
  buildRollingEntropy,
  buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 30)),
    skewThreshold: Math.max(0, Number(params.skewThreshold ?? 1.5)),
    entropyThreshold: Math.max(0, Number(params.entropyThreshold ?? 0.8)),
  };
}

export const range_skew_entropy_reversal: Strategy = {
  name: "Range Skew Entropy Reversal",
  description: "Fades range breakouts when true-range skewness and rolling entropy of range are both extremely high.",
  defaultParams: {
    lookback: 30,
    skewThreshold: 1.5,
    entropyThreshold: 0.8,
  },
  paramLabels: {
    lookback: "Lookback Window",
    skewThreshold: "Skew Threshold",
    entropyThreshold: "Entropy Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const ranges = buildRangeSeries(cleanData);
    const skewness = buildRollingSkewness(ranges, lookback);
    const entropy = buildRollingEntropy(ranges, lookback);
    const rangePercentile = buildPercentileRank(ranges, lookback);
    const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

    const skewThreshold = p.skewThreshold as number;
    const entropyThreshold = p.entropyThreshold as number;

    return createSignalLoop(
      cleanData,
      [skewness, entropy, rangePercentile, closeAcceptance],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const ent = entropy[i];
        const pct = rangePercentile[i];
        const acceptance = closeAcceptance[i];

        if (
          skew === null ||
          ent === null ||
          pct === null ||
          acceptance === null
        ) {
          return null;
        }

        if (skew > skewThreshold && ent > entropyThreshold && pct > 0.85) {
          if (acceptance < -0.5) {
            return createBuySignal(cleanData, i, "Range Skew Entropy reversal buy");
          }
          if (acceptance > 0.5) {
            return createSellSignal(cleanData, i, "Range Skew Entropy reversal sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "skewThreshold", "entropyThreshold"],
  },
};
