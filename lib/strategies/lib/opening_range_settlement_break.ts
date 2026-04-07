import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getOpens } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildBodyPctSeries } from "./price-action-frequency-core";

function normalizeOpeningRangeSettlementBreakParams(params: StrategyParams): StrategyParams {
	const smallBodyThreshold = Math.min(0.4, Math.max(0.1, Number(params.smallBodyThreshold ?? 0.25)));
	const minSettlementBars = Math.min(6, Math.max(2, Math.round(params.minSettlementBars ?? 3)));
	return { ...params, smallBodyThreshold, minSettlementBars };
}

export const opening_range_settlement_break: Strategy = {
	name: "Opening Range Settlement Break",
	description:
		"When N consecutive bars all settle near their opens (small bodies), the market is failing to commit. The first bar that breaks this pattern with a large body signals that commitment has returned — enter in the body direction. This captures periods of open-close equilibrium interrupted by directional commitment.",
	defaultParams: { smallBodyThreshold: 0.25, minSettlementBars: 3 },
	paramLabels: { smallBodyThreshold: "Small Body Threshold", minSettlementBars: "Min Settlement Bars" },
	normalizeParams: normalizeOpeningRangeSettlementBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeOpeningRangeSettlementBreakParams(params);
		if (cleanData.length < np.minSettlementBars + 2) return [];
		const closes = getCloses(cleanData);
		const opens = getOpens(cleanData);
		const bodyPct = buildBodyPctSeries(cleanData);
		const smallBodyFlags: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (bodyPct[i] < np.smallBodyThreshold) smallBodyFlags[i] = 1;
		}
		const streaks = buildStreakCount(smallBodyFlags);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			if (streaks[i - 1] < np.minSettlementBars) continue;
			if (bodyPct[i] < np.smallBodyThreshold) continue;
			if (closes[i] > opens[i])
				signals.push(createBuySignal(cleanData, i, `Settlement break after ${streaks[i - 1]} small-body bars, bullish commitment`));
			else if (closes[i] < opens[i])
				signals.push(createSellSignal(cleanData, i, `Settlement break after ${streaks[i - 1]} small-body bars, bearish commitment`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["smallBodyThreshold", "minSettlementBars"] } };
