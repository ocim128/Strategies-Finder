import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeBodyCompressionRatioBreakoutParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(3, Math.round(params.lookback ?? 10));
	const compressionRatio = Math.min(0.6, Math.max(0.2, Number(params.compressionRatio ?? 0.4)));
	return { ...params, lookback, compressionRatio };
}

export const body_compression_ratio_breakout: Strategy = {
	name: "Body Compression Ratio Breakout",
	description:
		"The ratio of current bar body size to the average body size over N bars measures directional compression. When body pct is unusually small relative to recent bars, the market is showing indecision at the body level. When a bar then produces a body that exceeds the average, compression has resolved directionally.",
	defaultParams: { lookback: 10, compressionRatio: 0.4 },
	paramLabels: { lookback: "Lookback", compressionRatio: "Compression Ratio" },
	normalizeParams: normalizeBodyCompressionRatioBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeBodyCompressionRatioBreakoutParams(params);
		if (cleanData.length < np.lookback + 2) return [];
		const closes = getCloses(cleanData);
		const bodyPct = buildBodyPctSeries(cleanData);
		const avgBodyPct = buildRollingAverage(bodyPct, np.lookback);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = np.lookback + 1; i < cleanData.length; i++) {
			const avg = avgBodyPct[i - 1];
			const avgCurr = avgBodyPct[i];
			if (avg === null || avgCurr === null) continue;
			if (bodyPct[i - 1] >= np.compressionRatio * avg) continue;
			if (bodyPct[i] <= avgCurr) continue;
			if (closes[i] > closes[i - 1])
				signals.push(createBuySignal(cleanData, i, `Body compression breakout, bodyPct ${bodyPct[i - 1].toFixed(3)} -> ${bodyPct[i].toFixed(3)}`));
			else if (closes[i] < closes[i - 1])
				signals.push(createSellSignal(cleanData, i, `Body compression breakout, bodyPct ${bodyPct[i - 1].toFixed(3)} -> ${bodyPct[i].toFixed(3)}`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["lookback", "compressionRatio"] } };
