import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

function normalizeUpDownReturnAsymmetryParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		asymmetryWindow: Math.max(2, Math.round(params.asymmetryWindow ?? 20)),
		ratioThreshold: Math.max(1, Math.abs(Number(params.ratioThreshold ?? 1.5))) };
}

export const up_down_return_asymmetry: Strategy = {
	name: "Up-Down Return Asymmetry",
	description: "Separately accumulating positive and negative close-to-close returns reveals directional risk perception asymmetry. When one side dominates, confirming closes in the dominant direction signal regime conviction. Trade with the dominant direction.",
	defaultParams: {
		asymmetryWindow: 20,
		ratioThreshold: 1.5 },
	paramLabels: {
		asymmetryWindow: "Asymmetry Window",
		ratioThreshold: "Ratio Threshold" },
	normalizeParams: normalizeUpDownReturnAsymmetryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeUpDownReturnAsymmetryParams(params);
		const window = p.asymmetryWindow as number;
		const ratioThreshold = p.ratioThreshold as number;
		if (cleanData.length < window + 2) return [];

		const closes = getCloses(cleanData);
		const upSum: number[] = new Array(cleanData.length).fill(0);
		const downSum: number[] = new Array(cleanData.length).fill(0);

		for (let i = 1; i < cleanData.length; i++) {
			const diff = closes[i] - closes[i - 1];
			upSum[i] = upSum[i - 1] + (diff > 0 ? diff : 0);
			downSum[i] = downSum[i - 1] + (diff < 0 ? Math.abs(diff) : 0);

			if (i > window) {
				const prevDiff = closes[i - window] - closes[i - window - 1];
				upSum[i] -= prevDiff > 0 ? prevDiff : 0;
				downSum[i] -= prevDiff < 0 ? Math.abs(prevDiff) : 0;
			}
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (i < window + 1) return null;

			const up = upSum[i];
			const down = downSum[i];

			if (up > 0 && down > 0) {
				if (up / down > ratioThreshold && closes[i] > closes[i - 1]) {
					return createBuySignal(cleanData, i, `Upside return dominance (up/down=${(up / down).toFixed(2)}), close confirms bullish`);
				}
				if (down / up > ratioThreshold && closes[i] < closes[i - 1]) {
					return createSellSignal(cleanData, i, `Downside return dominance (down/up=${(down / up).toFixed(2)}), close confirms bearish`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["asymmetryWindow", "ratioThreshold"] } };
