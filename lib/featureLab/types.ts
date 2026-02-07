export type FeatureLabFeatureKey =
    | 'ret_1'
    | 'ret_5'
    | 'rsi_14'
    | 'atr_pct_14'
    | 'adx_14'
    | 'ema_fast_slow_spread'
    | 'volume_rel_20';

export type FeatureLabForwardReturnKey = 'fwd_ret_5' | 'fwd_ret_20';
export type FeatureLabSide = 'long' | 'short';
export type FeatureLabSplit = 'train' | 'validation' | 'holdout';

export interface FeatureLabConfig {
    ret1Lookback: number;
    ret5Lookback: number;
    rsiPeriod: number;
    atrPeriod: number;
    adxPeriod: number;
    emaFastPeriod: number;
    emaSlowPeriod: number;
    volumeSmaPeriod: number;
    fwdRet5Horizon: number;
    fwdRet20Horizon: number;
    tpSlHorizon: number;
    tpPct: number;
    slPct: number;
    trainSplitRatio: number;
    validationSplitRatio: number;
}

export interface FeatureLabRow {
    barIndex: number;
    time: number;
    datetime: string;
    split: FeatureLabSplit;
    close: number;
    ret_1: number;
    ret_5: number;
    rsi_14: number;
    atr_pct_14: number;
    adx_14: number;
    ema_fast_slow_spread: number;
    volume_rel_20: number;
    fwd_ret_5: number;
    fwd_ret_20: number;
    long_tp_before_sl: 0 | 1;
    short_tp_before_sl: 0 | 1;
}

export interface FeatureLabDataset {
    rows: FeatureLabRow[];
    config: FeatureLabConfig;
    sourceBars: number;
    skippedHeadBars: number;
    droppedTailBars: number;
}

export interface FeatureLabVerdictConfig {
    binCount: number;
    minSampleCount: number;
    topBinsPerSide: number;
    targetReturn: FeatureLabForwardReturnKey;
    feeBps: number;
    slippageBps: number;
    minNetEdgeBps: number;
}

export interface FeatureLabSplitPerformance {
    split: FeatureLabSplit;
    sampleCount: number;
    meanForwardReturn: number;
    winRate: number;
}

export interface FeatureLabBinScore {
    side: FeatureLabSide;
    feature: FeatureLabFeatureKey;
    binIndex: number;
    binLower: number;
    binUpper: number;
    sampleCount: number;
    meanForwardReturn: number;
    meanForwardReturnBps: number;
    directionalMeanReturnBps: number;
    netDirectionalEdgeBps: number;
    winRate: number;
    earlyMeanReturn: number;
    lateMeanReturn: number;
    stabilityFactor: number;
    supportFactor: number;
    score: number;
    passesMinSample: boolean;
    passesDirectionalEdge: boolean;
    passesNetEdge: boolean;
    splitPerformance: FeatureLabSplitPerformance[];
}

export interface FeatureLabVerdictReport {
    generatedAt: string;
    totalRows: number;
    config: FeatureLabVerdictConfig;
    allLongBins: FeatureLabBinScore[];
    allShortBins: FeatureLabBinScore[];
    longTopBins: FeatureLabBinScore[];
    shortTopBins: FeatureLabBinScore[];
}

export interface FeatureLabExportMetadata {
    generatedAt: string;
    symbol: string;
    interval: string;
    sourceBars: number;
    analyzedRows: number;
    skippedHeadBars: number;
    droppedTailBars: number;
    splitBoundaries: {
        trainEndBarIndex: number;
        validationEndBarIndex: number;
    };
    splitRatios: {
        train: number;
        validation: number;
        holdout: number;
    };
    leakagePolicy: {
        featureRule: string;
        labelRule: string;
        tailDropRule: string;
    };
    featureDefinitions: Record<FeatureLabFeatureKey, string>;
    labelDefinitions: {
        fwd_ret_5: string;
        fwd_ret_20: string;
        long_tp_before_sl: string;
        short_tp_before_sl: string;
    };
    columns: (keyof FeatureLabRow)[];
}

export const DEFAULT_FEATURE_LAB_CONFIG: FeatureLabConfig = {
    ret1Lookback: 1,
    ret5Lookback: 5,
    rsiPeriod: 14,
    atrPeriod: 14,
    adxPeriod: 14,
    emaFastPeriod: 12,
    emaSlowPeriod: 26,
    volumeSmaPeriod: 20,
    fwdRet5Horizon: 5,
    fwdRet20Horizon: 20,
    tpSlHorizon: 20,
    tpPct: 0.015,
    slPct: 0.01,
    trainSplitRatio: 0.6,
    validationSplitRatio: 0.2,
};

export const DEFAULT_FEATURE_LAB_VERDICT_CONFIG: FeatureLabVerdictConfig = {
    binCount: 5,
    minSampleCount: 200,
    topBinsPerSide: 12,
    targetReturn: 'fwd_ret_20',
    feeBps: 0,
    slippageBps: 0,
    minNetEdgeBps: 0,
};
