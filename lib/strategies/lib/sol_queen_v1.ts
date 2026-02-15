import type { BacktestSettings, OHLCVData, Signal, Strategy, StrategyParams } from '../../types/strategies';
import { dynamic_vix_regime } from './dynamic-vix-regime';

// Fossilized structural regime settings.
const QUEEN_STRUCTURE: StrategyParams = {
    volWindow: 21,
    volLookback: 126,
    fastPeriod: 50,
    slowPeriod: 200,
};

// Fossilized oos-p7 behavior profile.
const QUEEN_BEHAVIOR: StrategyParams = {
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
    entryExposurePct: 60.0518,
    exitExposurePct: 37.4696,
    entryConfirmBars: 2,
    exitConfirmBars: 2,
    minHoldBars: 13,
    cooldownBars: 6,
};

// Backtest settings that must accompany this strategy for the crowned profile.
export const sol_queen_v1_backtest_overrides: Partial<BacktestSettings> = {
    riskMode: 'simple',
    stopLossAtr: 2.5,
    takeProfitAtr: 0,
    trailingAtr: 0,
    timeStopBars: 0,
    tradeFilterMode: 'adx',
    adxMin: 20,
    adxMax: 0,
    confirmLookback: 1,
};

export const sol_queen_v1: Strategy = {
    name: 'SOL Queen v1',
    description: 'Fossilized Dynamic VIX Iron Core profile with fixed structure and oos-p7 thresholds.',
    defaultParams: {
        ...QUEEN_STRUCTURE,
        ...QUEEN_BEHAVIOR,
    },
    paramLabels: {
        volWindow: 'Volatility Window (Locked)',
        volLookback: 'Volatility Lookback (Locked)',
        fastPeriod: 'Fast SMA Period (Locked)',
        slowPeriod: 'Slow SMA Period (Locked)',
        entryExposurePct: 'Entry Exposure Threshold (Locked)',
        exitExposurePct: 'Exit Exposure Threshold (Locked)',
        minHoldBars: 'Min Hold Bars (Locked)',
        entryConfirmBars: 'Entry Confirm Bars (Locked)',
    },
    execute: (data: OHLCVData[], _params: StrategyParams): Signal[] => {
        // Strategy is intentionally parameter-immutable: ignore incoming params.
        return dynamic_vix_regime.execute(data, {
            ...QUEEN_STRUCTURE,
            ...QUEEN_BEHAVIOR,
        });
    },
    metadata: {
        direction: 'long',
        walkForwardParams: [],
    },
};
