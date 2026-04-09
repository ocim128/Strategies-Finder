import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildCumulativeDecaySum, buildRollingZScore } from "./price-action-statistics-core";

function normalizeGammaProxyDecayAccelerationSnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 2)),
		decayFactor: Math.max(0.01, Math.min(0.999, Number(params.decayFactor ?? 0.7))) };
}

export const gamma_proxy_decay_acceleration_snap: Strategy = {
	name: "Gamma Proxy Decay Acceleration Snap",
	description: "Applying a fast-decay cumulative sum to price acceleration proxies gamma feedback intensity. When decayed acceleration reaches an extreme z-score and reverses, the gamma feedback loop has peaked and will snap back. Fade the cascade direction.",
	defaultParams: {
		rocPeriod: 2,
		decayFactor: 0.7 },
	paramLabels: {
		rocPeriod: "ROC Period",
		decayFactor: "Decay Factor" },
	normalizeParams: normalizeGammaProxyDecayAccelerationSnapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeGammaProxyDecayAccelerationSnapParams(params);
		const rocPeriod = p.rocPeriod as number;
		const decayFactor = p.decayFactor as number;
		if (cleanData.length < 55) return [];

		const closes = getCloses(cleanData);
		const velocity = buildRateOfChange(closes, rocPeriod);
		const velClean = velocity.map(v => v ?? 0);
		const acceleration = buildRateOfChange(velClean, rocPeriod);
		const accelClean = acceleration.map(v => v ?? 0);
		const decayedAccel = buildCumulativeDecaySum(accelClean, decayFactor);
		const zScore = buildRollingZScore(decayedAccel, 50);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < 52) return null;
			const priorZ = zScore[i - 1];
			const currZ = zScore[i];
			if (priorZ === null || currZ === null) return null;

			if (priorZ < -2.5 && currZ > priorZ) {
				return createBuySignal(cleanData, i, `Decayed acceleration z-score reversing from extreme bearish (${priorZ.toFixed(2)}→${currZ.toFixed(2)})`);
			}
			if (priorZ > 2.5 && currZ < priorZ) {
				return createSellSignal(cleanData, i, `Decayed acceleration z-score reversing from extreme bullish (${priorZ.toFixed(2)}→${currZ.toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rocPeriod", "decayFactor"] } };
