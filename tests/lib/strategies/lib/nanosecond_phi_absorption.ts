import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

function normalizeNanosecondPhiAbsorptionParams(params: StrategyParams): StrategyParams {
	const phiWickRatio = Math.max(0.01, Math.min(1, Number(params.phiWickRatio ?? 0.618)));
	const phiBodyThrust = Math.max(0.01, Math.min(1, Number(params.phiBodyThrust ?? 0.618)));
	return { ...params, phiWickRatio, phiBodyThrust };
}

export const nanosecond_phi_absorption: Strategy = {
	name: "Nanosecond Phi Absorption",
	description:
		"Identifies high-frequency algorithmic traps: a bar leaving a golden wick (>61.8% of range) immediately engulfed by a solid body thrust in the opposite direction.",
	defaultParams: { phiWickRatio: 0.618, phiBodyThrust: 0.618 },
	paramLabels: { phiWickRatio: "Phi Wick Ratio", phiBodyThrust: "Phi Body Thrust" },
	normalizeParams: normalizeNanosecondPhiAbsorptionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeNanosecondPhiAbsorptionParams(params);
		if (cleanData.length < 3) return [];

		const signals = [];
		for (let i = 1; i < cleanData.length; i++) {
			const prevMetrics = getPriceActionBarMetrics(cleanData[i - 1]);
			const currMetrics = getPriceActionBarMetrics(cleanData[i]);

			if (prevMetrics.range === 0 || currMetrics.range === 0) continue;

			const prevUpperWickPct = prevMetrics.upperWick / prevMetrics.range;
			const prevLowerWickPct = prevMetrics.lowerWick / prevMetrics.range;
			const currBodyPct = currMetrics.bodyPct;

			if (currBodyPct < np.phiBodyThrust) continue;

			if (prevUpperWickPct > np.phiWickRatio && cleanData[i].close > cleanData[i - 1].high) {
				signals.push(createBuySignal(cleanData, i, `Upper wick trap absorbed: prev wick ${(prevUpperWickPct * 100).toFixed(1)}%, body ${(currBodyPct * 100).toFixed(1)}%`));
			}
			if (prevLowerWickPct > np.phiWickRatio && cleanData[i].close < cleanData[i - 1].low) {
				signals.push(createSellSignal(cleanData, i, `Lower wick trap absorbed: prev wick ${(prevLowerWickPct * 100).toFixed(1)}%, body ${(currBodyPct * 100).toFixed(1)}%`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["phiWickRatio", "phiBodyThrust"],
	},
};
