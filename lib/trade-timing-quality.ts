import { getTimeIndex } from "./strategies/backtest/backtest-utils";
import { timeKey } from "./strategies/index";
import { medianOrNull } from "./statistics-utils";
import type {
    BacktestResult,
    OHLCVData,
    Trade,
    TradeTimingEntryHorizon,
    TradeTimingExitHorizon,
    TradeTimingQuality,
} from "./types/strategies";

const HORIZON_WEIGHTS = new Map<number, number>([
    [3, 0.5],
    [10, 0.35],
    [25, 0.15],
]);

const HORIZONS = [...HORIZON_WEIGHTS.keys()];
const EPSILON = 1e-10;

export function computeTradeTimingQuality(
    result: BacktestResult,
    ohlcvData: OHLCVData[]
): TradeTimingQuality {
    const timeIndex = getTimeIndex(ohlcvData);
    const movementFloors = new Map<number, number>();
    for (const horizon of HORIZONS) {
        movementFloors.set(horizon, computeMovementFloorPct(ohlcvData, horizon));
    }

    const entryHorizons = HORIZONS.map((horizon) =>
        computeEntryHorizon(result.trades, ohlcvData, timeIndex, horizon, movementFloors.get(horizon) ?? 0)
    );
    const exitHorizons = HORIZONS.map((horizon) =>
        computeExitHorizon(result.trades, ohlcvData, timeIndex, horizon, movementFloors.get(horizon) ?? 0)
    );
    const capture = computeExitCapture(result.trades, ohlcvData, timeIndex);
    const postExitScore = weightedAverageScore(exitHorizons);
    const exitScore = postExitScore === null
        ? capture.captureScore
        : capture.captureScore === null
            ? postExitScore
            : round2((postExitScore * 0.75) + (capture.captureScore * 0.25));

    return {
        entryScore: weightedAverageScore(entryHorizons),
        exitScore,
        entry: {
            horizons: entryHorizons,
        },
        exit: {
            horizons: exitHorizons,
            captureScore: capture.captureScore,
            averageGivebackPct: capture.averageGivebackPct,
            captureSampleSize: capture.captureSampleSize,
        },
    };
}

export function finderSortRequiresTradeTimingQuality(sortPriority: readonly string[]): boolean {
    return sortPriority.includes("entryScore") || sortPriority.includes("exitScore");
}

export function attachTradeTimingQuality(
    result: BacktestResult,
    ohlcvData: OHLCVData[]
): void {
    if (!Array.isArray(result.trades) || result.trades.length === 0 || ohlcvData.length === 0 || result.entryStats) {
        result.tradeTimingQuality = undefined;
        return;
    }

    result.tradeTimingQuality = computeTradeTimingQuality(result, ohlcvData);
}

export function averageTradeTimingQuality(
    entries: readonly BacktestResult[]
): TradeTimingQuality | undefined {
    const qualities = entries
        .map((result) => result.tradeTimingQuality)
        .filter((quality): quality is TradeTimingQuality => Boolean(quality));

    if (qualities.length === 0) {
        return undefined;
    }

    return {
        entryScore: averageNullable(qualities.map((quality) => quality.entryScore)),
        exitScore: averageNullable(qualities.map((quality) => quality.exitScore)),
        entry: {
            horizons: HORIZONS.map((horizon) => averageEntryHorizon(qualities, horizon)),
        },
        exit: {
            horizons: HORIZONS.map((horizon) => averageExitHorizon(qualities, horizon)),
            captureScore: averageNullable(qualities.map((quality) => quality.exit.captureScore)),
            averageGivebackPct: averageNullable(qualities.map((quality) => quality.exit.averageGivebackPct)),
            captureSampleSize: qualities.reduce((sum, quality) => sum + quality.exit.captureSampleSize, 0),
        },
    };
}

function computeEntryHorizon(
    trades: Trade[],
    ohlcvData: OHLCVData[],
    timeIndex: Map<string, number>,
    horizon: number,
    movementFloorPct: number
): TradeTimingEntryHorizon {
    let mfeSum = 0;
    let maeSum = 0;
    let positiveForwardCount = 0;
    let sampleSize = 0;

    for (const trade of trades) {
        if (!isFinitePositive(trade.entryPrice)) continue;
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        if (entryIndex === undefined) continue;

        const endIndex = entryIndex + horizon;
        if (endIndex >= ohlcvData.length) continue;

        let mfePct = 0;
        let maePct = 0;
        const isLong = trade.type === "long";
        for (let index = entryIndex + 1; index <= endIndex; index++) {
            const candle = ohlcvData[index];
            if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;

            const favorablePrice = isLong ? candle.high : candle.low;
            const adversePrice = isLong ? candle.low : candle.high;
            const favorableMove = absoluteMovePct(trade.entryPrice, favorablePrice);
            const adverseMove = absoluteMovePct(trade.entryPrice, adversePrice);

            mfePct = Math.max(mfePct, favorableMove);
            maePct = Math.max(maePct, adverseMove);
        }

        const forwardClose = ohlcvData[endIndex].close;
        if (!Number.isFinite(forwardClose)) continue;
        const forwardClosePct = directionalMovePct(trade.entryPrice, forwardClose, isLong);

        mfeSum += Math.max(0, mfePct);
        maeSum += Math.max(0, maePct);
        if (forwardClosePct > 0) {
            positiveForwardCount++;
        }
        sampleSize++;
    }

    if (sampleSize === 0) {
        return emptyEntryHorizon(horizon, movementFloorPct);
    }

    const avgMfePct = mfeSum / sampleSize;
    const avgMaePct = maeSum / sampleSize;
    const positiveForwardRatePct = (positiveForwardCount / sampleSize) * 100;
    const rawPathScore = ratioScore(avgMfePct, avgMaePct);
    const movementTotalPct = avgMfePct + avgMaePct;
    const movementConfidence = computeMovementConfidence(movementTotalPct, movementFloorPct);
    const pathScore = adjustScoreForMovement(rawPathScore, movementConfidence);
    const forwardRateScore = adjustScoreForMovement(positiveForwardRatePct, movementConfidence);

    return {
        bars: horizon,
        score: round2((pathScore * 0.7) + (forwardRateScore * 0.3)),
        avgMfePct: round4(avgMfePct),
        avgMaePct: round4(avgMaePct),
        positiveForwardRatePct: round2(positiveForwardRatePct),
        movementFloorPct: round4(movementFloorPct),
        movementConfidencePct: round2(movementConfidence * 100),
        sampleSize,
    };
}

function computeExitHorizon(
    trades: Trade[],
    ohlcvData: OHLCVData[],
    timeIndex: Map<string, number>,
    horizon: number,
    movementFloorPct: number
): TradeTimingExitHorizon {
    let avoidedAdverseSum = 0;
    let missedContinuationSum = 0;
    let adverseAfterExitCount = 0;
    let sampleSize = 0;

    for (const trade of trades) {
        if (trade.exitReason === "end_of_data") continue;
        if (!isFinitePositive(trade.exitPrice)) continue;

        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (exitIndex === undefined) continue;

        const endIndex = exitIndex + horizon;
        if (endIndex >= ohlcvData.length) continue;

        const isLong = trade.type === "long";
        let avoidedAdversePct = 0;
        let missedContinuationPct = 0;
        for (let index = exitIndex + 1; index <= endIndex; index++) {
            const candle = ohlcvData[index];
            if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;

            const adversePrice = isLong ? candle.low : candle.high;
            const favorablePrice = isLong ? candle.high : candle.low;
            const adverseMove = absoluteMovePct(trade.exitPrice, adversePrice);
            const favorableMove = absoluteMovePct(trade.exitPrice, favorablePrice);

            avoidedAdversePct = Math.max(avoidedAdversePct, adverseMove);
            missedContinuationPct = Math.max(missedContinuationPct, favorableMove);
        }

        const horizonClose = ohlcvData[endIndex].close;
        if (!Number.isFinite(horizonClose)) continue;
        const postExitClosePct = directionalMovePct(trade.exitPrice, horizonClose, isLong);

        avoidedAdverseSum += Math.max(0, avoidedAdversePct);
        missedContinuationSum += Math.max(0, missedContinuationPct);
        if (postExitClosePct < 0) {
            adverseAfterExitCount++;
        }
        sampleSize++;
    }

    if (sampleSize === 0) {
        return emptyExitHorizon(horizon, movementFloorPct);
    }

    const avgAvoidedAdversePct = avoidedAdverseSum / sampleSize;
    const avgMissedContinuationPct = missedContinuationSum / sampleSize;
    const adverseAfterExitRatePct = (adverseAfterExitCount / sampleSize) * 100;
    const rawProtectionScore = ratioScore(avgAvoidedAdversePct, avgMissedContinuationPct);
    const movementTotalPct = avgAvoidedAdversePct + avgMissedContinuationPct;
    const movementConfidence = computeMovementConfidence(movementTotalPct, movementFloorPct);
    const protectionScore = adjustScoreForMovement(rawProtectionScore, movementConfidence);
    const adverseRateScore = adjustScoreForMovement(adverseAfterExitRatePct, movementConfidence);

    return {
        bars: horizon,
        score: round2((protectionScore * 0.7) + (adverseRateScore * 0.3)),
        avgAvoidedAdversePct: round4(avgAvoidedAdversePct),
        avgMissedContinuationPct: round4(avgMissedContinuationPct),
        adverseAfterExitRatePct: round2(adverseAfterExitRatePct),
        movementFloorPct: round4(movementFloorPct),
        movementConfidencePct: round2(movementConfidence * 100),
        sampleSize,
    };
}

function computeExitCapture(
    trades: Trade[],
    ohlcvData: OHLCVData[],
    timeIndex: Map<string, number>
): { captureScore: number | null; averageGivebackPct: number | null; captureSampleSize: number } {
    let captureSum = 0;
    let givebackSum = 0;
    let sampleSize = 0;

    for (const trade of trades) {
        if (trade.exitReason === "end_of_data") continue;
        if (!isFinitePositive(trade.entryPrice) || !isFinitePositive(trade.exitPrice)) continue;

        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined || exitIndex < entryIndex) continue;

        const isLong = trade.type === "long";
        const realizedMovePct = directionalMovePct(trade.entryPrice, trade.exitPrice, isLong);
        let mfeDuringTrade = 0;

        if (exitIndex > entryIndex + 1) {
            for (let index = entryIndex + 1; index <= exitIndex - 1; index++) {
                const candle = ohlcvData[index];
                if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;
                const favorablePrice = isLong ? candle.high : candle.low;
                const favorableMove = absoluteMovePct(trade.entryPrice, favorablePrice);
                mfeDuringTrade = Math.max(mfeDuringTrade, favorableMove);
            }
        }

        mfeDuringTrade = Math.max(mfeDuringTrade, Math.max(realizedMovePct, 0));
        if (mfeDuringTrade <= EPSILON) continue;

        const capturePct = clamp(realizedMovePct / mfeDuringTrade, 0, 1) * 100;
        const givebackPct = Math.max(0, mfeDuringTrade - Math.max(realizedMovePct, 0));
        captureSum += capturePct;
        givebackSum += givebackPct;
        sampleSize++;
    }

    if (sampleSize === 0) {
        return {
            captureScore: null,
            averageGivebackPct: null,
            captureSampleSize: 0,
        };
    }

    return {
        captureScore: round2(captureSum / sampleSize),
        averageGivebackPct: round4(givebackSum / sampleSize),
        captureSampleSize: sampleSize,
    };
}

function computeMovementFloorPct(ohlcvData: OHLCVData[], horizon: number): number {
    const moves: number[] = [];
    for (let index = 0; index + horizon < ohlcvData.length; index++) {
        const startClose = ohlcvData[index].close;
        const endClose = ohlcvData[index + horizon].close;
        if (!isFinitePositive(startClose) || !Number.isFinite(endClose)) continue;
        moves.push(Math.abs(percentMove(endClose, startClose)));
    }
    return medianOrNull(moves) ?? 0;
}

function averageEntryHorizon(qualities: readonly TradeTimingQuality[], horizon: number): TradeTimingEntryHorizon {
    const horizons = qualities
        .map((quality) => quality.entry.horizons.find((item) => item.bars === horizon))
        .filter((item): item is TradeTimingEntryHorizon => Boolean(item));

    return {
        bars: horizon,
        score: averageNullable(horizons.map((item) => item.score)),
        avgMfePct: averageNullable(horizons.map((item) => item.avgMfePct)),
        avgMaePct: averageNullable(horizons.map((item) => item.avgMaePct)),
        positiveForwardRatePct: averageNullable(horizons.map((item) => item.positiveForwardRatePct)),
        movementFloorPct: averageNullable(horizons.map((item) => item.movementFloorPct)),
        movementConfidencePct: averageNullable(horizons.map((item) => item.movementConfidencePct)),
        sampleSize: horizons.reduce((sum, item) => sum + item.sampleSize, 0),
    };
}

function averageExitHorizon(qualities: readonly TradeTimingQuality[], horizon: number): TradeTimingExitHorizon {
    const horizons = qualities
        .map((quality) => quality.exit.horizons.find((item) => item.bars === horizon))
        .filter((item): item is TradeTimingExitHorizon => Boolean(item));

    return {
        bars: horizon,
        score: averageNullable(horizons.map((item) => item.score)),
        avgAvoidedAdversePct: averageNullable(horizons.map((item) => item.avgAvoidedAdversePct)),
        avgMissedContinuationPct: averageNullable(horizons.map((item) => item.avgMissedContinuationPct)),
        adverseAfterExitRatePct: averageNullable(horizons.map((item) => item.adverseAfterExitRatePct)),
        movementFloorPct: averageNullable(horizons.map((item) => item.movementFloorPct)),
        movementConfidencePct: averageNullable(horizons.map((item) => item.movementConfidencePct)),
        sampleSize: horizons.reduce((sum, item) => sum + item.sampleSize, 0),
    };
}

function weightedAverageScore(horizons: readonly { bars: number; score: number | null }[]): number | null {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const horizon of horizons) {
        if (horizon.score === null || !Number.isFinite(horizon.score)) continue;
        const weight = HORIZON_WEIGHTS.get(horizon.bars) ?? 0;
        if (weight <= 0) continue;
        weightedSum += horizon.score * weight;
        totalWeight += weight;
    }

    return totalWeight > 0 ? round2(weightedSum / totalWeight) : null;
}

function averageNullable(values: readonly (number | null)[]): number | null {
    const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (finiteValues.length === 0) return null;
    return round4(finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length);
}

function ratioScore(favorable: number, adverse: number): number {
    const denominator = favorable + adverse;
    return denominator > EPSILON ? clamp((favorable / denominator) * 100, 0, 100) : 50;
}

function computeMovementConfidence(movementTotalPct: number, movementFloorPct: number): number {
    if (movementFloorPct <= EPSILON) return 1;
    return clamp(movementTotalPct / movementFloorPct, 0, 1);
}

function adjustScoreForMovement(rawScore: number, movementConfidence: number): number {
    return 50 + ((rawScore - 50) * movementConfidence);
}

function emptyEntryHorizon(horizon: number, movementFloorPct: number): TradeTimingEntryHorizon {
    return {
        bars: horizon,
        score: null,
        avgMfePct: null,
        avgMaePct: null,
        positiveForwardRatePct: null,
        movementFloorPct: round4(movementFloorPct),
        movementConfidencePct: null,
        sampleSize: 0,
    };
}

function emptyExitHorizon(horizon: number, movementFloorPct: number): TradeTimingExitHorizon {
    return {
        bars: horizon,
        score: null,
        avgAvoidedAdversePct: null,
        avgMissedContinuationPct: null,
        adverseAfterExitRatePct: null,
        movementFloorPct: round4(movementFloorPct),
        movementConfidencePct: null,
        sampleSize: 0,
    };
}

function percentMove(to: number, from: number): number {
    return ((to - from) / from) * 100;
}

function absoluteMovePct(referencePrice: number, price: number): number {
    return Math.abs(percentMove(price, referencePrice));
}

function directionalMovePct(referencePrice: number, price: number, isLong: boolean): number {
    const move = percentMove(price, referencePrice);
    return isLong ? move : -move;
}

function isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}
