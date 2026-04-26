import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingStdDev } from "./price-action-statistics-core";
import { calculateSessionVWAP } from "../indicators";

function normalizeSessionVwapDeviationZscoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		threshold: Math.max(0.1, Number(params.threshold ?? 1.5)),
	};
}

export const session_vwap_deviation_zscore: Strategy = {
	name: "Session VWAP Deviation Z-Score",
	description: "Session VWAP resets each trading day, providing the intraday volume-weighted value consensus. The z-score of session-VWAP deviation is the gold standard intraday value reference — it resets daily, eliminating stale multi-day cumulative influence.",
	defaultParams: {
		lookback: 30,
		threshold: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeSessionVwapDeviationZscoreParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSessionVwapDeviationZscoreParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const svwap = calculateSessionVWAP(cleanData);
		const deviation: number[] = closes.map((c, i) => {
			const v = svwap[i];
			return v === null ? 0 : c - v;
		});
		const stdDev = buildRollingStdDev(deviation, p.lookback);

		return createSignalLoop(cleanData, [stdDev], (i) => {
			if (i < p.lookback) return null;
			const sd = stdDev[i];
			if (sd === null || sd < 1e-9) return null;

			const z = deviation[i] / sd;
			if (z < -p.threshold) {
				return createBuySignal(cleanData, i, `Session VWAP deviation z-score ${z.toFixed(3)} below -threshold`);
			}
			if (z > p.threshold) {
				return createSellSignal(cleanData, i, `Session VWAP deviation z-score ${z.toFixed(3)} above threshold`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
