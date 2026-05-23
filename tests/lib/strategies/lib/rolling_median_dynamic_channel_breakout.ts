import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap, type Polymarket1sPressureGapFrame } from "./polymarket-1s-helpers";

type RollingMedianDynamicChannelPrepared = {
  cleanData: OHLCVData[];
  closes: number[];
  polymarket1s: StrategyExecutionContext["polymarket1s"] | null;
  medianByLookback: Map<number, (number | null)[]>;
  stdDevByLookback: Map<number, (number | null)[]>;
  pressureGapByLookback: Map<number, Polymarket1sPressureGapFrame>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    threshold: Math.max(0, Number(params.threshold ?? 1.5)),
    maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.05)),
  };
}

function prepareRollingMedianDynamicChannelData(
  data: OHLCVData[],
  context?: StrategyExecutionContext
): RollingMedianDynamicChannelPrepared {
  const cleanData = ensureCleanData(data);
  return {
    cleanData,
    closes: getCloses(cleanData),
    polymarket1s: context?.polymarket1s ?? null,
    medianByLookback: new Map<number, (number | null)[]>(),
    stdDevByLookback: new Map<number, (number | null)[]>(),
    pressureGapByLookback: new Map<number, Polymarket1sPressureGapFrame>(),
  };
}

function getPreparedRollingMedianDynamicChannelData(
  preparedData: unknown,
  data: OHLCVData[],
  context?: StrategyExecutionContext
): RollingMedianDynamicChannelPrepared {
  if (preparedData && typeof preparedData === "object" && "medianByLookback" in preparedData) {
    const prepared = preparedData as RollingMedianDynamicChannelPrepared;
    if (prepared.polymarket1s === (context?.polymarket1s ?? null)) {
      return prepared;
    }
  }
  return prepareRollingMedianDynamicChannelData(data, context);
}

function getRollingMedian(prepared: RollingMedianDynamicChannelPrepared, lookback: number): (number | null)[] {
  let rollingMedian = prepared.medianByLookback.get(lookback);
  if (!rollingMedian) {
    rollingMedian = buildRollingMedian(prepared.closes, lookback);
    prepared.medianByLookback.set(lookback, rollingMedian);
  }
  return rollingMedian;
}

function getRollingStdDev(prepared: RollingMedianDynamicChannelPrepared, lookback: number): (number | null)[] {
  let rollingStdDev = prepared.stdDevByLookback.get(lookback);
  if (!rollingStdDev) {
    rollingStdDev = buildRollingStdDev(prepared.closes, lookback);
    prepared.stdDevByLookback.set(lookback, rollingStdDev);
  }
  return rollingStdDev;
}

function getPressureGap(
  prepared: RollingMedianDynamicChannelPrepared,
  lookback: number,
  context: StrategyExecutionContext
): Polymarket1sPressureGapFrame {
  let pressureGap = prepared.pressureGapByLookback.get(lookback);
  if (!pressureGap) {
    pressureGap = buildPolymarket1sPressureGap(prepared.cleanData, context, { volLookback: lookback });
    prepared.pressureGapByLookback.set(lookback, pressureGap);
  }
  return pressureGap;
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
  prepareFinderData: (data, _settings, context) => prepareRollingMedianDynamicChannelData(data, context),
  executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
    const p = normalizeParams(params);

    if (!context?.polymarket1s) return [];
    const prepared = getPreparedRollingMedianDynamicChannelData(preparedData, data, context);
    if (prepared.cleanData.length < p.lookback) return [];

    const lookback = p.lookback as number;
    const rollingMedian = getRollingMedian(prepared, lookback);
    const rollingStdDev = getRollingStdDev(prepared, lookback);
    const pressureGap = getPressureGap(prepared, lookback, context);

    return createSignalLoop(prepared.cleanData, [rollingMedian, rollingStdDev], (i) => {
      if (i < lookback) return null;

      const median = rollingMedian[i];
      const stdDev = rollingStdDev[i];
      if (median === null || stdDev === null) return null;

      const close = prepared.closes[i];
      const gap = pressureGap;
      const longAdverse = gap.longAdverse[i];
      const shortAdverse = gap.shortAdverse[i];

      if (longAdverse === null || shortAdverse === null) return null;

      if (close > (median + p.threshold * stdDev)) {
        if (longAdverse <= p.maxAdverse) {
          return createBuySignal(prepared.cleanData, i, "Breakout above rolling median channel with low adverse pressure gap");
        }
      }
      if (close < (median - p.threshold * stdDev)) {
        if (shortAdverse <= p.maxAdverse) {
          return createSellSignal(prepared.cleanData, i, "Breakout below rolling median channel with low adverse pressure gap");
        }
      }
      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
    rolling_median_dynamic_channel_breakout.executePrepared?.(
      prepareRollingMedianDynamicChannelData(data, context),
      params,
      data,
      context
    ) ?? [],
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "threshold", "maxAdverse"],
  },
};
