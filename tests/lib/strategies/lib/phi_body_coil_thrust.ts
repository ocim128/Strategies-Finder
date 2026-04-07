import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizePhiBodyCoilThrustParams(params: StrategyParams): StrategyParams {
	const coilStreak = Math.max(1, Math.round(params.coilStreak ?? 3));
	const phiCompression = Math.min(1, Math.max(0, Number(params.phiCompression ?? 0.382)));
	const phiExpansion = Math.min(1, Math.max(0, Number(params.phiExpansion ?? 0.618)));
	return { ...params, coilStreak, phiCompression, phiExpansion };
}

export const phi_body_coil_thrust: Strategy = {
	name: "Phi Body Coil Thrust",
	description:
		"Identifies a harmonic coil of at least three bars where the body percentage is strictly constrained below 38.2%, entering on the first bar that explodes beyond 61.8%.",
	defaultParams: { coilStreak: 3, phiCompression: 0.382, phiExpansion: 0.618 },
	paramLabels: { coilStreak: "Coil Streak", phiCompression: "Phi Compression", phiExpansion: "Phi Expansion" },
	normalizeParams: normalizePhiBodyCoilThrustParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizePhiBodyCoilThrustParams(params);
		if (cleanData.length < np.coilStreak + 2) return [];
		const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const flags: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			flags[i] = bodyPct[i] < np.phiCompression ? 1 : -1;
		}
		const streaks = buildStreakCount(flags);
		return createSignalLoop(cleanData, [streaks.map((s) => s as number | null)], (i) => {
			const prevStreak = streaks[i - 1];
			if (prevStreak < np.coilStreak) return null;
			if (bodyPct[i] <= np.phiExpansion) return null;
			if (bodyDir[i] === 1) return createBuySignal(cleanData, i, `Coil ${prevStreak}-bar compression thrust, body ${bodyPct[i].toFixed(3)}`);
			if (bodyDir[i] === -1) return createSellSignal(cleanData, i, `Coil ${prevStreak}-bar compression thrust, body ${bodyPct[i].toFixed(3)}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["coilStreak", "phiCompression", "phiExpansion"] } };
