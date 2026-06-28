import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeCloseAcceptanceInitiativeAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        alignmentStrength: Math.max(0, Number(params.alignmentStrength ?? 0.30)),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const close_acceptance_initiative_alignment: Strategy = {
    name: "Close Acceptance Initiative Alignment",
    description: "Close acceptance aligned with initiative pressure as confirmed flow.",
    defaultParams: {
        lookback: 25,
        alignmentStrength: 0.30,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        alignmentStrength: "Alignment Strength",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeCloseAcceptanceInitiativeAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceInitiativeAlignmentParams(params);
        const lookback = p.lookback as number;
        const alignmentStrength = p.alignmentStrength as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const cleanPressure = pressure.map(pr => pr ?? 0);

        const alignment: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const acc = closeAcceptance[i];
            const pr = cleanPressure[i];
            const signAcc = acc > 0 ? 1 : (acc < 0 ? -1 : 0);
            const signPr = pr > 0 ? 1 : (pr < 0 ? -1 : 0);
            alignment[i] = signAcc === signPr ? signAcc : 0;
        }

        const smoothedAlignment = buildRollingAverage(alignment, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [smoothedAlignment, volumePercentile], (i) => {
            const align = smoothedAlignment[i];
            const volPct = volumePercentile[i];
            if (align === null || volPct === null) return null;

            if (volPct > volumePercentileMin) {
                if (align > alignmentStrength) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Close acceptance and initiative pressure aligned bullishly at ${align.toFixed(2)}`
                    );
                }
                if (align < -alignmentStrength) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Close acceptance and initiative pressure aligned bearishly at ${align.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "alignmentStrength", "volumePercentileMin"],
    },
};
