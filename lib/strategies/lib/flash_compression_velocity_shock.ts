import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeFlashCompressionVelocityShockParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 10)),
    compression_z: Math.min(-0.1, Number(params.compression_z ?? -2.0)),
    shock_z: Math.max(0.1, Number(params.shock_z ?? 3.0)),
  };
}

export const flash_compression_velocity_shock: Strategy = {
  name: "Flash Compression Velocity Shock",
  description: "When short-term volatility collapses to near-zero and is immediately followed by a 3-sigma price velocity shock, it signals the start of a directional cascade.",
  defaultParams: {
    lookback: 10,
    compression_z: -2.0,
    shock_z: 3.0,
  },
  paramLabels: {
    lookback: "Z-Score Lookback",
    compression_z: "Compression Z-Score",
    shock_z: "Shock Z-Score",
  },
  normalizeParams: normalizeFlashCompressionVelocityShockParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeFlashCompressionVelocityShockParams(params);
    const lookback = p.lookback as number;
    const compressionZ = p.compression_z as number;
    const shockZ = p.shock_z as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const priceZ = buildRollingZScore(closes, lookback);
    
    const ranges = extractBarMetricSeries(cleanData, "range");
    const rangeZ = buildRollingZScore(ranges, lookback);

    return createSignalLoop(cleanData, [priceZ, rangeZ], (i) => {
      if (i < lookback + 1) return null;
      
      const prevRangeZ = rangeZ[i - 1];
      const currPriceZ = priceZ[i];
      
      if (prevRangeZ === null || currPriceZ === null) return null;

      // Buy: Range Z-Score[previous] < compression_z AND Price Z-Score > shock_z
      if (prevRangeZ < compressionZ && currPriceZ > shockZ) {
        return createBuySignal(cleanData, i, "Upside velocity shock from flash compression");
      }

      // Sell: Range Z-Score[previous] < compression_z AND Price Z-Score < -shock_z
      if (prevRangeZ < compressionZ && currPriceZ < -shockZ) {
        return createSellSignal(cleanData, i, "Downside velocity shock from flash compression");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "compression_z", "shock_z"],
  },
};