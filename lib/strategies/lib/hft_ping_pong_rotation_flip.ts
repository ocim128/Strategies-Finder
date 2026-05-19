import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildValueAreaRotation,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeHftPingPongRotationFlipParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 10)),
    flip_magnitude: Math.max(0.01, Number(params.flip_magnitude ?? 1.0)),
  };
}

export const hft_ping_pong_rotation_flip: Strategy = {
  name: "HFT Ping Pong Rotation Flip",
  description: "A sudden, violent flip in the Value Area Rotation sign signals the ping-pong is over and true distribution has begun.",
  defaultParams: {
    lookback: 10,
    flip_magnitude: 1.0,
  },
  paramLabels: {
    lookback: "VA Lookback",
    flip_magnitude: "Flip Magnitude",
  },
  normalizeParams: normalizeHftPingPongRotationFlipParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeHftPingPongRotationFlipParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [rotation.shift], (i) => {
      // Need 2x lookback for prev rotation check
      const requiredBars = lookback * 2;
      if (i < requiredBars) return null;
      
      const currShift = rotation.shift[i];
      const prevShift = rotation.shift[i - 1];
      
      if (currShift === null || prevShift === null) return null;

      const flipMagnitude = p.flip_magnitude as number;

      // Buy: Prev Rotation Shift < -flip_magnitude AND Current Rotation Shift > flip_magnitude
      if (prevShift < -flipMagnitude && currShift > flipMagnitude) {
        return createBuySignal(prepared.cleanData, i, "Upside polarity flip (ping-pong ended)");
      }

      // Sell: Prev Rotation Shift > flip_magnitude AND Current Rotation Shift < -flip_magnitude
      if (prevShift > flipMagnitude && currShift < -flipMagnitude) {
        return createSellSignal(prepared.cleanData, i, "Downside polarity flip (ping-pong ended)");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return hft_ping_pong_rotation_flip.executePrepared!(
      hft_ping_pong_rotation_flip.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "flip_magnitude"],
  },
};