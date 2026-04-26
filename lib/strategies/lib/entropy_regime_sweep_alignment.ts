import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";

function normalizeEntropyRegimeSweepAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		sweep_lookback: Math.max(2, Math.round(params.sweep_lookback ?? 10)),
		entropy_window: Math.max(3, Math.round(params.entropy_window ?? 20)),
		entropy_percentile_max: Math.min(100, Math.max(1, Math.round(params.entropy_percentile_max ?? 40))),
	};
}

export const entropy_regime_sweep_alignment: Strategy = {
	name: "Entropy Regime Sweep Alignment",
	description: "Sweep-reclaim detects when price sweeps a trailing level and reclaims it — a structural defense signal. Gating sweep-reclaim by rolling entropy ensures the sweep occurs during a low-disorder (trending) regime where the reclaim is meaningful, not during random noise.",
	defaultParams: {
		sweep_lookback: 10,
		entropy_window: 20,
		entropy_percentile_max: 40,
	},
	paramLabels: {
		sweep_lookback: "Sweep Lookback",
		entropy_window: "Entropy Window",
		entropy_percentile_max: "Entropy Percentile Max",
	},
	normalizeParams: normalizeEntropyRegimeSweepAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyRegimeSweepAlignmentParams(params);
		const minLookback = Math.max(p.sweep_lookback, p.entropy_window);
		if (cleanData.length < minLookback) return [];

		const closes = getCloses(cleanData);
		const sweep = buildSweepReclaimSeries(cleanData, p.sweep_lookback);
		const entropy = buildRollingEntropy(closes, p.entropy_window);
		const entropyPctMax = p.entropy_percentile_max / 100;
		const entropyPercentile = buildPercentileRank(
			entropy.map((v) => (v === null ? 0 : v)),
			p.entropy_window
		);

		return createSignalLoop(cleanData, [sweep, entropyPercentile], (i) => {
			if (i < minLookback) return null;
			const sw = sweep[i];
			const ep = entropyPercentile[i];
			if (sw === null || ep === null) return null;

			if (ep > entropyPctMax) return null;

			if (sw > 0) {
				return createBuySignal(cleanData, i, `Bullish sweep-reclaim in low-entropy regime (pct ${ep.toFixed(3)})`);
			}
			if (sw < 0) {
				return createSellSignal(cleanData, i, `Bearish sweep-reclaim in low-entropy regime (pct ${ep.toFixed(3)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["sweep_lookback", "entropy_window", "entropy_percentile_max"],
	},
};
