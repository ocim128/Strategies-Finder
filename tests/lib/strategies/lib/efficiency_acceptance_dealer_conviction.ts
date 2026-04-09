import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyAcceptanceDealerConvictionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		erLookback: Math.max(2, Math.round(params.erLookback ?? 14)),
		acceptanceThreshold: Math.max(0, Math.abs(Number(params.acceptanceThreshold ?? 0.3))) };
}

export const efficiency_acceptance_dealer_conviction: Strategy = {
	name: "Efficiency Acceptance Dealer Conviction",
	description: "High efficiency ratio with weak close acceptance signals mechanical gamma drift without genuine settlement conviction. When the first bar shows strong acceptance contra to the drift direction, the drift is reversing into conviction-backed movement. Fade the drift.",
	defaultParams: {
		erLookback: 14,
		acceptanceThreshold: 0.3 },
	paramLabels: {
		erLookback: "ER Lookback",
		acceptanceThreshold: "Acceptance Threshold" },
	normalizeParams: normalizeEfficiencyAcceptanceDealerConvictionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyAcceptanceDealerConvictionParams(params);
		const erLookback = p.erLookback as number;
		const acceptanceThreshold = p.acceptanceThreshold as number;
		if (cleanData.length < erLookback + 2) return [];

		const closes = getCloses(cleanData);
		const er = buildEfficiencyRatio(cleanData, erLookback);
		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const avgClose = buildRollingAverage(closes, erLookback);

		let driftDirection = 0;

		return createSignalLoop(cleanData, [er, avgClose], (i) => {
			if (i < erLookback + 1) return null;
			const erVal = er[i];
			if (erVal === null) return null;
			const avg = avgClose[i];
			if (avg === null) return null;

			if (Math.abs(erVal) > 0.6 && Math.abs(acceptance[i]) < acceptanceThreshold) {
				driftDirection = closes[i] < avg ? -1 : 1;
				return null;
			}

			if (driftDirection === -1 && acceptance[i] > 0.4) {
				driftDirection = 0;
				return createBuySignal(cleanData, i, `Bearish drift (${erVal.toFixed(2)} ER, weak acceptance) reversed with bullish acceptance`);
			}
			if (driftDirection === 1 && acceptance[i] < -0.4) {
				driftDirection = 0;
				return createSellSignal(cleanData, i, `Bullish drift (${erVal.toFixed(2)} ER, weak acceptance) reversed with bearish acceptance`);
			}

			if (Math.abs(erVal) <= 0.6 || Math.abs(acceptance[i]) >= acceptanceThreshold) {
				driftDirection = 0;
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["erLookback", "acceptanceThreshold"] } };
