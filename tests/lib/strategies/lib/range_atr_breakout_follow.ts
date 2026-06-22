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
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";

type RangeAtrBreakoutPrepared = {
	data: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	ranges: number[];
	acceptance: number[];
	atrByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeAtrParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 14))),
	};
}

function prepareRangeAtrData(data: OHLCVData[]): RangeAtrBreakoutPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		highs: getHighs(clean),
		lows: getLows(clean),
		closes: getCloses(clean),
		ranges: buildRangeSeries(clean),
		acceptance: buildCloseAcceptanceSeries(clean),
		atrByLookback: new Map(),
	};
}

function getPreparedRangeAtrData(preparedData: unknown, data: OHLCVData[]): RangeAtrBreakoutPrepared {
	if (preparedData && typeof preparedData === "object" && "atrByLookback" in preparedData) {
		return preparedData as RangeAtrBreakoutPrepared;
	}
	return prepareRangeAtrData(data);
}

export const range_atr_breakout_follow: Strategy = {
	name: "Range ATR Breakout Follow",
	description: "Chases trends when the current range exceeds 1.5x ATR and close acceptance confirms the direction.",
	defaultParams: {
		lookback: 14,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRangeAtrParams,
	prepareFinderData: (data) => prepareRangeAtrData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeAtrData(preparedData, data);
		const p = normalizeRangeAtrParams(params);
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

			const currentRange = prepared.ranges[i];
			const acc = prepared.acceptance[i];

			if (currentRange > 1.5 * currentAtr && acc > 0.5) {
				return createBuySignal(prepared.data, i, `Range breakout: range (${currentRange.toFixed(4)}) > 1.5 * ATR (${(1.5 * currentAtr).toFixed(4)}) with positive acceptance (${acc.toFixed(2)} > 0.5)`);
			}
			if (currentRange > 1.5 * currentAtr && acc < -0.5) {
				return createSellSignal(prepared.data, i, `Range breakout: range (${currentRange.toFixed(4)}) > 1.5 * ATR (${(1.5 * currentAtr).toFixed(4)}) with negative acceptance (${acc.toFixed(2)} < -0.5)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_atr_breakout_follow.executePrepared?.(prepareRangeAtrData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
