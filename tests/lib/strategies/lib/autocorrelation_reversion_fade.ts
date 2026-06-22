import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		autoCorrThreshold: Number(params.autoCorrThreshold ?? -0.30),
	};
}

export const autocorrelation_reversion_fade: Strategy = {
	name: "Autocorrelation Reversion Fade",
	description: "Fades the current bar's return when the rolling 1-bar autocorrelation of returns is highly negative.",
	defaultParams: {
		lookback: 30,
		autoCorrThreshold: -0.30,
	},
	paramLabels: {
		lookback: "Autocorrelation Window",
		autoCorrThreshold: "Autocorrelation Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const autoCorrThreshold = p.autoCorrThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1).map(v => v !== null ? v : 0);
		const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);

		return createSignalLoop(cleanData, [autoCorr], (i) => {
			if (i < lookback + 2) return null;
			const ac = autoCorr[i];
			if (ac === null) return null;

			if (ac >= autoCorrThreshold) return null;

			const ret = returns[i];
			if (ret < 0) {
				return createBuySignal(cleanData, i, `Negative autocorrelation (${ac.toFixed(2)}) < ${autoCorrThreshold} and return is negative (${(ret * 100).toFixed(2)}%)`);
			}
			if (ret > 0) {
				return createSellSignal(cleanData, i, `Negative autocorrelation (${ac.toFixed(2)}) < ${autoCorrThreshold} and return is positive (${(ret * 100).toFixed(2)}%)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "autoCorrThreshold"],
	},
};
