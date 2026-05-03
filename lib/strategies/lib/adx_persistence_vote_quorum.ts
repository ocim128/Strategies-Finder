import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateADX } from "../indicators";
import { buildStreakCount } from "./price-action-statistics-core";

function buildDirectionalIndexStreakFlags(highs: number[], lows: number[], closes: number[], period: number): number[] {
    const flags: number[] = new Array(closes.length).fill(0);
    const tr: number[] = new Array(closes.length).fill(0);
    const plusDM: number[] = new Array(closes.length).fill(0);
    const minusDM: number[] = new Array(closes.length).fill(0);

    for (let i = 1; i < closes.length; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
        tr[i] = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        );
    }

    let trSmooth = 0;
    let plusSmooth = 0;
    let minusSmooth = 0;
    for (let i = 1; i <= period && i < closes.length; i++) {
        trSmooth += tr[i];
        plusSmooth += plusDM[i];
        minusSmooth += minusDM[i];
    }

    for (let i = period; i < closes.length; i++) {
        if (i > period) {
            trSmooth = trSmooth - trSmooth / period + tr[i];
            plusSmooth = plusSmooth - plusSmooth / period + plusDM[i];
            minusSmooth = minusSmooth - minusSmooth / period + minusDM[i];
        }

        if (trSmooth <= 0) continue;
        const plusDI = 100 * (plusSmooth / trSmooth);
        const minusDI = 100 * (minusSmooth / trSmooth);
        if (plusDI > minusDI) {
            flags[i] = 1;
        } else if (minusDI > plusDI) {
            flags[i] = -1;
        }
    }

    return flags;
}

function normalizeAdxPersistenceVoteQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 14))),
        min_days: Math.max(1, Math.round(Number(params.min_days ?? 3))),
    };
}

export const adx_persistence_vote_quorum: Strategy = {
    name: "ADX Persistence Vote Quorum",
    description:
        "Combines ADX trend-strength thresholding with a persistent DI alignment streak before taking directional entries.",
    defaultParams: {
        lookback: 14,
        min_days: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        min_days: "Minimum Days",
    },
    normalizeParams: normalizeAdxPersistenceVoteQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAdxPersistenceVoteQuorumParams(params);
        const lookback = p.lookback as number;
        const minDays = p.min_days as number;
        if (cleanData.length < lookback * 2 + minDays) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const adx = calculateADX(highs, lows, closes, lookback);
        const diFlags = buildDirectionalIndexStreakFlags(highs, lows, closes, lookback);
        const diStreaks = buildStreakCount(diFlags);

        return createSignalLoop(cleanData, [adx], (i) => {
            const trendStrength = adx[i];
            if (trendStrength === null || trendStrength <= 25) return null;

            if (diStreaks[i] >= minDays) {
                return createBuySignal(cleanData, i, `ADX ${trendStrength.toFixed(1)} with DI+ streak ${diStreaks[i]}`);
            }
            if (diStreaks[i] <= -minDays) {
                return createSellSignal(cleanData, i, `ADX ${trendStrength.toFixed(1)} with DI- streak ${Math.abs(diStreaks[i])}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "min_days"],
    },
};
