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

function buildRollingSkewness(series: number[], window: number): number[] {
    const result = new Array(series.length).fill(0);
    if (window < 3) return result;
    
    for (let i = window - 1; i < series.length; i++) {
        let sum = 0;
        for (let j = 0; j < window; j++) sum += series[i - j];
        const mean = sum / window;
        
        let m2 = 0;
        for (let j = 0; j < window; j++) m2 += Math.pow(series[i - j] - mean, 2);
        const variance = m2 / window;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev === 0) {
            result[i] = 0;
            continue;
        }
        
        let m3 = 0;
        for (let j = 0; j < window; j++) m3 += Math.pow(series[i - j] - mean, 3);
        m3 = m3 / window;
        
        result[i] = m3 / Math.pow(stdDev, 3);
    }
    return result;
}

function buildRollingEntropy(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window - 1; i < series.length; i++) {
        const slice = series.slice(i - window + 1, i + 1);
        const min = Math.min(...slice);
        const max = Math.max(...slice);
        if (max === min) {
            res[i] = 0;
            continue;
        }
        const bins = 10;
        const counts = new Array(bins).fill(0);
        for (let v of slice) {
            let bin = Math.floor(((v - min) / (max - min)) * bins);
            if (bin === bins) bin--;
            counts[bin]++;
        }
        let entropy = 0;
        for (let c of counts) {
            if (c > 0) {
                const p = c / window;
                entropy -= p * Math.log2(p);
            }
        }
        res[i] = entropy;
    }
    return res;
}

function buildRollingMedian(series: number[], window: number): number[] {
    const res = new Array(series.length).fill(0);
    for (let i = window - 1; i < series.length; i++) {
        const slice = series.slice(i - window + 1, i + 1).sort((a,b)=>a-b);
        res[i] = slice[Math.floor(window / 2)];
    }
    return res;
}

export const skew_entropy_polarization_entry: Strategy = {
    name: "Skew Entropy Polarization Entry",
    description: "A directional regime can appear in the shape of returns before simple trend filters react. This enters when returns are ordered and asymmetrically biased.",
    defaultParams: {
        lookback: 30,
        entropyCeiling: 1,
        skewThreshold: 0.35,
    },
    paramLabels: {
        lookback: "Regime Lookback",
        entropyCeiling: "Entropy Ceiling",
        skewThreshold: "Abs Skew Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const closes = getCloses(cleanData);
        
        const lookback = params.lookback as number;
        const entropyCeiling = params.entropyCeiling as number;
        const skewThreshold = params.skewThreshold as number;

        if (cleanData.length < lookback + 2) return [];

        const returns = buildReturns(closes);
        const skew = buildRollingSkewness(returns, lookback);
        const entropy = buildRollingEntropy(returns, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;
            
            if (entropy[i] <= entropyCeiling) {
                if (skew[i] > skewThreshold && closes[i] > median[i]) {
                    return createBuySignal(cleanData, i, "Skew Entropy Polar Long");
                }
                if (skew[i] < -skewThreshold && closes[i] < median[i]) {
                    return createSellSignal(cleanData, i, "Skew Entropy Polar Short");
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyCeiling", "skewThreshold"],
    },
};
