import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildStreakCount } from "./price-action-statistics-core";

type AutocorrelationGatedPrepared = {
	data: OHLCVData[];
	streak: number[];
};

function normalizeAutocorrParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 5))),
	};
}

function prepareAutocorrData(data: OHLCVData[]): AutocorrelationGatedPrepared {
	const clean = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(clean);
	const autocorr = buildRollingAutoCorrelation(acceptance, 10, 1);
	const flags = autocorr.map(a => (a !== null && a < -0.1) ? 1 : 0);
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		streak,
	};
}

function getPreparedAutocorrData(preparedData: unknown, data: OHLCVData[]): AutocorrelationGatedPrepared {
	if (preparedData && typeof preparedData === "object" && "streak" in preparedData) {
		return preparedData as AutocorrelationGatedPrepared;
	}
	return prepareAutocorrData(data);
}

export const autocorrelation_gated_reversion_fade: Strategy = {
	name: "Autocorrelation-Gated Reversion Fade",
	description: "Fades the ratio when negative autocorrelation of close acceptance has persisted for a streak of bars, and close return agrees.",
	defaultParams: {
		lookback: 5,
	},
	paramLabels: {
		lookback: "Autocorrelation Streak Threshold",
	},
	normalizeParams: normalizeAutocorrParams,
	prepareFinderData: (data) => prepareAutocorrData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedAutocorrData(preparedData, data);
		const p = normalizeAutocorrParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		return createSignalLoop(prepared.data, [], (i) => {
			if (i < 1) return null;
			const s = prepared.streak[i];
			if (s < lookback) return null;

			const closeCurr = prepared.data[i].close;
			const closePrev = prepared.data[i - 1].close;

			if (closeCurr < closePrev) {
				return createBuySignal(prepared.data, i, `Autocorrelation gated reversion buy: negative autocorr streak (${s} >= ${lookback}) with negative return`);
			}
			if (closeCurr > closePrev) {
				return createSellSignal(prepared.data, i, `Autocorrelation gated reversion sell: negative autocorr streak (${s} >= ${lookback}) with positive return`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		autocorrelation_gated_reversion_fade.executePrepared?.(prepareAutocorrData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
