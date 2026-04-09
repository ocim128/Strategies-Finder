import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeRangeVelocityStallReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		stallZ: Math.max(0.5, Math.abs(Number(params.stallZ ?? 2.0))) };
}

export const range_velocity_stall_reversion: Strategy = {
	name: "Range Velocity Stall Reversion",
	description: "When the rate of change of average true range stalls at an extreme low z-score while price has extended far from its rolling average, range expansion is due and the extended move is likely to reverse. Fade the extension.",
	defaultParams: {
		lookback: 30,
		stallZ: 2.0 },
	paramLabels: {
		lookback: "Lookback",
		stallZ: "Stall Z-Score" },
	normalizeParams: normalizeRangeVelocityStallReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRangeVelocityStallReversionParams(params);
		const lookback = p.lookback as number;
		const stallZ = p.stallZ as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const ranges = buildRangeSeries(cleanData);
		const avgRange = buildRollingAverage(ranges, lookback);
		const rangeROC = buildRateOfChange(avgRange.map(v => v ?? 0), lookback);
		const rocZ = buildRollingZScore(rangeROC.map(v => v ?? 0), lookback);
		const avgClose = buildRollingAverage(closes, lookback);

		return createSignalLoop(cleanData, [rocZ, avgClose], (i) => {
			if (i < lookback * 2) return null;
			const rz = rocZ[i];
			const avg = avgClose[i];
			if (rz === null || avg === null) return null;

			const extendedUp = closes[i] > avg * 1.02;
			const extendedDown = closes[i] < avg * 0.98;

			if (rz < -stallZ && extendedUp) {
				return createSellSignal(cleanData, i, `Range velocity stalled (z=${rz.toFixed(2)}) with price extended above avg — reversion`);
			}
			if (rz < -stallZ && extendedDown) {
				return createBuySignal(cleanData, i, `Range velocity stalled (z=${rz.toFixed(2)}) with price extended below avg — reversion`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "stallZ"] } };
