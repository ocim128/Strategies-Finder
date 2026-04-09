import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeAcceptanceRocDealerRepositioningParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		acceptanceRocPeriod: Math.max(1, Math.round(params.acceptanceRocPeriod ?? 2)),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.5))) };
}

export const acceptance_roc_dealer_repositioning: Strategy = {
	name: "Acceptance ROC Dealer Repositioning",
	description: "Rate-of-change of close acceptance measures how fast settlement conviction is shifting. Extreme acceptance ROC proxies for dealers actively repositioning their delta hedge. When acceptance ROC reaches an extreme and current bar confirms the new direction, enter with the repositioning flow.",
	defaultParams: {
		acceptanceRocPeriod: 2,
		zThreshold: 2.5 },
	paramLabels: {
		acceptanceRocPeriod: "Acceptance ROC Period",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeAcceptanceRocDealerRepositioningParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAcceptanceRocDealerRepositioningParams(params);
		const rocPeriod = p.acceptanceRocPeriod as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < 33) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const acceptanceROC = buildRateOfChange(acceptance, rocPeriod);
		const rocClean = acceptanceROC.map(v => v ?? 0);
		const zScore = buildRollingZScore(rocClean, 30);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < 31) return null;
			const z = zScore[i];
			if (z === null) return null;

			if (z > zThreshold && acceptance[i] > 0) {
				return createBuySignal(cleanData, i, `Acceptance ROC z-score extreme bullish (${z.toFixed(2)}), acceptance confirms`);
			}
			if (z < -zThreshold && acceptance[i] < 0) {
				return createSellSignal(cleanData, i, `Acceptance ROC z-score extreme bearish (${z.toFixed(2)}), acceptance confirms`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["acceptanceRocPeriod", "zThreshold"] } };
