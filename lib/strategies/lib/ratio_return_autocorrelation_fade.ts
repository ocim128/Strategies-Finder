import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

type AutocorrelationFadePrepared = {
	data: OHLCVData[];
	closes: number[];
	returns: (number | null)[];
	autocorrByLookback: Map<number, (number | null)[]>;
};

function normalizeAutocorrelationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(-1.0, Math.min(1.0, Number(params.threshold ?? -0.15))),
	};
}

function prepareAutocorrelationData(data: OHLCVData[]): AutocorrelationFadePrepared {
	const clean = ensureCleanData(data);
	const closes = getCloses(clean);
	return {
		data: clean,
		closes,
		returns: buildRateOfChange(closes, 1),
		autocorrByLookback: new Map(),
	};
}

function getPreparedAutocorrelationData(preparedData: unknown, data: OHLCVData[]): AutocorrelationFadePrepared {
	if (preparedData && typeof preparedData === "object" && "autocorrByLookback" in preparedData) {
		return preparedData as AutocorrelationFadePrepared;
	}
	return prepareAutocorrelationData(data);
}

export const ratio_return_autocorrelation_fade: Strategy = {
	name: "Ratio Return Autocorrelation Fade",
	description: "Fades return direction when the rolling 1-bar autocorrelation of returns is negative.",
	defaultParams: {
		lookback: 30,
		threshold: -0.15,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeAutocorrelationParams,
	prepareFinderData: (data) => prepareAutocorrelationData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedAutocorrelationData(preparedData, data);
		const p = normalizeAutocorrelationParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback + 1) return [];

		// Filter null returns before computing autocorrelation
		// Wait, buildRollingAutoCorrelation expects number[] or (number | null)[]?
		// Let's check buildRollingAutoCorrelation signature: export function buildRollingAutoCorrelation(values: number[], lookbackInput: number, lag = 1)
		// Wait, buildRollingAutoCorrelation takes number[]! But buildRateOfChange returns (number | null)[].
		// Let's coerce (number | null)[] returns to number[] by replacing null with 0.
		// Wait, let's verify if buildRateOfChange returns (number | null)[] or number[].
		// Let's check buildRateOfChange signature in price-action-statistics-core.ts.
		// Actually, buildRateOfChange returns (number | null)[] where the first bar (index 0) is null.
		// So we can convert it to a number[] by setting index 0 to 0.
		const cleanReturns = prepared.returns.map(v => v ?? 0);

		let autocorr = prepared.autocorrByLookback.get(lookback);
		if (!autocorr) {
			autocorr = buildRollingAutoCorrelation(cleanReturns, lookback, 1);
			prepared.autocorrByLookback.set(lookback, autocorr);
		}

		return createSignalLoop(prepared.data, [autocorr], (i) => {
			if (i < lookback) return null;
			const r = prepared.returns[i];
			const ac = autocorr[i];
			if (r === null || ac === null) return null;

			if (ac < threshold && r < 0) {
				return createBuySignal(prepared.data, i, `Negative autocorrelation (${ac.toFixed(2)} < ${threshold}) and negative return (${(r * 100).toFixed(2)}%)`);
			}
			if (ac < threshold && r > 0) {
				return createSellSignal(prepared.data, i, `Negative autocorrelation (${ac.toFixed(2)} < ${threshold}) and positive return (${(r * 100).toFixed(2)}%)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		ratio_return_autocorrelation_fade.executePrepared?.(prepareAutocorrelationData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
