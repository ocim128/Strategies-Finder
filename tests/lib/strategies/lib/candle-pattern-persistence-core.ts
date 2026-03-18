import { OHLCVData } from "../../types/strategies";
import { ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";

export interface CandlePatternPersistenceState {
    cleanData: OHLCVData[];
    highs: number[];
    lows: number[];
    closes: number[];
    avgScore: (number | null)[];
    avgBodyPct: (number | null)[];
}

// Keep compatibility with CPPS behavior while hiding this setting in variant UIs.
export const CPPS_MIN_BODY_PCT_HARDCODED = 0;

export function computeCandlePatternPersistenceState(
    data: OHLCVData[],
    scoreLookbackInput: number
): CandlePatternPersistenceState {
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);

    const scoreLookback = Math.max(2, Math.round(scoreLookbackInput));

    const bodyScore: (number | null)[] = new Array(cleanData.length).fill(null);
    const bodyPct: (number | null)[] = new Array(cleanData.length).fill(null);

    for (let i = 0; i < cleanData.length; i++) {
        const range = highs[i] - lows[i];
        if (range <= 0) continue;

        const signedBody = cleanData[i].close - cleanData[i].open;
        const absBody = Math.abs(signedBody);

        bodyScore[i] = Math.max(-1, Math.min(1, signedBody / range));
        bodyPct[i] = Math.max(0, Math.min(1, absBody / range));
    }

    const avgScore: (number | null)[] = new Array(cleanData.length).fill(null);
    const avgBodyPct: (number | null)[] = new Array(cleanData.length).fill(null);

    for (let i = 0; i < cleanData.length; i++) {
        if (i < scoreLookback - 1) continue;

        let scoreSum = 0;
        let bodySum = 0;
        let count = 0;

        for (let j = i - scoreLookback + 1; j <= i; j++) {
            const s = bodyScore[j];
            const b = bodyPct[j];
            if (s === null || b === null) continue;
            scoreSum += s;
            bodySum += b;
            count++;
        }

        if (count < scoreLookback) continue;
        avgScore[i] = scoreSum / count;
        avgBodyPct[i] = bodySum / count;
    }

    return {
        cleanData,
        highs,
        lows,
        closes,
        avgScore,
        avgBodyPct,
    };
}

export function calculateCCI(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
): (number | null)[] {
    const length = closes.length;
    const result: (number | null)[] = new Array(length).fill(null);
    if (length === 0) return result;

    const p = Math.max(1, Math.round(period));
    const tp: number[] = new Array(length);

    for (let i = 0; i < length; i++) {
        tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
    }

    let tpSum = 0;
    for (let i = 0; i < length; i++) {
        tpSum += tp[i];
        if (i >= p) {
            tpSum -= tp[i - p];
        }

        if (i < p - 1) continue;

        const sma = tpSum / p;
        let meanDeviationSum = 0;
        for (let j = i - p + 1; j <= i; j++) {
            meanDeviationSum += Math.abs(tp[j] - sma);
        }

        const meanDeviation = meanDeviationSum / p;
        if (meanDeviation === 0) {
            result[i] = 0;
            continue;
        }

        result[i] = (tp[i] - sma) / (0.015 * meanDeviation);
    }

    return result;
}
