import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeStrikeProximityAcceptanceRejectionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		trailWindow: Math.max(2, Math.round(params.trailWindow ?? 20)),
		proximityPct: Math.max(0.01, Math.min(0.5, Number(params.proximityPct ?? 0.15))) };
}

export const strike_proximity_acceptance_rejection: Strategy = {
	name: "Strike Proximity Acceptance Rejection",
	description: "When price is near a trailing boundary but close acceptance opposes the approach, the boundary is actively rejecting price — modeling strike rejection where dealers defend a level. Fade back from the boundary.",
	defaultParams: {
		trailWindow: 20,
		proximityPct: 0.15 },
	paramLabels: {
		trailWindow: "Trail Window",
		proximityPct: "Proximity %" },
	normalizeParams: normalizeStrikeProximityAcceptanceRejectionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeStrikeProximityAcceptanceRejectionParams(params);
		const trailWindow = p.trailWindow as number;
		const proximityPct = p.proximityPct as number;
		if (cleanData.length < trailWindow + 2) return [];

		const closes = getCloses(cleanData);
		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const { highest, lowest } = buildTrailingHighLow(cleanData, trailWindow);

		return createSignalLoop(cleanData, [highest, lowest], (i) => {
			if (i < trailWindow) return null;
			const hi = highest[i];
			const lo = lowest[i];
			if (hi === null || lo === null) return null;
			const span = hi - lo;
			if (span <= 0) return null;

			const upperDist = (hi - closes[i]) / span;
			const lowerDist = (closes[i] - lo) / span;

			if (lowerDist < proximityPct && acceptance[i] > 0) {
				return createBuySignal(cleanData, i, `Lower boundary rejection (prox ${(lowerDist * 100).toFixed(0)}%), acceptance bullish (${acceptance[i].toFixed(2)})`);
			}
			if (upperDist < proximityPct && acceptance[i] < 0) {
				return createSellSignal(cleanData, i, `Upper boundary rejection (prox ${(upperDist * 100).toFixed(0)}%), acceptance bearish (${acceptance[i].toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trailWindow", "proximityPct"] } };
