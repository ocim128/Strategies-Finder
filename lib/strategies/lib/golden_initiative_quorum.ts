import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaAcceptanceRate,
	buildValueAreaMigrationRate,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeGoldenInitiativeQuorumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		phi_primary: Math.max(0, Number(params.phi_primary ?? 0.618)),
		phi_conjugate: Math.max(0, Math.min(1, Number(params.phi_conjugate ?? 0.382))),
	};
}

export const golden_initiative_quorum: Strategy = {
	name: "Golden Initiative Quorum",
	description: "Requires migration, low acceptance, and structural position to form a golden breakout quorum.",
	defaultParams: {
		lookback: 20,
		phi_primary: 0.618,
		phi_conjugate: 0.382,
	},
	paramLabels: {
		lookback: "VA Lookback",
		phi_primary: "Phi Primary",
		phi_conjugate: "Phi Conjugate",
	},
	normalizeParams: normalizeGoldenInitiativeQuorumParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeGoldenInitiativeQuorumParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const phiPrimary = p.phi_primary as number;
		const phiConjugate = p.phi_conjugate as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const migration = buildValueAreaMigrationRate(vaSeries.poc, prepared.closes, lookback);
		const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [migration, acceptance, position], (i) => {
			if (i < lookback * 2) return null;

			const currentMigration = migration[i];
			const currentAcceptance = acceptance[i];
			const currentPosition = position[i];
			if (currentMigration === null || currentAcceptance === null || currentPosition === null) return null;
			if (currentAcceptance >= phiConjugate) return null;

			if (currentMigration > phiPrimary && currentPosition > phiPrimary) {
				return createBuySignal(prepared.cleanData, i, "Golden initiative quorum bullish");
			}
			if (currentMigration < -phiPrimary && currentPosition < -phiPrimary) {
				return createSellSignal(prepared.cleanData, i, "Golden initiative quorum bearish");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		golden_initiative_quorum.executePrepared!(
			golden_initiative_quorum.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_primary", "phi_conjugate"],
	},
};
