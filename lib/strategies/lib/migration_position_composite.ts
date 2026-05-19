import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import {
	buildPricePositionInVA,
	buildValueAreaMigrationRate,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeMigrationPositionCompositeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		migration_threshold: Math.max(0, Number(params.migration_threshold ?? 0.2)),
		streak_length: Math.max(1, Math.round(params.streak_length ?? 3)),
	};
}

export const migration_position_composite: Strategy = {
	name: "Migration Position Composite",
	description: "Trades structural trends via either fast POC migration or persistent directional pinning outside the Value Area.",
	defaultParams: {
		lookback: 20,
		migration_threshold: 0.2,
		streak_length: 3,
	},
	paramLabels: {
		lookback: "VA Lookback",
		migration_threshold: "Migration Threshold",
		streak_length: "Streak Length",
	},
	normalizeParams: normalizeMigrationPositionCompositeParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeMigrationPositionCompositeParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const migrationThreshold = p.migration_threshold as number;
		const streakLength = p.streak_length as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
		const closeFlags = prepared.closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > prepared.closes[i - 1]) return 1;
			if (close < prepared.closes[i - 1]) return -1;
			return 0;
		});
		const streak = buildStreakCount(closeFlags);

		return createSignalLoop(prepared.cleanData, [migration, position], (i) => {
			if (i < lookback * 2) return null;

			const currentMigration = migration[i];
			const currentPosition = position[i];
			if (currentMigration === null || currentPosition === null) return null;

			const bullish = currentMigration > migrationThreshold
				|| (currentPosition > 1.0 && streak[i] >= streakLength);
			const bearish = currentMigration < -migrationThreshold
				|| (currentPosition < -1.0 && streak[i] <= -streakLength);

			if (bullish && bearish) return null;
			if (bullish) {
				return createBuySignal(prepared.cleanData, i, "Migration or positional dominance bullish");
			}
			if (bearish) {
				return createSellSignal(prepared.cleanData, i, "Migration or positional dominance bearish");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		migration_position_composite.executePrepared!(
			migration_position_composite.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "migration_threshold", "streak_length"],
	},
};
