import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildValueAreaAcceptanceRate,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeAcceptanceFlashCrashParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 15)),
    crash_delta: Math.max(0.01, Number(params.crash_delta ?? 0.4)),
  };
}

export const acceptance_flash_crash: Strategy = {
  name: "Acceptance Flash Crash",
  description: "A sudden, catastrophic drop in Value Area Acceptance from a previously balanced state reveals a hidden order book imbalance.",
  defaultParams: {
    lookback: 15,
    crash_delta: 0.4,
  },
  paramLabels: {
    lookback: "VA Lookback",
    crash_delta: "Crash Delta Threshold",
  },
  normalizeParams: normalizeAcceptanceFlashCrashParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeAcceptanceFlashCrashParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, p.lookback as number);

    return createSignalLoop(prepared.cleanData, [acceptance, vaSeries.poc], (i) => {
      const requiredBars = (p.lookback as number) * 2;
      if (i < requiredBars) return null;
      
      const currAccept = acceptance[i];
      const prevAccept = acceptance[i - 1];
      const poc = vaSeries.poc[i];
      
      if (currAccept === null || prevAccept === null || poc === null) return null;

      const crashDelta = p.crash_delta as number;
      const drop = prevAccept - currAccept;
      const close = prepared.closes[i];

      // Buy: Acceptance drop > crash_delta AND Close > POC
      if (drop > crashDelta && close > poc) {
        return createBuySignal(prepared.cleanData, i, "Upside acceptance flash crash");
      }

      // Sell: Acceptance drop > crash_delta AND Close < POC
      if (drop > crashDelta && close < poc) {
        return createSellSignal(prepared.cleanData, i, "Downside acceptance flash crash");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return acceptance_flash_crash.executePrepared!(
      acceptance_flash_crash.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "crash_delta"],
  },
};