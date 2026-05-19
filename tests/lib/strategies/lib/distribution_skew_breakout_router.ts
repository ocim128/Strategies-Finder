import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeDistributionSkewBreakoutRouterParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 55)),
		skew_offset: Math.max(0, Math.min(0.49, Number(params.skew_offset ?? 0.1))),
	};
}

export const distribution_skew_breakout_router: Strategy = {
	name: "Distribution Skew Breakout Router",
	description: "Routes breakouts by the POC skew inside the Value Area, buying accumulation profiles and selling distribution profiles.",
	defaultParams: {
		lookback: 55,
		skew_offset: 0.1,
	},
	paramLabels: {
		lookback: "VA Lookback",
		skew_offset: "Skew Offset",
	},
	normalizeParams: normalizeDistributionSkewBreakoutRouterParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeDistributionSkewBreakoutRouterParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const lookback = p.lookback as number;
		const skewOffset = p.skew_offset as number;
		const accumulationSkew = 0.5 + skewOffset;
		const distributionSkew = 0.5 - skewOffset;

		const vaSeries = getValueAreaSeries(prepared, lookback, 0.68, 12);

		return createSignalLoop(prepared.cleanData, [vaSeries.vah, vaSeries.val, vaSeries.poc], (i) => {
			if (i < lookback) return null;

			const currentVah = vaSeries.vah[i];
			const previousVah = vaSeries.vah[i - 1];
			const currentVal = vaSeries.val[i];
			const previousVal = vaSeries.val[i - 1];
			const currentPoc = vaSeries.poc[i];
			if (
				currentVah === null
				|| previousVah === null
				|| currentVal === null
				|| previousVal === null
				|| currentPoc === null
			) return null;

			const width = currentVah - currentVal;
			if (width <= 0) return null;

			const skew = (currentPoc - currentVal) / width;
			if (
				skew > accumulationSkew
				&& prepared.closes[i - 1] <= previousVah
				&& prepared.closes[i] > currentVah
			) {
				return createBuySignal(prepared.cleanData, i, "Accumulation-skew VAH breakout");
			}
			if (
				skew < distributionSkew
				&& prepared.closes[i - 1] >= previousVal
				&& prepared.closes[i] < currentVal
			) {
				return createSellSignal(prepared.cleanData, i, "Distribution-skew VAL breakdown");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		distribution_skew_breakout_router.executePrepared!(
			distribution_skew_breakout_router.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "skew_offset"],
	},
};
