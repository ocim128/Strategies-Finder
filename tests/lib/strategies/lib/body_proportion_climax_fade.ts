import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodyProportionClimaxFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    range_z_threshold: Math.max(0.1, Number(params.range_z_threshold ?? 2.5)),
    body_threshold: Math.max(0.1, Math.min(1.0, Number(params.body_threshold ?? 0.95))),
  };
}

export const body_proportion_climax_fade: Strategy = {
  name: "Body Proportion Climax Fade",
  description: "A micro-bar where the body consumes >95% of an unusually large range is a classic 'blow-off' or 'capitulation' tick. Fade it immediately on the next close.",
  defaultParams: {
    lookback: 20,
    range_z_threshold: 2.5,
    body_threshold: 0.95,
  },
  paramLabels: {
    lookback: "Range Z-Score Lookback",
    range_z_threshold: "Range Z-Score Threshold",
    body_threshold: "Min Body Proportion",
  },
  normalizeParams: normalizeBodyProportionClimaxFadeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeBodyProportionClimaxFadeParams(params);
    const lookback = p.lookback as number;
    const rangeZThreshold = p.range_z_threshold as number;
    const bodyThreshold = p.body_threshold as number;

    if (cleanData.length < lookback) return [];

    const ranges = extractBarMetricSeries(cleanData, "range");
    const bodyPcts = extractBarMetricSeries(cleanData, "bodyPct");
    const rangeZScore = buildRollingZScore(ranges, lookback);

    return createSignalLoop(cleanData, [rangeZScore], (i) => {
      if (i < lookback) return null;
      
      const currRangeZ = rangeZScore[i];
      const currBodyPct = bodyPcts[i];
      
      if (currRangeZ === null || currBodyPct === null) return null;

      const currBar = cleanData[i];

      // Buy: Range Z-Score > range_z_threshold AND bodyPct > body_threshold AND Close < Open
      if (currRangeZ > rangeZThreshold && currBodyPct > bodyThreshold && currBar.close < currBar.open) {
        return createBuySignal(cleanData, i, "Upside fade of capitulation tick");
      }

      // Sell: Range Z-Score > range_z_threshold AND bodyPct > body_threshold AND Close > Open
      if (currRangeZ > rangeZThreshold && currBodyPct > bodyThreshold && currBar.close > currBar.open) {
        return createSellSignal(cleanData, i, "Downside fade of blow-off tick");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "range_z_threshold", "body_threshold"],
  },
};