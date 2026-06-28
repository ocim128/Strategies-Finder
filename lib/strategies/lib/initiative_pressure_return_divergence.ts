import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeInitiativePressureReturnDivergenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        correlationMax: Math.max(-1, Math.min(1, Number(params.correlationMax ?? -0.20))),
    };
}

export const initiative_pressure_return_divergence: Strategy = {
    name: "Initiative Pressure Return Divergence",
    description: "Initiative pressure vs price return divergence as flow signal.",
    defaultParams: {
        lookback: 25,
        correlationMax: -0.20,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMax: "Correlation Max",
    },
    normalizeParams: normalizeInitiativePressureReturnDivergenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureReturnDivergenceParams(params);
        const lookback = p.lookback as number;
        const correlationMax = p.correlationMax as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const cleanPressure = pressure.map(pr => pr ?? 0);
        const pressureReturnCorr = buildRollingCorrelation(cleanPressure, cleanReturns, lookback);

        return createSignalLoop(cleanData, [pressureReturnCorr, returns], (i) => {
            const corr = pressureReturnCorr[i];
            const ret = returns[i];
            const pr = pressure[i];
            if (corr === null || ret === null || pr === null) return null;

            if (corr < correlationMax) {
                if (pr > 0 && ret < 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Divergence buy: correlation ${corr.toFixed(2)}, pressure ${pr.toFixed(2)}`
                    );
                }
                if (pr < 0 && ret > 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Divergence sell: correlation ${corr.toFixed(2)}, pressure ${pr.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMax"],
    },
};
