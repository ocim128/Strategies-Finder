import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
  getVolumes
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    corr_lookback: Math.max(2, Math.round(params.corr_lookback ?? 20)),
    phi_correlation: Math.min(0, Number(params.phi_correlation ?? -0.382)),
    vol_z_min: Math.max(0, Number(params.vol_z_min ?? 1.5)),
  };
}

export const euphoria_volume_phi_divergence: Strategy = {
  name: "Euphoria Volume Phi Divergence",
  description: "A correlation between volume and price returns below -0.382 proves smart money is distributing directly into retail demand.",
  defaultParams: {
    corr_lookback: 20,
    phi_correlation: -0.382,
    vol_z_min: 1.5,
  },
  paramLabels: {
    corr_lookback: "Correlation Lookback",
    phi_correlation: "Max Correlation",
    vol_z_min: "Min Volume Z-Score",
  },
  normalizeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeParams(params);
    if (cleanData.length < p.corr_lookback) return [];

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    const roc = buildRateOfChange(closes, 1);
    const volZScore = buildRollingZScore(volumes, p.corr_lookback);
    
    const volumesClean = volumes.map(v => v === null ? 0 : v);
    const correlation = buildRollingCorrelation(volumesClean, roc.map(r => r === null ? 0 : r), p.corr_lookback);

    return createSignalLoop(cleanData, [volZScore, correlation, roc], (i) => {
      if (i < p.corr_lookback) return null;
      const vz = volZScore[i];
      const corr = correlation[i];
      const currentRoc = roc[i];
      
      if (vz === null || corr === null || currentRoc === null) return null;

      if (vz > p.vol_z_min && corr < p.phi_correlation && currentRoc < 0) {
        return createBuySignal(cleanData, i, "Volume euphoria absorption long");
      }
      if (vz > p.vol_z_min && corr < p.phi_correlation && currentRoc > 0) {
        return createSellSignal(cleanData, i, "Volume euphoria absorption short");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["corr_lookback", "phi_correlation", "vol_z_min"],
  },
};





