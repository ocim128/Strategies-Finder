import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getHighs,
	getLows,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	highs: number[];
	lows: number[];
	closeLocation: number[];
	minByLookback: Map<number, (number | null)[]>;
	maxByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		rejectionLimit: Math.max(0.01, Math.min(1, Number(params.rejectionLimit ?? 0.8))),
	};
}

export const failed_breakout_rejection_reversion: Strategy = {
	name: "Failed Breakout Rejection Reversion",
	description: "Fades failed breakouts outside the rolling min/max channel when the close location returns inside the channel.",
	defaultParams: {
		lookback: 30,
		rejectionLimit: 0.8,
	},
	paramLabels: {
		lookback: "Lookback Window",
		rejectionLimit: "Rejection Limit",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		highs: getHighs(data),
		lows: getLows(data),
		closeLocation: buildCloseLocationSeries(data),
		minByLookback: new Map<number, (number | null)[]>(),
		maxByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const rejectionLimit = p.rejectionLimit as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const highs = prepared?.highs ?? getHighs(cleanData);
		const lows = prepared?.lows ?? getLows(cleanData);
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const minByLookback = prepared?.minByLookback ?? new Map<number, (number | null)[]>();
		const maxByLookback = prepared?.maxByLookback ?? new Map<number, (number | null)[]>();

		let channelMin = minByLookback.get(lookback);
		let channelMax = maxByLookback.get(lookback);

		if (!channelMin || !channelMax) {
			const minMax = buildRollingMinMax(closes, lookback);
			channelMin = minMax.min;
			channelMax = minMax.max;
			minByLookback.set(lookback, channelMin);
			maxByLookback.set(lookback, channelMax);
		}

		return createSignalLoop(cleanData, [channelMin, channelMax], (i) => {
			if (i < lookback) return null;

			const prevMin = channelMin![i - 1];
			const prevMax = channelMax![i - 1];
			if (prevMin === null || prevMax === null) return null;

			const low = lows[i];
			const high = highs[i];
			const cl = closeLocation[i];

			// Buy: low of current bar below rolling min of previous closes, but close location above rejectionLimit
			if (low < prevMin && cl > rejectionLimit) {
				return createBuySignal(cleanData, i, `Failed downside breakout: low ${low.toFixed(2)} < prevMin ${prevMin.toFixed(2)}, closeLocation ${cl.toFixed(2)} > ${rejectionLimit}`);
			}
			// Sell: high of current bar above rolling max of previous closes, but close location below (1 - rejectionLimit)
			if (high > prevMax && cl < 1 - rejectionLimit) {
				return createSellSignal(cleanData, i, `Failed upside breakout: high ${high.toFixed(2)} > prevMax ${prevMax.toFixed(2)}, closeLocation ${cl.toFixed(2)} < ${(1 - rejectionLimit).toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		failed_breakout_rejection_reversion.executePrepared!(
			failed_breakout_rejection_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rejectionLimit"],
	},
};
