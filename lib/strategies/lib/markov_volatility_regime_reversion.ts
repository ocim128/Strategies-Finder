import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	stddevReturnsByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
		transitionThreshold: Math.max(0.01, Math.min(1, Number(params.transitionThreshold ?? 0.6))),
	};
}

export const markov_volatility_regime_reversion: Strategy = {
	name: "Markov Volatility Regime Reversion",
	description: "Executes mean reversion trades when Markov volatility transition indicates high probability of moving from Expanded back to Compressed.",
	defaultParams: {
		lookback: 50,
		transitionThreshold: 0.6,
	},
	paramLabels: {
		lookback: "Lookback Window",
		transitionThreshold: "Transition Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		stddevReturnsByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const transitionThreshold = p.transitionThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const stddevReturnsByLookback = prepared?.stddevReturnsByLookback ?? new Map<number, (number | null)[]>();
		let stddev = stddevReturnsByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(returns, lookback);
			stddevReturnsByLookback.set(lookback, stddev);
		}

		const cleanStddev = stddev.map((v) => v ?? 0);
		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(cleanStddev, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		// Discretize states: 1: Expanded (volPct > 0.5), 0: Compressed (volPct <= 0.5)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const vp = volPct[j];
			states[j] = (vp !== null && vp > 0.5) ? 1 : 0;
		}

		return createSignalLoop(cleanData, [zscore, volPct], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Compute P(Expanded -> Compressed), i.e., P(1 -> 0)
			const start = i - lookback + 1;
			const end = i - 1;

			let countExpanded = 0;
			let countExpandedToCompressed = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 1) {
					countExpanded++;
					if (states[j + 1] === 0) {
						countExpandedToCompressed++;
					}
				}
			}

			const prob = countExpanded > 0 ? countExpandedToCompressed / countExpanded : 0;

			// Buy: close z-score < -1.8, transition probability > transitionThreshold
			if (z < -1.8 && prob > transitionThreshold) {
				return createBuySignal(cleanData, i, `Volatility transition Exp->Comp prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			// Sell: close z-score > 1.8, transition probability > transitionThreshold
			if (z > 1.8 && prob > transitionThreshold) {
				return createSellSignal(cleanData, i, `Volatility transition Exp->Comp prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_volatility_regime_reversion.executePrepared!(
			markov_volatility_regime_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "transitionThreshold"],
	},
};
