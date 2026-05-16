import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData } from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank, buildEfficiencyRatio, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeVelocityPercentilePhiSnapParams(params: StrategyParams): StrategyParams {
	const velocityWindow = Math.max(1, Math.round(params.velocityWindow ?? 5));
	const erLookback = Math.max(3, Math.round(params.erLookback ?? 13));
	const phiInefficiency = Math.max(0.01, Math.min(0.99, Number(params.phiInefficiency ?? 0.382)));
	return { ...params, velocityWindow, erLookback, phiInefficiency };
}

export const velocity_percentile_phi_snap: Strategy = {
	name: "Velocity Percentile Phi Snap",
	description:
		"Identifies synthetic hyper-speed where absolute velocity is at the 99th percentile but path efficiency has collapsed below 0.382, fading the ghost thrust.",
	defaultParams: { velocityWindow: 5, erLookback: 13, phiInefficiency: 0.382 },
	paramLabels: { velocityWindow: "Velocity Window", erLookback: "ER Lookback", phiInefficiency: "Phi Inefficiency" },
	normalizeParams: normalizeVelocityPercentilePhiSnapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeVelocityPercentilePhiSnapParams(params);
		const minBars = Math.max(np.velocityWindow, np.erLookback) + 20;
		if (cleanData.length < minBars) return [];

		const closes = cleanData.map((d) => d.close);
		const roc = buildRateOfChange(closes, np.velocityWindow);
		const rocFilled = roc.map((v) => v ?? 0);
		const negRoc = rocFilled.map((v) => -v);
		const rankLookback = np.erLookback + np.velocityWindow;
		const rocRank = buildPercentileRank(rocFilled, rankLookback);
		const negRank = buildPercentileRank(negRoc, rankLookback);
		const er = buildEfficiencyRatio(cleanData, np.erLookback);
		const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");

		const signals = [];
		for (let i = minBars; i < cleanData.length; i++) {
			const rank = rocRank[i];
			const nr = negRank[i];
			const erVal = er[i];
			if (erVal === null) continue;

			if (rank !== null && rank > 0.99 && erVal < np.phiInefficiency && bodyDirection[i] === 1) {
				signals.push(createBuySignal(cleanData, i, `Velocity 99th pctile with ER < ${np.phiInefficiency} & bullish body`));
			}
			if (nr !== null && nr > 0.99 && erVal < np.phiInefficiency && bodyDirection[i] === -1) {
				signals.push(createSellSignal(cleanData, i, `Velocity 99th pctile with ER < ${np.phiInefficiency} & bearish body`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["velocityWindow", "erLookback", "phiInefficiency"] } };





