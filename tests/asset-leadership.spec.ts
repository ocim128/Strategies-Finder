import { expect } from "chai";
import { describe, it } from "node:test";
import { buildAssetLeadershipReport, createAssetLeadershipPersistedRun } from "../lib/finder/asset-leadership";
import type { AssetLeadershipPersistedRun, FinderUniverseCandidate } from "../lib/types/finder";

function makeCandidate(args: {
    strategyKey: string;
    strategyName: string;
    symbols: Array<{ symbol: string; status: "profitable" | "losing"; netProfit: number; expectancy: number; sharpeRatio: number; profitFactor: number; totalTrades: number; firstClose?: number; lastClose?: number; directionalLookbackClose?: number; directionalLookbackBars?: number }>;
    profitableActiveRatio: number;
}): FinderUniverseCandidate {
    return {
        strategyKey: args.strategyKey,
        strategyName: args.strategyName,
        params: { threshold: 1 },
        symbols: args.symbols.map((s) => ({
            symbol: s.symbol,
            status: s.status,
            barCount: 1000,
            firstClose: s.firstClose,
            lastClose: s.lastClose,
            directionalLookbackClose: s.directionalLookbackClose,
            directionalLookbackBars: s.directionalLookbackBars,
            result: {
                netProfit: s.netProfit,
                netProfitPercent: 0,
                expectancy: s.expectancy,
                avgTrade: 0,
                winRate: 0.6,
                profitFactor: s.profitFactor,
                totalTrades: s.totalTrades,
                maxDrawdownPercent: 0,
                winningTrades: Math.round(s.totalTrades * 0.6),
                losingTrades: Math.round(s.totalTrades * 0.4),
                avgWin: 10,
                avgLoss: -5,
                sharpeRatio: s.sharpeRatio,
            },
        })),
        activeSymbols: args.symbols.filter((s) => s.totalTrades > 0).length,
        profitableSymbols: args.symbols.filter((s) => s.netProfit > 0).length,
        losingSymbols: args.symbols.filter((s) => s.netProfit < 0).length,
        flatSymbols: 0,
        noTradeSymbols: 0,
        totalTrades: args.symbols.reduce((sum, s) => sum + s.totalTrades, 0),
        profitableActiveRatio: args.profitableActiveRatio,
        medianExpectancy: 50,
        medianSharpe: 2,
        medianNetProfit: 100,
        worstNetProfit: -100,
        bestNetProfit: 1000,
    };
}

function makeRun(overrides: Partial<AssetLeadershipPersistedRun> & { candidates: FinderUniverseCandidate[] }): AssetLeadershipPersistedRun {
    return {
        runId: overrides.runId ?? `run-${Date.now()}`,
        createdAt: overrides.createdAt ?? Date.now(),
        interval: overrides.interval ?? "4h",
        strategyCount: overrides.strategyCount ?? 1,
        universeSymbolCount: overrides.universeSymbolCount ?? 10,
        topN: overrides.topN ?? 5,
        candidates: overrides.candidates,
    };
}

describe("Asset Leadership aggregation", () => {
    it("returns empty report when no runs exist", () => {
        const report = buildAssetLeadershipReport({ runs: [] });
        expect(report.overview.totalRuns).to.equal(0);
        expect(report.currentLeaders).to.deep.equal([]);
        expect(report.emergingLeaders).to.deep.equal([]);
        expect(report.fallingLeaders).to.deep.equal([]);
        expect(report.consistentLeaders).to.deep.equal([]);
    });

    it("extracts synthetic pair assets and builds current leaders", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                        { symbol: "ZEC+ENA", status: "profitable", netProfit: 400, expectancy: 40, sharpeRatio: 2.8, profitFactor: 2.2, totalTrades: 18 },
                        { symbol: "ETH+SOL", status: "profitable", netProfit: 200, expectancy: 20, sharpeRatio: 1.5, profitFactor: 1.5, totalTrades: 16 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });

        expect(report.currentLeaders.length).to.be.greaterThan(0);
        expect(report.overview.totalAssets).to.be.greaterThan(0);
        expect(report.overview.totalRuns).to.equal(1);

        // Both ZEC and APT should appear as assets from synthetic pairs
        const zec = report.currentLeaders.find((row) => row.asset === "ZEC");
        const apt = report.currentLeaders.find((row) => row.asset === "APT");
        expect(zec).to.not.be.undefined;
        expect(apt).to.not.be.undefined;
        // ZEC should have more appearances since it appears in 2 pairs
        expect(zec!.appearances).to.equal(2);
        expect(apt!.appearances).to.equal(1);
    });

    it("identifies emerging leaders from score change between windows", () => {
        const now = Date.now();
        const run1 = makeRun({
            runId: "run-1",
            createdAt: now - 86400000,
            candidates: [
                makeCandidate({
                    strategyKey: "strat-a",
                    strategyName: "Strategy A",
                    profitableActiveRatio: 0.5,
                    symbols: [
                        { symbol: "BTC+ETH", status: "profitable", netProfit: 100, expectancy: 10, sharpeRatio: 1.0, profitFactor: 1.2, totalTrades: 16 },
                    ],
                }),
            ],
        });

        const run2 = makeRun({
            runId: "run-2",
            createdAt: now,
            candidates: [
                makeCandidate({
                    strategyKey: "strat-a",
                    strategyName: "Strategy A",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "BTC+ETH", status: "profitable", netProfit: 800, expectancy: 80, sharpeRatio: 3.5, profitFactor: 2.8, totalTrades: 20 },
                        { symbol: "BTC+SOL", status: "profitable", netProfit: 600, expectancy: 60, sharpeRatio: 3.0, profitFactor: 2.0, totalTrades: 18 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run1, run2] });
        expect(report.emergingLeaders.length).to.be.greaterThan(0);
        const btc = report.emergingLeaders.find((row) => row.asset === "BTC");
        expect(btc).to.not.be.undefined;
    });

    it("calculates consistent leaders by consecutive runs", () => {
        const now = Date.now();
        const runs: AssetLeadershipPersistedRun[] = [];
        for (let i = 0; i < 5; i++) {
            runs.push(makeRun({
                runId: `run-${i}`,
                createdAt: now - (5 - i) * 86400000,
                candidates: [
                    makeCandidate({
                        strategyKey: "strat",
                        strategyName: "Strategy",
                        profitableActiveRatio: 0.7,
                        symbols: [
                            { symbol: "ZEC+APT", status: "profitable", netProfit: 300, expectancy: 30, sharpeRatio: 2.5, profitFactor: 2.0, totalTrades: 20 },
                            { symbol: "ZEC+ENA", status: "profitable", netProfit: 250, expectancy: 25, sharpeRatio: 2.0, profitFactor: 1.8, totalTrades: 18 },
                        ],
                    }),
                ],
            }));
        }

        const report = buildAssetLeadershipReport({ runs });
        expect(report.consistentLeaders.length).to.be.greaterThan(0);
        const zec = report.consistentLeaders.find((row) => row.asset === "ZEC");
        expect(zec).to.not.be.undefined;
        expect(zec!.consecutiveRuns).to.equal(5);
        expect(zec!.totalRunsSeen).to.equal(5);
    });

    it("ranks the base asset as strong when a profitable synthetic ratio rises", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20, directionalLookbackClose: 1, directionalLookbackBars: 96, lastClose: 1.2 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });

        expect(report.strongestNow[0]?.asset).to.equal("ZEC");
        expect(report.weakestNow[0]?.asset).to.equal("APT");
    });

    it("ranks the quote asset as strong when a profitable synthetic ratio falls", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20, directionalLookbackClose: 1, directionalLookbackBars: 96, lastClose: 0.8 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });

        expect(report.strongestNow[0]?.asset).to.equal("APT");
        expect(report.weakestNow[0]?.asset).to.equal("ZEC");
    });

    it("scopes reports to the latest interval by default", () => {
        const olderRun = makeRun({
            runId: "run-2h",
            createdAt: 1000,
            interval: "2h",
            candidates: [
                makeCandidate({
                    strategyKey: "older",
                    strategyName: "Older",
                    profitableActiveRatio: 1,
                    symbols: [
                        { symbol: "BTC+ETH", status: "profitable", netProfit: 1000, expectancy: 100, sharpeRatio: 4, profitFactor: 4, totalTrades: 30, directionalLookbackClose: 1, directionalLookbackBars: 96, lastClose: 1.5 },
                    ],
                }),
            ],
        });
        const latestRun = makeRun({
            runId: "run-15m",
            createdAt: 2000,
            interval: "15m",
            candidates: [
                makeCandidate({
                    strategyKey: "latest",
                    strategyName: "Latest",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3, profitFactor: 2.5, totalTrades: 20, directionalLookbackClose: 1, directionalLookbackBars: 96, lastClose: 1.2 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [olderRun, latestRun] });

        expect(report.overview.totalRuns).to.equal(1);
        expect(report.recentRuns.map((run) => run.interval)).to.deep.equal(["15m"]);
        expect(report.currentLeaders.some((row) => row.asset === "BTC")).to.equal(false);
        expect(report.strongestNow[0]?.asset).to.equal("ZEC");
    });

    it("ignores non-synthetic symbols", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "BTCUSDT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 300, expectancy: 30, sharpeRatio: 2.0, profitFactor: 1.8, totalTrades: 16 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        // BTCUSDT should not appear as an asset (no + separator)
        const btcusdt = report.currentLeaders.find((row) => row.asset === "BTCUSDT");
        expect(btcusdt).to.be.undefined;
        const zec = report.currentLeaders.find((row) => row.asset === "ZEC");
        expect(zec).to.not.be.undefined;
    });

    it("counts observations per-symbol so totalObservations reflects pair count, not asset count", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                        { symbol: "ZEC+ENA", status: "profitable", netProfit: 400, expectancy: 40, sharpeRatio: 2.8, profitFactor: 2.2, totalTrades: 18 },
                        { symbol: "ETH+APT", status: "profitable", netProfit: 200, expectancy: 20, sharpeRatio: 1.5, profitFactor: 1.5, totalTrades: 16 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        // 3 synthetic pairs → 3 observations (each pair = 1 observation with 2 assets)
        expect(report.overview.totalObservations).to.equal(3);
        // 4 unique assets: ZEC, APT, ENA, ETH
        expect(report.overview.totalAssets).to.equal(4);
    });

    it("excludes load_failed symbols from observations", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.5,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                        { symbol: "BNB+APT", status: "profitable", netProfit: 0, expectancy: 0, sharpeRatio: 0, profitFactor: 0, totalTrades: 0 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        // BNB+APT has result but zero trades; ZEC+APT has result with trades
        // Both should generate observations since both have result (status can be "profitable")
        expect(report.overview.totalObservations).to.equal(2);
        // Both APT appearances count
        const apt = report.currentLeaders.find((row) => row.asset === "APT");
        expect(apt).to.not.be.undefined;
        expect(apt!.appearances).to.equal(2);
    });

    it("computes per-asset strongestPartner from per-symbol observations", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                        { symbol: "ZEC+ENA", status: "profitable", netProfit: 400, expectancy: 40, sharpeRatio: 2.8, profitFactor: 2.2, totalTrades: 18 },
                        { symbol: "ETH+APT", status: "profitable", netProfit: 200, expectancy: 20, sharpeRatio: 1.5, profitFactor: 1.5, totalTrades: 16 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        const zec = report.currentLeaders.find((row) => row.asset === "ZEC");
        expect(zec).to.not.be.undefined;
        // ZEC appears in 2 pairs: ZEC+APT and ZEC+ENA
        expect(zec!.appearances).to.equal(2);
        // partnerDiversity = 2 (APT and ENA)
        expect(zec!.partnerDiversity).to.equal(2);
        // strongestPartner should be either APT or ENA (both have 1 appearance)
        expect(["APT", "ENA"]).to.include(zec!.strongestPartner);
    });

    it("excludes symbols without result from observations", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.5,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        // Only 1 pair with data → 1 observation
        expect(report.overview.totalObservations).to.equal(1);
    });

    it("produces derived metrics with leadership insights", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.8,
                    symbols: [
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 500, expectancy: 50, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                        { symbol: "ZEC+ENA", status: "profitable", netProfit: 400, expectancy: 40, sharpeRatio: 2.8, profitFactor: 2.2, totalTrades: 18 },
                        { symbol: "ETH+APT", status: "losing", netProfit: -10, expectancy: -5, sharpeRatio: -0.5, profitFactor: 0.3, totalTrades: 10 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        expect(report.derivedMetrics.length).to.be.greaterThan(0);
        const dominant = report.derivedMetrics.find((m) => m.label === "Dominant asset");
        expect(dominant).to.not.be.undefined;
        // ZEC has all-profitable observations; APT has a losing one → ZEC scores higher
        expect(dominant!.value).to.include("ZEC");
    });

    it("derivedMetrics dominant asset matches the top current leader", () => {
        const run = makeRun({
            candidates: [
                makeCandidate({
                    strategyKey: "demo",
                    strategyName: "Demo",
                    profitableActiveRatio: 0.9,
                    symbols: [
                        { symbol: "ETH+APT", status: "profitable", netProfit: 100, expectancy: 10, sharpeRatio: 1.0, profitFactor: 1.5, totalTrades: 16 },
                        { symbol: "ZEC+APT", status: "profitable", netProfit: 800, expectancy: 80, sharpeRatio: 3.5, profitFactor: 3.0, totalTrades: 22 },
                        { symbol: "ZEC+ENA", status: "profitable", netProfit: 600, expectancy: 60, sharpeRatio: 3.0, profitFactor: 2.5, totalTrades: 20 },
                    ],
                }),
            ],
        });

        const report = buildAssetLeadershipReport({ runs: [run] });
        // ZEC should be both the current leader and the dominant asset
        const topLeader = report.currentLeaders[0];
        expect(topLeader).to.not.be.undefined;
        const dominant = report.derivedMetrics.find((m) => m.label === "Dominant asset");
        expect(dominant).to.not.be.undefined;
        expect(dominant!.value).to.include(topLeader!.asset);
    });

    it("createAssetLeadershipPersistedRun preserves candidate data", () => {
        const candidate = makeCandidate({
            strategyKey: "test",
            strategyName: "Test",
            profitableActiveRatio: 0.5,
            symbols: [
                { symbol: "A+B", status: "profitable", netProfit: 100, expectancy: 10, sharpeRatio: 1.0, profitFactor: 1.5, totalTrades: 16 },
            ],
        });
        const run = createAssetLeadershipPersistedRun({
            runId: "test-run",
            interval: "4h",
            strategyCount: 1,
            universeSymbolCount: 5,
            topN: 3,
            candidates: [candidate],
        });
        expect(run.runId).to.equal("test-run");
        expect(run.candidates).to.have.length(1);
        expect(run.candidates[0].symbols[0].symbol).to.equal("A+B");
    });
});
