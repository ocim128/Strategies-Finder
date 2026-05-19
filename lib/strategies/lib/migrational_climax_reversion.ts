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

function normalizeMigrationalClimaxReversionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    climax_migration: Math.max(0.01, Number(params.climax_migration ?? 0.3)),
  };
}

export const migrational_climax_reversion: Strategy = {
  name: "Migrational Climax Reversion",
  description: "When the Value Area is migrating extremely fast and price is simultaneously overextended, the trend has reached a blow-off climax and is ripe for a sharp fade.",
  defaultParams: {
    lookback: 20,
    climax_migration: 0.3,
  },
  paramLabels: {
    lookback: "VA Lookback",
    climax_migration: "Climax Migration Rate",
  },
  normalizeParams: normalizeMigrationalClimaxReversionParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeMigrationalClimaxReversionParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, p.lookback as number);

    return createSignalLoop(prepared.cleanData, [position, migration], (i) => {
      const requiredBars = (p.lookback as number) * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const currMig = migration[i];
      const currClose = prepared.closes[i];
      const prevClose = prepared.closes[i - 1];
      
      if (currPos === null || currMig === null) return null;

      const climaxMigration = p.climax_migration as number;

      // Buy: Migration < -climax_migration AND Price Position < -1.2 AND Close > previous Close
      if (currMig < -climaxMigration && currPos < -1.2 && currClose > prevClose) {
        return createBuySignal(prepared.cleanData, i, "Blow-off bottom climax reversion");
      }

      // Sell: Migration > climax_migration AND Price Position > 1.2 AND Close < previous Close
      if (currMig > climaxMigration && currPos > 1.2 && currClose < prevClose) {
        return createSellSignal(prepared.cleanData, i, "Blow-off top climax reversion");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return migrational_climax_reversion.executePrepared!(
      migrational_climax_reversion.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "climax_migration"],
  },
};