import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingStdDev } from "./price-action-statistics-core";
import { buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeCloseClusteringBreakoutParams(params: StrategyParams): StrategyParams {
	const clusterLookback = Math.max(5, Math.round(params.clusterLookback ?? 10));
	const clusterFactor = Math.min(0.6, Math.max(0.1, Number(params.clusterFactor ?? 0.3)));
	return { ...params, clusterLookback, clusterFactor };
}

export const close_clustering_breakout: Strategy = {
	name: "Close Clustering Breakout",
	description:
		"When the rolling standard deviation of closes drops extremely low, prices are clustering tightly around a narrow level. This close-clustering indicates temporary equilibrium storing energy. When a bar's range expands beyond the cluster's range, the equilibrium breaks and a directional move follows.",
	defaultParams: { clusterLookback: 10, clusterFactor: 0.3 },
	paramLabels: { clusterLookback: "Cluster Lookback", clusterFactor: "Cluster Factor" },
	normalizeParams: normalizeCloseClusteringBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeCloseClusteringBreakoutParams(params);
		if (cleanData.length < np.clusterLookback + 2) return [];
		const closes = getCloses(cleanData);
		const ranges = buildRangeSeries(cleanData);
		const closeStdDev = buildRollingStdDev(closes, np.clusterLookback);
		const avgRange = buildRollingAverage(ranges, np.clusterLookback);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = np.clusterLookback; i < cleanData.length; i++) {
			const sd = closeStdDev[i];
			const ar = avgRange[i];
			if (sd === null || ar === null || ar === 0) continue;
			if (sd >= np.clusterFactor * ar) continue;
			let maxClose = -Infinity;
			let minClose = Infinity;
			for (let j = i - np.clusterLookback + 1; j <= i; j++) {
				if (closes[j] > maxClose) maxClose = closes[j];
				if (closes[j] < minClose) minClose = closes[j];
			}
			if (closes[i] > maxClose)
				signals.push(createBuySignal(cleanData, i, `Close cluster breakout above ${maxClose.toFixed(2)}, stddev ${sd.toFixed(4)}`));
			else if (closes[i] < minClose)
				signals.push(createSellSignal(cleanData, i, `Close cluster breakout below ${minClose.toFixed(2)}, stddev ${sd.toFixed(4)}`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["clusterLookback", "clusterFactor"] } };
