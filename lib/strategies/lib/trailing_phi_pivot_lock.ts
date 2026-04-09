import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, detectPivots } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeTrailingPhiPivotLockParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pivot_lookback: Math.max(2, Math.round(params.pivot_lookback ?? 10)),
		macro_lookback: Math.max(2, Math.round(params.macro_lookback ?? 50)),
		phi_retrace: Math.max(0.01, Math.abs(Number(params.phi_retrace ?? 0.382))) };
}

export const trailing_phi_pivot_lock: Strategy = {
	name: "Trailing Phi Pivot Lock",
	description: "A newly detected pivot is only structurally sound if the close retraces the golden ratio of the trailing macro spread from the pivot, quantifying the reversal without subjective Fibonacci tools.",
	defaultParams: {
		pivot_lookback: 10,
		macro_lookback: 50,
		phi_retrace: 0.382 },
	paramLabels: {
		pivot_lookback: "Pivot Lookback",
		macro_lookback: "Macro Lookback",
		phi_retrace: "Phi Retrace" },
	normalizeParams: normalizeTrailingPhiPivotLockParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrailingPhiPivotLockParams(params);
		const pivotDepth = Math.max(2, Math.round(p.pivot_lookback / 2));
		if (cleanData.length < pivotDepth * 2 + 1 + p.macro_lookback) return [];

		const pivots = detectPivots(cleanData, {
			depth: pivotDepth * 2,
			deviationThreshold: 0.5,
			extremaMode: "pine",
			lockConfirmedPivots: true });

		const { highest, lowest } = buildTrailingHighLow(cleanData, p.macro_lookback);
		const closes = getCloses(cleanData);

		const lastPivotLow: (number | null)[] = new Array(cleanData.length).fill(null);
		const lastPivotHigh: (number | null)[] = new Array(cleanData.length).fill(null);

		let currentLow: number | null = null;
		let currentHigh: number | null = null;
		for (let i = 0; i < cleanData.length; i++) {
			for (const piv of pivots) {
				if (piv.index <= i) {
					if (!piv.isHigh) currentLow = piv.price;
					else currentHigh = piv.price;
				}
			}
			lastPivotLow[i] = currentLow;
			lastPivotHigh[i] = currentHigh;
		}

		return createSignalLoop(cleanData, [highest, lowest], (i) => {
			const hi = highest[i];
			const lo = lowest[i];
			if (hi === null || lo === null) return null;

			const spread = hi - lo;
			if (spread <= 0) return null;

			const retraceThreshold = spread * p.phi_retrace;

			const pivLow = lastPivotLow[i];
			if (pivLow !== null && (closes[i] - pivLow) > retraceThreshold) {
				return createBuySignal(cleanData, i, `Pivot low ${pivLow.toFixed(2)} retraced ${(closes[i] - pivLow).toFixed(2)} > phi * spread`);
			}

			const pivHigh = lastPivotHigh[i];
			if (pivHigh !== null && (pivHigh - closes[i]) > retraceThreshold) {
				return createSellSignal(cleanData, i, `Pivot high ${pivHigh.toFixed(2)} retraced ${(pivHigh - closes[i]).toFixed(2)} > phi * spread`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pivot_lookback", "macro_lookback", "phi_retrace"] } };
