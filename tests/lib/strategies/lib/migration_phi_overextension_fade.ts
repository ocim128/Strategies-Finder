import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
} from "../strategy-helpers";
import {
  buildPricePositionInVA,
  buildValueAreaMigrationRate,
  getPreparedValueAreaData,
  getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeMigrationPhiOverextensionFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    phi_migration: Math.max(0.1, Number(params.phi_migration ?? 0.618)),
  };
}

export const migration_phi_overextension_fade: Strategy = {
  name: "Migration Phi Overextension Fade",
  description: "If the Value Area Migration Rate hits the golden threshold, the POC has violently shifted. If price is extended even further beyond this shift, fade it back to the newly established POC.",
  defaultParams: {
    lookback: 20,
    phi_migration: 0.618,
  },
  paramLabels: {
    lookback: "VA Lookback",
    phi_migration: "Phi Migration Limit",
  },
  normalizeParams: normalizeMigrationPhiOverextensionFadeParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeMigrationPhiOverextensionFadeParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const phiMigration = p.phi_migration as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [position, migration], (i) => {
      if (i < lookback * 2) return null;
      
      const currPos = position[i];
      const currMig = migration[i];
      
      if (currPos === null || currMig === null) return null;

      const currClose = prepared.closes[i];
      const prevClose = prepared.closes[i - 1];

      // Buy: Migration Rate < -phi_migration AND Price Position in VA < -1.0 AND Close > previous Close
      if (currMig < -phiMigration && currPos < -1.0 && currClose > prevClose) {
        return createBuySignal(prepared.cleanData, i, "Upside reversion to downside golden migration");
      }

      // Sell: Migration Rate > phi_migration AND Price Position in VA > 1.0 AND Close < previous Close
      if (currMig > phiMigration && currPos > 1.0 && currClose < prevClose) {
        return createSellSignal(prepared.cleanData, i, "Downside reversion to upside golden migration");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return migration_phi_overextension_fade.executePrepared!(
      migration_phi_overextension_fade.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "phi_migration"],
  },
};