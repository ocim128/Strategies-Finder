import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaMigrationRate,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeValueMigrationGoldenTrapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		conjugate_migration: Math.max(0, Number(params.conjugate_migration ?? 0.382)),
	};
}

export const value_migration_golden_trap: Strategy = {
	name: "Value Migration Golden Trap",
	description: "Fades Value Area breaks when POC migration stays below the golden conjugate and a counter-candle appears.",
	defaultParams: {
		lookback: 20,
		conjugate_migration: 0.382,
	},
	paramLabels: {
		lookback: "VA Lookback",
		conjugate_migration: "Conjugate Migration",
	},
	normalizeParams: normalizeValueMigrationGoldenTrapParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeValueMigrationGoldenTrapParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const conjugateMigration = p.conjugate_migration as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
		const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);

		return createSignalLoop(prepared.cleanData, [position, migration], (i) => {
			if (i < lookback * 2) return null;

			const currentPosition = position[i];
			const currentMigration = migration[i];
			if (currentPosition === null || currentMigration === null) return null;
			if (Math.abs(currentMigration) >= conjugateMigration) return null;

			const bar = prepared.cleanData[i];
			if (currentPosition < -1.0 && bar.close > bar.open) {
				return createBuySignal(prepared.cleanData, i, "Golden trap fade below static value");
			}
			if (currentPosition > 1.0 && bar.close < bar.open) {
				return createSellSignal(prepared.cleanData, i, "Golden trap fade above static value");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		value_migration_golden_trap.executePrepared!(
			value_migration_golden_trap.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "conjugate_migration"],
	},
};
