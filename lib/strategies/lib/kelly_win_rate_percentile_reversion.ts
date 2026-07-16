import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	retPctByLookback: Map<number, (number | null)[]>;
	medianByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(15, Math.round(Number(params.lookback ?? 50))),
		minKellyFraction: Number(params.minKellyFraction ?? 0.2),
	};
}

export const kelly_win_rate_percentile_reversion: Strategy = {
	name: "Kelly Win Rate Percentile Reversion",
	description: "Directly links entry permission to rolling empirical Kelly calculations of past return percentile crossings returning to the median.",
	defaultParams: {
		lookback: 50,
		minKellyFraction: 0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyFraction: "Min Kelly Fraction",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		retPctByLookback: new Map<number, (number | null)[]>(),
		medianByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minKellyFraction = p.minKellyFraction as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		const len = cleanData.length;
		if (len < lookback + 12) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const retPctByLookback = prepared?.retPctByLookback ?? new Map<number, (number | null)[]>();
		let retPct = retPctByLookback.get(lookback);
		if (!retPct) {
			retPct = buildPercentileRank(returns, lookback);
			retPctByLookback.set(lookback, retPct);
		}

		const medianByLookback = prepared?.medianByLookback ?? new Map<number, (number | null)[]>();
		let median = medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(closes, lookback);
			medianByLookback.set(lookback, median);
		}

		// Precalculate extreme states and their success flags (price crossing median within next 10 bars)
		// 1: downside extreme (retPct < 0.1), 2: upside extreme (retPct > 0.9)
		const isExtreme = new Uint8Array(len);
		const isSuccess = new Uint8Array(len);
		for (let j = 0; j < len; j++) {
			const rp = retPct[j];
			if (rp === null) continue;
			if (rp < 0.1) {
				isExtreme[j] = 1;
				// Check success (returns to median) in next 10 bars
				const endK = Math.min(j + 10, len - 1);
				for (let k = j + 1; k <= endK; k++) {
					const m = median[k];
					if (m !== null && closes[k] >= m) {
						isSuccess[j] = 1;
						break;
					}
				}
			} else if (rp > 0.9) {
				isExtreme[j] = 2;
				// Check success in next 10 bars
				const endK = Math.min(j + 10, len - 1);
				for (let k = j + 1; k <= endK; k++) {
					const m = median[k];
					if (m !== null && closes[k] <= m) {
						isSuccess[j] = 1;
						break;
					}
				}
			}
		}

		return createSignalLoop(cleanData, [retPct], (i) => {
			if (i < lookback + 10) return null;

			const rp = retPct[i];
			if (rp === null) return null;

			// Tally the last 20 resolved extreme events (which must have occurred at or before i - 10)
			let countEvents = 0;
			let countSuccesses = 0;
			for (let j = i - 10; j >= 0; j--) {
				if (isExtreme[j] > 0) {
					countEvents++;
					if (isSuccess[j] === 1) {
						countSuccesses++;
					}
					if (countEvents === 20) break;
				}
			}

			const winRate = countEvents > 0 ? countSuccesses / countEvents : 0.5;
			const kelly = 2 * winRate - 1;

			if (kelly > minKellyFraction) {
				// Buy: close return is below 10th percentile
				if (rp < 0.1) {
					return createBuySignal(cleanData, i, `Empirical Kelly buy: return Pct ${rp.toFixed(2)}, winRate ${winRate.toFixed(2)} from last ${countEvents} events, Kelly ${kelly.toFixed(2)} > ${minKellyFraction}`);
				}
				// Sell: close return is above 90th percentile
				if (rp > 0.9) {
					return createSellSignal(cleanData, i, `Empirical Kelly sell: return Pct ${rp.toFixed(2)}, winRate ${winRate.toFixed(2)} from last ${countEvents} events, Kelly ${kelly.toFixed(2)} > ${minKellyFraction}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_win_rate_percentile_reversion.executePrepared!(
			kelly_win_rate_percentile_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyFraction"],
	},
};
