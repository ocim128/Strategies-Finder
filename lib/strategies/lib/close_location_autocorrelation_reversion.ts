import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	closeLocation: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	clAutocorrByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
		maxAutocorrelation: Number(params.maxAutocorrelation ?? -0.2),
	};
}

export const close_location_autocorrelation_reversion: Strategy = {
	name: "Close Location Autocorrelation Reversion",
	description: "Fades close location bounds when negative rolling autocorrelation of the close-location series is below maxAutocorrelation at price extremes.",
	defaultParams: {
		lookback: 20,
		maxAutocorrelation: -0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		maxAutocorrelation: "Max Autocorrelation",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		closeLocation: buildCloseLocationSeries(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		clAutocorrByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const maxAutocorrelation = p.maxAutocorrelation as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const clAutocorrByLookback = prepared?.clAutocorrByLookback ?? new Map<number, (number | null)[]>();
		let clAutocorr = clAutocorrByLookback.get(lookback);
		if (!clAutocorr) {
			clAutocorr = buildRollingAutoCorrelation(closeLocation, lookback, 1);
			clAutocorrByLookback.set(lookback, clAutocorr);
		}

		return createSignalLoop(cleanData, [zscore, clAutocorr], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			const ca = clAutocorr[i];
			if (z === null || ca === null) return null;

			const cl = closeLocation[i];

			// Buy: close z-score below -1.5, rolling autocorrelation less than maxAutocorrelation, current close location < 0.15
			if (z < -1.5 && ca < maxAutocorrelation && cl < 0.15) {
				return createBuySignal(cleanData, i, `CL Autocorr buy: Z ${z.toFixed(2)}, Autocorr ${ca.toFixed(2)}, CL ${cl.toFixed(2)}`);
			}
			// Sell: close z-score above 1.5, rolling autocorrelation less than maxAutocorrelation, current close location > 0.85
			if (z > 1.5 && ca < maxAutocorrelation && cl > 0.85) {
				return createSellSignal(cleanData, i, `CL Autocorr sell: Z ${z.toFixed(2)}, Autocorr ${ca.toFixed(2)}, CL ${cl.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		close_location_autocorrelation_reversion.executePrepared!(
			close_location_autocorrelation_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxAutocorrelation"],
	},
};
