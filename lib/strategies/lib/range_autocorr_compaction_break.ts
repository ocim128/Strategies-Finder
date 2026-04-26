import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import {
	buildRollingAutoCorrelation,
	buildRateOfChange,
} from "./price-action-statistics-core";
import { buildRangeSeries } from "./price-action-frequency-core";

function normalizeRangeAutocorrCompactionBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autocorr_window: Math.max(5, Math.round(params.autocorr_window ?? 20)),
		break_threshold: Number(params.break_threshold ?? -0.2),
	};
}

export const range_autocorr_compaction_break: Strategy = {
	name: "Range Autocorrelation Compaction Break",
	description: "When range autocorrelation drops sharply (volatility clustering breaking down), the market is transitioning from a compressed regime to a directional breakout. The current bar's body direction gives the entry side.",
	defaultParams: {
		autocorr_window: 20,
		break_threshold: -0.2,
	},
	paramLabels: {
		autocorr_window: "Autocorrelation Window",
		break_threshold: "Break Threshold",
	},
	normalizeParams: normalizeRangeAutocorrCompactionBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRangeAutocorrCompactionBreakParams(params);
		if (cleanData.length < p.autocorr_window + 2) return [];

		const ranges = buildRangeSeries(cleanData);
		const autocorr = buildRollingAutoCorrelation(ranges, p.autocorr_window);
		const autocorrValues: number[] = autocorr.map((v) => (v === null ? 0 : v));
		const autocorrRoc = buildRateOfChange(autocorrValues, 1);

		return createSignalLoop(cleanData, [autocorrRoc], (i) => {
			if (i < p.autocorr_window + 1) return null;
			const ar = autocorrRoc[i];
			if (ar === null) return null;
			if (ar >= p.break_threshold) return null;

			const bar = cleanData[i];
			if (bar.close > bar.open) {
				return createBuySignal(cleanData, i, `Range autocorrelation breaking (${ar.toFixed(3)}) with bullish bar`);
			}
			if (bar.close < bar.open) {
				return createSellSignal(cleanData, i, `Range autocorrelation breaking (${ar.toFixed(3)}) with bearish bar`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autocorr_window", "break_threshold"],
	},
};
