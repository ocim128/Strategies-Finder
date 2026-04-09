import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { getVolumes } from "../strategy-helpers";

function normalizeVolumeWeightedAcceptanceZscoreThrustParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.5))) };
}

export const volume_weighted_acceptance_zscore_thrust: Strategy = {
	name: "Volume Weighted Acceptance Z-Score Thrust",
	description: "Close acceptance multiplied by relative volume creates a volume-weighted conviction measure. When the z-score of this product reaches an extreme and the bar body confirms, a high-conviction, high-participation dealer event is underway. Trade continuation.",
	defaultParams: {
		lookback: 30,
		zThreshold: 2.5 },
	paramLabels: {
		lookback: "Lookback",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeVolumeWeightedAcceptanceZscoreThrustParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeWeightedAcceptanceZscoreThrustParams(params);
		const lookback = p.lookback as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const volumes = getVolumes(cleanData);
		const avgVol = buildRollingAverage(volumes, lookback);

		const vwAcceptance: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const av = avgVol[i];
			const relVol = av !== null && av > 0 ? volumes[i] / av : 1;
			vwAcceptance[i] = acceptance[i] * relVol;
		}

		const zScore = buildRollingZScore(vwAcceptance, lookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			const bodyDir = cleanData[i].close > cleanData[i].open ? 1 : cleanData[i].close < cleanData[i].open ? -1 : 0;

			if (z > zThreshold && bodyDir > 0) {
				return createBuySignal(cleanData, i, `VW acceptance z-score extreme bullish (${z.toFixed(2)}), body confirms`);
			}
			if (z < -zThreshold && bodyDir < 0) {
				return createSellSignal(cleanData, i, `VW acceptance z-score extreme bearish (${z.toFixed(2)}), body confirms`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zThreshold"] } };
