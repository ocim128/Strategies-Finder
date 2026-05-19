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

function normalizeStaticValueFalseBreakoutParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 20)),
    max_migration: Math.max(0, Number(params.max_migration ?? 0.1)),
  };
}

export const static_value_false_breakout: Strategy = {
  name: "Static Value False Breakout",
  description: "If price attempts to trend but the underlying Value Area Migration Rate remains near zero, the breakout lacks institutional backing and will revert.",
  defaultParams: {
    lookback: 20,
    max_migration: 0.1,
  },
  paramLabels: {
    lookback: "VA Lookback",
    max_migration: "Max Migration Rate",
  },
  normalizeParams: normalizeStaticValueFalseBreakoutParams,
  prepareFinderData: (data: OHLCVData[]) => {
    return getPreparedValueAreaData(null, data);
  },
  executePrepared: (
    preparedData: unknown,
    params: StrategyParams,
    data: OHLCVData[],
    _context?: StrategyExecutionContext
  ) => {
    const p = normalizeStaticValueFalseBreakoutParams(params);
    const prepared = getPreparedValueAreaData(preparedData, data);
    
    // #COMPLETION_DRIVE: Using standard 68% VA coverage
    // #SUGGEST_VERIFY: Test if a wider/narrower VA improves the definition of "false breakout"
    const vaSeries = getValueAreaSeries(prepared, p.lookback as number, 0.68, 12);
    
    const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
    // Use the same lookback period for migration rate calculation
    const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, p.lookback as number);

    return createSignalLoop(prepared.cleanData, [position, migration], (i) => {
      // Need enough bars for both the primary VA lookback and the secondary migration lookback
      const requiredBars = (p.lookback as number) * 2;
      if (i < requiredBars) return null;
      
      const currPos = position[i];
      const currMig = migration[i];
      
      if (currPos === null || currMig === null) return null;

      const maxMigration = p.max_migration as number;

      // Buy: Absolute Value Area Migration Rate < max_migration AND Price Position < -1.0
      if (Math.abs(currMig) < maxMigration && currPos < -1.0) {
        return createBuySignal(prepared.cleanData, i, "False breakdown (static value)");
      }

      // Sell: Absolute Value Area Migration Rate < max_migration AND Price Position > 1.0
      if (Math.abs(currMig) < maxMigration && currPos > 1.0) {
        return createSellSignal(prepared.cleanData, i, "False breakout (static value)");
      }

      return null;
    });
  },
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
    return static_value_false_breakout.executePrepared!(
      static_value_false_breakout.prepareFinderData!(data),
      params,
      data,
      context
    );
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "max_migration"],
  },
};