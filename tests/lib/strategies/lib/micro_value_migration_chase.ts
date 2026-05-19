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

function normalizeMicroValueMigrationChaseParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 15)),
    migration_threshold: Math.max(0.01, Number(params.migration_threshold ?? 0.15)),
  };
}

export const micro_value_migration_chase: Strategy = {
  name: "Micro Value Migration Chase",
  description: "On HFT timeframes, when the Point of Control migrates rapidly AND price is already positioned on the aggressive side of that migration, a micro-trend is confirmed.",
  defaultParams: {
    lookback: 15,
    migration_threshold: 0.15,
  },
  paramLabels: {
    lookback: "VA Lookback",
    migration_threshold: "Min Migration Rate",
  },
  normalizeParams: normalizeMicroValueMigrationChaseParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeMicroValueMigrationChaseParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    const lookback = p.lookback as number;
    const migrationThreshold = p.migration_threshold as number;
    
    const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);

    return createSignalLoop(prepared.cleanData, [position, migration], (i) => {
      // Need 2x lookback for migration calculation
      const requiredBars = lookback * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const currMig = migration[i];
      
      if (currPos === null || currMig === null) return null;

      // Buy: Value Area Migration Rate > migration_threshold AND Price Position in VA > 0.5
      if (currMig > migrationThreshold && currPos > 0.5) {
        return createBuySignal(prepared.cleanData, i, "Upside micro value migration chase");
      }

      // Sell: Value Area Migration Rate < -migration_threshold AND Price Position in VA < -0.5
      if (currMig < -migrationThreshold && currPos < -0.5) {
        return createSellSignal(prepared.cleanData, i, "Downside micro value migration chase");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return micro_value_migration_chase.executePrepared!(
      micro_value_migration_chase.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "migration_threshold"],
  },
};