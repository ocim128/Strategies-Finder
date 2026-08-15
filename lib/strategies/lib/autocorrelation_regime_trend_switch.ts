import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

const ZERO_AC_CROSS = 0;

function normalizeAutocorrelationRegimeTrendSwitchParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const autocorrelation_regime_trend_switch: Strategy = {
    name: "Autocorrelation Regime Trend Switch",
    description: "Enters when the rolling lag-1 autocorrelation of one-bar close returns flips across zero, sided by the net move over the same lookback.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeAutocorrelationRegimeTrendSwitchParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeAutocorrelationRegimeTrendSwitchParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        // buildRollingAutoCorrelation emits NaN for windows with non-finite
        // members; the signal loop only treats null as missing, so normalize.
        const autocorr = buildRollingAutoCorrelation(returns, lookback, 1).map((value) =>
            Number.isNaN(value) ? null : value
        );

        const netSum = new Array<number>(cleanData.length).fill(0);
        let acc = 0;
        for (let i = 0; i < cleanData.length; i++) {
            acc += returns[i];
            netSum[i] = acc;
        }

        return createSignalLoop(cleanData, [autocorr], (i) => {
            if (i < lookback) return null;
            const prev = autocorr[i - 1];
            const curr = autocorr[i];
            if (prev === null || curr === null) return null;
            const windowSum = netSum[i] - (i >= lookback ? netSum[i - lookback] : 0);

            if (prev <= ZERO_AC_CROSS && curr > ZERO_AC_CROSS && windowSum > 0) {
                return createBuySignal(cleanData, i, `Autocorrelation regime flip up (${curr.toFixed(3)}) with positive net move ${windowSum.toFixed(4)}`);
            }
            if (prev >= ZERO_AC_CROSS && curr < ZERO_AC_CROSS && windowSum < 0) {
                return createSellSignal(cleanData, i, `Autocorrelation regime flip down (${curr.toFixed(3)}) with negative net move ${windowSum.toFixed(4)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
