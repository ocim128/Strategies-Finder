import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildValueAreaRotation,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeValueAreaRotationDriftParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		shift_threshold: Math.max(0, Number(params.shift_threshold ?? 0.5)),
	};
}

export const value_area_rotation_drift: Strategy = {
	name: "Value Area Rotation Drift",
	description: "Follows directional Value Area rotation when the distribution shift exceeds a minimum drift threshold.",
	defaultParams: {
		lookback: 20,
		shift_threshold: 0.5,
	},
	paramLabels: {
		lookback: "VA Lookback",
		shift_threshold: "Shift Threshold",
	},
	normalizeParams: normalizeValueAreaRotationDriftParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeValueAreaRotationDriftParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const shiftThreshold = p.shift_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);

		return createSignalLoop(prepared.cleanData, [rotation.shift], (i) => {
			if (i < lookback * 2) return null;

			const shift = rotation.shift[i];
			if (shift === null) return null;

			if (shift > shiftThreshold) {
				return createBuySignal(prepared.cleanData, i, "Value Area rotation drift upward");
			}
			if (shift < -shiftThreshold) {
				return createSellSignal(prepared.cleanData, i, "Value Area rotation drift downward");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		value_area_rotation_drift.executePrepared!(
			value_area_rotation_drift.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "shift_threshold"],
	},
};
