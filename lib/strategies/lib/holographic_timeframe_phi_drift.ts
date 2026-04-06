import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildDualTimeframeRatio } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";
import { calculateMomentum } from "../indicators";

function normalizeHolographicTimeframePhiDriftParams(params: StrategyParams): StrategyParams {
	const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 8));
	const slowWindow = Math.max(fastWindow + 1, Math.round(params.slowWindow ?? 55));
	const phiExpansion = Math.max(0.5, Number(params.phiExpansion ?? 1.01618));
	return { ...params, fastWindow, slowWindow, phiExpansion };
}

export const holographic_timeframe_phi_drift: Strategy = {
	name: "Holographic Timeframe Phi Drift",
	description:
		"Aligns with macro algorithmic drift when the dual-timeframe ratio exceeds the 1.618% harmonic premium, firing only when local momentum confirms the directional shift.",
	defaultParams: { fastWindow: 8, slowWindow: 55, phiExpansion: 1.01618 },
	paramLabels: { fastWindow: "Fast Window", slowWindow: "Slow Window", phiExpansion: "Phi Expansion" },
	normalizeParams: normalizeHolographicTimeframePhiDriftParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeHolographicTimeframePhiDriftParams(params);
		if (cleanData.length < np.slowWindow + 2) return [];

		const closes = getCloses(cleanData);
		const ratio = buildDualTimeframeRatio(closes, np.fastWindow, np.slowWindow, buildRollingAverage);
		const momentum = calculateMomentum(closes, np.fastWindow);

		const phiFloor = 2.0 - np.phiExpansion;

		const signals = [];
		for (let i = np.slowWindow; i < cleanData.length; i++) {
			const r = ratio[i];
			const m = momentum[i];
			const mPrev = momentum[i - 1];
			if (r === null || m === null || mPrev === null) continue;

			if (r > np.phiExpansion && mPrev <= 0 && m > 0) {
				signals.push(createBuySignal(cleanData, i, `DTF ratio > ${np.phiExpansion} & momentum crossed above 0`));
			}
			if (r < phiFloor && mPrev >= 0 && m < 0) {
				signals.push(createSellSignal(cleanData, i, `DTF ratio < ${phiFloor.toFixed(5)} & momentum crossed below 0`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow", "phiExpansion"],
	},
};
