import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
  getVolumes,
} from "../strategy-helpers";

function normalizeMicroVwapDislocationSnapParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 55)),
    dislocation_pct: Math.max(0.0001, Number(params.dislocation_pct ?? 0.05)),
  };
}

// Inline rolling VWAP calculation as it's computationally cheap
function buildRollingMicroVwap(closes: number[], volumes: number[], lookback: number): (number | null)[] {
  const len = closes.length;
  const vwap: (number | null)[] = new Array(len).fill(null);

  for (let i = lookback - 1; i < len; i++) {
    let sumVol = 0;
    let sumVolPrice = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      sumVol += volumes[j];
      sumVolPrice += closes[j] * volumes[j];
    }
    vwap[i] = sumVol > 0 ? sumVolPrice / sumVol : closes[i];
  }

  return vwap;
}

export const micro_vwap_dislocation_snap: Strategy = {
  name: "Micro VWAP Dislocation Snap",
  description: "A massive, instantaneous percent deviation from a rolling micro-VWAP is a pricing error that snaps back.",
  defaultParams: {
    lookback: 55,
    dislocation_pct: 0.05,
  },
  paramLabels: {
    lookback: "VWAP Lookback",
    dislocation_pct: "Dislocation Pct",
  },
  normalizeParams: normalizeMicroVwapDislocationSnapParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeMicroVwapDislocationSnapParams(params);
    const lookback = p.lookback as number;
    const dislocationPct = p.dislocation_pct as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    const vwap = buildRollingMicroVwap(closes, volumes, lookback);

    return createSignalLoop(cleanData, [vwap], (i) => {
      if (i < lookback) return null;
      
      const currVwap = vwap[i];
      if (currVwap === null) return null;

      const currBar = cleanData[i];

      const deviation = (currBar.close - currVwap) / currVwap;

      // Buy: Deviation < -dislocation_pct AND Close > Open
      if (deviation < -dislocationPct && currBar.close > currBar.open) {
        return createBuySignal(cleanData, i, "Snapback from downside VWAP dislocation");
      }

      // Sell: Deviation > dislocation_pct AND Close < Open
      if (deviation > dislocationPct && currBar.close < currBar.open) {
        return createSellSignal(cleanData, i, "Snapback from upside VWAP dislocation");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "dislocation_pct"],
  },
};