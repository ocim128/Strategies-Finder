import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import {
  extractBarMetricSeries,
  buildCloseLocationSeries,
} from "./price-action-frequency-core";
import {
  buildRollingSkewness,
  buildRollingMedian,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 40)),
    skewThreshold: Math.max(0, Number(params.skewThreshold ?? 1.2)),
  };
}

export const close_midpoint_deviation_skew_reversion: Strategy = {
  name: "Close Midpoint Deviation Skew Reversion",
  description: "Fades a trending ratio when the skewness of close midpoint deviations reaches positive extremes and starts to revert.",
  defaultParams: {
    lookback: 40,
    skewThreshold: 1.2,
  },
  paramLabels: {
    lookback: "Lookback Window",
    skewThreshold: "Skew Threshold",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];

    const closeMidpointDev = extractBarMetricSeries(cleanData, "closeMidpointDev");
    const skewness = buildRollingSkewness(closeMidpointDev, lookback);

    const closes = getCloses(cleanData);
    const medianCloses = buildRollingMedian(closes, lookback);
    const closeLocation = buildCloseLocationSeries(cleanData);

    const skewThreshold = p.skewThreshold as number;

    return createSignalLoop(
      cleanData,
      [skewness, medianCloses, closeLocation],
      (i) => {
        if (i < lookback) return null;
        const skew = skewness[i];
        const medClose = medianCloses[i];
        const prevMedClose = medianCloses[i - 1];
        const closeLoc = closeLocation[i];

        if (
          skew === null ||
          medClose === null ||
          prevMedClose === null ||
          closeLoc === null
        ) {
          return null;
        }

        const prevClose = closes[i - 1];

        if (skew > skewThreshold) {
          if (prevClose < prevMedClose && closeLoc > 0.5) {
            return createBuySignal(cleanData, i, "Close midpoint dev skew reversion buy");
          }
          if (prevClose > prevMedClose && closeLoc < 0.5) {
            return createSellSignal(cleanData, i, "Close midpoint dev skew reversion sell");
          }
        }
        return null;
      }
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "skewThreshold"],
  },
};
