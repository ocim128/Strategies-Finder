import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { dynamic_vix_regime } from './dynamic-vix-regime';

const LOCKED_STRUCTURE: StrategyParams = {
    volWindow: 21,
    volLookback: 126,
    fastPeriod: 50,
    slowPeriod: 200,
};

const LOCKED_BEHAVIOR: StrategyParams = {
    useSpikeRegime: 1,
    useRecoveryRegime: 1,
    useLowVolDeRisk: 1,
    useMlOverlay: 1,
    adaptiveLookbacks: 0,
    adaptiveStrengthPct: 0,
    minAdaptiveFactor: 1,
    maxAdaptiveFactor: 1,
    spikePercentilePct: 80,
    calmPercentilePct: 25,
    oversoldRetPct: 3,
    extensionPct: 5,
    mlBullThresholdPct: 60,
    exitConfirmBars: 2,
    cooldownBars: 6,
};

function normalizeThresholds(params: StrategyParams): StrategyParams {
    const entryExposurePct = Math.max(50, Math.min(95, Number(params.entryExposurePct ?? 66)));
    const exitExposureRaw = Math.max(5, Math.min(70, Number(params.exitExposurePct ?? 38)));
    const exitExposurePct = Math.min(exitExposureRaw, entryExposurePct - 0.05);
    const minHoldBars = Math.max(1, Math.round(Number(params.minHoldBars ?? 10)));
    const entryConfirmBars = Math.max(1, Math.round(Number(params.entryConfirmBars ?? 2)));
    return {
        entryExposurePct,
        exitExposurePct,
        minHoldBars,
        entryConfirmBars,
    };
}

export const dynamic_vix_regime_iron_core: Strategy = {
    name: 'Dynamic VIX Regime Iron Core',
    description: 'Dynamic VIX with fixed market-frequency structure (21/126/50/200) and threshold-only evolution to reduce dimensional overfit.',
    defaultParams: {
        entryExposurePct: 66,
        exitExposurePct: 38,
        minHoldBars: 10,
        entryConfirmBars: 2,
    },
    paramLabels: {
        entryExposurePct: 'Entry Exposure Threshold (%)',
        exitExposurePct: 'Exit Exposure Threshold (%)',
        minHoldBars: 'Min Hold Bars',
        entryConfirmBars: 'Entry Confirm Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const thresholdParams = normalizeThresholds(params);
        const merged: StrategyParams = {
            ...LOCKED_STRUCTURE,
            ...LOCKED_BEHAVIOR,
            ...thresholdParams,
        };
        return dynamic_vix_regime.execute(data, merged);
    },
    metadata: {
        direction: 'long',
        walkForwardParams: [
            'entryExposurePct',
            'exitExposurePct',
            'minHoldBars',
            'entryConfirmBars',
        ],
    },
};
