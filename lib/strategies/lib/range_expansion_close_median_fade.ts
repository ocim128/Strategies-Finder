import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getHighs,
	getLows,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

type CloseMedianFadePrepared = {
	data: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	ranges: number[];
	atrByLookback: Map<number, (number | null)[]>;
	medianByLookback: Map<number, (number | null)[]>;
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeCloseMedianFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareCloseMedianFadeData(data: OHLCVData[]): CloseMedianFadePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		highs: getHighs(clean),
		lows: getLows(clean),
		closes: getCloses(clean),
		ranges: buildRangeSeries(clean),
		atrByLookback: new Map(),
		medianByLookback: new Map(),
		zScoreByLookback: new Map(),
	};
}

function getPreparedCloseMedianFadeData(
	preparedData: unknown,
	data: OHLCVData[]
): CloseMedianFadePrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as CloseMedianFadePrepared;
	}
	return prepareCloseMedianFadeData(data);
}

export const range_expansion_close_median_fade: Strategy = {
	name: "Range Expansion Close Median Fade",
	description: "Fades large range expansions (> 1.5x ATR) when close deviates significantly from its median.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeCloseMedianFadeParams,
	prepareFinderData: (data) => prepareCloseMedianFadeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedCloseMedianFadeData(preparedData, data);
		const p = normalizeCloseMedianFadeParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let atr = prepared.atrByLookback.get(lookback);
		if (!atr) {
			atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, lookback);
			prepared.atrByLookback.set(lookback, atr);
		}

		let median = prepared.medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(prepared.closes, lookback);
			prepared.medianByLookback.set(lookback, median);
		}

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			const distance = prepared.closes.map((c, idx) => {
				const m = median![idx];
				return m !== null ? c - m : 0;
			});
			zscore = buildRollingZScore(distance, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [atr, median, zscore], (i) => {
			if (i < lookback) return null;
			const currentAtr = atr[i];
			const z = zscore[i];
			if (currentAtr === null || z === null) return null;

			const range = prepared.ranges[i];

			if (range > 1.5 * currentAtr && z <= -1.8) {
				return createBuySignal(prepared.data, i, `Extreme range close fade: range (${range.toFixed(4)} > 1.5 * ATR (${(1.5 * currentAtr).toFixed(4)})) with close distance Z-Score (${z.toFixed(2)} <= -1.8)`);
			}
			if (range > 1.5 * currentAtr && z >= 1.8) {
				return createSellSignal(prepared.data, i, `Extreme range close fade: range (${range.toFixed(4)} > 1.5 * ATR (${(1.5 * currentAtr).toFixed(4)})) with close distance Z-Score (${z.toFixed(2)} >= 1.8)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_expansion_close_median_fade.executePrepared?.(prepareCloseMedianFadeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
