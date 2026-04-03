import { expect } from 'chai';
import { describe, it } from 'node:test';
import { Trade, Time } from './lib/strategies/index';
import {
    analyzeTradePatterns,
    runAnalysisFilterFinder,
    simulateComboFilter,
    simulateFilter,
} from './lib/strategies/backtest/trade-analyzer';
describe('Trade Analyzer', () => {
    it('treats missing snapshot values as failing active single-feature filters', () => {
        const trades: Trade[] = [
            {
                id: 1,
                type: 'long',
                entryTime: 1 as unknown as Time,
                entryPrice: 100,
                exitTime: 2 as unknown as Time,
                exitPrice: 101,
                pnl: 10,
                pnlPercent: 10,
                size: 1,
                entrySnapshot: { volumeRatio: 1.8 }
            },
            {
                id: 2,
                type: 'long',
                entryTime: 2 as unknown as Time,
                entryPrice: 100,
                exitTime: 3 as unknown as Time,
                exitPrice: 99,
                pnl: -8,
                pnlPercent: -8,
                size: 1,
                entrySnapshot: { volumeRatio: null }
            },
            {
                id: 3,
                type: 'long',
                entryTime: 3 as unknown as Time,
                entryPrice: 100,
                exitTime: 4 as unknown as Time,
                exitPrice: 102,
                pnl: 6,
                pnlPercent: 6,
                size: 1,
                entrySnapshot: { volumeRatio: 1.3 }
            },
        ];

        const simulation = simulateFilter(trades, 'volumeRatio', 'above', 1.0);

        expect(simulation.remainingTrades).to.equal(2);
        expect(simulation.removedTrades).to.equal(1);
        expect(simulation.filteredWinRate).to.equal(100);
    });

    it('treats missing snapshot values as failing active combo filters', () => {
        const trades: Trade[] = [
            {
                id: 1,
                type: 'long',
                entryTime: 1 as unknown as Time,
                entryPrice: 100,
                exitTime: 2 as unknown as Time,
                exitPrice: 101,
                pnl: 12,
                pnlPercent: 12,
                size: 1,
                entrySnapshot: { volumeRatio: 1.6, priceRangePos: 0.2 }
            },
            {
                id: 2,
                type: 'long',
                entryTime: 2 as unknown as Time,
                entryPrice: 100,
                exitTime: 3 as unknown as Time,
                exitPrice: 99,
                pnl: -7,
                pnlPercent: -7,
                size: 1,
                entrySnapshot: { volumeRatio: 1.7, priceRangePos: null }
            },
            {
                id: 3,
                type: 'long',
                entryTime: 3 as unknown as Time,
                entryPrice: 100,
                exitTime: 4 as unknown as Time,
                exitPrice: 100.5,
                pnl: 5,
                pnlPercent: 5,
                size: 1,
                entrySnapshot: { volumeRatio: 1.4, priceRangePos: 0.3 }
            },
        ];

        const simulation = simulateComboFilter(trades, [
            { feature: 'volumeRatio', label: 'Volume Ratio', direction: 'above', threshold: 1.0 },
            { feature: 'priceRangePos', label: 'Price Range Pos', direction: 'below', threshold: 0.5 },
        ]);

        expect(simulation.remainingTrades).to.equal(2);
        expect(simulation.removedTrades).to.equal(1);
        expect(simulation.filteredWinRate).to.equal(100);
    });

    it('relax-aware mode should honor max removal cap', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 100; i++) {
            const isLowQualityBucket = i < 10;
            const bodyPercent = isLowQualityBucket ? 15 : 60 + (i % 5);
            const pnl = isLowQualityBucket
                ? -12
                : (i % 3 === 0 ? -6 : 9);

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100 + pnl / 10,
                pnl,
                pnlPercent: pnl / 10,
                size: 1,
                entrySnapshot: {
                    rsi: 50 + (i % 7),
                    adx: 20 + (i % 10),
                    atrPercent: 1 + (i % 5) * 0.05,
                    emaDistance: (i % 11) - 5,
                    volumeRatio: 0.8 + (i % 6) * 0.1,
                    priceRangePos: 0.3 + (i % 6) * 0.1,
                    barsFromHigh: i % 12,
                    barsFromLow: i % 12,
                    trendEfficiency: 0.2 + (i % 8) * 0.08,
                    atrRegimeRatio: 0.8 + (i % 6) * 0.1,
                    bodyPercent,
                    wickSkew: (i % 21) - 10,
                    volumeTrend: 0.8 + (i % 5) * 0.1,
                    volumeBurst: (i % 7) - 3,
                    volumePriceDivergence: ((i % 11) - 5) / 5,
                    volumeConsistency: 0.3 + (i % 8) * 0.1
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'relax_aware',
            maxSingleRemoval: 15
        });

        const suggested = analyses.filter(a => a.suggestedFilter !== null);
        expect(suggested.length).to.be.greaterThan(0);
        suggested.forEach(a => {
            expect(a.tradesRemovedPercent).to.be.at.most(15.0001);
        });
    });

    it('should only suggest below direction for bars-from-high/low features', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 30; i++) {
            const isLoss = i < 10;
            const barsValue = isLoss ? 16 + (i % 3) : (i % 4);

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -10 : 6,
                pnlPercent: isLoss ? -1 : 0.6,
                size: 1,
                entrySnapshot: {
                    rsi: 50,
                    adx: 25,
                    atrPercent: 1.2,
                    emaDistance: 0.5,
                    volumeRatio: 1.1,
                    priceRangePos: 0.45,
                    barsFromHigh: barsValue,
                    barsFromLow: barsValue,
                    trendEfficiency: 0.6,
                    atrRegimeRatio: 1.1,
                    bodyPercent: 55,
                    wickSkew: 2,
                    volumeTrend: 1.0,
                    volumeBurst: 0.5,
                    volumePriceDivergence: 0.1,
                    volumeConsistency: 0.7
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'quality',
            maxSingleRemoval: 35
        });

        const barsFromHigh = analyses.find(a => a.feature === 'barsFromHigh');
        const barsFromLow = analyses.find(a => a.feature === 'barsFromLow');

        expect(barsFromHigh).to.not.be.undefined;
        expect(barsFromLow).to.not.be.undefined;
        expect(barsFromHigh?.suggestedFilter).to.not.be.null;
        expect(barsFromLow?.suggestedFilter).to.not.be.null;
        expect(barsFromHigh?.suggestedFilter?.direction).to.equal('below');
        expect(barsFromLow?.suggestedFilter?.direction).to.equal('below');
    });

    it('should keep tiny non-zero suggested thresholds non-zero', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 30; i++) {
            const isLoss = i < 10;
            const divergence = isLoss
                ? (-0.000002 + (i * 0.00000002))
                : (0.0000005 + ((i - 10) * 0.00000002));

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -8 : 5,
                pnlPercent: isLoss ? -0.8 : 0.5,
                size: 1,
                entrySnapshot: {
                    rsi: 52,
                    adx: 24,
                    atrPercent: 1.15,
                    emaDistance: 0.4,
                    volumeRatio: 1.05,
                    priceRangePos: 0.5,
                    barsFromHigh: 3,
                    barsFromLow: 3,
                    trendEfficiency: 0.62,
                    atrRegimeRatio: 1.05,
                    bodyPercent: 58,
                    wickSkew: 1,
                    volumeTrend: 1.02,
                    volumeBurst: 0.2,
                    volumePriceDivergence: divergence,
                    volumeConsistency: 0.72
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'quality',
            maxSingleRemoval: 35
        });
        const divergenceFeature = analyses.find(a => a.feature === 'volumePriceDivergence');

        expect(divergenceFeature).to.not.be.undefined;
        expect(divergenceFeature?.suggestedFilter).to.not.be.null;
        expect(divergenceFeature?.suggestedFilter?.threshold).to.not.equal(0);
    });

    it('finder ranges should keep zero suggested thresholds active', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 12; i++) {
            const isLoss = i < 4;
            const tf60Perf = i < 6 ? -0.2 : 0.2;

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -7 : 6,
                pnlPercent: isLoss ? -0.7 : 0.6,
                size: 1,
                entrySnapshot: {
                    rsi: 52,
                    adx: 24,
                    atrPercent: 1.1,
                    emaDistance: 0.3,
                    volumeRatio: 1.05,
                    priceRangePos: 0.5,
                    barsFromHigh: 3,
                    barsFromLow: 3,
                    trendEfficiency: 0.6,
                    atrRegimeRatio: 1.0,
                    bodyPercent: 55,
                    wickSkew: 1,
                    tf60Perf,
                    volumeTrend: 1.0,
                    volumeBurst: 0.1,
                    volumePriceDivergence: 0.05,
                    volumeConsistency: 0.7
                }
            });
        }

        const finderResult = runAnalysisFilterFinder(
            trades,
            [{
                feature: 'tf60Perf',
                label: 'TF 60m Perf %',
                winStats: { mean: 0.1, median: 0.1, stddev: 0.1, count: 8 },
                lossStats: { mean: -0.1, median: -0.1, stddev: 0.1, count: 4 },
                separationScore: 0.4,
                suggestedFilter: { direction: 'above', threshold: 0 },
                winRateIfFiltered: 0,
                expectancyIfFiltered: 0,
                tradesRemovedPercent: 0
            }],
            { randomTrials: 1, refineTrials: 0 }
        );

        expect(finderResult.featureRanges.length).to.equal(1);
        expect(finderResult.featureRanges[0].suggestedThreshold).to.not.equal(0);
    });

    it('supports custom win and payout semantics for polymarket-style analysis', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 14; i++) {
            const isWin = i >= 4;
            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: -5,
                pnlPercent: -0.5,
                size: 1,
                entrySnapshot: {
                    rsi: 45 + i,
                    adx: 20,
                    atrPercent: 1.2,
                    emaDistance: 0,
                    volumeRatio: isWin ? 1.8 + (i * 0.01) : 0.55 + (i * 0.01),
                    priceRangePos: isWin ? 0.25 : 0.88,
                    barsFromHigh: isWin ? 1 : 11,
                    barsFromLow: isWin ? 2 : 9,
                    trendEfficiency: isWin ? 0.75 : 0.18,
                    atrRegimeRatio: 1.0,
                    bodyPercent: 55,
                    wickSkew: 0,
                    volumeTrend: 1.0,
                    volumeBurst: isWin ? 0.7 : -0.6,
                    volumePriceDivergence: isWin ? 0.35 : -0.35,
                    volumeConsistency: 0.6
                },
                polymarketOutcome: {
                    eventStartTs: 1_700_000_000 + i * 300,
                    eventEndTs: 1_700_000_300 + i * 300,
                    eventSlug: `event-${i}`,
                    marketSlug: `market-${i}`,
                    prediction: 'yes',
                    actualOutcomeUp: isWin ? 1 : 0,
                    isWin,
                    marketEntryPrice: isWin ? 0.35 : 0.65
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            isWin: (trade) => trade.polymarketOutcome?.isWin === true,
            payout: (trade) => {
                const price = trade.polymarketOutcome?.marketEntryPrice ?? 0;
                return trade.polymarketOutcome?.isWin ? (1 - price) : -price;
            }
        });

        expect(analyses.length).to.be.greaterThan(0);
        const volumeRatio = analyses.find((analysis) => analysis.feature === 'volumeRatio');
        expect(volumeRatio).to.not.be.undefined;
        expect(volumeRatio?.suggestedFilter).to.not.be.null;
        expect(volumeRatio?.winRateIfFiltered).to.be.greaterThan(70);
        expect(volumeRatio?.expectancyIfFiltered).to.be.greaterThan(0);
    });

    it('finder uses custom win and payout semantics for combo candidates', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 16; i++) {
            const isWin = i >= 5;
            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: -4,
                pnlPercent: -0.4,
                size: 1,
                entrySnapshot: {
                    rsi: isWin ? 64 : 36,
                    adx: 24,
                    atrPercent: 1.1,
                    emaDistance: 0.2,
                    volumeRatio: isWin ? 1.7 + (i * 0.01) : 0.7 + (i * 0.01),
                    priceRangePos: isWin ? 0.28 : 0.82,
                    barsFromHigh: isWin ? 2 : 9,
                    barsFromLow: isWin ? 3 : 8,
                    trendEfficiency: isWin ? 0.74 : 0.22,
                    atrRegimeRatio: 1.0,
                    bodyPercent: 58,
                    wickSkew: 0,
                    volumeTrend: 1.0,
                    volumeBurst: isWin ? 0.6 : -0.6,
                    volumePriceDivergence: isWin ? 0.25 : -0.25,
                    volumeConsistency: 0.7
                },
                polymarketOutcome: {
                    eventStartTs: 1_700_010_000 + i * 300,
                    eventEndTs: 1_700_010_300 + i * 300,
                    eventSlug: `combo-${i}`,
                    marketSlug: `combo-market-${i}`,
                    prediction: 'yes',
                    actualOutcomeUp: isWin ? 1 : 0,
                    isWin,
                    marketEntryPrice: isWin ? 0.4 : 0.7
                }
            });
        }

        const semantics = {
            isWin: (trade: Trade) => trade.polymarketOutcome?.isWin === true,
            payout: (trade: Trade) => {
                const price = trade.polymarketOutcome?.marketEntryPrice ?? 0;
                return trade.polymarketOutcome?.isWin ? (1 - price) : -price;
            }
        };
        const analyses = analyzeTradePatterns(trades, semantics);
        const finderResult = runAnalysisFilterFinder(trades, analyses, {
            randomTrials: 16,
            refineTrials: 8,
            minBadRemovedPct: 10,
            maxGoodRemovedPct: 25,
            maxTotalRemovedPct: 60,
            ...semantics
        });

        expect(finderResult.bestCandidate).to.not.equal(null);
        expect(finderResult.bestCandidate?.simulation.filteredExpectancy).to.be.greaterThan(
            finderResult.bestCandidate?.simulation.originalExpectancy ?? 0
        );
    });
});

