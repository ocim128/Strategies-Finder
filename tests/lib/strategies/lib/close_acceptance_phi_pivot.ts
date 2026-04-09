import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, detectPivots } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";

function normalizeCloseAcceptancePhiPivotParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pivot_lookback: Math.max(4, Math.round(params.pivot_lookback ?? 10)),
		phi_acceptance: Math.max(0.01, Math.min(0.99, Number(params.phi_acceptance ?? 0.382))),
	};
}

export const close_acceptance_phi_pivot: Strategy = {
	name: "Close Acceptance Phi Pivot",
	description: "A pivot is structurally confirmed when the Close Acceptance series rapidly drops below or rises above the 0.382 threshold, proving institutional rejection of the extreme.",
	defaultParams: {
		pivot_lookback: 10,
		phi_acceptance: 0.382,
	},
	paramLabels: {
		pivot_lookback: "Pivot Lookback",
		phi_acceptance: "Phi Acceptance",
	},
	normalizeParams: normalizeCloseAcceptancePhiPivotParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseAcceptancePhiPivotParams(params);
		const halfDepth = Math.max(1, Math.floor(p.pivot_lookback / 2));
		if (cleanData.length < halfDepth * 2 + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const pivots = detectPivots(cleanData, {
			depth: p.pivot_lookback,
			deviationThreshold: 0,
			includeConfirmationIndex: true,
		});

		const pivotsByConfirm = new Map<number, { isHigh: boolean }[]>();
		for (const pivot of pivots) {
			const ci = pivot.confirmationIndex ?? pivot.index;
			if (!pivotsByConfirm.has(ci)) pivotsByConfirm.set(ci, []);
			pivotsByConfirm.get(ci)!.push({ isHigh: pivot.isHigh });
		}

		let mostRecentPivotLowConfirm = -1;
		let mostRecentPivotHighConfirm = -1;
		const recentPivotLow = new Array(cleanData.length).fill(false);
		const recentPivotHigh = new Array(cleanData.length).fill(false);
		const recentWindow = p.pivot_lookback * 3;

		for (let i = 0; i < cleanData.length; i++) {
			const confirmed = pivotsByConfirm.get(i);
			if (confirmed) {
				for (const info of confirmed) {
					if (!info.isHigh) mostRecentPivotLowConfirm = i;
					if (info.isHigh) mostRecentPivotHighConfirm = i;
				}
			}
			if (mostRecentPivotLowConfirm >= 0 && (i - mostRecentPivotLowConfirm) <= recentWindow)
				recentPivotLow[i] = true;
			if (mostRecentPivotHighConfirm >= 0 && (i - mostRecentPivotHighConfirm) <= recentWindow)
				recentPivotHigh[i] = true;
		}

		return createSignalLoop(cleanData, [], (i) => {
			const acc = acceptance[i];
			if (recentPivotLow[i] && acc < p.phi_acceptance && cleanData[i].close > cleanData[i].open)
				return createBuySignal(cleanData, i, "Pivot low with acceptance rejection");
			if (recentPivotHigh[i] && acc > (1 - p.phi_acceptance) && cleanData[i].close < cleanData[i].open)
				return createSellSignal(cleanData, i, "Pivot high with acceptance rejection");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pivot_lookback", "phi_acceptance"],
	},
};
