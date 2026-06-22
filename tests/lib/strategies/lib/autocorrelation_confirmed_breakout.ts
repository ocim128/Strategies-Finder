import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingAutoCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		acThreshold: Number(params.acThreshold ?? 0.20),
	};
}

export const autocorrelation_confirmed_breakout: Strategy = {
	name: "Autocorrelation Confirmed Breakout",
	description: "Triggers a breakout entry when the ratio breaks its rolling median channel, gated by positive return autocorrelation to filter out mean-reverting chop.",
	defaultParams: {
		lookback: 30,
		acThreshold: 0.20,
	},
	paramLabels: {
		lookback: "Lookback Window",
		acThreshold: "Autocorrelation Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const acThreshold = p.acThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, lookback);

		const returns = buildRateOfChange(closes, 1).map(v => v !== null ? v : 0);
		const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);

		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [median, autoCorr], (i) => {
			if (i < lookback + 2) return null;
			const ac = autoCorr[i];
			const m = median[i];
			const cl = closeLocation[i];
			if (ac === null || m === null || cl === null) return null;

			if (ac <= acThreshold) return null;

			const close = closes[i];
			if (close > m && cl > 0.70) {
				return createBuySignal(cleanData, i, `Close breakout above median with autocorrelation (${ac.toFixed(2)}) > ${acThreshold}, close location ${cl.toFixed(2)} > 0.70`);
			}
			if (close < m && cl < 0.30) {
				return createSellSignal(cleanData, i, `Close breakdown below median with autocorrelation (${ac.toFixed(2)}) > ${acThreshold}, close location ${cl.toFixed(2)} < 0.30`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "acThreshold"],
	},
};
