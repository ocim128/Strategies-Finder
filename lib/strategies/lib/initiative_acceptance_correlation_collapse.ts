import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeInitiativeAcceptanceCorrelationCollapseParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corrWindow: Math.max(3, Math.round(params.corrWindow ?? 25)),
		corrFloor: Math.max(0, Math.abs(Number(params.corrFloor ?? 0.15))) };
}

export const initiative_acceptance_correlation_collapse: Strategy = {
	name: "Initiative Acceptance Correlation Collapse",
	description: "Rolling correlation between initiative pressure and close acceptance measures whether aggressive flow produces committed settlements. When correlation collapses toward zero, the flow-conviction coupling sustaining the move has broken. Fade the prevailing close direction.",
	defaultParams: {
		corrWindow: 25,
		corrFloor: 0.15 },
	paramLabels: {
		corrWindow: "Correlation Window",
		corrFloor: "Correlation Floor" },
	normalizeParams: normalizeInitiativeAcceptanceCorrelationCollapseParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeAcceptanceCorrelationCollapseParams(params);
		const corrWindow = p.corrWindow as number;
		const corrFloor = p.corrFloor as number;
		if (cleanData.length < corrWindow + 2) return [];

		const closes = getCloses(cleanData);
		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const ipSeries = buildInitiativePressureSeries(cleanData, corrWindow);
		const ipClean = ipSeries.map(v => v ?? 0);
		const corr = buildRollingCorrelation(ipClean, acceptance, corrWindow);
		const avgClose = buildRollingAverage(closes, corrWindow);

		return createSignalLoop(cleanData, [corr, avgClose], (i) => {
			if (i < corrWindow + 1) return null;
			const priorCorr = corr[i - 1];
			const currCorr = corr[i];
			if (priorCorr === null || currCorr === null) return null;

			if (Math.abs(priorCorr) > corrFloor && Math.abs(currCorr) <= corrFloor) {
				const avg = avgClose[i];
				if (avg !== null && closes[i] < avg) {
					return createBuySignal(cleanData, i, `Correlation collapsed (${currCorr.toFixed(2)}), close below avg — fade long`);
				}
				if (avg !== null && closes[i] > avg) {
					return createSellSignal(cleanData, i, `Correlation collapsed (${currCorr.toFixed(2)}), close above avg — fade short`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corrWindow", "corrFloor"] } };
