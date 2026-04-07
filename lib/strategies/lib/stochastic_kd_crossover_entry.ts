import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, checkCrossover } from "../strategy-helpers";
import { calculateStochastic } from "../indicators";

function normalizeStochasticKdCrossoverEntryParams(params: StrategyParams): StrategyParams {
	const stochPeriod = Math.max(2, Math.round(params.stochPeriod ?? 14));
	const smoothK = Math.min(10, Math.max(1, Math.round(params.smoothK ?? 3)));
	return { ...params, stochPeriod, smoothK };
}

export const stochastic_kd_crossover_entry: Strategy = {
	name: "Stochastic K/D Crossover Entry",
	description:
		"The Stochastic oscillator's %K line crossing %D is the most direct momentum crossover signal. Unlike EMA/SMA crosses which use arbitrary lookback pairings, Stochastic is bounded 0-100 with the crossover occurring between a raw and smoothed measure of the same quantity, making it self-normalizing across instruments and regimes.",
	defaultParams: { stochPeriod: 14, smoothK: 3 },
	paramLabels: { stochPeriod: "Stochastic Period", smoothK: "Smooth K" },
	normalizeParams: normalizeStochasticKdCrossoverEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeStochasticKdCrossoverEntryParams(params);
		if (cleanData.length < np.stochPeriod + np.smoothK + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const stoch = calculateStochastic(highs, lows, closes, np.stochPeriod, np.smoothK);
		return createSignalLoop(cleanData, [stoch.k, stoch.d], (i) => {
			const cross = checkCrossover(stoch.k, stoch.d, i);
			if (cross === "bullish")
				return createBuySignal(cleanData, i, `Stochastic bullish K/D crossover`);
			if (cross === "bearish")
				return createSellSignal(cleanData, i, `Stochastic bearish K/D crossover`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["stochPeriod", "smoothK"] } };
