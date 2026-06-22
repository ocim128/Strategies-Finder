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
import { computePriceActionBarMetrics, buildRangeSeries } from "./price-action-frequency-core";

type WickRejectionFadePrepared = {
	data: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	ranges: number[];
	lowerWickRatios: number[];
	upperWickRatios: number[];
	atrByLookback: Map<number, (number | null)[]>;
};

function normalizeWickRejectionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareWickRejectionFadeData(data: OHLCVData[]): WickRejectionFadePrepared {
	const clean = ensureCleanData(data);
	const lowerWickRatios = new Array(clean.length);
	const upperWickRatios = new Array(clean.length);
	for (let i = 0; i < clean.length; i++) {
		const metrics = computePriceActionBarMetrics(clean[i]);
		lowerWickRatios[i] = metrics.range > 0 ? metrics.lowerWick / metrics.range : 0;
		upperWickRatios[i] = metrics.range > 0 ? metrics.upperWick / metrics.range : 0;
	}
	return {
		data: clean,
		highs: getHighs(clean),
		lows: getLows(clean),
		closes: getCloses(clean),
		ranges: buildRangeSeries(clean),
		lowerWickRatios,
		upperWickRatios,
		atrByLookback: new Map(),
	};
}

function getPreparedWickRejectionFadeData(
	preparedData: unknown,
	data: OHLCVData[]
): WickRejectionFadePrepared {
	if (preparedData && typeof preparedData === "object" && "atrByLookback" in preparedData) {
		return preparedData as WickRejectionFadePrepared;
	}
	return prepareWickRejectionFadeData(data);
}

export const range_expansion_wick_rejection_fade: Strategy = {
	name: "Range Expansion Wick Rejection Fade",
	description: "Fades range expansions (range > 1.5x ATR) that print a large upper or lower wick rejection.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeWickRejectionFadeParams,
	prepareFinderData: (data) => prepareWickRejectionFadeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedWickRejectionFadeData(preparedData, data);
		const p = normalizeWickRejectionFadeParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let atr = prepared.atrByLookback.get(lookback);
		if (!atr) {
			atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, lookback);
			prepared.atrByLookback.set(lookback, atr);
		}

		return createSignalLoop(prepared.data, [atr], (i) => {
			if (i < lookback) return null;
			const currentAtr = atr[i];
			if (currentAtr === null) return null;

			const range = prepared.ranges[i];
			const lowerWick = prepared.lowerWickRatios[i];
			const upperWick = prepared.upperWickRatios[i];

			if (range > 1.5 * currentAtr && lowerWick > 0.50) {
				return createBuySignal(prepared.data, i, `Range expansion fade: range (${range.toFixed(4)} > 1.5 * ATR (${(1.5 * currentAtr).toFixed(4)})) with lower wick rejection (${lowerWick.toFixed(2)} > 0.50)`);
			}
			if (range > 1.5 * currentAtr && upperWick > 0.50) {
				return createSellSignal(prepared.data, i, `Range expansion fade: range (${range.toFixed(4)} > 1.5 * ATR (${(1.5 * currentAtr).toFixed(4)})) with upper wick rejection (${upperWick.toFixed(2)} > 0.50)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_expansion_wick_rejection_fade.executePrepared?.(prepareWickRejectionFadeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
