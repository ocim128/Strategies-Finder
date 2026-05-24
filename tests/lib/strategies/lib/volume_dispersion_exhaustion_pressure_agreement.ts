import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingStdDev, buildRollingMedian } from "./price-action-statistics-core";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming volume standard deviation depletion signals passive absorption
// #SUGGEST_VERIFY: Verify that volume standard deviation compared to its rolling median * volStdDevMax is a valid exhaust trigger
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        volStdDevMax: Math.max(0.01, Math.min(2.0, Number(params.volStdDevMax ?? 0.15))),
    };
}

export const volume_dispersion_exhaustion_pressure_agreement: Strategy = {
    name: "Volume Dispersion Exhaustion with Pressure Agreement",
    description: "Fades boundary touches on Binance when volume dispersion is low (confirming passive absorption without active aggressive takers), gated by binary Polymarket pressure agreement.",
    defaultParams: {
        lookback: 30,
        volStdDevMax: 0.15,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volStdDevMax: "Volume StdDev Max",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const volStdDevMax = p.volStdDevMax as number;

        if (cleanData.length < lookback * 2) return [];

        const typical = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);

        const typicalMinMax = buildRollingMinMax(typical, lookback, false);
        const volStdDev = buildRollingStdDev(volumes, lookback);
        
        // Convert NullableSeries of volStdDev to number[] for buildRollingMedian
        const cleanVolStdDev = volStdDev.map((v) => v ?? 0);
        const volStdDevMedian = buildRollingMedian(cleanVolStdDev, lookback);

        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMinMax.min, typicalMinMax.max, volStdDev, volStdDevMedian],
            (i) => {
                if (i < lookback * 2) return null;

                const currentTypical = typical[i];
                const tMin = typicalMinMax.min[i];
                const tMax = typicalMinMax.max[i];
                const currentVolStdDev = volStdDev[i];
                const medianVolStdDev = volStdDevMedian[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (tMin === null || tMax === null || currentVolStdDev === null || medianVolStdDev === null) return null;

                // Volume Dispersion Exhaustion check
                if (currentVolStdDev >= medianVolStdDev * volStdDevMax) return null;

                // Typical price touches or breaches boundaries
                const touchesFloor = currentTypical <= tMin;
                const touchesCeiling = currentTypical >= tMax;

                // Buy YES: typical touches floor, volume stddev exhausted, longAllowed is true
                if (touchesFloor && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Vol dispersion floor YES: typical ${currentTypical.toFixed(2)} <= min ${tMin.toFixed(2)}, volStdDev ${currentVolStdDev.toFixed(2)} < median ${medianVolStdDev.toFixed(2)} * ${volStdDevMax}`
                    );
                }

                // Buy NO (expressed as Sell signal): typical touches ceiling, volume stddev exhausted, shortAllowed is true
                if (touchesCeiling && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Vol dispersion ceiling NO: typical ${currentTypical.toFixed(2)} >= max ${tMax.toFixed(2)}, volStdDev ${currentVolStdDev.toFixed(2)} < median ${medianVolStdDev.toFixed(2)} * ${volStdDevMax}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volStdDevMax"],
    },
};
