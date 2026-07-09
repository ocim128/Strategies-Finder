import { expect } from "chai";
import { describe, it } from "node:test";
import {
    formatMonteCarloMetricValue,
    getMonteCarloCoverageWarnings,
    getMonteCarloSuccessRateLabel,
} from "../lib/monte-carlo-renderer";
import {
    buildPolymarketMonteCarloInput,
    derivePolymarketSharePnl,
    runPolymarketMonteCarloSimulation,
    type MonteCarloSettings,
} from "../lib/strategies/monte-carlo";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";
import type { BacktestPolymarketTradeSummary, TradePolymarketOutcome } from "../lib/types/polymarket-outcomes";

const BASE_TIME = Date.UTC(2024, 0, 1, 0, 0, 0);

function createTrade(
    id: number,
    outcome?: TradePolymarketOutcome | null,
    exitTime = BASE_TIME + (id * 60_000),
): Trade {
    const trade: Trade = {
        id,
        type: id % 2 === 0 ? "short" : "long",
        entryTime: (exitTime - 60_000) as Time,
        entryPrice: 100,
        exitTime: exitTime as Time,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "signal",
    };

    if (outcome !== undefined) {
        trade.polymarketOutcome = outcome;
    }

    return trade;
}

function createOutcome(overrides: Partial<TradePolymarketOutcome> = {}): TradePolymarketOutcome {
    return {
        eventStartTs: 0,
        eventEndTs: 300,
        eventSlug: "event",
        marketSlug: "market",
        prediction: "yes",
        actualOutcomeUp: 1,
        isWin: true,
        marketYesPrice: 0.4,
        marketNoPrice: 0.6,
        marketEntryPrice: 0.4,
        evaluationMode: "resolve_hold",
        isProfitable: true,
        marketExitPrice: 1,
        marketExitTs: 300,
        marketExitSource: "resolution",
        marketPnl: 0.6,
        ...overrides,
    };
}

function createBacktestResult(
    trades: Trade[],
    summary?: Partial<BacktestPolymarketTradeSummary>,
): BacktestResult {
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        polymarketTradeSummary: summary
            ? {
                seriesId: "BTCUSDT",
                outcomeRowsLoaded: trades.length,
                scoredTrades: trades.length,
                missingOutcomeTrades: 0,
                ...summary,
            }
            : undefined,
    };
}

function createMonteCarloSettings(overrides: Partial<MonteCarloSettings> = {}): MonteCarloSettings {
    return {
        simulations: 3,
        seed: 1337,
        enableSequenceRandomization: false,
        enableBootstrap: false,
        enableParameterPerturbation: false,
        parameterPerturbationStdDev: 5,
        ruinThresholdPercent: 60,
        initialCapital: 100,
        polymarketStakePerTrade: 1,
        ...overrides,
    };
}

describe("polymarket monte carlo input", () => {
    it("derives share pnl from direct pnl, exit minus entry, and resolve-hold fallback", () => {
        expect(derivePolymarketSharePnl(createOutcome({ marketPnl: 0.25 }))).to.equal(0.25);
        expect(derivePolymarketSharePnl(createOutcome({ marketPnl: null, marketEntryPrice: 0.4, marketExitPrice: 0.75 }))).to.equal(0.35);
        expect(derivePolymarketSharePnl(createOutcome({ marketPnl: null, marketExitPrice: null, marketEntryPrice: 0.4, isWin: true }))).to.equal(0.6);
        expect(derivePolymarketSharePnl(createOutcome({ marketPnl: null, marketExitPrice: null, marketEntryPrice: 0.4, isWin: false }))).to.equal(-0.4);
    });

    it("builds usable trade input, coverage, and skip breakdown deterministically", () => {
        const trades = [
            createTrade(1, createOutcome({ marketPnl: 0.2 })),
            createTrade(2, createOutcome({ marketPnl: null, marketEntryPrice: 0.55, marketExitPrice: 0.7 })),
            createTrade(3, createOutcome({ marketPnl: null, marketExitPrice: null, marketEntryPrice: 0.3, isWin: true })),
            createTrade(4, createOutcome({ marketExitSource: "duplicate", marketPnl: null, marketExitPrice: null, isWin: null })),
            createTrade(5, createOutcome({ marketExitSource: "filtered", marketPnl: null, marketExitPrice: null, isWin: null })),
            createTrade(6, createOutcome({ marketExitSource: "missing", marketPnl: null, marketExitPrice: null, isWin: null })),
            createTrade(7, createOutcome({ marketExitSource: "no_event", marketPnl: null, marketExitPrice: null, isWin: null })),
            createTrade(8, null),
        ];
        const result = createBacktestResult(trades, {
            evaluationMode: "resolve_hold",
            missingPriceTrades: 1,
            missingOutcomeTrades: 2,
            duplicateTradesIgnored: 1,
        });
        const input = buildPolymarketMonteCarloInput(result);

        expect(input.hasTradeLevelAnnotations).to.equal(true);
        expect(input.evaluationMode).to.equal("resolve_hold");
        expect(input.trades).to.have.length(3);
        expect(input.trades.map((trade) => trade.sharePnl)).to.deep.equal([0.2, 0.1499999999999999, 0.7]);
        expect(input.coverageSummary).to.deep.include({
            usableTrades: 3,
            totalTrades: 8,
            missingPriceTrades: 1,
            missingOutcomeTrades: 2,
            duplicateTradesIgnored: 1,
            filteredTradesIgnored: 1,
        });
        expect(input.coverageSummary.overallCoverage).to.be.closeTo(0.375, 1e-12);
        expect(input.coverageSummary.dataCoverage).to.be.closeTo(0.5, 1e-12);
    });

    it("resolves evaluation mode from summary first, then trade annotations", () => {
        const trades = [
            createTrade(1, createOutcome({ evaluationMode: "signal_exit_same_event" })),
            createTrade(2, createOutcome({ evaluationMode: "resolve_hold" })),
            createTrade(3, createOutcome({ evaluationMode: "resolve_hold" })),
            createTrade(4, createOutcome({ evaluationMode: "resolve_hold" })),
            createTrade(5, createOutcome({ evaluationMode: "resolve_hold" })),
        ];

        const fromTrades = buildPolymarketMonteCarloInput(createBacktestResult(trades));
        expect(fromTrades.evaluationMode).to.equal("signal_exit_same_event");

        const fromSummary = buildPolymarketMonteCarloInput(
            createBacktestResult(trades, { evaluationMode: "resolve_hold" }),
        );
        expect(fromSummary.evaluationMode).to.equal("resolve_hold");
    });

    it("accepts native-session trade annotations without any 5m-specific contract", async () => {
        const trades = [
            createTrade(1, createOutcome({ eventEndTs: 900, marketExitTs: 900, marketEntryPrice: 0.4, marketPnl: 0.6 })),
            createTrade(2, createOutcome({ eventEndTs: 900, marketExitTs: 900, marketEntryPrice: 0.55, marketPnl: -0.55, isWin: false })),
            createTrade(3, createOutcome({ eventEndTs: 900, marketExitTs: 900, marketEntryPrice: 0.35, marketPnl: 0.65 })),
            createTrade(4, createOutcome({ eventEndTs: 900, marketExitTs: 900, marketEntryPrice: 0.5, marketPnl: -0.5, isWin: false })),
            createTrade(5, createOutcome({ eventEndTs: 900, marketExitTs: 900, marketEntryPrice: 0.45, marketPnl: 0.55 })),
        ];
        const result = createBacktestResult(trades, {
            outcomeInterval: "15m",
            evaluationMode: "resolve_hold",
        });

        const input = buildPolymarketMonteCarloInput(result);
        expect(input.trades).to.have.length(5);
        expect(input.coverageSummary.usableTrades).to.equal(5);

        const simulation = await runPolymarketMonteCarloSimulation(
            input,
            createMonteCarloSettings({ simulations: 1, seed: 21 }),
        );

        expect(simulation.status).to.equal("success");
        expect(simulation.inputSource).to.equal("polymarket");
    });
});

describe("polymarket monte carlo engine", () => {
    it("uses a fixed stake per trade and triggers ruin thresholds", async () => {
        const input = {
            trades: [
                { entryPrice: 0.5, sharePnl: -0.5, exitTime: (BASE_TIME + 60_000) as Time },
                { entryPrice: 0.5, sharePnl: 0.5, exitTime: (BASE_TIME + 120_000) as Time },
                { entryPrice: 0.5, sharePnl: -0.5, exitTime: (BASE_TIME + 180_000) as Time },
                { entryPrice: 0.5, sharePnl: 0.5, exitTime: (BASE_TIME + 240_000) as Time },
                { entryPrice: 0.5, sharePnl: 0, exitTime: (BASE_TIME + 300_000) as Time },
            ],
            hasTradeLevelAnnotations: true,
            evaluationMode: "signal_exit_same_event" as const,
            coverageSummary: {
                usableTrades: 5,
                totalTrades: 5,
                overallCoverage: 1,
                dataCoverage: 1,
                missingPriceTrades: 0,
                missingOutcomeTrades: 0,
                duplicateTradesIgnored: 0,
                filteredTradesIgnored: 0,
            },
        };

        const result = await runPolymarketMonteCarloSimulation(
            input,
            createMonteCarloSettings({ simulations: 1, seed: 7, ruinThresholdPercent: 60, polymarketStakePerTrade: 50 }),
        );

        expect(result.status).to.equal("success");
        expect(result.inputSource).to.equal("polymarket");
        expect(result.successRateLabel).to.equal("Positive Trade Rate");
        expect(result.polymarketSizingModel).to.equal("fixed_stake");
        expect(result.inputNetProfit).to.be.closeTo(0, 1e-9);
        expect(result.metricSamples.netProfitValues[0]).to.be.closeTo(0, 1e-9);
        expect(result.ruinProbabilityMetrics.ruinProbability).to.equal(1);
        expect(result.ruinProbabilityMetrics.medianTradesToRuin).to.equal(0);
        expect(result.ruinProbabilityMetrics.maxDrawdownDistribution.median).to.be.closeTo(50, 1e-9);
        expect(result.metricSamples.winRateValues[0]).to.be.closeTo(40, 1e-9);
    });

    it("requires at least five usable polymarket trades", async () => {
        const input = {
            trades: [
                { entryPrice: 0.5, sharePnl: 0.5, exitTime: (BASE_TIME + 60_000) as Time },
                { entryPrice: 0.5, sharePnl: -0.5, exitTime: (BASE_TIME + 120_000) as Time },
                { entryPrice: 0.5, sharePnl: 0.5, exitTime: (BASE_TIME + 180_000) as Time },
                { entryPrice: 0.5, sharePnl: -0.5, exitTime: (BASE_TIME + 240_000) as Time },
            ],
            hasTradeLevelAnnotations: true,
            evaluationMode: "resolve_hold" as const,
            coverageSummary: {
                usableTrades: 4,
                totalTrades: 6,
                overallCoverage: 4 / 6,
                dataCoverage: 1,
                missingPriceTrades: 0,
                missingOutcomeTrades: 0,
                duplicateTradesIgnored: 1,
                filteredTradesIgnored: 1,
            },
        };

        const result = await runPolymarketMonteCarloSimulation(
            input,
            createMonteCarloSettings({ simulations: 5, seed: 42 }),
        );

        expect(result.status).to.equal("insufficient_sample");
        expect(result.errorMessage).to.contain("Need at least 5");
        expect(result.coverageSummary?.usableTrades).to.equal(4);
    });

    it("is deterministic for the same seed and settings", async () => {
        const input = {
            trades: [
                { entryPrice: 0.4, sharePnl: 0.2, exitTime: (BASE_TIME + 60_000) as Time },
                { entryPrice: 0.5, sharePnl: -0.5, exitTime: (BASE_TIME + 120_000) as Time },
                { entryPrice: 0.35, sharePnl: 0.65, exitTime: (BASE_TIME + 180_000) as Time },
                { entryPrice: 0.55, sharePnl: -0.55, exitTime: (BASE_TIME + 240_000) as Time },
                { entryPrice: 0.45, sharePnl: 0.1, exitTime: (BASE_TIME + 300_000) as Time },
                { entryPrice: 0.6, sharePnl: 0.4, exitTime: (BASE_TIME + 360_000) as Time },
            ],
            hasTradeLevelAnnotations: true,
            evaluationMode: "signal_exit_same_event" as const,
            coverageSummary: {
                usableTrades: 6,
                totalTrades: 7,
                overallCoverage: 6 / 7,
                dataCoverage: 1,
                missingPriceTrades: 0,
                missingOutcomeTrades: 0,
                duplicateTradesIgnored: 1,
                filteredTradesIgnored: 0,
            },
        };

        const settings = createMonteCarloSettings({
            simulations: 8,
            seed: 99,
            enableSequenceRandomization: true,
            enableBootstrap: true,
            polymarketStakePerTrade: 10,
        });

        const [left, right] = await Promise.all([
            runPolymarketMonteCarloSimulation(input, settings),
            runPolymarketMonteCarloSimulation(input, settings),
        ]);

        expect(left.status).to.equal("success");
        expect(right.status).to.equal("success");
        expect(left.metricSamples.netProfitValues).to.deep.equal(right.metricSamples.netProfitValues);
        expect(left.metricSamples.maxDrawdownPercentValues).to.deep.equal(right.metricSamples.maxDrawdownPercentValues);
        expect(left.metricSamples.winRateValues).to.deep.equal(right.metricSamples.winRateValues);
    });
});

describe("polymarket monte carlo renderer helpers", () => {
    it("reports low coverage warnings and source-aware labels", () => {
        expect(getMonteCarloSuccessRateLabel({ successRateLabel: "Positive Trade Rate" })).to.equal("Positive Trade Rate");
        expect(formatMonteCarloMetricValue(125.5, "Bankroll PnL")).to.equal("+$125.50");

        const warnings = getMonteCarloCoverageWarnings({
            inputSource: "polymarket",
            coverageSummary: {
                usableTrades: 5,
                totalTrades: 40,
                overallCoverage: 0.125,
                dataCoverage: 0.5,
                missingPriceTrades: 10,
                missingOutcomeTrades: 25,
                duplicateTradesIgnored: 0,
                filteredTradesIgnored: 0,
            },
        });

        expect(warnings).to.have.length(2);
        expect(warnings[0]).to.contain("Low confidence");
        expect(warnings[1]).to.contain("Data quality warning");
    });
});
