import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import {
	buildValueAreaMigrationRate,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeMigrationEfficiencyDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		er_threshold: Math.max(0, Math.min(1, Number(params.er_threshold ?? 0.6))),
		migration_cap: Math.max(0, Number(params.migration_cap ?? 0.05)),
	};
}

export const migration_efficiency_divergence: Strategy = {
	name: "Migration Efficiency Divergence",
	description: "Fades efficient price trends when Value Area migration proves that structural value stayed flat.",
	defaultParams: {
		lookback: 20,
		er_threshold: 0.6,
		migration_cap: 0.05,
	},
	paramLabels: {
		lookback: "Lookback",
		er_threshold: "Efficiency Threshold",
		migration_cap: "Migration Cap",
	},
	normalizeParams: normalizeMigrationEfficiencyDivergenceParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeMigrationEfficiencyDivergenceParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const erThreshold = p.er_threshold as number;
		const migrationCap = p.migration_cap as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);
		const efficiency = buildEfficiencyRatio(prepared.cleanData, lookback);

		return createSignalLoop(prepared.cleanData, [migration, efficiency], (i) => {
			if (i < lookback * 2) return null;

			const currentMigration = migration[i];
			const currentEfficiency = efficiency[i];
			if (currentMigration === null || currentEfficiency === null) return null;
			if (currentEfficiency <= erThreshold || Math.abs(currentMigration) >= migrationCap) return null;

			if (prepared.closes[i] < prepared.closes[i - lookback]) {
				return createBuySignal(prepared.cleanData, i, "Efficient downtrend without value migration");
			}
			if (prepared.closes[i] > prepared.closes[i - lookback]) {
				return createSellSignal(prepared.cleanData, i, "Efficient uptrend without value migration");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		migration_efficiency_divergence.executePrepared!(
			migration_efficiency_divergence.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "er_threshold", "migration_cap"],
	},
};
