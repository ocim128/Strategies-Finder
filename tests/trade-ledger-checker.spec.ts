import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TradeLedgerProvenance, TradeLedgerRankRow, TradeLedgerRow } from "../lib/batch-backtest/trade-ledger-exporter";
import { createTradeLedgerControlPool } from "../lib/batch-backtest/trade-ledger-control-pool";
import {
    TRADE_LEDGER_CONTROL_RUNS,
    TRADE_LEDGER_CONTROL_SEED,
    computeSliceStats,
    computeTimeSplit,
    createRuleRowProxy,
    calibratedRandomRule,
    evaluateTradeLedgerRule,
    evaluateTradeLedgerRuleAsync,
    joinSignalRanks,
    loadLedgerForReplay,
    loadLedgerRows,
    mulberry32,
    prepareTradeLedgerReplay,
    replayPair,
    runChecker,
    type LedgerRule,
    type TradeLedgerRuleRow,
    type ReplayParams,
} from "../scripts/trade-ledger-checker";

// ============================================================================
// W1: anti-leakage proxy (get / has / ownKeys / getOwnPropertyDescriptor)
// ============================================================================

function baseRow(overrides: Partial<TradeLedgerRow>): TradeLedgerRow {
    return {
        ledgerVersion: 2,
        pair: "A+B",
        baseSymbol: "AUSDT",
        quoteSymbol: "BUSDT",
        direction: "long",
        signalTime: 100,
        signalBarIndex: 3,
        fillTime: 200,
        fillPrice: 10,
        executed: true,
        notExecutedReason: null,
        feat_entryRangePosition: 50,
        feat_atrPct: 2,
        feat_return20: 1,
        feat_gapPct: 0.2,
        feat_dow: 3,
        feat_hour: 14,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 2,
        feat_barsSincePairLastFire: null,
        feat_pairSpreadVolatility20: null,
        feat_legVolatilityRatio20: null,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: {
            fillTime: 200,
            fillPrice: 10,
            exitTime: 300,
            exitPrice: 11,
            pnlPercent: 5,
            barsHeld: 2,
            exitReason: "signal",
        },
        asIfReason: null,
        horizons: {
            "24": {
                entryTimeSec: 200,
                entryPrice: 10,
                exitTimeSec: 300,
                exitPrice: 11,
                pnlPercent: 0.1,
                status: "ok",
            },
        },
        exitTime: 300,
        exitPrice: 11,
        pnlPercent: 5,
        fees: 0.1,
        exitReason: "take_profit",
        ...overrides,
    };
}

describe("trade ledger checker rule proxy (W1)", () => {
    it("allows identity, entry, and feat_* fields", () => {
        const proxy = createRuleRowProxy(baseRow({}));
        const rule: LedgerRule = (row) =>
            row.pair === "A+B"
            && row.direction === "long"
            && row.fillPrice === 10
            && row.feat_atrPct !== null
            && row.feat_atrPct > 1
            && row.feat_rank === null;
        expect(rule(proxy)).to.equal(true);
    });

    it("throws on property reads of every outcome-ish field", () => {
        for (const field of ["exitTime", "exitPrice", "pnlPercent", "fees", "exitReason", "asIf", "asIfReason", "executed", "notExecutedReason"]) {
            const proxy = createRuleRowProxy(baseRow({}));
            expect(() => (proxy as unknown as Record<string, unknown>)[field], field).to.throw(/forbidden ledger field/);
        }
    });

    it("throws when a rule probes fields with `in`", () => {
        const proxy = createRuleRowProxy(baseRow({}));
        expect(() => "pnlPercent" in proxy).to.throw(/forbidden ledger field/);
        expect(() => "asIf" in proxy).to.throw(/forbidden ledger field/);
        expect("feat_atrPct" in proxy).to.equal(true);
    });

    it("throws on Object.keys / Object.entries / spread / descriptor reads", () => {
        const proxy = createRuleRowProxy(baseRow({}));
        expect(() => Object.keys(proxy)).to.throw(/enumerate ledger fields/);
        expect(() => Object.entries(proxy)).to.throw(/enumerate ledger fields/);
        expect(() => ({ ...proxy })).to.throw(/enumerate ledger fields/);
        expect(() => Object.getOwnPropertyDescriptor(proxy, "pnlPercent")).to.throw(/forbidden ledger field/);
        // JSON round-trips enumerate too — refused (via get("toJSON") first).
        expect(() => JSON.stringify(proxy)).to.throw();
    });
});


// ============================================================================
// Replay semantics (W2)
// ============================================================================

const replayParams: ReplayParams = { maxOpenTrades: 1, cooldownBars: 0 };

function candidateRow(overrides: Partial<TradeLedgerRow>): TradeLedgerRow {
    return baseRow({
        pair: "P1",
        signalBarIndex: 0,
        signalTime: 0,
        feat_atrPct: 2,
        asIf: { fillTime: 0, fillPrice: 10, exitTime: 1, exitPrice: 11, pnlPercent: 1, barsHeld: 1, exitReason: "signal" },
        ...overrides,
    });
}

describe("trade ledger replay (W2)", () => {
    const acceptAll: LedgerRule = () => true;

    it("accept-all replay admits every candidate the flat/busy state machine allows", () => {
        const rows = Array.from({ length: 10 }, (_, i) => candidateRow({
            signalBarIndex: i,
            signalTime: i * 1000,
            // barsHeld 1: exitBar = fill + 1, so only same-next-bar fills block.
            asIf: { fillTime: i, fillPrice: 10, exitTime: i + 1, exitPrice: 11, pnlPercent: 1, barsHeld: 1, exitReason: "signal" },
        }));
        const result = replayPair("P1", rows, acceptAll, replayParams, 0);
        expect(result.candidates).to.equal(10);
        // barsHeld 1 blocks only the immediately following bar.
        expect(result.admitted).to.equal(5);
        expect(result.blocked).to.equal(5);
        expect(result.rejectedByRule).to.equal(0);
    });

    it("a rule rejection frees the slot: later candidates are still evaluated", () => {
        const rows = [
            candidateRow({ signalBarIndex: 0, signalTime: 0, asIf: { fillTime: 0, fillPrice: 10, exitTime: 0, exitPrice: 11, pnlPercent: 1, barsHeld: 0, exitReason: "signal" } }), // admit, exit bar 0
            candidateRow({ signalBarIndex: 1, signalTime: 1000, feat_atrPct: 0.5 }), // rejected (slot free)
            candidateRow({ signalBarIndex: 2, signalTime: 2000 }), // admitted
        ];
        const rule: LedgerRule = (row) => row.feat_atrPct !== null && row.feat_atrPct > 1;
        const result = replayPair("P1", rows, rule, replayParams, 0);
        expect(result.admitted).to.equal(2);
        expect(result.rejectedByRule).to.equal(1);
        expect(result.blocked).to.equal(0);
        expect(result.trades.map((t) => t.signalBarIndex)).to.deep.equal([0, 2]);
    });

    it("blocks candidates while a slot is busy and counts cooldown blocks", () => {
        const rows = [
            candidateRow({ signalBarIndex: 0, signalTime: 0 }), // admit, exit bar 1
            candidateRow({ signalBarIndex: 1, signalTime: 1000 }), // busy (exit bar 1)
        ];
        const busy = replayPair("P1", rows, acceptAll, replayParams, 0);
        expect(busy.admitted).to.equal(1);
        expect(busy.blocked).to.equal(1);

        // Cooldown 3 armed at exit bar 1 blocks fills at bars 2..3.
        const cooldownRows = [
            candidateRow({ signalBarIndex: 0, signalTime: 0, asIf: { fillTime: 0, fillPrice: 10, exitTime: 1, exitPrice: 11, pnlPercent: 1, barsHeld: 1, exitReason: "signal" } }),
            candidateRow({ signalBarIndex: 3, signalTime: 3000, asIf: { fillTime: 3, fillPrice: 10, exitTime: 4, exitPrice: 11, pnlPercent: 1, barsHeld: 1, exitReason: "signal" } }),
        ];
        const cooling = replayPair("P1", cooldownRows, acceptAll, { maxOpenTrades: 1, cooldownBars: 3 }, 0);
        expect(cooling.admitted).to.equal(1);
        expect(cooling.blocked).to.equal(1);
    });

    it("counts right-censored candidates as blocked, never zero-fills", () => {
        const rows = [
            candidateRow({ signalBarIndex: 0, signalTime: 0 }),
            candidateRow({ signalBarIndex: 5, signalTime: 5000, asIf: null, asIfReason: "right_censored" }),
        ];
        const result = replayPair("P1", rows, acceptAll, replayParams, 0);
        expect(result.admitted).to.equal(1);
        expect(result.rightCensored).to.equal(1);
        expect(result.blocked).to.equal(1);
    });
});

// ============================================================================
// Stats + split
// ============================================================================

describe("trade ledger checker split and stats", () => {
    it("splits by GLOBAL calendar time at 60% of the range, never by count", () => {
        const split = computeTimeSplit([
            baseRow({ signalTime: 0 }),
            baseRow({ signalTime: 100 }),
        ]);
        expect(split.minTime).to.equal(0);
        expect(split.maxTime).to.equal(100);
        expect(split.splitTime).to.equal(60);
        const isRows = [5, 59, 60, 95].filter((t) => t < split.splitTime);
        expect(isRows).to.deep.equal([5, 59]);
    });

    it("computes hand-checked slice stats including compounded drawdown", () => {
        const empty = computeSliceStats([]);
        expect(empty.trades).to.equal(0);
        expect(empty.totalReturnPercent).to.equal(null);

        const stats = computeSliceStats([10, 20, 30, 5]);
        expect(stats.meanPnlPercent).to.equal(16.25);
        expect(stats.medianPnlPercent).to.equal(15);
        expect(stats.hitRatePercent).to.equal(100);
        expect(stats.totalReturnPercent).to.be.closeTo(80.18, 1e-9);
        expect(stats.maxDrawdownPercent).to.equal(0);

        const dd = computeSliceStats([50, -50]);
        expect(dd.maxDrawdownPercent).to.equal(50);
        expect(dd.totalReturnPercent).to.be.closeTo(-25, 1e-9);
    });
});

// ============================================================================
// Seeded random control with two-pass calibration
// ============================================================================

describe("trade ledger checker random control (seeded, calibrated)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => candidateRow({
        signalBarIndex: i,
        signalTime: i * 1000,
        asIf: { fillTime: i, fillPrice: 10, exitTime: i, exitPrice: 11, pnlPercent: 2, barsHeld: 0, exitReason: "signal" },
    }));

    it("is deterministic for a fixed seed and approximates the target count", () => {
        const a = calibratedRandomRule(rows, 5, replayParams, 0, TRADE_LEDGER_CONTROL_SEED + 1);
        const b = calibratedRandomRule(rows, 5, replayParams, 0, TRADE_LEDGER_CONTROL_SEED + 1);
        const resultA = replayPair("P1", rows, a.rule, replayParams, 0);
        const resultB = replayPair("P1", rows, b.rule, replayParams, 0);
        expect(resultA.admitted).to.equal(resultB.admitted);
        // Two-pass calibration lands near the target keep-rate.
        expect(Math.abs(resultA.admitted - 5)).to.be.at.most(2);
    });

    it("calibrates with independent admission state for each pair", () => {
        const multiPairRows = ["P1", "P2"].flatMap((pair) => Array.from({ length: 5 }, (_, i) => candidateRow({
            pair,
            signalBarIndex: i,
            signalTime: i,
            asIf: { fillTime: i, fillPrice: 10, exitTime: i + 1, exitPrice: 11, pnlPercent: 1, barsHeld: 1, exitReason: "signal" },
        })));
        const prepared = prepareTradeLedgerReplay({ rows: multiPairRows, replayParams: replayParams });
        const calibrated = calibratedRandomRule(
            multiPairRows,
            3,
            replayParams,
            0,
            TRADE_LEDGER_CONTROL_SEED + 1,
            undefined,
            true,
            undefined,
            prepared.controlPairs,
        );
        expect(calibrated.calibratedP).to.be.closeTo(0.45, Number.EPSILON);
    });

    it("mulberry32 sequences are seed-stable", () => {
        const r1 = mulberry32(123);
        const r2 = mulberry32(123);
        const r3 = mulberry32(124);
        expect([r1(), r1(), r1()]).to.deep.equal([r2(), r2(), r2()]);
        expect(r3()).to.not.equal(r2());
    });

    it("runs the full control count with the documented base seed", () => {
        expect(TRADE_LEDGER_CONTROL_RUNS).to.equal(200);
        expect(TRADE_LEDGER_CONTROL_SEED).to.equal(42);
    });

    it("keeps the optimized control replay identical to the generic replay", () => {
        const rows = Array.from({ length: 24 }, (_, i) => candidateRow({
            pair: i % 2 === 0 ? "P1" : "P2",
            signalBarIndex: i,
            signalTime: i * 1000,
            asIf: i === 23
                ? null
                : { fillTime: i, fillPrice: 10, exitTime: i + 1, exitPrice: 11, pnlPercent: i - 8, barsHeld: i % 4, exitReason: "signal" },
            asIfReason: i === 23 ? "right_censored" : null,
        }));
        const replay = { maxOpenTrades: 2, cooldownBars: 2, shift: 0 };
        const prepared = prepareTradeLedgerReplay({ rows, replayParams: replay });
        const input = {
            folder: "fixture",
            ruleName: "optimized-control-parity",
            rows,
            joinedRankCount: 0,
            rule: (row: TradeLedgerRuleRow) => row.signalBarIndex % 3 !== 0,
            replay,
            controlRuns: 9,
            prepared,
        };
        const optimized = evaluateTradeLedgerRule(input);

        const pairResults = [...prepared.pairs.entries()].map(([pair, pairRows]) =>
            replayPair(pair, pairRows, input.rule, replay, 0, prepared.ruleRows, true));
        const admitted = pairResults.flatMap((result) => result.trades);
        const controlTotalReturns: number[] = [];
        const controlIsMeanPnls: number[] = [];
        const controlIsMedianPnls: number[] = [];
        const controlHoldoutMeanPnls: number[] = [];
        const controlHoldoutMedianPnls: number[] = [];
        const average = (values: readonly number[]): number | null => values.length > 0
            ? values.reduce((sum, value) => sum + value, 0) / values.length
            : null;
        for (let k = 0; k < input.controlRuns; k += 1) {
            const random = calibratedRandomRule(rows, admitted.length, replay, 0, TRADE_LEDGER_CONTROL_SEED + 1 + k, prepared.ruleRows, true, undefined, prepared.controlPairs);
            let equity = 1;
            const isPnls: number[] = [];
            const holdoutPnls: number[] = [];
            for (const [pair, pairRows] of prepared.pairs) {
                const result = replayPair(pair, pairRows, random.rule, replay, 0, prepared.ruleRows, true);
                for (const trade of result.trades) {
                    const pnl = trade.asIf?.pnlPercent ?? 0;
                    equity *= 1 + pnl / 100;
                    if (trade.signalTime < prepared.split.splitTime) isPnls.push(pnl);
                    else holdoutPnls.push(pnl);
                }
            }
            controlTotalReturns.push((equity - 1) * 100);
            const isStats = computeSliceStats(isPnls);
            if (isStats.meanPnlPercent !== null) controlIsMeanPnls.push(isStats.meanPnlPercent);
            if (isStats.medianPnlPercent !== null) controlIsMedianPnls.push(isStats.medianPnlPercent);
            const holdoutStats = computeSliceStats(holdoutPnls);
            if (holdoutStats.meanPnlPercent !== null) controlHoldoutMeanPnls.push(holdoutStats.meanPnlPercent);
            if (holdoutStats.medianPnlPercent !== null) controlHoldoutMedianPnls.push(holdoutStats.medianPnlPercent);
        }
        const median = (values: readonly number[]): number | null => {
            if (values.length === 0) return null;
            const sorted = [...values].sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
        };
        expect(optimized.controlMean).to.equal(average(controlTotalReturns));
        expect(optimized.controlMedian).to.equal(median(controlTotalReturns));
        expect(optimized.controlIsMeanPnl).to.equal(average(controlIsMeanPnls));
        expect(optimized.controlIsMedianPnl).to.equal(average(controlIsMedianPnls));
        expect(optimized.controlHoldoutMeanPnl).to.equal(average(controlHoldoutMeanPnls));
        expect(optimized.controlHoldoutMedianPnl).to.equal(average(controlHoldoutMedianPnls));
        expect(optimized.controlCandidateVisits).to.equal(prepared.candidateRows * input.controlRuns);
    });

    it("keeps the server worker control replay identical to the synchronous replay", async () => {
        const replay = { maxOpenTrades: 2, cooldownBars: 2, shift: 0 };
        const prepared = prepareTradeLedgerReplay({ rows, replayParams: replay });
        const input = {
            folder: "fixture",
            ruleName: "worker-control-parity",
            rows,
            joinedRankCount: 0,
            rule: (row: TradeLedgerRuleRow) => row.signalBarIndex % 3 !== 0,
            replay,
            controlRuns: 9,
            prepared,
        };
        const expected = evaluateTradeLedgerRule(input);
        const pool = createTradeLedgerControlPool(prepared, { workerCount: 2 });
        try {
            const actual = await evaluateTradeLedgerRuleAsync(input, pool.run);
            expect(actual.controlRuns).to.equal(expected.controlRuns);
            expect(actual.controlMean).to.equal(expected.controlMean);
            expect(actual.controlMedian).to.equal(expected.controlMedian);
            expect(actual.controlIsMeanPnl).to.equal(expected.controlIsMeanPnl);
            expect(actual.controlIsMedianPnl).to.equal(expected.controlIsMedianPnl);
            expect(actual.controlHoldoutMeanPnl).to.equal(expected.controlHoldoutMeanPnl);
            expect(actual.controlHoldoutMedianPnl).to.equal(expected.controlHoldoutMedianPnl);
            expect(actual.controlCandidateVisits).to.equal(expected.controlCandidateVisits);

            const singleSlotReplay = { maxOpenTrades: 1, cooldownBars: 0, shift: 0 };
            const singleSlotInput = { ...input, replay: singleSlotReplay };
            const singleSlotExpected = evaluateTradeLedgerRule(singleSlotInput);
            const singleSlotActual = await evaluateTradeLedgerRuleAsync(singleSlotInput, pool.run);
            expect(singleSlotActual.controlMean).to.equal(singleSlotExpected.controlMean);
            expect(singleSlotActual.controlMedian).to.equal(singleSlotExpected.controlMedian);
            expect(singleSlotActual.controlIsMeanPnl).to.equal(singleSlotExpected.controlIsMeanPnl);
            expect(singleSlotActual.controlHoldoutMeanPnl).to.equal(singleSlotExpected.controlHoldoutMeanPnl);
            expect(singleSlotActual.controlCandidateVisits).to.equal(singleSlotExpected.controlCandidateVisits);

            const busyRows = rows.map((row) => ({ ...row, asIf: { ...row.asIf!, barsHeld: 2 } }));
            const busyPrepared = prepareTradeLedgerReplay({ rows: busyRows, replayParams: singleSlotReplay });
            const busyInput = { ...singleSlotInput, ruleName: "worker-control-busy-parity", rows: busyRows, prepared: busyPrepared };
            const busyExpected = evaluateTradeLedgerRule(busyInput);
            const busyPool = createTradeLedgerControlPool(busyPrepared, { workerCount: 2 });
            try {
                const busyActual = await evaluateTradeLedgerRuleAsync(busyInput, busyPool.run);
                expect(busyActual.controlMean).to.equal(busyExpected.controlMean);
                expect(busyActual.controlMedian).to.equal(busyExpected.controlMedian);
                expect(busyActual.controlIsMeanPnl).to.equal(busyExpected.controlIsMeanPnl);
                expect(busyActual.controlHoldoutMeanPnl).to.equal(busyExpected.controlHoldoutMeanPnl);
                expect(busyActual.controlCandidateVisits).to.equal(busyExpected.controlCandidateVisits);
            } finally {
                await busyPool.close();
            }
        } finally {
            await pool.close();
        }
    });
});

// ============================================================================
// Ranks join
// ============================================================================

describe("trade ledger checker ranks join", () => {
    it("joins rank fields by (signalTime, pair) and counts matches", () => {
        const rows = [
            baseRow({ pair: "A+B", signalTime: 100 }),
            baseRow({ pair: "C+D", signalTime: 100 }),
            baseRow({ pair: "E+F", signalTime: 200 }),
        ];
        const ranks = new Map<string, TradeLedgerRankRow>([
            ["100|A+B", { signalTime: 100, pair: "A+B", rank: 1, candidatesAtTime: 2 }],
            ["100|C+D", { signalTime: 100, pair: "C+D", rank: 2, candidatesAtTime: 2 }],
        ]);
        const joined = joinSignalRanks(rows, ranks);
        expect(joined).to.equal(2);
        expect(rows[0]!.feat_rank).to.equal(1);
        expect(rows[1]!.feat_rank).to.equal(2);
        expect(rows[2]!.feat_rank).to.equal(null);
    });
});

// ============================================================================
// Folder loading + refusals + full report
// ============================================================================

const eligibleProvenance: TradeLedgerProvenance = {
    ledgerVersion: 2,
    featureVersion: 2,
    runId: "batch-replay",
    startedAt: "2026-08-29T14:12:00.000Z",
    interval: "4h",
    strategyKey: "s",
    strategyParams: {},
    backtestSettings: {},
    capitalSettings: {},
    engineMode: "typescript",
    executionModel: "signal_close",
    tradeDirection: "long",
    riskMode: "percentage",
    fees: { commissionPercent: 0, slippageBps: 0 },
    pairCount: 1,
    symbols: ["P1"],
    replay: {
        replayEligible: true,
        replayBlockers: [],
        maxOpenTrades: 1,
        cooldownBars: 0,
        executionModel: "signal_close",
        tradeDirection: "long",
        allowSameBarExit: false,
        disableSignalExits: true,
        slippageRate: 0,
        commissionRate: 0,
    },
};

/** A certifiably complete summary.json (the W1 guard reads these fields). */
const completeSummary = {
    ledgerVersion: 2,
    featureVersion: 2,
    runId: "batch-replay",
    startedAt: "2026-08-29T14:12:00.000Z",
    finishedAt: "2026-08-29T14:20:00.000Z",
    cancelled: false,
    ledgerComplete: true,
    failedWrites: 0,
    lastError: null,
    totals: { pairs: 1, signals: 10, executed: 10, notExecuted: 0 },
    suppressionRate: 0,
    rightCensored: 0,
    duplicateSignalsCollapsed: 0,
    submittedPairs: 1,
    loadedPairs: 1,
    rowBearingPairs: 1,
    emptyPairs: 0,
    failedPairs: [] as string[],
    perPairSuppression: [],
    topSuppressedPairs: [],
};

function fixtureRow(bar: number, atr: number, pnl: number): TradeLedgerRow {
    return candidateRow({
        signalBarIndex: bar,
        signalTime: bar * 1000,
        feat_atrPct: atr,
        // barsHeld 1: exit bar = bar + 1, so the bar after each admit blocks.
        asIf: { fillTime: bar, fillPrice: 10, exitTime: bar + 1, exitPrice: 10 * (1 + pnl / 100), pnlPercent: pnl, barsHeld: 1, exitReason: "signal" },
    });
}

describe("trade ledger checker report (replay)", () => {
    const fixtureDir = path.join(process.cwd(), "artifacts", "test-logs", "trade-ledger-checker-spec");
    const ruleFile = path.join(fixtureDir, "rule.ts");
    const cheatingRuleFile = path.join(fixtureDir, "cheating-rule.ts");

    before(() => {
        rmSync(fixtureDir, { recursive: true, force: true });
        mkdirSync(fixtureDir, { recursive: true });

        // b0 admit(+10) | b1 blocked(busy) | b2 rejected(atr 0.5) | b3 admit(+20)
        // b4 blocked | b5 admit(-5) | b6 blocked | b7 admit(+30) | b8 blocked | b9 admit(+5)
        const rows = [
            fixtureRow(0, 2, 10),
            fixtureRow(1, 2, 15),
            fixtureRow(2, 0.5, -99),
            fixtureRow(3, 2, 20),
            fixtureRow(4, 2, 15),
            fixtureRow(5, 2, -5),
            fixtureRow(6, 2, 15),
            fixtureRow(7, 2, 30),
            fixtureRow(8, 2, 15),
            fixtureRow(9, 2, 5),
        ];
        writeFileSync(path.join(fixtureDir, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        writeFileSync(path.join(fixtureDir, "signal-ranks.jsonl"), "");
        writeFileSync(path.join(fixtureDir, "provenance.json"), JSON.stringify(eligibleProvenance));
        writeFileSync(path.join(fixtureDir, "summary.json"), JSON.stringify(completeSummary));

        writeFileSync(ruleFile, "export default (row) => row.feat_atrPct !== null && row.feat_atrPct > 1;\n");
        writeFileSync(cheatingRuleFile, "export default (row) => row.pnlPercent > 0;\n");
    });

    after(() => {
        rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("replays the rule over all candidates and prints the deterministic report", async () => {
        const report = await runChecker(fixtureDir, ruleFile);

        // Admitted b0,b3,b5,b7,b9 = 5 of 10; b2 rejected by rule; 4 busy-blocked.
        expect(report).to.include("candidates: total=10 admitted=5 rejectedByRule=1 blocked=4 rightCensored=0");
        expect(report).to.include("kept: 5/10 (50.0000% of candidates)");
        // IS = admitted trades with signalTime < 5400s: b0(+10), b3(+20), b5(-5).
        expect(report).to.include("IS slice (first 60% of global calendar range; split at 1970-01-01T01:30:00.000Z): trades=3");
        expect(report).to.include("meanPnl=8.3333% medianPnl=10.0000% hitRate=66.6667%");
        // Compounded metrics are demoted to labeled informational lines.
        expect(report).to.include("scale-dependent (compounded): totalReturn=25.4000% maxDrawdown=5.0000%");
        expect(report).to.include("scale-dependent (compounded): meanIsTotalReturn=");
        // Per-trade rule-vs-control deltas are the primary comparison.
        expect(report).to.include("rule vs control (per-trade, primary): isMeanPnlDelta=");
        expect(report).to.include("isMeanPnlVsControl=");
        expect(report).to.include("controlIsMeanPnl=");
        expect(report).to.include("note: the PRIMARY rule-vs-control comparison is per-trade pnl deltas");
        // HOLDOUT printed but sealed.
        expect(report).to.include("HOLDOUT slice (last 40%) — sealed - finalists only: trades=2");
        // Per-pair breakdown present.
        expect(report).to.include("P1: candidates=10 admitted=5 rejectedByRule=1 blocked=4 rightCensored=0");
        // Deterministic.
        const again = await runChecker(fixtureDir, ruleFile);
        expect(again).to.equal(report);
    });

    it("trivial rule matches the accept-all replay (kept = every flat-allowed slot)", async () => {
        const trivialFile = path.join(fixtureDir, "trivial-rule.ts");
        writeFileSync(trivialFile, "export default () => true;\n");
        const report = await runChecker(fixtureDir, trivialFile);
        expect(report).to.include("kept: 5/10 (50.0000% of candidates)");
        expect(report).to.include("rejectedByRule=0");
        rmSync(trivialFile);
    });

    it("refuses v1 folders instead of faking as-if outcomes", async () => {
        const v1Dir = path.join(fixtureDir, "v1");
        mkdirSync(v1Dir, { recursive: true });
        writeFileSync(path.join(v1Dir, "provenance.json"), JSON.stringify({ ...eligibleProvenance, ledgerVersion: 1 }));
        writeFileSync(path.join(v1Dir, "ledger.jsonl"), "");
        let message = "";
        try {
            await loadLedgerForReplay(v1Dir);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.contain("re-run the batch to regenerate");
        rmSync(v1Dir, { recursive: true, force: true });
    });

    it("refuses replay-ineligible configs with the blocker reasons", async () => {
        const ineligibleDir = path.join(fixtureDir, "ineligible");
        mkdirSync(ineligibleDir, { recursive: true });
        writeFileSync(path.join(ineligibleDir, "provenance.json"), JSON.stringify({
            ...eligibleProvenance,
            replay: { ...eligibleProvenance.replay, replayEligible: false, replayBlockers: ["adaptive_take_profit:mfe_bootstrap"] },
        }));
        writeFileSync(path.join(ineligibleDir, "ledger.jsonl"), "");
        let message = "";
        try {
            await loadLedgerForReplay(ineligibleDir);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.contain("not eligible");
        expect(message).to.contain("adaptive_take_profit");
        rmSync(ineligibleDir, { recursive: true, force: true });
    });

    it("enforces the anti-leakage proxy end-to-end: a cheating rule fails the check", async () => {
        let failed = false;
        try {
            await runChecker(fixtureDir, cheatingRuleFile);
        } catch (error) {
            failed = true;
            expect(error instanceof Error ? error.message : "").to.contain("forbidden ledger field");
        }
        expect(failed).to.equal(true);
    });

    it("loads rows (streaming) and keeps parsed rows for replay", async () => {
        const rows = await loadLedgerRows(fixtureDir);
        expect(rows.length).to.equal(10);
        expect(rows.every((r) => r.asIf !== null)).to.equal(true);
    });
});

// ============================================================================
// W1: incomplete-ledger refusal + --allow-incomplete banner
// ============================================================================

describe("trade ledger checker incomplete-ledger guard (W1)", () => {
    const fixtureDir = path.join(process.cwd(), "artifacts", "test-logs", "trade-ledger-incomplete-spec");

    beforeEach(() => {
        rmSync(fixtureDir, { recursive: true, force: true });
        mkdirSync(fixtureDir, { recursive: true });
        writeFileSync(path.join(fixtureDir, "provenance.json"), JSON.stringify(eligibleProvenance));
        writeFileSync(path.join(fixtureDir, "ledger.jsonl"), JSON.stringify(fixtureRow(0, 2, 10)) + "\n");
        writeFileSync(path.join(fixtureDir, "signal-ranks.jsonl"), "");
    });

    afterEach(() => {
        rmSync(fixtureDir, { recursive: true, force: true });
    });

    function writeSummary(overrides: Record<string, unknown>): void {
        writeFileSync(path.join(fixtureDir, "summary.json"), JSON.stringify({
            ledgerVersion: 2,
            ledgerComplete: true,
            failedWrites: 0,
            failedPairs: [],
            ...overrides,
        }));
    }

    async function refusalMessage(options?: { allowIncomplete?: boolean }): Promise<string> {
        try {
            await loadLedgerForReplay(fixtureDir, options);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        return "";
    }

    it("refuses when summary.json is missing", async () => {
        const message = await refusalMessage();
        expect(message).to.contain("summary.json not found");
        expect(message).to.contain("completeness cannot be verified");
    });

    it("refuses when ledgerComplete is false and lists the dropped pairs", async () => {
        writeSummary({ ledgerComplete: false, failedWrites: 2, failedPairs: ["AAA+BBB", "CCC+DDD"] });
        const message = await refusalMessage();
        expect(message).to.contain("Refusing incomplete ledger");
        expect(message).to.contain("ledgerComplete=false, failedWrites=2");
        expect(message).to.contain("AAA+BBB, CCC+DDD");
        expect(message).to.contain("--allow-incomplete");
    });

    it("refuses when failedWrites > 0 even with ledgerComplete true", async () => {
        writeSummary({ ledgerComplete: true, failedWrites: 1, failedPairs: ["EEE+FFF"] });
        const message = await refusalMessage();
        expect(message).to.contain("Refusing incomplete ledger");
        expect(message).to.contain("failedWrites=1");
        expect(message).to.contain("EEE+FFF");
    });

    it("refuses unsupported summary ledgerVersions", async () => {
        writeSummary({ ledgerVersion: 1 });
        const message = await refusalMessage();
        expect(message).to.contain("unsupported");
    });

    it("--allow-incomplete proceeds and the report carries the loud warning banner", async () => {
        writeSummary({ ledgerComplete: false, failedWrites: 3, failedPairs: ["GGG+HHH"] });
        // Refused without the flag…
        expect(await refusalMessage()).to.contain("Refusing incomplete ledger");
        // …and banner-stamped with it (banner lives IN the report text).
        const ruleFile = path.join(fixtureDir, "rule.ts");
        writeFileSync(ruleFile, "export default () => true;\n");
        const report = await runChecker(fixtureDir, ruleFile, { allowIncomplete: true });
        expect(report).to.include("!! INCOMPLETE LEDGER — produced with --allow-incomplete: failedWrites=3; dropped pair rows (1): GGG+HHH");
        expect(report).to.include("!! This report must NOT be treated as a clean result.");
        // A clean folder produces no banner.
        writeSummary({});
        const cleanReport = await runChecker(fixtureDir, ruleFile, { allowIncomplete: true });
        expect(cleanReport).to.not.include("INCOMPLETE LEDGER");
    });

    it("streams JSONL with CRLF, empty lines, no trailing newline, and UTF-8 bullet pairs", async () => {
        const rows = [
            fixtureRow(0, 2, 10),
            fixtureRow(1, 2, 15),
            fixtureRow(2, 0.5, -99),
        ];
        rows[1] = { ...rows[1]!, pair: "BÜLL•ETF" };
        // Empty line in the middle, CRLF endings, no trailing newline.
        const body = `${JSON.stringify(rows[0]!)}\r\n\r\n${JSON.stringify(rows[1]!)}\r\n${JSON.stringify(rows[2]!)}`;
        writeFileSync(path.join(fixtureDir, "ledger.jsonl"), body);
        const loaded = await loadLedgerRows(fixtureDir);
        expect(loaded.length).to.equal(3);
        expect(loaded[0]!.pair).to.equal("P1");
        expect(loaded[1]!.pair).to.equal("BÜLL•ETF");
        expect(loaded[2]!.feat_atrPct).to.equal(0.5);
    });
});
