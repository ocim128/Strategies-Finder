import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
    data: OHLCVData[];
    returns: number[];
    ranks: Map<string, (number | null)[]>;
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return { data: cleanData, returns: buildRateOfChange(getCloses(cleanData), 1).map(v => v ?? 0), ranks: new Map() };
}

/** Only the lowest rank and a UNIQUE highest rank can pass an extreme
 * threshold. Monotone queues find those in O(bars), without sorted-window
 * insertion/removal on every bar. Interior ranks are represented by 0.5;
 * callers must first prove that no interior rank can produce a signal.
 */
function buildExtremeRanks(values: number[], lookback: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    const minima = new Int32Array(values.length);
    const maxima = new Int32Array(values.length);
    let minHead = 0, minTail = 0, maxHead = 0, maxTail = 0, finiteCount = 0;
    for (let i = 0; i < values.length; i++) {
        if (i >= lookback && Number.isFinite(values[i - lookback])) finiteCount--;
        while (minHead < minTail && minima[minHead] <= i - lookback) minHead++;
        while (maxHead < maxTail && maxima[maxHead] <= i - lookback) maxHead++;
        const value = values[i];
        if (!Number.isFinite(value)) continue;
        finiteCount++;
        while (minHead < minTail && values[minima[minTail - 1]] > value) minTail--;
        while (maxHead < maxTail && values[maxima[maxTail - 1]] < value) maxTail--;
        minima[minTail++] = i;
        maxima[maxTail++] = i;
        if (i < lookback - 1 || finiteCount < 2) continue;
        result[i] = value === values[minima[minHead]] ? 0 : maxima[maxHead] === i ? 1 : 0.5;
    }
    return result;
}

function executePrepared(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = preparedData as PreparedData | undefined;
    const preparedWindow = prepared?.ranks instanceof Map && prepared.data === data ? prepared : prepareData(data);
    const cleanData = preparedWindow.data;
    const p = normalizeParams(params);
    const lookback = p.lookback as number;
    if (cleanData.length < lookback) return [];
    // Use the actual floating-point rank comparisons, including at thresholds
    // exactly on a rank boundary. Ties always have their lower-bound rank.
    const extremesOnly = Number.isFinite(lookback)
        && 1 / (lookback - 1) >= 1 - p.pctlExtreme
        && (lookback - 2) / (lookback - 1) <= p.pctlExtreme;
    const key = `${lookback}|${extremesOnly}`;
    let pctRank = preparedWindow.ranks.get(key);
    if (!pctRank) {
        const rollingSum = new Array<number>(cleanData.length).fill(0);
        let currentSum = 0;
        for (let i = 0; i < cleanData.length; i++) {
            currentSum += preparedWindow.returns[i];
            if (i >= lookback) currentSum -= preparedWindow.returns[i - lookback];
            rollingSum[i] = currentSum;
        }
        pctRank = extremesOnly ? buildExtremeRanks(rollingSum, lookback) : buildPercentileRank(rollingSum, lookback);
        // Bound retained features during broad sweeps; payload lifetime belongs
        // to the Finder window and never retains another dataset.
        if (preparedWindow.ranks.size >= 4) preparedWindow.ranks.delete(preparedWindow.ranks.keys().next().value!);
        preparedWindow.ranks.set(key, pctRank);
    }
    return createSignalLoop(cleanData, [pctRank], (i) => {
        const pr = pctRank[i];
        if (pr === null) return null;
        if (pr < 1 - p.pctlExtreme) {
            return createBuySignal(cleanData, i, `Cumulative return percentile buy: pct ${pr.toFixed(2)}`);
        }
        if (pr > p.pctlExtreme) {
            return createSellSignal(cleanData, i, `Cumulative return percentile sell: pct ${pr.toFixed(2)}`);
        }
        return null;
    });
}

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 87))),
        pctlExtreme: Math.max(0.5, Math.min(0.999, Number(params.pctlExtreme ?? 0.999))),
    };
}

export const cumulative_return_percentile_reversion: Strategy = {
    name: "Cumulative Return Percentile Reversion",
    description: "Fades cumulative return over lookback when it sits at a percentile extreme of its own history.",
    defaultParams: {
        lookback: 87,
        pctlExtreme: 0.999,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
    },
    normalizeParams,
    prepareFinderData: prepareData,
    executePrepared: executePrepared,
    execute: (data: OHLCVData[], params: StrategyParams) => executePrepared(undefined, params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
