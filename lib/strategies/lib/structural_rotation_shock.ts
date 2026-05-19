import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildValueAreaRotation,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeStructuralRotationShockParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		rotation_threshold: Math.max(0, Number(params.rotation_threshold ?? 2.0)),
	};
}

export const structural_rotation_shock: Strategy = {
	name: "Structural Rotation Shock",
	description: "Trades momentum when Value Area rotation crosses an extreme structural shift threshold.",
	defaultParams: {
		lookback: 20,
		rotation_threshold: 2.0,
	},
	paramLabels: {
		lookback: "VA Lookback",
		rotation_threshold: "Rotation Threshold",
	},
	normalizeParams: normalizeStructuralRotationShockParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeStructuralRotationShockParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const rotationThreshold = p.rotation_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);

		return createSignalLoop(prepared.cleanData, [rotation.shift], (i) => {
			if (i < lookback * 2) return null;

			const currentShift = rotation.shift[i];
			const previousShift = rotation.shift[i - 1];
			if (currentShift === null || previousShift === null) return null;

			if (previousShift <= rotationThreshold && currentShift > rotationThreshold) {
				return createBuySignal(prepared.cleanData, i, "Structural rotation shock upward");
			}
			if (previousShift >= -rotationThreshold && currentShift < -rotationThreshold) {
				return createSellSignal(prepared.cleanData, i, "Structural rotation shock downward");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		structural_rotation_shock.executePrepared!(
			structural_rotation_shock.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rotation_threshold"],
	},
};
