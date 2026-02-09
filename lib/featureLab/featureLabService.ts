import type { Time } from "lightweight-charts";
import type { OHLCVData } from '../types/strategies';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from "../strategies/indicators";
import {
    DEFAULT_FEATURE_LAB_CONFIG,
    DEFAULT_FEATURE_LAB_VERDICT_CONFIG,
    FeatureLabBinScore,
    FeatureLabConfig,
    FeatureLabDataset,
    FeatureLabExportMetadata,
    FeatureLabFeatureKey,
    FeatureLabRow,
    FeatureLabSide,
    FeatureLabSplit,
    FeatureLabVerdictConfig,
    FeatureLabVerdictReport,
} from '../types/index';

const FEATURE_KEYS: FeatureLabFeatureKey[] = [
    'ret_1',
    'ret_5',
    'rsi_14',
    'atr_pct_14',
    'adx_14',
    'ema_fast_slow_spread',
    'volume_rel_20',
];

const CSV_COLUMNS: (keyof FeatureLabRow)[] = [
    'barIndex',
    'time',
    'datetime',
    'split',
    'close',
    ...FEATURE_KEYS,
    'fwd_ret_5',
    'fwd_ret_20',
    'long_tp_before_sl',
    'short_tp_before_sl',
];

export function buildFeatureLabDataset(
    ohlcvData: OHLCVData[],
    overrides: Partial<FeatureLabConfig> = {}
): FeatureLabDataset {
    const config: FeatureLabConfig = { ...DEFAULT_FEATURE_LAB_CONFIG, ...overrides };
    const size = ohlcvData.length;
    if (size === 0) {
        return {
            rows: [],
            config,
            sourceBars: 0,
            skippedHeadBars: 0,
            droppedTailBars: 0,
        };
    }

    const close = new Array<number>(size);
    const high = new Array<number>(size);
    const low = new Array<number>(size);
    const volume = new Array<number>(size);
    for (let i = 0; i < size; i++) {
        const bar = ohlcvData[i];
        close[i] = bar.close;
        high[i] = bar.high;
        low[i] = bar.low;
        volume[i] = bar.volume ?? 0;
    }

    const rsi = calculateRSI(close, config.rsiPeriod);
    const atr = calculateATR(high, low, close, config.atrPeriod);
    const adx = calculateADX(high, low, close, config.adxPeriod);
    const emaFast = calculateEMA(close, config.emaFastPeriod);
    const emaSlow = calculateEMA(close, config.emaSlowPeriod);
    const volumeSma = calculateSMA(volume, config.volumeSmaPeriod);

    const firstValidFeatureIndex = Math.max(
        config.ret1Lookback,
        config.ret5Lookback,
        config.rsiPeriod,
        config.atrPeriod - 1,
        config.adxPeriod * 2 - 1,
        config.emaFastPeriod - 1,
        config.emaSlowPeriod - 1,
        config.volumeSmaPeriod - 1
    );

    const requiredFutureBars = Math.max(config.fwdRet5Horizon, config.fwdRet20Horizon, config.tpSlHorizon);
    const lastValidLabelIndex = size - 1 - requiredFutureBars;
    const droppedTailBars = Math.max(0, size - Math.max(firstValidFeatureIndex, lastValidLabelIndex + 1));
    const splitBoundaries = computeSplitBoundaries(
        firstValidFeatureIndex,
        lastValidLabelIndex,
        config.trainSplitRatio,
        config.validationSplitRatio
    );

    if (lastValidLabelIndex < firstValidFeatureIndex) {
        return {
            rows: [],
            config,
            sourceBars: size,
            skippedHeadBars: Math.min(size, firstValidFeatureIndex),
            droppedTailBars,
        };
    }

    const rows: FeatureLabRow[] = [];
    for (let i = firstValidFeatureIndex; i <= lastValidLabelIndex; i++) {
        const closeNow = close[i];
        const closePrev1 = close[i - config.ret1Lookback];
        const closePrev5 = close[i - config.ret5Lookback];
        const closeFwd5 = close[i + config.fwdRet5Horizon];
        const closeFwd20 = close[i + config.fwdRet20Horizon];
        const rsiVal = rsi[i];
        const atrVal = atr[i];
        const adxVal = adx[i];
        const emaFastVal = emaFast[i];
        const emaSlowVal = emaSlow[i];
        const volumeSmaVal = volumeSma[i];

        if (
            !isFinitePositive(closeNow) ||
            !isFinitePositive(closePrev1) ||
            !isFinitePositive(closePrev5) ||
            !isFinitePositive(closeFwd5) ||
            !isFinitePositive(closeFwd20) ||
            !isFinitePositive(volumeSmaVal)
        ) {
            continue;
        }

        if (
            !isFiniteNumber(rsiVal) ||
            !isFiniteNumber(atrVal) ||
            !isFiniteNumber(adxVal) ||
            !isFiniteNumber(emaFastVal) ||
            !isFiniteNumber(emaSlowVal)
        ) {
            continue;
        }

        const ret1 = closeNow / closePrev1 - 1;
        const ret5 = closeNow / closePrev5 - 1;
        const atrPct14 = atrVal / closeNow;
        const emaSpread = (emaFastVal - emaSlowVal) / closeNow;
        const volumeRel20 = volume[i] / volumeSmaVal;
        const fwdRet5 = closeFwd5 / closeNow - 1;
        const fwdRet20 = closeFwd20 / closeNow - 1;

        if (
            !isFiniteNumber(ret1) ||
            !isFiniteNumber(ret5) ||
            !isFiniteNumber(atrPct14) ||
            !isFiniteNumber(emaSpread) ||
            !isFiniteNumber(volumeRel20) ||
            !isFiniteNumber(fwdRet5) ||
            !isFiniteNumber(fwdRet20)
        ) {
            continue;
        }

        const time = toUnixSeconds(ohlcvData[i].time);
        rows.push({
            barIndex: i,
            time,
            datetime: new Date(time * 1000).toISOString(),
            split: resolveSplit(i, splitBoundaries.trainEndBarIndex, splitBoundaries.validationEndBarIndex),
            close: closeNow,
            ret_1: ret1,
            ret_5: ret5,
            rsi_14: rsiVal,
            atr_pct_14: atrPct14,
            adx_14: adxVal,
            ema_fast_slow_spread: emaSpread,
            volume_rel_20: volumeRel20,
            fwd_ret_5: fwdRet5,
            fwd_ret_20: fwdRet20,
            long_tp_before_sl: evaluateTpBeforeSlLabel(ohlcvData, i, config.tpSlHorizon, config.tpPct, config.slPct, 'long'),
            short_tp_before_sl: evaluateTpBeforeSlLabel(ohlcvData, i, config.tpSlHorizon, config.tpPct, config.slPct, 'short'),
        });
    }

    return {
        rows,
        config,
        sourceBars: size,
        skippedHeadBars: Math.min(size, firstValidFeatureIndex),
        droppedTailBars,
    };
}

export function buildFeatureLabCsv(rows: FeatureLabRow[]): string {
    const header = CSV_COLUMNS.join(',');
    const body = rows.map((row) => CSV_COLUMNS.map((column) => String(row[column])).join(','));
    return [header, ...body].join('\n');
}

export function buildFeatureLabVerdictReport(
    rows: FeatureLabRow[],
    overrides: Partial<FeatureLabVerdictConfig> = {}
): FeatureLabVerdictReport {
    const config: FeatureLabVerdictConfig = { ...DEFAULT_FEATURE_LAB_VERDICT_CONFIG, ...overrides };
    const allLongBins: FeatureLabBinScore[] = [];
    const allShortBins: FeatureLabBinScore[] = [];
    const longTopBins: FeatureLabBinScore[] = [];
    const shortTopBins: FeatureLabBinScore[] = [];

    for (const feature of FEATURE_KEYS) {
        const values = rows
            .map((row) => row[feature])
            .filter((value): value is number => Number.isFinite(value));
        const edges = computeQuantileEdges(values, config.binCount);
        if (!edges) continue;

        const bins: FeatureLabRow[][] = Array.from({ length: config.binCount }, () => []);
        for (const row of rows) {
            const binIndex = assignBin(row[feature], edges);
            if (binIndex >= 0) {
                bins[binIndex].push(row);
            }
        }

        for (let binIndex = 0; binIndex < bins.length; binIndex++) {
            const binRows = bins[binIndex];
            const longScore = scoreBin('long', feature, binIndex, binRows, edges, config);
            if (longScore) allLongBins.push(longScore);

            const shortScore = scoreBin('short', feature, binIndex, binRows, edges, config);
            if (shortScore) allShortBins.push(shortScore);
        }
    }

    allLongBins.sort((a, b) => b.score - a.score);
    allShortBins.sort((a, b) => b.score - a.score);

    for (const bin of allLongBins) {
        if (bin.passesMinSample && bin.passesDirectionalEdge && bin.passesNetEdge) {
            longTopBins.push(bin);
        }
    }
    for (const bin of allShortBins) {
        if (bin.passesMinSample && bin.passesDirectionalEdge && bin.passesNetEdge) {
            shortTopBins.push(bin);
        }
    }

    longTopBins.sort((a, b) => b.score - a.score);
    shortTopBins.sort((a, b) => b.score - a.score);

    return {
        generatedAt: new Date().toISOString(),
        totalRows: rows.length,
        config,
        allLongBins,
        allShortBins,
        longTopBins: longTopBins.slice(0, config.topBinsPerSide),
        shortTopBins: shortTopBins.slice(0, config.topBinsPerSide),
    };
}

export function buildFeatureLabMetadata(
    dataset: FeatureLabDataset,
    symbol: string,
    interval: string
): FeatureLabExportMetadata {
    const { trainEndBarIndex, validationEndBarIndex } = deriveSplitBoundariesFromRows(dataset.rows);
    const train = clampRatio(dataset.config.trainSplitRatio);
    const validation = clampRatio(dataset.config.validationSplitRatio);
    const holdout = Math.max(0, 1 - train - validation);

    return {
        generatedAt: new Date().toISOString(),
        symbol,
        interval,
        sourceBars: dataset.sourceBars,
        analyzedRows: dataset.rows.length,
        skippedHeadBars: dataset.skippedHeadBars,
        droppedTailBars: dataset.droppedTailBars,
        splitBoundaries: {
            trainEndBarIndex,
            validationEndBarIndex,
        },
        splitRatios: {
            train,
            validation,
            holdout,
        },
        leakagePolicy: {
            featureRule: "Feature values at bar i are computed only from bars <= i.",
            labelRule: "Forward labels at bar i use only bars > i.",
            tailDropRule: "Rows without full forward horizon labels are dropped from the dataset tail.",
        },
        featureDefinitions: {
            ret_1: "close[i] / close[i-1] - 1",
            ret_5: "close[i] / close[i-5] - 1",
            rsi_14: "RSI(close, 14) at i",
            atr_pct_14: "ATR(high, low, close, 14)[i] / close[i]",
            adx_14: "ADX(high, low, close, 14)[i]",
            ema_fast_slow_spread: "(EMA(close,12)[i] - EMA(close,26)[i]) / close[i]",
            volume_rel_20: "volume[i] / SMA(volume,20)[i]",
        },
        labelDefinitions: {
            fwd_ret_5: "close[i+5] / close[i] - 1",
            fwd_ret_20: "close[i+20] / close[i] - 1",
            long_tp_before_sl: `Within next ${dataset.config.tpSlHorizon} bars, long TP (${(dataset.config.tpPct * 100).toFixed(2)}%) hits before SL (${(dataset.config.slPct * 100).toFixed(2)}%).`,
            short_tp_before_sl: `Within next ${dataset.config.tpSlHorizon} bars, short TP (${(dataset.config.tpPct * 100).toFixed(2)}%) hits before SL (${(dataset.config.slPct * 100).toFixed(2)}%).`,
        },
        columns: CSV_COLUMNS.slice(),
    };
}

export function evaluateTpBeforeSlLabel(
    ohlcvData: OHLCVData[],
    index: number,
    horizonBars: number,
    tpPct: number,
    slPct: number,
    side: FeatureLabSide
): 0 | 1 {
    const entry = ohlcvData[index]?.close;
    if (!isFinitePositive(entry) || horizonBars <= 0) return 0;

    const lastIndex = Math.min(ohlcvData.length - 1, index + horizonBars);
    if (lastIndex <= index) return 0;

    const longTp = entry * (1 + tpPct);
    const longSl = entry * (1 - slPct);
    const shortTp = entry * (1 - tpPct);
    const shortSl = entry * (1 + slPct);

    for (let i = index + 1; i <= lastIndex; i++) {
        const candle = ohlcvData[i];

        if (side === 'long') {
            const tpHit = candle.high >= longTp;
            const slHit = candle.low <= longSl;
            if (tpHit && slHit) return 0;
            if (tpHit) return 1;
            if (slHit) return 0;
            continue;
        }

        const tpHit = candle.low <= shortTp;
        const slHit = candle.high >= shortSl;
        if (tpHit && slHit) return 0;
        if (tpHit) return 1;
        if (slHit) return 0;
    }

    return 0;
}

function scoreBin(
    side: FeatureLabSide,
    feature: FeatureLabFeatureKey,
    binIndex: number,
    rows: FeatureLabRow[],
    edges: number[],
    config: FeatureLabVerdictConfig
): FeatureLabBinScore | null {
    const returns = rows
        .map((row) => row[config.targetReturn])
        .filter((value): value is number => Number.isFinite(value));
    if (returns.length === 0) return null;

    const half = Math.max(1, Math.floor(returns.length / 2));
    const earlyMean = mean(returns.slice(0, half));
    const lateMean = mean(returns.slice(half));
    const meanForwardReturn = mean(returns);
    const meanForwardReturnBps = meanForwardReturn * 10_000;

    const directionalMeanReturnBps = side === 'long' ? meanForwardReturnBps : -meanForwardReturnBps;
    const netDirectionalEdgeBps = directionalMeanReturnBps - config.feeBps - config.slippageBps;
    const passesDirectionalEdge = directionalMeanReturnBps > 0;
    const passesNetEdge = netDirectionalEdgeBps >= config.minNetEdgeBps;
    const passesMinSample = rows.length >= config.minSampleCount;

    const directionalEarly = side === 'long' ? earlyMean : -earlyMean;
    const directionalLate = side === 'long' ? lateMean : -lateMean;
    const divergence = Math.abs(directionalEarly - directionalLate);
    const baseline = Math.max(Math.abs(meanForwardReturn), 1e-9);
    const stabilityFactor = 1 / (1 + divergence / baseline);
    const supportFactor = Math.min(2, Math.sqrt(rows.length / Math.max(1, config.minSampleCount)));
    const scoreBase = Math.max(0, netDirectionalEdgeBps - config.minNetEdgeBps);
    const score = scoreBase * stabilityFactor * supportFactor;

    const wins = returns.filter((value) => (side === 'long' ? value > 0 : value < 0)).length;
    const winRate = wins / returns.length;
    const splitPerformance = computeSplitPerformance(rows, config.targetReturn, side);

    return {
        side,
        feature,
        binIndex,
        binLower: edges[binIndex],
        binUpper: edges[binIndex + 1],
        sampleCount: rows.length,
        meanForwardReturn,
        meanForwardReturnBps,
        directionalMeanReturnBps,
        netDirectionalEdgeBps,
        winRate,
        earlyMeanReturn: earlyMean,
        lateMeanReturn: lateMean,
        stabilityFactor,
        supportFactor,
        score,
        passesMinSample,
        passesDirectionalEdge,
        passesNetEdge,
        splitPerformance,
    };
}

function computeQuantileEdges(values: number[], bins: number): number[] | null {
    if (values.length === 0 || bins < 2) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const edges: number[] = [];
    for (let i = 0; i <= bins; i++) {
        const position = (i / bins) * (sorted.length - 1);
        const left = Math.floor(position);
        const right = Math.min(sorted.length - 1, left + 1);
        const frac = position - left;
        edges.push(sorted[left] + (sorted[right] - sorted[left]) * frac);
    }

    if (edges[0] === edges[edges.length - 1]) {
        return null;
    }
    return edges;
}

function assignBin(value: number, edges: number[]): number {
    if (!Number.isFinite(value) || edges.length < 2) return -1;
    if (value <= edges[0]) return 0;
    for (let i = 1; i < edges.length; i++) {
        if (value <= edges[i]) {
            return i - 1;
        }
    }
    return edges.length - 2;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const value of values) sum += value;
    return sum / values.length;
}

function isFiniteNumber(value: number | null): value is number {
    return value !== null && Number.isFinite(value);
}

function isFinitePositive(value: number | null): value is number {
    return value !== null && Number.isFinite(value) && value > 0;
}

function toUnixSeconds(time: Time): number {
    if (typeof time === 'number') return Math.floor(time);
    if (typeof time === 'string') {
        const parsed = Date.parse(time);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
        const numeric = Number(time);
        if (Number.isFinite(numeric)) return Math.floor(numeric);
    }
    if (typeof time === 'object' && time && 'year' in time) {
        return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
    }
    return Math.floor(Date.now() / 1000);
}

function computeSplitBoundaries(
    firstIndex: number,
    lastIndex: number,
    trainRatioRaw: number,
    validationRatioRaw: number
): { trainEndBarIndex: number; validationEndBarIndex: number } {
    const total = Math.max(1, lastIndex - firstIndex + 1);
    const trainRatio = clampRatio(trainRatioRaw);
    const validationRatio = clampRatio(validationRatioRaw);
    const maxValidationRatio = Math.max(0, 1 - trainRatio);
    const adjustedValidation = Math.min(validationRatio, maxValidationRatio);

    let trainCount = Math.floor(total * trainRatio);
    let validationCount = Math.floor(total * adjustedValidation);

    if (trainCount < 1 && total >= 1) trainCount = 1;
    if (trainCount + validationCount >= total) {
        validationCount = Math.max(0, total - trainCount - 1);
    }

    const trainEndBarIndex = firstIndex + trainCount - 1;
    const validationEndBarIndex = trainEndBarIndex + validationCount;
    return { trainEndBarIndex, validationEndBarIndex };
}

function resolveSplit(index: number, trainEndBarIndex: number, validationEndBarIndex: number): FeatureLabSplit {
    if (index <= trainEndBarIndex) return 'train';
    if (index <= validationEndBarIndex) return 'validation';
    return 'holdout';
}

function computeSplitPerformance(
    rows: FeatureLabRow[],
    returnKey: 'fwd_ret_5' | 'fwd_ret_20',
    side: FeatureLabSide
) {
    const splits: FeatureLabSplit[] = ['train', 'validation', 'holdout'];
    return splits.map((split) => {
        const splitReturns = rows
            .filter((row) => row.split === split)
            .map((row) => row[returnKey])
            .filter((value): value is number => Number.isFinite(value));

        if (splitReturns.length === 0) {
            return {
                split,
                sampleCount: 0,
                meanForwardReturn: 0,
                winRate: 0,
            };
        }

        const wins = splitReturns.filter((value) => (side === 'long' ? value > 0 : value < 0)).length;
        return {
            split,
            sampleCount: splitReturns.length,
            meanForwardReturn: mean(splitReturns),
            winRate: wins / splitReturns.length,
        };
    });
}

function deriveSplitBoundariesFromRows(rows: FeatureLabRow[]): {
    trainEndBarIndex: number;
    validationEndBarIndex: number;
} {
    let trainEndBarIndex = -1;
    let validationEndBarIndex = -1;
    for (const row of rows) {
        if (row.split === 'train') {
            trainEndBarIndex = Math.max(trainEndBarIndex, row.barIndex);
        }
        if (row.split === 'validation') {
            validationEndBarIndex = Math.max(validationEndBarIndex, row.barIndex);
        }
    }
    if (validationEndBarIndex < trainEndBarIndex) {
        validationEndBarIndex = trainEndBarIndex;
    }
    return { trainEndBarIndex, validationEndBarIndex };
}

function clampRatio(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}




