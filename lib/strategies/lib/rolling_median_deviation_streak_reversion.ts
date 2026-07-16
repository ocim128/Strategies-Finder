import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	closeLocation: number[];
	medianByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 6))),
	};
}

export const rolling_median_deviation_streak_reversion: Strategy = {
	name: "Rolling Median Deviation Streak Reversion",
	description: "Fades extended closes entirely on one side of the rolling median when close location reverts.",
	defaultParams: {
		lookback: 40,
		streakThreshold: 6,
	},
	paramLabels: {
		lookback: "Lookback Window",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		closeLocation: buildCloseLocationSeries(data),
		medianByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const streakThreshold = p.streakThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < Math.max(lookback, streakThreshold + 2)) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);
		const medianByLookback = prepared?.medianByLookback ?? new Map<number, (number | null)[]>();
		let median = medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(closes, lookback);
			medianByLookback.set(lookback, median);
		}

		// Compute streaks of being on one side of rolling median
		const flagsAbove = new Array(cleanData.length).fill(0);
		const flagsBelow = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const m = median[j];
			if (m !== null) {
				if (closes[j] > m) {
					flagsAbove[j] = 1;
				} else if (closes[j] < m) {
					flagsBelow[j] = -1;
				}
			}
		}
		const aboveStreaks = buildStreakCount(flagsAbove);
		const belowStreaks = buildStreakCount(flagsBelow);

		return createSignalLoop(cleanData, [median], (i) => {
			if (i < Math.max(lookback, streakThreshold + 1)) return null;

			// Buy: Closes have been below median for streakThreshold bars up to i-1, and current close location is > 0.7
			if (belowStreaks[i - 1] <= -streakThreshold && closeLocation[i] > 0.7) {
				return createBuySignal(cleanData, i, `Close was below median for ${Math.abs(belowStreaks[i - 1])} bars, closeLocation ${closeLocation[i].toFixed(2)} (buy)`);
			}
			// Sell: Closes have been above median for streakThreshold bars up to i-1, and current close location is < 0.3
			if (aboveStreaks[i - 1] >= streakThreshold && closeLocation[i] < 0.3) {
				return createSellSignal(cleanData, i, `Close was above median for ${aboveStreaks[i - 1]} bars, closeLocation ${closeLocation[i].toFixed(2)} (sell)`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		rolling_median_deviation_streak_reversion.executePrepared!(
			rolling_median_deviation_streak_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "streakThreshold"],
	},
};
