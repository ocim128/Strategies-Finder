import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildPercentileRank, buildStreakCount, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
		volPercentileThreshold: Math.max(0, Math.min(1, Number(params.volPercentileThreshold ?? 0.7))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 3))),
	};
}

export const relative_volume_thrust_streak_reversion: Strategy = {
	name: "Relative Volume Thrust Streak Reversion",
	description: "Fades extreme close z-score deviations when volume thrust streak breaks.",
	defaultParams: {
		lookback: 20,
		volPercentileThreshold: 0.7,
		streakThreshold: 3,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volPercentileThreshold: "Vol Percentile Threshold",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volPercentileThreshold = p.volPercentileThreshold as number;
		const streakThreshold = p.streakThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < Math.max(lookback, streakThreshold + 2)) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);
		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(volumes, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		// Compute volume thrust streaks
		const flags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const vp = volPct[j];
			if (vp !== null && vp > volPercentileThreshold) {
				flags[j] = 1;
			}
		}
		const thrustStreaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [zscore, volPct], (i) => {
			if (i < Math.max(lookback, streakThreshold + 1)) return null;

			const z = zscore[i];
			const vp = volPct[i];
			if (z === null || vp === null) return null;

			// Buy: close z-score below -1.8, streak of high vol ended at i-1, current vol pct drops below 0.5
			if (z < -1.8 && thrustStreaks[i - 1] >= streakThreshold && vp < 0.5) {
				return createBuySignal(cleanData, i, `Z-Score extreme (${z.toFixed(2)}) with volume thrust streak of ${thrustStreaks[i - 1]} bars ending`);
			}
			// Sell: close z-score above 1.8, streak of high vol ended at i-1, current vol pct drops below 0.5
			if (z > 1.8 && thrustStreaks[i - 1] >= streakThreshold && vp < 0.5) {
				return createSellSignal(cleanData, i, `Z-Score extreme (${z.toFixed(2)}) with volume thrust streak of ${thrustStreaks[i - 1]} bars ending`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		relative_volume_thrust_streak_reversion.executePrepared!(
			relative_volume_thrust_streak_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volPercentileThreshold", "streakThreshold"],
	},
};
