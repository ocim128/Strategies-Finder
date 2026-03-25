import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 3)),
		zscoreShock: Number(params.zscoreShock ?? 3.0),
		retracePct: Number(params.retracePct ?? 0.5)
	};
}

export const micro_shock_retrace_scalp: Strategy = {
	name: "Micro Shock Retrace Scalp",
	description: "Capitalizes on 1m 'air pockets' where a sudden rapid price shock immediately retraces more than halfway within the next 60 seconds.",
	defaultParams: { rocPeriod: 3, zscoreShock: 3.0, retracePct: 0.5 },
	paramLabels: { rocPeriod: "ROC Period", zscoreShock: "Z-Score Shock", retracePct: "Retrace %" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["rocPeriod", "zscoreShock", "retracePct"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < 25) return [];

		const closes = getCloses(clean);
		const roc = buildRateOfChange(closes, p.rocPeriod);
		const cleanRoc = roc.map(r => r ?? 0);
		const zscore = buildRollingZScore(cleanRoc, 20); 

		return createSignalLoop(clean, [zscore], (i) => {
			if (i === 0) return null;
			
			const prevZ = zscore[i-1];
			if (prevZ === null) return null;

			const shockBar = clean[i-1];
			const curBar = clean[i];
			const shockRange = shockBar.high - shockBar.low;

			if (shockRange === 0) return null;

			if (prevZ < -p.zscoreShock) {
				const retraceLevel = shockBar.low + shockRange * p.retracePct;
				if (curBar.close > retraceLevel) {
					return createBuySignal(clean, i, "Micro Shock Fade Up");
				}
			}

			if (prevZ > p.zscoreShock) {
				const retraceLevel = shockBar.high - shockRange * p.retracePct;
				if (curBar.close < retraceLevel) {
					return createSellSignal(clean, i, "Micro Shock Fade Down");
				}
			}

			return null;
		});
	}
};
