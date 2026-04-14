import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildDualTimeframeRatio, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeVolatilityRatioOverextensionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fast_window: Math.max(2, Math.round(params.fast_window ?? 5)),
		slow_window: Math.max(5, Math.round(params.slow_window ?? 30)),
		ratio_threshold: Math.max(1.0, Number(params.ratio_threshold ?? 2.0)),
	};
}

export const volatility_ratio_overextension: Strategy = {
	name: "Volatility Ratio Overextension",
	description: "When short-term volatility spikes far above the baseline ratio and the bar was directional, the volatility overextension created a temporary mispricing. Fade the overextension.",
	defaultParams: {
		fast_window: 5,
		slow_window: 30,
		ratio_threshold: 2.0,
	},
	paramLabels: {
		fast_window: "Fast Window",
		slow_window: "Slow Window",
		ratio_threshold: "Ratio Threshold",
	},
	normalizeParams: normalizeVolatilityRatioOverextensionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolatilityRatioOverextensionParams(params);
		const slowWindow = p.slow_window as number;
		if (cleanData.length < slowWindow + 2) return [];

		const trSeries = extractBarMetricSeries(cleanData, 'trueRange');
		const volRatio = buildDualTimeframeRatio(trSeries, p.fast_window as number, slowWindow, buildRollingStdDev);

		return createSignalLoop(cleanData, [volRatio], (i) => {
			if (i < slowWindow) return null;
			const ratio = volRatio[i];
			if (ratio === null) return null;
			if (ratio < p.ratio_threshold) return null;

			const bar = cleanData[i];
			if (bar.close < bar.open) {
				return createBuySignal(cleanData, i, `Vol ratio ${ratio.toFixed(2)}x, bearish overextension`);
			}
			if (bar.close > bar.open) {
				return createSellSignal(cleanData, i, `Vol ratio ${ratio.toFixed(2)}x, bullish overextension`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_window", "slow_window", "ratio_threshold"],
	},
};
