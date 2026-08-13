import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import {
    buildRollingCorrelation,
    buildRollingStdDev,
} from "./price-action-statistics-core";

const RESIDUAL_Z_FADE = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
    };
}

export const ar1_residual_reversion: Strategy = {
    name: "AR(1) Residual Reversion",
    description: "Fades closes that deviate at least 1.5 residual standard deviations from their own trailing-window AR(1) forecast.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "AR Fit Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        // lagged[j] = closes[j-1]; the j = 0 pad is never inside a filled window (i >= lookback - 1).
        const lagged: number[] = new Array(cleanData.length).fill(0);
        for (let j = 1; j < cleanData.length; j++) {
            lagged[j] = closes[j - 1];
        }

        const r = buildRollingCorrelation(lagged, closes, lookback);
        const sdX = buildRollingStdDev(lagged, lookback);
        const sdY = buildRollingStdDev(closes, lookback);
        const meanX = buildRollingAverage(lagged, lookback);
        const meanY = buildRollingAverage(closes, lookback);

        // Dense residual (0 where the AR fit is not yet valid) so the rolling
        // std helper stays finite; the entry gate requires i >= lookback + 1.
        const residual: number[] = new Array(cleanData.length).fill(0);
        for (let i = lookback; i < cleanData.length; i++) {
            const c = r[i];
            const sx = sdX[i];
            const sy = sdY[i];
            const mx = meanX[i];
            const my = meanY[i];
            if (c === null || sx === null || sy === null || mx === null || my === null || sx <= 0) continue;
            const b = (c * sy) / sx;
            const a = my - b * mx;
            residual[i] = closes[i] - (a + b * closes[i - 1]);
        }
        const resStd = buildRollingStdDev(residual, lookback);

        return createSignalLoop(cleanData, [resStd], (i) => {
            if (i < lookback + 1) return null;
            const s = resStd[i];
            const c = r[i];
            const sx = sdX[i];
            const sy = sdY[i];
            const mx = meanX[i];
            const my = meanY[i];
            if (s === null || s <= 0 || c === null || sx === null || sy === null || mx === null || my === null || sx <= 0) {
                return null;
            }
            const b = (c * sy) / sx;
            const a = my - b * mx;
            // Floor the residual scale at a tiny price-relative epsilon so
            // float-noise residuals on near-perfectly-fitted windows cannot
            // produce arbitrary z-scores from division by a degenerate scale.
            const scale = Math.max(s, 1e-9 * Math.abs(closes[i]));
            const z = (closes[i] - (a + b * closes[i - 1])) / scale;
            if (z <= -RESIDUAL_Z_FADE) {
                return createBuySignal(cleanData, i, `AR(1) residual ${z.toFixed(2)} std below forecast`);
            }
            if (z >= RESIDUAL_Z_FADE) {
                return createSellSignal(cleanData, i, `AR(1) residual ${z.toFixed(2)} std above forecast`);
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
