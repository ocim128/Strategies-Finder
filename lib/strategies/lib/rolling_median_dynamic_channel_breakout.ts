import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    threshold: Math.max(0, Number(params.threshold ?? 1.5)),
    maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.05)),
  };
}

export const rolling_median_dynamic_channel_breakout: Strategy = {
  name: "Rolling Median Dynamic Channel Breakout",
  description: "Capitalizes on rapid directional breakouts beyond a volatility-adjusted rolling median channel on Binance, filtering out trades where the Polymarket event contract is already pricing in a strong disagreement with the movement.",
  defaultParams: {
    lookback: 30,
    threshold: 1.5,
    maxAdverse: 0.05,
  },
  paramLabels: {
    lookback: "Lookback",
    threshold: "Threshold",
    maxAdverse: "Max Adverse",
  },
  normalizeParams,
  polymarket1sConfig: {
    required: true,
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);

    if (cleanData.length < p.lookback) return [];
    
    // #COMPLETION_DRIVE: Assuming Polymarket 1s context is populated when polymarket1sConfig.required is true
    // #SUGGEST_VERIFY: Ensure the caller executes this strategy only with a valid Polymarket 1s execution context
    if (!context?.polymarket1s) return [];

    const closes = getCloses(cleanData);
    const rollingMedian = buildRollingMedian(closes, p.lookback);
    const rollingStdDev = buildRollingStdDev(closes, p.lookback);
    const pressureGap = buildPolymarket1sPressureGap(cleanData, context.polymarket1s, { volLookback: p.lookback });

    return createSignalLoop(cleanData, [rollingMedian, rollingStdDev], (i) => {
      if (i < p.lookback) return null;

      const median = rollingMedian[i];
      const stdDev = rollingStdDev[i];
      if (median === null || stdDev === null) return null;

      const close = closes[i];
      const gap = pressureGap;
      const longAdverse = gap.longAdverse[i];
      const shortAdverse = gap.shortAdverse[i];

      if (longAdverse === null || shortAdverse === null) return null;

      if (close > (median + p.threshold * stdDev)) {
        if (longAdverse <= p.maxAdverse) {
          return createBuySignal(cleanData, i, "Breakout above rolling median channel with low adverse pressure gap");
        }
      }
      if (close < (median - p.threshold * stdDev)) {
        if (shortAdverse <= p.maxAdverse) {
          return createSellSignal(cleanData, i, "Breakout below rolling median channel with low adverse pressure gap");
        }
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "threshold", "maxAdverse"],
  },
};
