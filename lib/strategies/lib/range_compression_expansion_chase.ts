import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		expansionThreshold: Math.max(0.01, Math.min(0.99, Number(params.expansionThreshold ?? 0.85))),
		compressionLookback: Math.max(1, Math.round(Number(params.compressionLookback ?? 5))),
	};
}

export const range_compression_expansion_chase: Strategy = {
	name: "Range Compression-Expansion Chase",
	description: "Chases the direction of a ratio breakout when the intrabar range spikes after a period of tight coupling (low range).",
	defaultParams: {
		lookback: 30,
		expansionThreshold: 0.85,
		compressionLookback: 5,
	},
	paramLabels: {
		lookback: "Lookback Window",
		expansionThreshold: "Expansion Threshold",
		compressionLookback: "Compression Lookback",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const expansionThreshold = p.expansionThreshold as number;
		const compressionLookback = p.compressionLookback as number;
		if (cleanData.length < lookback + compressionLookback) return [];

		const ranges = buildRangeSeries(cleanData);
		const rangePercentile = buildPercentileRank(ranges, lookback);
		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [rangePercentile], (i) => {
			if (i < lookback + compressionLookback) return null;
			const currentPercentile = rangePercentile[i];
			if (currentPercentile === null) return null;

			// Expansion threshold check
			if (currentPercentile <= expansionThreshold) return null;

			// Check compression of preceding compressionLookback bars
			let sumPrevPct = 0;
			for (let j = 1; j <= compressionLookback; j++) {
				const val = rangePercentile[i - j];
				if (val === null) return null;
				sumPrevPct += val;
			}
			const avgPrevPct = sumPrevPct / compressionLookback;
			if (avgPrevPct >= 0.35) return null;

			const closeLoc = closeLocation[i];
			if (closeLoc > 0.8) {
				return createBuySignal(cleanData, i, `Range expansion (${currentPercentile.toFixed(2)}) after compression (avg=${avgPrevPct.toFixed(2)}), close location ${closeLoc.toFixed(2)} > 0.8`);
			}
			if (closeLoc < 0.2) {
				return createSellSignal(cleanData, i, `Range expansion (${currentPercentile.toFixed(2)}) after compression (avg=${avgPrevPct.toFixed(2)}), close location ${closeLoc.toFixed(2)} < 0.2`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "expansionThreshold", "compressionLookback"],
	},
};
