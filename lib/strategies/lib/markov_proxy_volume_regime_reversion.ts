import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		inactiveStateStability: Math.max(0.01, Math.min(1, Number(params.inactiveStateStability ?? 0.65))),
	};
}

export const markov_proxy_volume_regime_reversion: Strategy = {
	name: "Markov Proxy Volume Regime Reversion",
	description: "Systematically fades low-liquidity moves when the low-liquidity volume regime is statistically stable.",
	defaultParams: {
		lookback: 30,
		inactiveStateStability: 0.65,
	},
	paramLabels: {
		lookback: "Lookback Window",
		inactiveStateStability: "Inactive Stability",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const inactiveStateStability = p.inactiveStateStability as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

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

		// Discretize states: 0: Inactive (volPct < 0.35), 1: Active (volPct >= 0.35)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const vp = volPct[j];
			states[j] = (vp !== null && vp < 0.35) ? 0 : 1;
		}

		return createSignalLoop(cleanData, [zscore, volPct], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			const currentState = states[i];

			// Compute P(Inactive -> Inactive), i.e., P(0 -> 0)
			const start = i - lookback + 1;
			const end = i - 1;

			let countInactive = 0;
			let countInactiveToInactive = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 0) {
					countInactive++;
					if (states[j + 1] === 0) {
						countInactiveToInactive++;
					}
				}
			}

			const prob = countInactive > 0 ? countInactiveToInactive / countInactive : 0;

			// Buy: close z-score < -1.6, current volume state is Inactive (0), probability > inactiveStateStability
			if (z < -1.6 && currentState === 0 && prob > inactiveStateStability) {
				return createBuySignal(cleanData, i, `Inactive volume stability prob ${prob.toFixed(2)} > ${inactiveStateStability}`);
			}
			// Sell: close z-score > 1.6, current volume state is Inactive (0), probability > inactiveStateStability
			if (z > 1.6 && currentState === 0 && prob > inactiveStateStability) {
				return createSellSignal(cleanData, i, `Inactive volume stability prob ${prob.toFixed(2)} > ${inactiveStateStability}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_proxy_volume_regime_reversion.executePrepared!(
			markov_proxy_volume_regime_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "inactiveStateStability"],
	},
};
