import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import {
	buildValueAreaWidth,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

const Z_SCORE_LOOKBACK = 20;

function normalizeWidthExpansionZscoreRouterParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		va_lookback: Math.max(3, Math.round(params.va_lookback ?? 55)),
		width_threshold: Math.max(0, Number(params.width_threshold ?? 0.1)),
		z_threshold: Math.max(0, Number(params.z_threshold ?? 2.0)),
	};
}

export const width_expansion_zscore_router: Strategy = {
	name: "Width Expansion ZScore Router",
	description: "Routes z-score extremes to mean reversion in compressed value and momentum in expanded value.",
	defaultParams: {
		va_lookback: 55,
		width_threshold: 0.1,
		z_threshold: 2.0,
	},
	paramLabels: {
		va_lookback: "VA Lookback",
		width_threshold: "Width Threshold",
		z_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeWidthExpansionZscoreRouterParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeWidthExpansionZscoreRouterParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const vaLookback = p.va_lookback as number;
		const widthThreshold = p.width_threshold as number;
		const zThreshold = p.z_threshold as number;

		const vaSeries = getValueAreaSeries(prepared, vaLookback, 0.68, 12);
		const width = buildValueAreaWidth(vaSeries.vah, vaSeries.val, prepared.closes);
		const zScore = buildRollingZScore(prepared.closes, Z_SCORE_LOOKBACK);

		return createSignalLoop(prepared.cleanData, [width, zScore], (i) => {
			if (i < Math.max(vaLookback, Z_SCORE_LOOKBACK)) return null;

			const currentWidth = width[i];
			const currentZ = zScore[i];
			if (currentWidth === null || currentZ === null) return null;

			if (currentWidth < widthThreshold) {
				if (currentZ < -zThreshold) {
					return createBuySignal(prepared.cleanData, i, "Compressed value lower z-score fade");
				}
				if (currentZ > zThreshold) {
					return createSellSignal(prepared.cleanData, i, "Compressed value upper z-score fade");
				}
				return null;
			}

			if (currentZ > zThreshold) {
				return createBuySignal(prepared.cleanData, i, "Expanded value upside z-score discovery");
			}
			if (currentZ < -zThreshold) {
				return createSellSignal(prepared.cleanData, i, "Expanded value downside z-score discovery");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		width_expansion_zscore_router.executePrepared!(
			width_expansion_zscore_router.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["va_lookback", "width_threshold", "z_threshold"],
	},
};
