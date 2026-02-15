import type { BacktestSettings, OHLCVData, Signal, Strategy, StrategyParams } from '../../types/strategies';
import { dynamic_vix_regime } from './dynamic-vix-regime';

// Heavyweight lock: btc-p5 structure is fossilized.
const BTC_QUEEN_STRUCTURE: StrategyParams = {
    volWindow: 26,
    volLookback: 149,
    fastPeriod: 39,
    slowPeriod: 268,
};

const BASE_BEHAVIOR: StrategyParams = {
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
    entryExposurePct: 67.3756,
    exitExposurePct: 49.2985,
    minHoldBars: 9,
    entryConfirmBars: 2,
    exitConfirmBars: 2,
    cooldownBars: 6,
};

export const btc_queen_v1_backtest_overrides: Partial<BacktestSettings> = {
    riskMode: 'simple',
    stopLossAtr: 1.5,
    takeProfitAtr: 0,
    trailingAtr: 0,
    timeStopBars: 0,
    tradeFilterMode: 'adx',
    adxMin: 15,
    adxMax: 0,
    confirmLookback: 1,
};

export const btc_queen_v1: Strategy = {
    name: 'BTC Queen v1',
    description: 'Fossilized BTC Queen profile with locked structure, thresholds, and oxygen settings.',
    defaultParams: {
        ...BTC_QUEEN_STRUCTURE,
        ...BASE_BEHAVIOR,
    },
    paramLabels: {
        volWindow: 'Volatility Window (Locked)',
        volLookback: 'Volatility Lookback (Locked)',
        fastPeriod: 'Fast SMA Period (Locked)',
        slowPeriod: 'Slow SMA Period (Locked)',
        entryExposurePct: 'Entry Exposure Threshold (%)',
        exitExposurePct: 'Exit Exposure Threshold (%)',
        minHoldBars: 'Min Hold Bars',
        entryConfirmBars: 'Entry Confirm Bars',
    },
    execute: (data: OHLCVData[], _params: StrategyParams): Signal[] => {
        return dynamic_vix_regime.execute(data, {
            ...BTC_QUEEN_STRUCTURE,
            ...BASE_BEHAVIOR,
        });
    },
    metadata: {
        direction: 'long',
        walkForwardParams: [],
    },
};
