import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { calculateVWAP } from "../indicators";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getHighs,
	getLows,
	getTypicalPrices,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingStdDev } from "./price-action-statistics-core";

type VwapDeviationPrepared = {
	data: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	volumes: number[];
	typicalPrices: number[];
	vwapByLookback: Map<number, (number | null)[]>;
	stdDevByLookback: Map<number, (number | null)[]>;
};

function normalizeVwapDeviationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareVwapDeviationData(data: OHLCVData[]): VwapDeviationPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		highs: getHighs(clean),
		lows: getLows(clean),
		closes: getCloses(clean),
		volumes: getVolumes(clean),
		typicalPrices: getTypicalPrices(clean),
		vwapByLookback: new Map(),
		stdDevByLookback: new Map(),
	};
}

function getPreparedVwapDeviationData(preparedData: unknown, data: OHLCVData[]): VwapDeviationPrepared {
	if (preparedData && typeof preparedData === "object" && "vwapByLookback" in preparedData) {
		return preparedData as VwapDeviationPrepared;
	}
	return prepareVwapDeviationData(data);
}

export const typical_price_vwap_deviation_fade: Strategy = {
	name: "Typical Price VWAP Deviation Fade",
	description: "Fades typical price deviations from the rolling VWAP, normalized by typical price standard deviation.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeVwapDeviationParams,
	prepareFinderData: (data) => prepareVwapDeviationData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVwapDeviationData(preparedData, data);
		const p = normalizeVwapDeviationParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let vwap = prepared.vwapByLookback.get(lookback);
		if (!vwap) {
			vwap = calculateVWAP(prepared.highs, prepared.lows, prepared.closes, prepared.volumes, lookback);
			prepared.vwapByLookback.set(lookback, vwap);
		}

		let stddev = prepared.stdDevByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(prepared.typicalPrices, lookback);
			prepared.stdDevByLookback.set(lookback, stddev);
		}

		return createSignalLoop(prepared.data, [vwap, stddev], (i) => {
			if (i < lookback) return null;
			const currentVwap = vwap[i];
			const currentStd = stddev[i];
			if (currentVwap === null || currentStd === null || currentStd <= 1e-9) return null;

			const tp = prepared.typicalPrices[i];
			const deviation = tp - currentVwap;
			const z = deviation / currentStd;

			if (z <= -2.0) {
				return createBuySignal(prepared.data, i, `Typical price crossed below VWAP: Z-Score (${z.toFixed(2)}) <= -2.0`);
			}
			if (z >= 2.0) {
				return createSellSignal(prepared.data, i, `Typical price crossed above VWAP: Z-Score (${z.toFixed(2)}) >= 2.0`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_vwap_deviation_fade.executePrepared?.(prepareVwapDeviationData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
