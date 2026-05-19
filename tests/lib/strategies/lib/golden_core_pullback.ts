import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaMigrationRate,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeGoldenCorePullbackParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		phi_pocket: Math.max(0, Math.min(1, Number(params.phi_pocket ?? 0.618))),
	};
}

export const golden_core_pullback: Strategy = {
	name: "Golden Core Pullback",
	description: "Enters trend continuation when migrating value pulls price back into the internal golden pocket.",
	defaultParams: {
		lookback: 20,
		phi_pocket: 0.618,
	},
	paramLabels: {
		lookback: "VA Lookback",
		phi_pocket: "Phi Pocket",
	},
	normalizeParams: normalizeGoldenCorePullbackParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeGoldenCorePullbackParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const phiPocket = p.phi_pocket as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [migration, position], (i) => {
			if (i < lookback * 2) return null;

			const currentMigration = migration[i];
			const previousPosition = position[i - 1];
			const currentPosition = position[i];
			if (currentMigration === null || previousPosition === null || currentPosition === null) return null;

			if (currentMigration > 0.1 && previousPosition >= phiPocket && currentPosition < phiPocket) {
				return createBuySignal(prepared.cleanData, i, "Golden pocket pullback in rising value");
			}
			if (currentMigration < -0.1 && previousPosition <= -phiPocket && currentPosition > -phiPocket) {
				return createSellSignal(prepared.cleanData, i, "Golden pocket pullback in falling value");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		golden_core_pullback.executePrepared!(
			golden_core_pullback.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_pocket"],
	},
};
