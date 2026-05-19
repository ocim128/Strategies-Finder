import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaRotation,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizePositionalCapitulationTrapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		excess_threshold: Math.max(1, Number(params.excess_threshold ?? 1.2)),
	};
}

export const positional_capitulation_trap: Strategy = {
	name: "Positional Capitulation Trap",
	description: "Fades deep positional excess when Value Area rotation moves against the breakout direction.",
	defaultParams: {
		lookback: 20,
		excess_threshold: 1.2,
	},
	paramLabels: {
		lookback: "VA Lookback",
		excess_threshold: "Excess Threshold",
	},
	normalizeParams: normalizePositionalCapitulationTrapParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizePositionalCapitulationTrapParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const excessThreshold = p.excess_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);

		return createSignalLoop(prepared.cleanData, [position, rotation.shift], (i) => {
			if (i < lookback * 2) return null;

			const currentPosition = position[i];
			const currentShift = rotation.shift[i];
			if (currentPosition === null || currentShift === null) return null;

			if (currentPosition < -excessThreshold && currentShift > 0) {
				return createBuySignal(prepared.cleanData, i, "Downside positional trap against rising value");
			}
			if (currentPosition > excessThreshold && currentShift < 0) {
				return createSellSignal(prepared.cleanData, i, "Upside positional trap against falling value");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		positional_capitulation_trap.executePrepared!(
			positional_capitulation_trap.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "excess_threshold"],
	},
};
