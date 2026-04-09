import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";

function normalizeCumulativeDirectionalVolumeFlipParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)) };
}

export const cumulative_directional_volume_flip: Strategy = {
	name: "Cumulative Directional Volume Flip",
	description: "Summing signed volume (volume * bar direction) over a rolling window produces a raw order-flow proxy. When this cumulative measure crosses zero, the dominant participation side has structurally shifted. Enter in the new direction.",
	defaultParams: {
		lookback: 20 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeCumulativeDirectionalVolumeFlipParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCumulativeDirectionalVolumeFlipParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 2) return [];

		const volumes = getVolumes(cleanData);
		const signedVol: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const dir = cleanData[i].close > cleanData[i].open ? 1 : cleanData[i].close < cleanData[i].open ? -1 : 0;
			signedVol[i] = volumes[i] * dir;
		}

		const cumSV: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const start = Math.max(0, i - lookback + 1);
			let sum = 0;
			for (let j = start; j <= i; j++) {
				sum += signedVol[j];
			}
			cumSV[i] = sum;
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (i < lookback + 1) return null;

			if (cumSV[i - 1] < 0 && cumSV[i] >= 0) {
				return createBuySignal(cleanData, i, `Cumulative directional volume flipped bullish (${cumSV[i - 1].toFixed(0)}→${cumSV[i].toFixed(0)})`);
			}
			if (cumSV[i - 1] > 0 && cumSV[i] <= 0) {
				return createSellSignal(cleanData, i, `Cumulative directional volume flipped bearish (${cumSV[i - 1].toFixed(0)}→${cumSV[i].toFixed(0)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
