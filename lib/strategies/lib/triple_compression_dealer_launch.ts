import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries, buildPercentileRank } from "./price-action-statistics-core";

function normalizeTripleCompressionDealerLaunchParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		compressionWindow: Math.max(2, Math.round(params.compressionWindow ?? 30)),
		compressionRank: Math.max(0, Math.min(100, Number(params.compressionRank ?? 15))) };
}

export const triple_compression_dealer_launch: Strategy = {
	name: "Triple Compression Dealer Launch",
	description: "When true range, body percentage, AND volume simultaneously collapse to rolling percentile lows, the market is in complete dealer positioning lull. The first bar breaking all three compressions with a directional close launches a new positioning cycle. Enter in that direction.",
	defaultParams: {
		compressionWindow: 30,
		compressionRank: 15 },
	paramLabels: {
		compressionWindow: "Compression Window",
		compressionRank: "Compression Rank Max" },
	normalizeParams: normalizeTripleCompressionDealerLaunchParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTripleCompressionDealerLaunchParams(params);
		const compressionWindow = p.compressionWindow as number;
		const compressionRank = p.compressionRank as number;
		const rankThreshold = compressionRank / 100;
		if (cleanData.length < compressionWindow + 2) return [];

		const trSeries = extractBarMetricSeries(cleanData, "trueRange");
		const bpSeries = extractBarMetricSeries(cleanData, "bodyPct");
		const volumes = getVolumes(cleanData);

		const trRank = buildPercentileRank(trSeries, compressionWindow);
		const bpRank = buildPercentileRank(bpSeries, compressionWindow);
		const volRank = buildPercentileRank(volumes, compressionWindow);

		return createSignalLoop(cleanData, [trRank, bpRank, volRank], (i) => {
			if (i < compressionWindow + 1) return null;
			const prevTrR = trRank[i - 1];
			const prevBpR = bpRank[i - 1];
			const prevVolR = volRank[i - 1];
			if (prevTrR === null || prevBpR === null || prevVolR === null) return null;
			if (prevTrR >= rankThreshold || prevBpR >= rankThreshold || prevVolR >= rankThreshold) return null;

			const currTrR = trRank[i];
			const currBpR = bpRank[i];
			const currVolR = volRank[i];
			if (currTrR === null || currBpR === null || currVolR === null) return null;
			if (currTrR <= rankThreshold || currBpR <= rankThreshold || currVolR <= rankThreshold) return null;

			const bodyDir = cleanData[i].close > cleanData[i].open ? 1 : cleanData[i].close < cleanData[i].open ? -1 : 0;

			if (bodyDir > 0) {
				return createBuySignal(cleanData, i, `Triple compression breakout bullish (TR=${(currTrR * 100).toFixed(0)}%, BP=${(currBpR * 100).toFixed(0)}%, Vol=${(currVolR * 100).toFixed(0)}%)`);
			}
			if (bodyDir < 0) {
				return createSellSignal(cleanData, i, `Triple compression breakout bearish (TR=${(currTrR * 100).toFixed(0)}%, BP=${(currBpR * 100).toFixed(0)}%, Vol=${(currVolR * 100).toFixed(0)}%)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["compressionWindow", "compressionRank"] } };
