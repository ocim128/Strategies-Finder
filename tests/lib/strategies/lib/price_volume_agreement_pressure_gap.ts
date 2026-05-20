import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getHighs,
  getLows,
  getCloses,
  getVolumes
} from "../strategy-helpers";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    volumeZThreshold: Math.max(0, Number(params.volumeZThreshold ?? 1.5)),
    maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.04)),
  };
}

export const price_volume_agreement_pressure_gap: Strategy = {
  name: "Price Volume Agreement Pressure Gap",
  description: "Trades high-conviction breakout signals on Binance that are backed by an extreme volume spike, while using the Polymarket pressure gap to avoid buying already fully-priced outcomes.",
  defaultParams: {
    lookback: 20,
    volumeZThreshold: 1.5,
    maxAdverse: 0.04,
  },
  paramLabels: {
    lookback: "Lookback",
    volumeZThreshold: "Volume Z-Score Threshold",
    maxAdverse: "Max Adverse Pressure",
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

    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);

    const channelHighs = buildRollingMinMax(highs, p.lookback, false).max;
    const channelLows = buildRollingMinMax(lows, p.lookback, false).min;
    const volumeZScores = buildRollingZScore(volumes, p.lookback);
    const pressureGap = buildPolymarket1sPressureGap(cleanData, context.polymarket1s, { volLookback: p.lookback });

    return createSignalLoop(cleanData, [channelHighs, channelLows, volumeZScores], (i) => {
      if (i < p.lookback) return null;

      const upperBand = channelHighs[i];
      const lowerBand = channelLows[i];
      const volZ = volumeZScores[i];
      if (upperBand === null || lowerBand === null || volZ === null) return null;

      const close = closes[i];
      const gap = pressureGap;
      const longAdverse = gap.longAdverse[i];
      const shortAdverse = gap.shortAdverse[i];

      if (longAdverse === null || shortAdverse === null) return null;

      if (close > upperBand && volZ > p.volumeZThreshold && longAdverse <= p.maxAdverse) {
        return createBuySignal(cleanData, i, "Donchian channel upside breakout with volume Z-Score spike and low adverse pressure gap");
      }
      if (close < lowerBand && volZ > p.volumeZThreshold && shortAdverse <= p.maxAdverse) {
        return createSellSignal(cleanData, i, "Donchian channel downside breakout with volume Z-Score spike and low adverse pressure gap");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "volumeZThreshold", "maxAdverse"],
  },
};
