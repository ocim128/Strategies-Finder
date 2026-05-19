import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	buildValueAreaWidth,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeWidthCompressionGoldenBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		golden_compression: Math.max(0, Number(params.golden_compression ?? 0.0618)),
	};
}

export const width_compression_golden_breakout: Strategy = {
	name: "Width Compression Golden Breakout",
	description: "A compressed Value Area marks a coiled market; the first boundary break becomes the momentum entry.",
	defaultParams: {
		lookback: 20,
		golden_compression: 0.0618,
	},
	paramLabels: {
		lookback: "VA Lookback",
		golden_compression: "Golden Compression",
	},
	normalizeParams: normalizeWidthCompressionGoldenBreakoutParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeWidthCompressionGoldenBreakoutParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const goldenCompression = p.golden_compression as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);
		const position = buildPricePositionInVA(prepared.closes, vaSeries.vah, vaSeries.val, vaSeries.poc);

		return createSignalLoop(prepared.cleanData, [width, position], (i) => {
			if (i < lookback) return null;

			const currentWidth = width[i];
			const currentPosition = position[i];
			const previousPosition = position[i - 1];
			if (currentWidth === null || currentPosition === null || previousPosition === null) return null;
			if (currentWidth >= goldenCompression) return null;

			if (previousPosition <= 1.0 && currentPosition > 1.0) {
				return createBuySignal(prepared.cleanData, i, "Golden width compression breakout above VAH");
			}
			if (previousPosition >= -1.0 && currentPosition < -1.0) {
				return createSellSignal(prepared.cleanData, i, "Golden width compression breakdown below VAL");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		width_compression_golden_breakout.executePrepared!(
			width_compression_golden_breakout.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "golden_compression"],
	},
};
