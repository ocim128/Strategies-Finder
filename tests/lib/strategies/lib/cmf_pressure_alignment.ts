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
import { calculateCMF } from "../indicators";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    cmfPeriod: Math.max(2, Math.round(params.cmfPeriod ?? 20)),
    cmfThreshold: Math.max(0, Number(params.cmfThreshold ?? 0.15)),
    maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.04)),
  };
}

export const cmf_pressure_alignment: Strategy = {
  name: "CMF Pressure Alignment",
  description: "Uses volume-weighted money flow to identify accumulation/distribution, vetoing entries if Polymarket probabilities strongly oppose the flow.",
  defaultParams: {
    cmfPeriod: 20,
    cmfThreshold: 0.15,
    maxAdverse: 0.04,
  },
  paramLabels: {
    cmfPeriod: "CMF Period",
    cmfThreshold: "CMF Threshold",
    maxAdverse: "Max Adverse Pressure",
  },
  normalizeParams,
  polymarket1sConfig: {
    required: true,
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);

    if (cleanData.length < p.cmfPeriod) return [];
    if (!context?.polymarket1s) return [];

    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);

    const cmf = calculateCMF(highs, lows, closes, volumes, p.cmfPeriod);
    const pressureGap = buildPolymarket1sPressureGap(cleanData, context.polymarket1s);

    return createSignalLoop(cleanData, [cmf], (i) => {
      if (i < p.cmfPeriod) return null;
      
      const currentCmf = cmf[i];
      if (currentCmf === null) return null;

      const gap = pressureGap;
      const longAdverse = gap.longAdverse[i];
      const shortAdverse = gap.shortAdverse[i];

      if (longAdverse === null || shortAdverse === null) return null;

      if (currentCmf > p.cmfThreshold) {
        if (longAdverse <= p.maxAdverse) {
            return createBuySignal(cleanData, i, "CMF Bullish accumulation with acceptable pressure");
        }
      }
      if (currentCmf < -p.cmfThreshold) {
        if (shortAdverse <= p.maxAdverse) {
            return createSellSignal(cleanData, i, "CMF Bearish distribution with acceptable pressure");
        }
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["cmfPeriod", "cmfThreshold", "maxAdverse"],
  },
};





