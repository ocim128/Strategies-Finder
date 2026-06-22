import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation, buildRollingMedian } from "./price-action-statistics-core";

type AutocorrMomentumPrepared = {
	data: OHLCVData[];
	closes: number[];
	returnsClean: number[];
	range: number[];
	closeLocation: number[];
	autocorrByLookback: Map<number, (number | null)[]>;
	medianByLookback: Map<number, (number | null)[]>;
};

function normalizeAutocorrMomParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
		threshold: Math.max(-0.99, Number(params.threshold ?? 0.15)),
	};
}

function prepareAutocorrMomData(data: OHLCVData[]): AutocorrMomentumPrepared {
	const clean = ensureCleanData(data);
	const closes = getCloses(clean);
	const returns = buildRateOfChange(closes, 1);
	const returnsClean = returns.map(r => r ?? 0);
	const range = buildRangeSeries(clean);
	const closeLocation = buildCloseLocationSeries(clean);
	return {
		data: clean,
		closes,
		returnsClean,
		range,
		closeLocation,
		autocorrByLookback: new Map(),
		medianByLookback: new Map(),
	};
}

function getPreparedAutocorrMomData(preparedData: unknown, data: OHLCVData[]): AutocorrMomentumPrepared {
	if (preparedData && typeof preparedData === "object" && "autocorrByLookback" in preparedData) {
		return preparedData as AutocorrMomentumPrepared;
	}
	return prepareAutocorrMomData(data);
}

export const autocorrelation_momentum_breakout: Strategy = {
	name: "Autocorrelation Momentum Breakout",
	description: "Chases a breakout when rolling autocorrelation of returns is positive (trending regime) and range expands.",
	defaultParams: {
		lookback: 20,
		threshold: 0.15,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Autocorrelation Threshold",
	},
	normalizeParams: normalizeAutocorrMomParams,
	prepareFinderData: (data) => prepareAutocorrMomData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedAutocorrMomData(preparedData, data);
		const p = normalizeAutocorrMomParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let autocorr = prepared.autocorrByLookback.get(lookback);
		if (!autocorr) {
			autocorr = buildRollingAutoCorrelation(prepared.returnsClean, lookback, 1);
			prepared.autocorrByLookback.set(lookback, autocorr);
		}

		let rangeMedian = prepared.medianByLookback.get(lookback);
		if (!rangeMedian) {
			rangeMedian = buildRollingMedian(prepared.range, lookback);
			prepared.medianByLookback.set(lookback, rangeMedian);
		}

		return createSignalLoop(prepared.data, [autocorr, rangeMedian], (i) => {
			if (i < lookback) return null;
			const a = autocorr[i];
			const median = rangeMedian[i];
			if (a === null || median === null) return null;

			const r = prepared.range[i];
			const closeLoc = prepared.closeLocation[i];

			if (a > threshold && r > median) {
				if (closeLoc > 0.75) {
					return createBuySignal(prepared.data, i, `Autocorrelation momentum buy: return autocorr (${a.toFixed(2)}) > ${threshold.toFixed(2)} with range (${r.toFixed(4)}) > median (${median.toFixed(4)}) and close location (${closeLoc.toFixed(2)}) > 0.75`);
				}
				if (closeLoc < 0.25) {
					return createSellSignal(prepared.data, i, `Autocorrelation momentum sell: return autocorr (${a.toFixed(2)}) > ${threshold.toFixed(2)} with range (${r.toFixed(4)}) > median (${median.toFixed(4)}) and close location (${closeLoc.toFixed(2)}) < 0.25`);
				}
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		autocorrelation_momentum_breakout.executePrepared?.(prepareAutocorrMomData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
