import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBacktest, runBacktestCompact } from "../lib/strategies/backtest/backtest-engine";
import {
    toTradeGateFeatureRow,
    type TradeGateFeatureRow,
} from "../lib/batch-backtest/trade-ledger-features";
import { buildTradeLedgerRowsForPair } from "../lib/batch-backtest/trade-ledger-exporter";
import {
    evaluateTradeGate,
    TradeGateEvaluationError,
    type TradeGate,
} from "../lib/batch-backtest/trade-gate";
import { buildBatchRunTradeGateBodyField } from "../lib/batch-backtest/trade-gate-wire";
import { discoverLedgerSweepCatalog } from "../lib/batch-backtest/trade-ledger-sweep-catalog";
import { __testInternals } from "../lib/batch-backtest/batch-backtest-vite-plugin";
import { processRunBatch } from "../lib/batch-backtest/batch-backtest-vite-plugin";
import type { BatchStreamEvent } from "../lib/batch-backtest/batch-backtest-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Signal, Time } from "../lib/types/strategies";

const BASE_TIME = 1_700_000_000;

function makeBars(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => {
        const close = 100 + index;
        return {
            time: (BASE_TIME + index * 60) as Time,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000,
        };
    });
}

function makeSignal(index: number): Signal {
    return {
        time: (BASE_TIME + index * 60) as Time,
        type: "buy",
        price: 100 + index,
        barIndex: index,
    };
}

function makeFeatureRow(index: number, candidatesAtTime = 2): TradeGateFeatureRow {
    return {
        ledgerVersion: 2,
        pair: "PAIR",
        direction: "long",
        signalTime: BASE_TIME + index * 60,
        signalBarIndex: index,
        fillTime: BASE_TIME + index * 60,
        fillPrice: 100 + index,
        feat_entryRangePosition: null,
        feat_atrPct: null,
        feat_return20: null,
        feat_gapPct: null,
        feat_dow: 0,
        feat_hour: 0,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_candidatesAtTime: candidatesAtTime,
    };
}

function makeGate(
    rows: readonly TradeGateFeatureRow[],
    evaluate: (row: TradeGateFeatureRow) => boolean,
): TradeGate {
    return {
        enabled: true,
        provenance: {
            schema: "batch.trade_gate.v1",
            folderId: "fixture",
            sweepId: "sweep",
            rules: [{ ruleId: "q1", ruleName: "q1.ts", sourceHash: "hash" }],
        },
        rules: [{ ruleId: "q1", ruleName: "q1.ts", sourceHash: "hash", evaluate }],
        pairs: new Map([[
            "PAIR",
            { pair: "PAIR", featuresBySignalKey: new Map(rows.map((row) => [`${row.signalBarIndex}|${row.direction}`, row])) },
        ]]),
    };
}

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    riskMode: "percentage",
    stopLossEnabled: false,
    takeProfitEnabled: false,
    disableSignalExits: true,
    maxOpenTrades: 1,
};

describe("Trade Gate", () => {
    it("uses the same feature values as the ledger row and does not expose rank", () => {
        const data = makeBars(32);
        const signal = makeSignal(20);
        const built = buildTradeLedgerRowsForPair({
            pair: "PAIR",
            data,
            signals: [signal],
            trades: [],
            context: {
                tradeDirection: "long",
                executionModel: "signal_close",
                maxOpenTrades: 1,
                cooldownBars: 0,
                slippageRate: 0,
            },
        });
        assert.equal(built.rows.length, 1);
        const gateRow = toTradeGateFeatureRow(built.rows[0]!, 3);
        assert.equal("feat_rank" in gateRow, false);
        assert.deepEqual(
            {
                feat_entryRangePosition: gateRow.feat_entryRangePosition,
                feat_atrPct: gateRow.feat_atrPct,
                feat_return20: gateRow.feat_return20,
                feat_gapPct: gateRow.feat_gapPct,
                feat_dow: gateRow.feat_dow,
                feat_hour: gateRow.feat_hour,
                feat_pairWinRatePrior: gateRow.feat_pairWinRatePrior,
                feat_pairTradesPrior: gateRow.feat_pairTradesPrior,
            },
            {
                feat_entryRangePosition: built.rows[0]!.feat_entryRangePosition,
                feat_atrPct: built.rows[0]!.feat_atrPct,
                feat_return20: built.rows[0]!.feat_return20,
                feat_gapPct: built.rows[0]!.feat_gapPct,
                feat_dow: built.rows[0]!.feat_dow,
                feat_hour: built.rows[0]!.feat_hour,
                feat_pairWinRatePrior: built.rows[0]!.feat_pairWinRatePrior,
                feat_pairTradesPrior: built.rows[0]!.feat_pairTradesPrior,
            },
        );
        assert.equal(gateRow.feat_candidatesAtTime, 3);
    });

    it("applies OR semantics and counts rejected entries before position state", () => {
        const data = makeBars(8);
        const rows = [makeFeatureRow(1), makeFeatureRow(2)];
        const gate = makeGate(rows, (row) => row.signalBarIndex === 2);
        gate.rules = [
            { ruleId: "q1", ruleName: "always-false.ts", sourceHash: "a", evaluate: () => false },
            { ruleId: "q2", ruleName: "candidates-at-time.ts", sourceHash: "b", evaluate: (row) => row.signalBarIndex === 2 && row.feat_candidatesAtTime === 2 },
        ];
        const result = runBacktest(data, [makeSignal(1), makeSignal(2)], 1000, 100, 0, settings, undefined, undefined, {
            tradeGate: gate,
            tradeGatePair: "PAIR",
        });
        assert.equal(result.totalTrades, 1);
        assert.deepEqual(result.tradeGateStats, {
            signalsEvaluated: 2,
            admitted: 1,
            rejectedByGate: 1,
            blocked: 0,
        });
    });

    it("counts an admitted signal blocked by ordinary position state", () => {
        const data = makeBars(8);
        const rows = [makeFeatureRow(1), makeFeatureRow(2)];
        const gate = makeGate(rows, () => true);
        const result = runBacktest(data, [makeSignal(1), makeSignal(2)], 1000, 100, 0, settings, undefined, undefined, {
            tradeGate: gate,
            tradeGatePair: "PAIR",
        });
        assert.deepEqual(result.tradeGateStats, {
            signalsEvaluated: 2,
            admitted: 2,
            rejectedByGate: 0,
            blocked: 1,
        });
    });

    it("keeps the compact engine on the same gate decision path", () => {
        const data = makeBars(8);
        const rows = [makeFeatureRow(1), makeFeatureRow(2)];
        const gate = makeGate(rows, (row) => row.signalBarIndex === 2);
        const result = runBacktestCompact(data, [makeSignal(1), makeSignal(2)], 1000, 100, 0, settings, undefined, undefined, {
            omitEquityCurve: true,
            includeSharpeRatio: false,
            skipDrawdown: true,
            tradeGate: gate,
            tradeGatePair: "PAIR",
        });
        assert.deepEqual(result.tradeGateStats, {
            signalsEvaluated: 2,
            admitted: 1,
            rejectedByGate: 1,
            blocked: 0,
        });
    });

    it("preserves byte-identical output when the gate is off", () => {
        const data = makeBars(8);
        const signals = [makeSignal(1), makeSignal(2)];
        const ordinary = runBacktest(data, signals, 1000, 100, 0, settings);
        const explicitlyOff = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            tradeGate: undefined,
        });
        assert.equal(JSON.stringify(explicitlyOff), JSON.stringify(ordinary));
        assert.equal("tradeGateStats" in ordinary, false);
    });

    it("fails loudly when a selected rule throws", () => {
        const stats = { signalsEvaluated: 0, admitted: 0, rejectedByGate: 0, blocked: 0 };
        const gate = makeGate([makeFeatureRow(1)], () => {
            throw new Error("bad predicate");
        });
        assert.throws(
            () => evaluateTradeGate(gate, makeFeatureRow(1), stats),
            (error: unknown) => error instanceof TradeGateEvaluationError && /bad predicate/.test(error.message),
        );
        assert.deepEqual(stats, { signalsEvaluated: 1, admitted: 0, rejectedByGate: 0, blocked: 0 });
    });

    it("omits the request field when off and carries only selected gate options when on", () => {
        assert.deepEqual(buildBatchRunTradeGateBodyField({ enabled: false, folderId: "", ruleIds: [] }), {});
        assert.deepEqual(buildBatchRunTradeGateBodyField({ enabled: true, folderId: "ledger", ruleIds: ["q1", "q2"] }), {
            tradeGate: { enabled: true, folderId: "ledger", ruleIds: ["q1", "q2"] },
        });
    });

    it("exposes only EDGE rules from a folder's latest completed sweep", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "trade-gate-catalog-"));
        try {
            const folder = path.join(root, "archive", "mining-ledger", "fixture");
            const rules = path.join(root, "archive", "mining-ledger", "rules");
            const oldSweep = path.join(folder, "sweeps", "old");
            const newSweep = path.join(folder, "sweeps", "new");
            const latestEdgeSweep = path.join(folder, "sweeps", "latest-edge");
            await Promise.all([
                mkdir(path.join(folder, "sweeps"), { recursive: true }),
                mkdir(oldSweep, { recursive: true }),
                mkdir(newSweep, { recursive: true }),
                mkdir(latestEdgeSweep, { recursive: true }),
                mkdir(rules, { recursive: true }),
            ]);
            const ruleSource = "export default (row: any) => row.signalBarIndex === 2 && row.feat_candidatesAtTime === 1;\n";
            const sourceHash = createHash("sha256").update(ruleSource).digest("hex");
            await Promise.all([
                writeFile(path.join(folder, "ledger.jsonl"), "{}\n"),
                writeFile(path.join(folder, "provenance.json"), JSON.stringify({
                    ledgerVersion: 2,
                    featureVersion: 2,
                    replay: { replayEligible: true },
                })),
                writeFile(path.join(folder, "summary.json"), JSON.stringify({
                    ledgerComplete: true,
                    failedWrites: 0,
                    totals: { signals: 1, pairs: 1 },
                })),
                writeFile(path.join(rules, "q1.ts"), ruleSource),
                writeFile(path.join(oldSweep, "summary.json"), JSON.stringify({
                    complete: true,
                    results: [{
                        ruleId: "q1",
                        ruleName: "q1.ts",
                        sourceHash,
                        verdict: "EDGE-CANDIDATE",
                        keptPct: 10,
                        isMeanPnlDeltaPp: 1,
                        holdoutMeanPnlDeltaPp: 2,
                        isMedianPnlDeltaPp: 1,
                        holdoutMedianPnlDeltaPp: 2,
                    }],
                })),
                writeFile(path.join(newSweep, "summary.json"), JSON.stringify({
                    complete: true,
                    results: [{
                        ruleId: "q1",
                        ruleName: "q1.ts",
                        sourceHash,
                        verdict: "NO-EDGE",
                        keptPct: 0,
                        isMeanPnlDeltaPp: 0,
                        holdoutMeanPnlDeltaPp: 0,
                        isMedianPnlDeltaPp: 0,
                        holdoutMedianPnlDeltaPp: 0,
                    }],
                })),
            ]);
            await utimes(path.join(oldSweep, "summary.json"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
            await utimes(path.join(newSweep, "summary.json"), new Date(1_700_000_001_000), new Date(1_700_000_001_000));
            const catalog = await discoverLedgerSweepCatalog(root);
            assert.equal(catalog.folders[0]?.latestSweep?.sweepId, "new");
            assert.deepEqual(catalog.folders[0]?.latestSweep?.edgeRules, []);
            assert.equal(__testInternals.parseTradeGateOptionsForTests({ enabled: false }), null);

            const rankRuleSource = "export default (row: any) => row.feat_rank === 1;\n";
            const rankRuleHash = createHash("sha256").update(rankRuleSource).digest("hex");
            await Promise.all([
                writeFile(path.join(rules, "q2.ts"), rankRuleSource),
                writeFile(path.join(latestEdgeSweep, "summary.json"), JSON.stringify({
                    complete: true,
                    results: [
                        {
                            ruleId: "q1",
                            ruleName: "q1.ts",
                            sourceHash,
                            verdict: "EDGE-CANDIDATE",
                            keptPct: 10,
                            isMeanPnlDeltaPp: 1,
                            holdoutMeanPnlDeltaPp: 2,
                            isMedianPnlDeltaPp: 1,
                            holdoutMedianPnlDeltaPp: 2,
                        },
                        {
                            ruleId: "q2",
                            ruleName: "q2.ts",
                            sourceHash: rankRuleHash,
                            verdict: "EDGE-CANDIDATE",
                            keptPct: 10,
                            isMeanPnlDeltaPp: 1,
                            holdoutMeanPnlDeltaPp: 2,
                            isMedianPnlDeltaPp: 1,
                            holdoutMedianPnlDeltaPp: 2,
                        },
                    ],
                })),
            ]);
            await utimes(path.join(latestEdgeSweep, "summary.json"), new Date(1_700_000_002_000), new Date(1_700_000_002_000));
            const resolved = await __testInternals.resolveTradeGateForTests(root, {
                enabled: true,
                folderId: "fixture",
                ruleIds: ["q1"],
            });
            assert.equal(resolved.provenance.sweepId, "latest-edge");
            assert.deepEqual(resolved.provenance.rules, [{ ruleId: "q1", ruleName: "q1.ts", sourceHash }]);
            await assert.rejects(
                __testInternals.resolveTradeGateForTests(root, { enabled: true, folderId: "fixture", ruleIds: ["q2"] }),
                /reads feat_rank/,
            );

            const fixtureStrategy = {
                name: "Trade Gate Fixture",
                description: "Two entry signals for server pre-pass certification.",
                defaultParams: {},
                paramLabels: {},
                execute(data: OHLCVData[]) {
                    return [
                        { time: data[1]!.time, type: "buy" as const, price: data[1]!.close, barIndex: 1 },
                        { time: data[2]!.time, type: "buy" as const, price: data[2]!.close, barIndex: 2 },
                        { time: data[data.length - 1]!.time, type: "sell" as const, price: data[data.length - 1]!.close, barIndex: data.length - 1 },
                    ];
                },
            };
            const fixtureCapital: CapitalSettings = {
                initialCapital: 1000,
                positionSize: 100,
                commission: 0,
                sizingMode: "percent",
                fixedTradeAmount: 1000,
            };
            const events: BatchStreamEvent[] = [];
            const owner = 9401;
            __testInternals.setLedgerRootDirForTests(root);
            __testInternals.setRunOwnerForTests(owner);
            try {
                await processRunBatch(
                    {
                        interval: "5m",
                        strategyKey: "trade_gate_fixture",
                        strategy: fixtureStrategy,
                        strategyParams: {},
                        backtestSettings: settings,
                        capitalSettings: fixtureCapital,
                        symbols: ["PAIR"],
                        loadDataset: () => Promise.resolve(makeBars(8)),
                        minUsableBars: 1,
                        tradeGateOptions: { enabled: true, folderId: "fixture", ruleIds: ["q1"] },
                    },
                    (event) => events.push(event),
                    owner,
                    "gate-fixture-run",
                );
            } finally {
                __testInternals.setRunOwnerForTests(0);
                await __testInternals.releaseLastResults("trade_gate_fixture_cleanup");
                __testInternals.setLedgerRootDirForTests(null);
            }
            const symbolEvent = events.find((event): event is Extract<BatchStreamEvent, { type: "symbol" }> => event.type === "symbol");
            assert.deepEqual(symbolEvent?.row.result?.tradeGateStats, {
                signalsEvaluated: 2,
                admitted: 1,
                rejectedByGate: 1,
                blocked: 0,
            });
            const done = events.find((event): event is Extract<BatchStreamEvent, { type: "done" }> => event.type === "done");
            assert.equal(done?.tradeGateProvenance?.rules[0]?.sourceHash, sourceHash);
            assert.deepEqual(done?.tradeGateStats, {
                signalsEvaluated: 2,
                admitted: 1,
                rejectedByGate: 1,
                blocked: 0,
            });
            assert.match(done?.summary ?? "", /Trade Gate evaluated 2, admitted 1, rejected 1, blocked 0/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
