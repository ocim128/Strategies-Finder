import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

export const candle_return_rate_mean_reversion: Strategy = {
    name: "Candle Return Rate Mean Reversion",
    description: "Trades overextensions in N-bar cumulative close returns relative to rolling median behavior.",
    defaultParams: {
        windowN: 20,
        thresholdPct: 1.5,
    },
    paramLabels: {
        windowN: "Return Window (N)",
        thresholdPct: "Deviation Threshold (%)",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 50) return [];

        const windowN = Math.max(5, Math.round(params.windowN ?? 20));
        const thresholdPct = Math.max(0.1, params.thresholdPct ?? 1.5);

        const closes = getCloses(cleanData);
        const signals: Signal[] = [];
        const cumulativeReturns: Array<number | null> = new Array(cleanData.length).fill(null);

        for (let i = windowN; i < cleanData.length; i++) {
            const base = closes[i - windowN];
            if (base === 0) continue;
            cumulativeReturns[i] = ((closes[i] - base) / base) * 100;
        }

        for (let i = windowN * 2; i < cleanData.length; i++) {
            const current = cumulativeReturns[i];
            if (current === null) continue;

            const history: number[] = [];
            for (let j = i - windowN; j < i; j++) {
                const sample = cumulativeReturns[j];
                if (sample !== null) history.push(sample);
            }
            if (history.length < Math.ceil(windowN * 0.6)) continue;

            const baseline = median(history);
            const deviation = current - baseline;

            if (deviation > thresholdPct) {
                signals.push(createSellSignal(cleanData, i, "CRR overextension short fade"));
            } else if (deviation < -thresholdPct) {
                signals.push(createBuySignal(cleanData, i, "CRR overextension long fade"));
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["windowN", "thresholdPct"],
    },
};

