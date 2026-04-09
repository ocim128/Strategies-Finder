import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodySentimentShiftEntryParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 10)) };
}

export const body_sentiment_shift_entry: Strategy = {
	name: "Body Sentiment Shift Entry",
	description: "The rolling sum of bar body directions measures net directional sentiment over a window. When this sum crosses zero, the aggregate bar-by-bar verdict has changed direction. Enter with the new sentiment.",
	defaultParams: {
		lookback: 10 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeBodySentimentShiftEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodySentimentShiftEntryParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 2) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const sentimentSum: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const start = Math.max(0, i - lookback + 1);
			let sum = 0;
			for (let j = start; j <= i; j++) {
				sum += bodyDir[j];
			}
			sentimentSum[i] = sum;
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (i < lookback + 1) return null;

			if (sentimentSum[i - 1] < 0 && sentimentSum[i] >= 0) {
				return createBuySignal(cleanData, i, `Body sentiment shifted bullish (${sentimentSum[i - 1]}→${sentimentSum[i]})`);
			}
			if (sentimentSum[i - 1] > 0 && sentimentSum[i] <= 0) {
				return createSellSignal(cleanData, i, `Body sentiment shifted bearish (${sentimentSum[i - 1]}→${sentimentSum[i]})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
