import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaAcceptanceRate,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeGoldenConjugateInitiativeTrendParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		conjugate_acceptance: Math.max(0, Math.min(1, Number(params.conjugate_acceptance ?? 0.382))),
	};
}

export const golden_conjugate_initiative_trend: Strategy = {
	name: "Golden Conjugate Initiative Trend",
	description: "Low Value Area acceptance confirms initiative value discovery when price extends beyond the distribution.",
	defaultParams: {
		lookback: 20,
		conjugate_acceptance: 0.382,
	},
	paramLabels: {
		lookback: "VA Lookback",
		conjugate_acceptance: "Conjugate Acceptance",
	},
	normalizeParams: normalizeGoldenConjugateInitiativeTrendParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeGoldenConjugateInitiativeTrendParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const conjugateAcceptance = p.conjugate_acceptance as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [acceptance, position], (i) => {
			if (i < lookback * 2) return null;

			const currentAcceptance = acceptance[i];
			const currentPosition = position[i];
			if (currentAcceptance === null || currentPosition === null) return null;
			if (currentAcceptance >= conjugateAcceptance) return null;

			if (currentPosition > 1.0 && prepared.closes[i] > prepared.closes[i - 1]) {
				return createBuySignal(prepared.cleanData, i, "Low-acceptance initiative breakout");
			}
			if (currentPosition < -1.0 && prepared.closes[i] < prepared.closes[i - 1]) {
				return createSellSignal(prepared.cleanData, i, "Low-acceptance initiative breakdown");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		golden_conjugate_initiative_trend.executePrepared!(
			golden_conjugate_initiative_trend.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "conjugate_acceptance"],
	},
};
