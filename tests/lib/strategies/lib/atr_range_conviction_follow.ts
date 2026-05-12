import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
	getAtrSeries,
	getPreparedRangeConvictionData,
	normalizeIntegerParam,
	normalizeNumberParam,
	prepareRangeConvictionData,
} from "./range-conviction-core";

function normalizeAtrRangeConvictionFollowParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		atr_period: normalizeIntegerParam(params.atr_period, 14, 2),
		range_atr_min: normalizeNumberParam(params.range_atr_min, 1.6, 0.05, 10),
		acceptance_min: normalizeNumberParam(params.acceptance_min, 0.55, 0.01, 0.99),
	};
}

function executeAtrRangeConvictionFollow(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
	const prepared = getPreparedRangeConvictionData(preparedData, data);
	const p = normalizeAtrRangeConvictionFollowParams(params);
	const atrPeriod = p.atr_period as number;
	const rangeAtrMin = p.range_atr_min as number;
	const acceptanceMin = p.acceptance_min as number;
	if (prepared.cleanData.length < atrPeriod + 2) return [];

	const atr = getAtrSeries(prepared, atrPeriod);

	return createSignalLoop(prepared.cleanData, [], (i) => {
		if (i < atrPeriod) return null;
		const atrNow = atr[i];
		if (atrNow === null || atrNow <= 0) return null;
		if (prepared.trueRange[i] < rangeAtrMin * atrNow) return null;

		const acceptance = prepared.acceptance[i];
		if (acceptance >= acceptanceMin) {
			return createBuySignal(prepared.cleanData, i, `ATR range conviction follow: TR ${(prepared.trueRange[i] / atrNow).toFixed(2)}x ATR, acceptance ${acceptance.toFixed(2)}`);
		}
		if (acceptance <= -acceptanceMin) {
			return createSellSignal(prepared.cleanData, i, `ATR range conviction follow: TR ${(prepared.trueRange[i] / atrNow).toFixed(2)}x ATR, acceptance ${acceptance.toFixed(2)}`);
		}
		return null;
	});
}

export const atr_range_conviction_follow: Strategy = {
	name: "ATR Range Conviction Follow",
	description: "Trades completed volatility expansion bars only when true range is large versus ATR and the candle settles with strong directional acceptance.",
	defaultParams: {
		atr_period: 14,
		range_atr_min: 1.6,
		acceptance_min: 0.55,
	},
	paramLabels: {
		atr_period: "ATR Period",
		range_atr_min: "Min Range / ATR",
		acceptance_min: "Min Close Acceptance",
	},
	normalizeParams: normalizeAtrRangeConvictionFollowParams,
	prepareFinderData: (data) => prepareRangeConvictionData(data),
	executePrepared: executeAtrRangeConvictionFollow,
	execute: (data: OHLCVData[], params: StrategyParams) =>
		executeAtrRangeConvictionFollow(prepareRangeConvictionData(data), params, data),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atr_period", "range_atr_min", "acceptance_min"],
	},
};
