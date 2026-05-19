import { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	buildPricePositionInVA,
	getPreparedValueAreaData,
	getValueAreaSeries,
} from "./value-area-acceptance-core";

function normalizeMultiHorizonValueDisagreementParams(params: StrategyParams): StrategyParams {
	const shortLookback = Math.max(3, Math.round(params.short_lookback ?? 10));
	return {
		...params,
		short_lookback: shortLookback,
		long_lookback: Math.max(shortLookback + 1, Math.round(params.long_lookback ?? 55)),
	};
}

export const multi_horizon_value_disagreement: Strategy = {
	name: "Multi Horizon Value Disagreement",
	description: "Uses short-term value breaking away from long-term value as a two-of-three structural breakout quorum.",
	defaultParams: {
		short_lookback: 10,
		long_lookback: 55,
	},
	paramLabels: {
		short_lookback: "Short VA Lookback",
		long_lookback: "Long VA Lookback",
	},
	normalizeParams: normalizeMultiHorizonValueDisagreementParams,
	prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
	executePrepared: (
		preparedData: unknown,
		params: StrategyParams,
		data: OHLCVData[],
		_context?: StrategyExecutionContext
	) => {
		const p = normalizeMultiHorizonValueDisagreementParams(params);
		const prepared = getPreparedValueAreaData(preparedData, data);
		const shortLookback = p.short_lookback as number;
		const longLookback = p.long_lookback as number;

		const shortVa = getValueAreaSeries(prepared, shortLookback, 0.68, 12);
		const longVa = getValueAreaSeries(prepared, longLookback, 0.68, 12);
		const shortPosition = buildPricePositionInVA(prepared.closes, shortVa.vah, shortVa.val, shortVa.poc);

		return createSignalLoop(prepared.cleanData, [shortVa.poc, longVa.poc, shortPosition, longVa.vah, longVa.val], (i) => {
			if (i < longLookback) return null;

			const shortPoc = shortVa.poc[i];
			const longPoc = longVa.poc[i];
			const position = shortPosition[i];
			const longVah = longVa.vah[i];
			const longVal = longVa.val[i];
			if (shortPoc === null || longPoc === null || position === null || longVah === null || longVal === null) return null;

			const buyVotes = (shortPoc > longPoc ? 1 : 0)
				+ (position > 0 ? 1 : 0)
				+ (prepared.closes[i] > longVah ? 1 : 0);
			const sellVotes = (shortPoc < longPoc ? 1 : 0)
				+ (position < 0 ? 1 : 0)
				+ (prepared.closes[i] < longVal ? 1 : 0);

			if (buyVotes >= 2 && sellVotes >= 2) return null;
			if (buyVotes >= 2) {
				return createBuySignal(prepared.cleanData, i, "Short-term value breaking above long-term value");
			}
			if (sellVotes >= 2) {
				return createSellSignal(prepared.cleanData, i, "Short-term value breaking below long-term value");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
		multi_horizon_value_disagreement.executePrepared!(
			multi_horizon_value_disagreement.prepareFinderData!(data),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["short_lookback", "long_lookback"],
	},
};
