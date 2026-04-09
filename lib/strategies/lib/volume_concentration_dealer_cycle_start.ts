import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes, getCloses } from "../strategy-helpers";
import { buildRollingAverage, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeVolumeConcentrationDealerCycleStartParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		concentrationWindow: Math.max(2, Math.round(params.concentrationWindow ?? 30)),
		concentrationRank: Math.max(0, Math.min(100, Number(params.concentrationRank ?? 10))) };
}

export const volume_concentration_dealer_cycle_start: Strategy = {
	name: "Volume Concentration Dealer Cycle Start",
	description: "When volume std dev collapses to a percentile low, all participants have converged on a narrow participation band. When the next bar's volume explodes and price breaks the trailing range, a new dealer hedging cycle has initiated. Enter in the breakout direction.",
	defaultParams: {
		concentrationWindow: 30,
		concentrationRank: 10 },
	paramLabels: {
		concentrationWindow: "Concentration Window",
		concentrationRank: "Concentration Rank Max" },
	normalizeParams: normalizeVolumeConcentrationDealerCycleStartParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeConcentrationDealerCycleStartParams(params);
		const window = p.concentrationWindow as number;
		const rankMax = p.concentrationRank as number;
		if (cleanData.length < window + 2) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const volStdDev = buildRollingStdDev(volumes, window);
		const volStdClean = volStdDev.map(v => v ?? 0);
		const rank = buildPercentileRank(volStdClean, window);
		const avgVol = buildRollingAverage(volumes, window);
		const volStdForExplosion = buildRollingStdDev(volumes, window);
		const { highest, lowest } = buildTrailingHighLow(cleanData, window);

		return createSignalLoop(cleanData, [rank, avgVol, highest, lowest], (i) => {
			if (i < window) return null;
			const priorRank = rank[i - 1];
			if (priorRank === null || priorRank >= rankMax / 100) return null;

			const avg = avgVol[i];
			const sd = volStdForExplosion[i];
			if (avg === null || sd === null || sd <= 0) return null;
			if (volumes[i] <= avg + 2 * sd) return null;

			const hi = highest[i];
			const lo = lowest[i];
			if (hi === null || lo === null) return null;

			if (closes[i] > hi) {
				return createBuySignal(cleanData, i, `Vol concentration breakout bullish (rank ${(priorRank * 100).toFixed(0)}%, vol explosion)`);
			}
			if (closes[i] < lo) {
				return createSellSignal(cleanData, i, `Vol concentration breakout bearish (rank ${(priorRank * 100).toFixed(0)}%, vol explosion)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["concentrationWindow", "concentrationRank"] } };
