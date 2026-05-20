import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildPolymarket1sExecutableEdge, buildPolymarket1sEdgePersistence } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 40)),
    efficiencyThreshold: Math.max(0, Number(params.efficiencyThreshold ?? 0.4)),
    minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    persistenceSec: Math.max(1, Math.round(params.persistenceSec ?? 3)),
  };
}

export const efficiency_ratio_edge_persistence: Strategy = {
  name: "Efficiency Ratio Edge Persistence",
  description: "Exploits high-efficiency directional trends on Binance, using the persistence of an executable price edge on Polymarket to filter out transient noise and confirm entry stability.",
  defaultParams: {
    lookback: 40,
    efficiencyThreshold: 0.4,
    minEdge: 0.015,
    persistenceSec: 3,
  },
  paramLabels: {
    lookback: "Lookback",
    efficiencyThreshold: "Efficiency Threshold",
    minEdge: "Min Edge",
    persistenceSec: "Persistence Sec",
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
    const efficiency = buildEfficiencyRatio(cleanData, p.lookback);
    const edgeFrame = buildPolymarket1sExecutableEdge(cleanData, context.polymarket1s, { volLookback: p.lookback });
    const persistence = buildPolymarket1sEdgePersistence(edgeFrame, {
      minEdge: p.minEdge,
      ewmaLookback: p.persistenceSec,
    });

    return createSignalLoop(cleanData, [efficiency], (i) => {
      if (i < p.lookback) return null;

      const er = efficiency[i];
      if (er === null) return null;

      const yesEdgeSec = persistence.yesEdgeSeconds[i];
      const noEdgeSec = persistence.noEdgeSeconds[i];

      const currentClose = closes[i];
      const pastClose = closes[i - p.lookback];

      if (er > p.efficiencyThreshold && currentClose > pastClose && yesEdgeSec >= p.persistenceSec) {
        return createBuySignal(cleanData, i, "High price efficiency trend with persisted Polymarket yes executable edge");
      }
      if (er > p.efficiencyThreshold && currentClose < pastClose && noEdgeSec >= p.persistenceSec) {
        return createSellSignal(cleanData, i, "High price efficiency trend with persisted Polymarket no executable edge");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "efficiencyThreshold", "minEdge", "persistenceSec"],
  },
};
