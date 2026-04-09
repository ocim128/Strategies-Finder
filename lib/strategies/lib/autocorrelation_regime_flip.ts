import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizeAutocorrelationRegimeFlipParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autocorrWindow: Math.max(3, Math.round(params.autocorrWindow ?? 30)),
		momentumWindow: Math.max(1, Math.round(params.momentumWindow ?? 5)) };
}

export const autocorrelation_regime_flip: Strategy = {
	name: "Autocorrelation Regime Flip",
	description: "When return autocorrelation flips from negative to positive, the microstructure shifts to a trending regime. Enter in the direction of momentum after the regime flip.",
	defaultParams: {
		autocorrWindow: 30,
		momentumWindow: 5 },
	paramLabels: {
		autocorrWindow: "Autocorrelation Window",
		momentumWindow: "Momentum Window" },
	normalizeParams: normalizeAutocorrelationRegimeFlipParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAutocorrelationRegimeFlipParams(params);
		if (cleanData.length < p.autocorrWindow + p.momentumWindow) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const returnValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			returnValues[i] = returns[i] ?? 0;
		}
		const autocorr = buildRollingAutoCorrelation(returnValues, p.autocorrWindow);
		const momentum = buildRateOfChange(closes, p.momentumWindow);

		return createSignalLoop(cleanData, [autocorr, momentum], (i) => {
			if (i < 1 || i < p.autocorrWindow) return null;
			const acCurr = autocorr[i];
			const acPrev = autocorr[i - 1];
			const mom = momentum[i];
			if (acCurr === null || acPrev === null || mom === null) return null;

			if (acPrev < 0 && acCurr >= 0 && mom > 0) {
				return createBuySignal(cleanData, i, `Return autocorr flipped positive: ${acPrev.toFixed(3)} -> ${acCurr.toFixed(3)}, bullish momentum`);
			}
			if (acPrev < 0 && acCurr >= 0 && mom < 0) {
				return createSellSignal(cleanData, i, `Return autocorr flipped positive: ${acPrev.toFixed(3)} -> ${acCurr.toFixed(3)}, bearish momentum`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autocorrWindow", "momentumWindow"] } };
