import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildValueAreaMigrationRate,
	buildValueAreaWidth,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeThinLiquidityAirPocketFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		width_threshold: Math.max(0, Number(params.width_threshold ?? 0.04)),
		migration_threshold: Math.max(0, Number(params.migration_threshold ?? 0.2)),
	};
}

export const thin_liquidity_air_pocket_fade: Strategy = {
	name: "Thin Liquidity Air Pocket Fade",
	description: "Fades compressed Value Area migration jumps that look like thin-liquidity air pockets rather than broad value discovery.",
	defaultParams: {
		lookback: 20,
		width_threshold: 0.04,
		migration_threshold: 0.2,
	},
	paramLabels: {
		lookback: "VA Lookback",
		width_threshold: "Max VA Width",
		migration_threshold: "Migration Threshold",
	},
	normalizeParams: normalizeThinLiquidityAirPocketFadeParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeThinLiquidityAirPocketFadeParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const widthThreshold = p.width_threshold as number;
		const migrationThreshold = p.migration_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);
		const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);

		return createSignalLoop(prepared.cleanData, [width, migration, vaSeries.poc], (i) => {
			if (i < lookback * 2) return null;

			const currentWidth = width[i];
			const currentMigration = migration[i];
			const currentPoc = vaSeries.poc[i];
			if (currentWidth === null || currentMigration === null || currentPoc === null) return null;
			if (currentWidth >= widthThreshold) return null;

			if (currentMigration < -migrationThreshold && prepared.closes[i] > currentPoc) {
				return createBuySignal(prepared.cleanData, i, "Fade downside thin-liquidity migration pocket");
			}
			if (currentMigration > migrationThreshold && prepared.closes[i] < currentPoc) {
				return createSellSignal(prepared.cleanData, i, "Fade upside thin-liquidity migration pocket");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		thin_liquidity_air_pocket_fade.executePrepared!(
			thin_liquidity_air_pocket_fade.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "width_threshold", "migration_threshold"],
	},
};
