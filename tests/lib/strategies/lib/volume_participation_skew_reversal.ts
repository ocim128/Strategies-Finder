import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeParticipationSkewReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.0))) };
}

export const volume_participation_skew_reversal: Strategy = {
	name: "Volume Participation Skew Reversal",
	description: "Track the ratio of up-bar volume to down-bar volume as a rolling skew. When this ratio reaches an extreme z-score and begins reverting toward 1.0, the dominant volume participation side is exhausting. Trade the mean-reversion.",
	defaultParams: {
		lookback: 30,
		zThreshold: 2.0 },
	paramLabels: {
		lookback: "Lookback",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeVolumeParticipationSkewReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeParticipationSkewReversalParams(params);
		const lookback = p.lookback as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		let upVol: number[] = [];
		let downVol: number[] = [];
		for (let i = 0; i < cleanData.length; i++) {
			if (closes[i] > cleanData[i].open) {
				upVol.push(cleanData[i].volume);
				downVol.push(0);
			} else {
				upVol.push(0);
				downVol.push(cleanData[i].volume);
			}
		}

		const skew: number[] = upVol.map((_, i) => {
			if (i < lookback) return 1;
			let sumUp = 0, sumDown = 0;
			for (let j = i - lookback + 1; j <= i; j++) {
				sumUp += upVol[j];
				sumDown += downVol[j];
			}
			return sumDown === 0 ? 2 : sumUp / sumDown;
		});

		const zScore = buildRollingZScore(skew, lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < lookback * 2) return null;
			const z = zScore[i];
			const prevZ = zScore[i - 1];
			if (z === null || prevZ === null) return null;

			if (prevZ > zThreshold && z < prevZ) {
				return createSellSignal(cleanData, i, `Up-vol dominance fading (z: ${prevZ.toFixed(2)} -> ${z.toFixed(2)}) — participation skew reversing`);
			}
			if (prevZ < -zThreshold && z > prevZ) {
				return createBuySignal(cleanData, i, `Down-vol dominance fading (z: ${prevZ.toFixed(2)} -> ${z.toFixed(2)}) — participation skew reversing`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zThreshold"] } };
