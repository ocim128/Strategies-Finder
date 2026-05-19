import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildValueAreaAcceptanceRate,
	buildValueAreaWidth,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeCompressionInitiativeSqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		width_threshold: Math.max(0, Number(params.width_threshold ?? 0.05)),
		accept_threshold: Math.max(0, Math.min(1, Number(params.accept_threshold ?? 0.35))),
	};
}

export const compression_initiative_squeeze: Strategy = {
	name: "Compression Initiative Squeeze",
	description: "A narrow Value Area and sudden acceptance breakdown mark initiative flow breaking out of balance.",
	defaultParams: {
		lookback: 20,
		width_threshold: 0.05,
		accept_threshold: 0.35,
	},
	paramLabels: {
		lookback: "VA Lookback",
		width_threshold: "Max VA Width",
		accept_threshold: "Acceptance Drop Threshold",
	},
	normalizeParams: normalizeCompressionInitiativeSqueezeParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeCompressionInitiativeSqueezeParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const widthThreshold = p.width_threshold as number;
		const acceptThreshold = p.accept_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);
		const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);
		const acceptance = buildValueAreaAcceptanceRate(prepared.closes, vaSeries.vah, vaSeries.val, lookback);

		return createSignalLoop(prepared.cleanData, [width, acceptance, vaSeries.poc], (i) => {
			if (i < lookback * 2) return null;

			const currentWidth = width[i];
			const currentAcceptance = acceptance[i];
			const previousAcceptance = acceptance[i - 1];
			const currentPoc = vaSeries.poc[i];
			if (
				currentWidth === null
				|| currentAcceptance === null
				|| previousAcceptance === null
				|| currentPoc === null
			) return null;

			const acceptanceDropped = previousAcceptance >= acceptThreshold && currentAcceptance < acceptThreshold;
			if (currentWidth >= widthThreshold || !acceptanceDropped) return null;

			if (prepared.closes[i] > currentPoc) {
				return createBuySignal(prepared.cleanData, i, "Compressed value initiative break above POC");
			}
			if (prepared.closes[i] < currentPoc) {
				return createSellSignal(prepared.cleanData, i, "Compressed value initiative break below POC");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		compression_initiative_squeeze.executePrepared!(
			compression_initiative_squeeze.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "width_threshold", "accept_threshold"],
	},
};
