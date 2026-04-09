import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildPercentileRank } from "./price-action-statistics-core";

function normalizeRealizedVolPremiumOverstatementParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 50)),
		compressionRank: Math.max(0, Math.min(100, Number(params.compressionRank ?? 10))) };
}

export const realized_vol_premium_overstatement: Strategy = {
	name: "Realized Vol Premium Overstatement",
	description: "When both true range and body percentage simultaneously collapse to rolling percentile lows, realized vol has fallen below options premium pricing. Fade the recent body direction because the underlying lacks energy to justify the remaining premium.",
	defaultParams: {
		lookback: 50,
		compressionRank: 10 },
	paramLabels: {
		lookback: "Lookback",
		compressionRank: "Compression Rank Max" },
	normalizeParams: normalizeRealizedVolPremiumOverstatementParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRealizedVolPremiumOverstatementParams(params);
		const lookback = p.lookback as number;
		const compressionRank = p.compressionRank as number;
		const rankThreshold = compressionRank / 100;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const trSeries = extractBarMetricSeries(cleanData, "trueRange");
		const bpSeries = extractBarMetricSeries(cleanData, "bodyPct");
		const trRank = buildPercentileRank(trSeries, lookback);
		const bpRank = buildPercentileRank(bpSeries, lookback);
		const avgClose = buildRollingAverage(closes, lookback);

		return createSignalLoop(cleanData, [trRank, bpRank, avgClose], (i) => {
			if (i < lookback) return null;
			const tr = trRank[i];
			const bp = bpRank[i];
			if (tr === null || bp === null) return null;
			if (tr >= rankThreshold || bp >= rankThreshold) return null;

			const avg = avgClose[i];
			if (avg === null) return null;

			if (closes[i] < avg) {
				return createBuySignal(cleanData, i, `Dual vol collapse (TR=${(tr * 100).toFixed(0)}%, BP=${(bp * 100).toFixed(0)}%), close below avg — fade long`);
			}
			if (closes[i] > avg) {
				return createSellSignal(cleanData, i, `Dual vol collapse (TR=${(tr * 100).toFixed(0)}%, BP=${(bp * 100).toFixed(0)}%), close above avg — fade short`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "compressionRank"] } };
