import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildDualTimeframeRatio, buildRateOfChange } from "./price-action-statistics-core";
import { calculateSMA } from "../indicators";

function normalizeDualTimeframePhiAccelerationParams(params: StrategyParams): StrategyParams {
	const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 8));
	const slowWindow = Math.max(fastWindow + 1, Math.round(params.slowWindow ?? 34));
	const phiVelocity = Math.max(0.01, Number(params.phiVelocity ?? 1.618));
	return { ...params, fastWindow, slowWindow, phiVelocity };
}

export const dual_timeframe_phi_acceleration: Strategy = {
	name: "Dual Timeframe Phi Acceleration",
	description:
		"Demands the macro trend is structurally intact, then fires exactly when the micro rate of change accelerates past a 1.618% harmonic threshold.",
	defaultParams: { fastWindow: 8, slowWindow: 34, phiVelocity: 1.618 },
	paramLabels: { fastWindow: "Fast Window", slowWindow: "Slow Window", phiVelocity: "Phi Velocity (%)" },
	normalizeParams: normalizeDualTimeframePhiAccelerationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeDualTimeframePhiAccelerationParams(params);
		if (cleanData.length < np.slowWindow + 2) return [];
		const closes = getCloses(cleanData);
		const ratio = buildDualTimeframeRatio(closes, np.fastWindow, np.slowWindow, calculateSMA);
		const roc = buildRateOfChange(closes, 1);
		const rocPct: (number | null)[] = roc.map((v) => (v !== null ? v * 100 : null));
		return createSignalLoop(cleanData, [ratio, rocPct], (i) => {
			const r = ratio[i];
			const rc = rocPct[i];
			const rcPrev = rocPct[i - 1];
			if (r === null || rc === null || rcPrev === null) return null;
			if (r > 1.0 && rcPrev <= np.phiVelocity && rc > np.phiVelocity)
				return createBuySignal(cleanData, i, `Macro aligned ${(r).toFixed(3)}, ROC thrust ${rc.toFixed(2)}% > ${np.phiVelocity}%`);
			if (r < 1.0 && rcPrev >= -np.phiVelocity && rc < -np.phiVelocity)
				return createSellSignal(cleanData, i, `Macro aligned ${(r).toFixed(3)}, ROC thrust ${rc.toFixed(2)}% < -${np.phiVelocity}%`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["fastWindow", "slowWindow", "phiVelocity"] } };
