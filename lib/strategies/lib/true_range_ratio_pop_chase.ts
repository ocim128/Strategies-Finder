import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";

export const true_range_ratio_pop_chase: Strategy = {
	name: "True Range Ratio Pop Chase",
	description: "When the current bar's true range is more than a multiple of the prior bar's true range, enter in the close direction.",
	defaultParams: {
		trMult: 1.2,
		minCloseReturn: 0.001 },
	paramLabels: {
		trMult: "True Range Multiplier",
		minCloseReturn: "Min Close Return" },
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const trMult = Number(params.trMult ?? 1.2);
		const minCloseReturn = Number(params.minCloseReturn ?? 0.001);

		if (cleanData.length < 2) return [];

		const trueRange = extractBarMetricSeries(cleanData, 'trueRange');
		const closeReturn = extractBarMetricSeries(cleanData, 'closeReturn');

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || trueRange[i] === null || trueRange[i-1] === null || closeReturn[i] === null) return null;

			if (trueRange[i]! > trueRange[i-1]! * trMult) {
				if (closeReturn[i]! > minCloseReturn) {
					return createBuySignal(cleanData, i, "Chase bullish true range pop");
				} else if (closeReturn[i]! < -minCloseReturn) {
					return createSellSignal(cleanData, i, "Chase bearish true range pop");
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trMult", "minCloseReturn"] } };





