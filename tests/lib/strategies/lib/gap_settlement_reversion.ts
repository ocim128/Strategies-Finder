import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getOpens } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeGapSettlementReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		zThreshold: Math.max(0.5, Math.abs(Number(params.zThreshold ?? 2.5))) };
}

export const gap_settlement_reversion: Strategy = {
	name: "Gap Settlement Reversion",
	description: "When the gap (open vs prior close) reaches an extreme z-score but the bar's body rejects the gap direction by settling back toward the prior close, the gap lacked genuine follow-through. Fade the gap direction.",
	defaultParams: {
		lookback: 30,
		zThreshold: 2.5 },
	paramLabels: {
		lookback: "Lookback",
		zThreshold: "Z-Score Threshold" },
	normalizeParams: normalizeGapSettlementReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeGapSettlementReversionParams(params);
		const lookback = p.lookback as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const opens = getOpens(cleanData);
		const gaps: number[] = opens.map((o, i) => i === 0 ? 0 : o - closes[i - 1]);
		const avgGap = buildRollingAverage(gaps, lookback);
		const zScore = buildRollingZScore(gaps, lookback);

		return createSignalLoop(cleanData, [zScore, avgGap], (i) => {
			if (i < lookback) return null;
			const z = zScore[i];
			if (z === null) return null;

			const bodyDirection = cleanData[i].close - cleanData[i].open;

			if (z > zThreshold && bodyDirection < 0) {
				return createSellSignal(cleanData, i, `Gap up extreme (z=${z.toFixed(2)}) but bar rejected — gap failure fade short`);
			}
			if (z < -zThreshold && bodyDirection > 0) {
				return createBuySignal(cleanData, i, `Gap down extreme (z=${z.toFixed(2)}) but bar rejected — gap failure fade long`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zThreshold"] } };
