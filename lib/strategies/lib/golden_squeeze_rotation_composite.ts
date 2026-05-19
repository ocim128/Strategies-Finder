import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaRotation,
	buildValueAreaWidth,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeGoldenSqueezeRotationCompositeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		phi_squeeze: Math.max(0, Number(params.phi_squeeze ?? 0.0618)),
		phi_rotation: Math.max(0, Number(params.phi_rotation ?? 1.618)),
	};
}

export const golden_squeeze_rotation_composite: Strategy = {
	name: "Golden Squeeze Rotation Composite",
	description: "Combines golden width squeeze breakouts with violent Value Area rotation entries.",
	defaultParams: {
		lookback: 20,
		phi_squeeze: 0.0618,
		phi_rotation: 1.618,
	},
	paramLabels: {
		lookback: "VA Lookback",
		phi_squeeze: "Phi Squeeze",
		phi_rotation: "Phi Rotation",
	},
	normalizeParams: normalizeGoldenSqueezeRotationCompositeParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeGoldenSqueezeRotationCompositeParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const phiSqueeze = p.phi_squeeze as number;
		const phiRotation = p.phi_rotation as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);
		const rotation = buildValueAreaRotation(vaSeries.vah, vaSeries.val, prepared.closes, lookback);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [width, rotation.shift, position], (i) => {
			if (i < lookback * 2) return null;

			const currentWidth = width[i];
			const currentShift = rotation.shift[i];
			const currentPosition = position[i];
			if (currentWidth === null || currentShift === null || currentPosition === null) return null;

			if (
				(currentWidth < phiSqueeze && currentPosition > 1.0)
				|| (currentShift > phiRotation && currentPosition > 0)
			) {
				return createBuySignal(prepared.cleanData, i, "Golden squeeze or rotation composite bullish");
			}
			if (
				(currentWidth < phiSqueeze && currentPosition < -1.0)
				|| (currentShift < -phiRotation && currentPosition < 0)
			) {
				return createSellSignal(prepared.cleanData, i, "Golden squeeze or rotation composite bearish");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		golden_squeeze_rotation_composite.executePrepared!(
			golden_squeeze_rotation_composite.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_squeeze", "phi_rotation"],
	},
};
