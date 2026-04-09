import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeDealerCascadeAcceptanceExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		acceptanceThreshold: Math.max(0, Math.min(1, Math.abs(Number(params.acceptanceThreshold ?? 0.7)))),
		streakThreshold: Math.max(2, Math.round(params.streakThreshold ?? 4)) };
}

export const dealer_cascade_acceptance_exhaustion: Strategy = {
	name: "Dealer Cascade Acceptance Exhaustion",
	description: "Consecutive bars with extreme close acceptance and expanding true range signal a dealer hedging cascade. When the streak breaks, the hedging flow is exhausted and the underlying snaps back. Fade the exhausted cascade direction.",
	defaultParams: {
		acceptanceThreshold: 0.7,
		streakThreshold: 4 },
	paramLabels: {
		acceptanceThreshold: "Acceptance Threshold",
		streakThreshold: "Streak Threshold" },
	normalizeParams: normalizeDealerCascadeAcceptanceExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDealerCascadeAcceptanceExhaustionParams(params);
		const threshold = p.acceptanceThreshold as number;
		const streakReq = p.streakThreshold as number;
		if (cleanData.length < streakReq + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const trSeries = extractBarMetricSeries(cleanData, "trueRange");
		const avgTr = buildRollingAverage(trSeries, 20);

		const bullishFlags = new Array(cleanData.length).fill(0);
		const bearishFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const expanding = avgTr[i] !== null && trSeries[i] > avgTr[i]!;
			if (acceptance[i] > threshold && expanding) bullishFlags[i] = 1;
			if (acceptance[i] < -threshold && expanding) bearishFlags[i] = -1;
		}

		const bullishStreaks = buildStreakCount(bullishFlags);
		const bearishStreaks = buildStreakCount(bearishFlags);

		return createSignalLoop(cleanData, [avgTr], (i) => {
			if (bearishStreaks[i - 1] <= -streakReq && Math.abs(acceptance[i]) < threshold) {
				return createBuySignal(cleanData, i, `Bearish acceptance cascade exhausted (streak ${bearishStreaks[i - 1]}), acceptance softened`);
			}
			if (bullishStreaks[i - 1] >= streakReq && Math.abs(acceptance[i]) < threshold) {
				return createSellSignal(cleanData, i, `Bullish acceptance cascade exhausted (streak ${bullishStreaks[i - 1]}), acceptance softened`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["acceptanceThreshold", "streakThreshold"] } };
