import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaAcceptanceRate,
	buildValueAreaRotation,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

const ACCEPTANCE_THRESHOLD = 0.4;
const POSITION_THRESHOLD = 0.8;

function normalizeValueAcceptanceQuorumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
	};
}

export const value_acceptance_quorum: Strategy = {
	name: "Value Acceptance Quorum",
	description: "Requires low acceptance, directional Value Area position, and matching distribution drift for initiative entries.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "VA Lookback",
	},
	normalizeParams: normalizeValueAcceptanceQuorumParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeValueAcceptanceQuorumParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);

		return createSignalLoop(prepared.cleanData, [acceptance, position, rotation.shift], (i) => {
			if (i < lookback * 2) return null;

			const currentAcceptance = acceptance[i];
			const currentPosition = position[i];
			const currentShift = rotation.shift[i];
			if (currentAcceptance === null || currentPosition === null || currentShift === null) return null;
			if (currentAcceptance >= ACCEPTANCE_THRESHOLD) return null;

			if (currentPosition > POSITION_THRESHOLD && currentShift > 0) {
				return createBuySignal(prepared.cleanData, i, "Unanimous value acceptance quorum bullish");
			}
			if (currentPosition < -POSITION_THRESHOLD && currentShift < 0) {
				return createSellSignal(prepared.cleanData, i, "Unanimous value acceptance quorum bearish");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		value_acceptance_quorum.executePrepared!(
			value_acceptance_quorum.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
