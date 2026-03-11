import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

function buildReturns(series: number[]): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = 1; i < series.length; i++) {
        const prior = series[i - 1];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

function buildRollingAutoCorrelation(series: number[], window: number, lag: number = 1): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window + lag - 1; i < series.length; i++) {
        let sumX = 0, sumY = 0;
        for (let j = 0; j < window; j++) {
            sumX += series[i - j];
            sumY += series[i - j - lag];
        }
        const meanX = sumX / window;
        const meanY = sumY / window;
        
        let num = 0, denX = 0, denY = 0;
        for (let j = 0; j < window; j++) {
            const x = series[i - j] - meanX;
            const y = series[i - j - lag] - meanY;
            num += x * y;
            denX += x * x;
            denY += y * y;
        }
        res[i] = (denX > 0 && denY > 0) ? num / Math.sqrt(denX * denY) : 0;
    }
    return res;
}

function buildRollingMinMaxSpan(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window - 1; i < series.length; i++) {
        let max = -Infinity;
        let min = Infinity;
        for (let j = 0; j < window; j++) {
            if (series[i - j] > max) max = series[i - j];
            if (series[i - j] < min) min = series[i - j];
        }
        res[i] = max - min;
    }
    return res;
}

function buildRateOfChange(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window; i < series.length; i++) {
        const prior = series[i - window];
        res[i] = prior !== 0 ? (series[i] - prior) / prior : 0;
    }
    return res;
}

export const autocorr_deadband_release: Strategy = {
    name: "Autocorrelation Deadband Release",
    description: "Waits for serial dependence to collapse into a tight near-zero deadband, then trades only when rate-of-change breaks out decisively.",
    defaultParams: {
        lookback: 18,
        deadbandWidth: 0.18,
        rocTrigger: 0.012,
    },
    paramLabels: {
        lookback: "Deadband Window",
        deadbandWidth: "Max Band Width",
        rocTrigger: "ROC Trigger (abs)",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const closes = getCloses(cleanData);
        
        const lookback = params.lookback as number;
        const deadbandWidth = params.deadbandWidth as number;
        const rocTrigger = params.rocTrigger as number;

        if (cleanData.length < lookback + lookback + 1) return [];

        const returns = buildReturns(closes);
        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);
        const acBandWidth = buildRollingMinMaxSpan(autoCorr, lookback);
        const roc = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + lookback) return null;
            
            if (acBandWidth[i - 1] <= deadbandWidth) {
                if (roc[i] > rocTrigger) {
                    return createBuySignal(cleanData, i, "Deadband Release Long");
                }
                if (roc[i] < -rocTrigger) {
                    return createSellSignal(cleanData, i, "Deadband Release Short");
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "deadbandWidth", "rocTrigger"],
    },
};
