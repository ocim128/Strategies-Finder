import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildPricePositionInVA,
  buildValueAreaRotation,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeRotationPhiDivergenceTrapParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_rotation: Math.max(0.1, Number(params.phi_rotation ?? 0.618)),
  };
}

export const rotation_phi_divergence_trap: Strategy = {
  name: "Rotation Phi Divergence Trap",
  description: "If price breaches the Value Area High, but the Value Area Rotation shift violently opposes the breakout with a negative magnitude > 0.618, it is a mathematically proven bull trap.",
  defaultParams: {
    lookback: 20,
    phi_rotation: 0.618,
  },
  paramLabels: {
    lookback: "VA Lookback",
    phi_rotation: "Phi Rotation Magnitude",
  },
  normalizeParams: normalizeRotationPhiDivergenceTrapParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeRotationPhiDivergenceTrapParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const phiRotation = p.phi_rotation as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    // Use the same lookback period for rotation calculation
    const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [position, rotation.shift], (i) => {
      // Need 2x lookback for rotation
      const requiredBars = lookback * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const currShift = rotation.shift[i];
      
      if (currPos === null || currShift === null) return null;

      // Buy: Price Position in VA < -1.0 AND Rotation Shift > phi_rotation
      if (currPos < -1.0 && currShift > phiRotation) {
        return createBuySignal(prepared.cleanData, i, "Bear trap: Price down, Value strongly up");
      }

      // Sell: Price Position in VA > 1.0 AND Rotation Shift < -phi_rotation
      if (currPos > 1.0 && currShift < -phiRotation) {
        return createSellSignal(prepared.cleanData, i, "Bull trap: Price up, Value strongly down");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return rotation_phi_divergence_trap.executePrepared!(
      rotation_phi_divergence_trap.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_rotation"],
  },
};