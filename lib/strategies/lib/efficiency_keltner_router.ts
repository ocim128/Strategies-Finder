import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getHighs,
	getLows,
} from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

const KELTNER_MULTIPLIER = 2;

function normalizeEfficiencyKeltnerRouterParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		er_lookback: Math.max(2, Math.round(params.er_lookback ?? 20)),
		keltner_lookback: Math.max(2, Math.round(params.keltner_lookback ?? 55)),
		er_threshold: Math.max(0, Math.min(1, Number(params.er_threshold ?? 0.4))),
	};
}

export const efficiency_keltner_router: Strategy = {
	name: "Efficiency Keltner Router",
	description: "Routes Keltner boundary signals to fades in chop and continuation entries in efficient trends.",
	defaultParams: {
		er_lookback: 20,
		keltner_lookback: 55,
		er_threshold: 0.4,
	},
	paramLabels: {
		er_lookback: "Efficiency Lookback",
		keltner_lookback: "Keltner Lookback",
		er_threshold: "Efficiency Threshold",
	},
	normalizeParams: normalizeEfficiencyKeltnerRouterParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyKeltnerRouterParams(params);
		const erLookback = p.er_lookback as number;
		const keltnerLookback = p.keltner_lookback as number;
		if (cleanData.length < Math.max(erLookback, keltnerLookback) + 2) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const efficiency = buildEfficiencyRatio(cleanData, erLookback);
		const channels = calculateKeltnerChannels(highs, lows, closes, keltnerLookback, keltnerLookback, KELTNER_MULTIPLIER);

		return createSignalLoop(cleanData, [efficiency, channels.upper, channels.lower], (i) => {
			if (i < Math.max(erLookback, keltnerLookback)) return null;

			const er = efficiency[i];
			const upper = channels.upper[i];
			const lower = channels.lower[i];
			const previousUpper = channels.upper[i - 1];
			const previousLower = channels.lower[i - 1];
			if (er === null || upper === null || lower === null || previousUpper === null || previousLower === null) return null;

			if (er < (p.er_threshold as number)) {
				if (closes[i] < lower) {
					return createBuySignal(cleanData, i, "Low-efficiency Keltner lower-band fade");
				}
				if (closes[i] > upper) {
					return createSellSignal(cleanData, i, "Low-efficiency Keltner upper-band fade");
				}
				return null;
			}

			if (closes[i - 1] <= previousUpper && closes[i] > upper) {
				return createBuySignal(cleanData, i, "Efficient Keltner upside continuation");
			}
			if (closes[i - 1] >= previousLower && closes[i] < lower) {
				return createSellSignal(cleanData, i, "Efficient Keltner downside continuation");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["er_lookback", "keltner_lookback", "er_threshold"],
	},
};
