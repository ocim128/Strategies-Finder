import { expect } from "chai";
import { describe, it } from "node:test";
import {
    COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
    CompactArtifactSchemaError,
    assertCompactSchema,
    fromCompactPairArtifact,
    isCompactPairArtifact,
    toCompactPairArtifact,
    toCompactTargetArtifact,
} from "../lib/batch-backtest/batch-miner-artifact";
import {
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    runPreparedBatchSyntheticStateMiner,
    runBatchSyntheticStateMiner,
    type BatchSyntheticPairArtifact,
} from "../lib/batch-backtest/batch-synthetic-state-miner";
import { timeKey } from "../lib/strategies";
import type { BacktestResult, OHLCVData, Signal, Time, Trade } from "../lib/types/strategies";

function makeCandles(length: number, priceAt: (index: number) => number): OHLCVData[] {
    return Array.from({ length }, (_, index) => {
        const close = priceAt(index);
        // Use ms-shaped numeric times (the production case) so the round-trip
        // parity covers the dominant time shape in this repo.
        return {
            time: (1_700_000_000_000 + index * 300_000) as Time,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000,
        };
    });
}

function makeResult(trades: Trade[]): BacktestResult {
    return {
        trades,
        netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0, avgTrade: 0,
        profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0, totalTrades: trades.length,
        winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0, sharpeRatio: 0, equityCurve: [],
    };
}

function makeSignals(data: OHLCVData[], indexes: number[], type: Signal["type"] = "buy"): Signal[] {
    return indexes.map((index) => ({
        time: data[index]!.time,
        type,
        price: data[index]!.close,
        barIndex: index,
    }));
}

describe("batch miner compact artifact round-trip parity", () => {
    // Intent being locked (per AGENTS.md rule 8): the compact SoA artifact is
    // the Phase 2 acceleration boundary that lets the server plugin store
    // typed-array artifacts and lets Rust / worker_threads consume them. If the
    // round-trip ever drifts from the raw artifact on any field the miner
    // reads, verdicts silently change on server-side runs. These tests fail the
    // moment the round-trip is not byte-identical for the load-bearing fields.

    it("compact round-trip preserves every candle's timeKey exactly", () => {
        const data = makeCandles(50, (i) => 100 + i * 0.1);
        const raw: BatchSyntheticPairArtifact = {
            symbol: "ZEC+APT", baseAsset: "ZEC", quoteAsset: "APT",
            data, signals: [], result: makeResult([]),
        };
        const compact = toCompactPairArtifact(raw);
        const back = fromCompactPairArtifact(compact);
        expect(back.data.length).to.equal(raw.data.length);
        for (let i = 0; i < raw.data.length; i += 1) {
            // The miner indexes everything by timeKey; this is the parity that
            // actually matters. Raw ms-numeric time -> String -> same key.
            expect(timeKey(back.data[i]!.time)).to.equal(timeKey(raw.data[i]!.time));
            expect(back.data[i]!.close).to.equal(raw.data[i]!.close);
            expect(back.data[i]!.high).to.equal(raw.data[i]!.high);
            expect(back.data[i]!.low).to.equal(raw.data[i]!.low);
            expect(back.data[i]!.open).to.equal(raw.data[i]!.open);
            expect(back.data[i]!.volume).to.equal(raw.data[i]!.volume);
        }
    });

    it("compact round-trip preserves signal timeKey, type, price, barIndex", () => {
        const data = makeCandles(40, (i) => 100 + i);
        const signals = makeSignals(data, [5, 10, 15, 20], "buy")
            .concat(makeSignals(data, [7, 12], "sell"));
        // Drop barIndex on one signal to exercise the -1 sentinel round-trip.
        const { barIndex: _drop, ...noBarIndex } = signals[0]!;
        signals[0] = noBarIndex as Signal;
        const raw: BatchSyntheticPairArtifact = {
            symbol: "ZEC+BTC", baseAsset: "ZEC", quoteAsset: "BTC",
            data, signals, result: makeResult([]),
        };
        const back = fromCompactPairArtifact(toCompactPairArtifact(raw));
        expect(back.signals.length).to.equal(raw.signals.length);
        for (let i = 0; i < raw.signals.length; i += 1) {
            expect(timeKey(back.signals[i]!.time)).to.equal(timeKey(raw.signals[i]!.time));
            expect(back.signals[i]!.type).to.equal(raw.signals[i]!.type);
            expect(back.signals[i]!.price).to.equal(raw.signals[i]!.price);
            expect(back.signals[i]!.barIndex).to.equal(raw.signals[i]!.barIndex);
        }
    });

    it("compact round-trip preserves trade entry/exit timeKey, type, entryPrice, end_of_data flag", () => {
        const data = makeCandles(40, (i) => 100 + i);
        const trades: Trade[] = [
            {
                id: 0, type: "long",
                entryTime: data[5]!.time, entryPrice: 105,
                exitTime: data[10]!.time, exitPrice: 110,
                pnl: 5, pnlPercent: 5, size: 1, exitReason: "signal",
            },
            {
                id: 1, type: "short",
                entryTime: data[15]!.time, entryPrice: 115,
                exitTime: data[35]!.time, exitPrice: 135,
                pnl: -20, pnlPercent: -20, size: 1, exitReason: "end_of_data",
            },
        ];
        const raw: BatchSyntheticPairArtifact = {
            symbol: "ETH+USDT", baseAsset: "ETH", quoteAsset: "USDT",
            data, signals: [], result: makeResult(trades),
        };
        const back = fromCompactPairArtifact(toCompactPairArtifact(raw));
        expect(back.result.trades.length).to.equal(2);
        expect(timeKey(back.result.trades[0]!.entryTime)).to.equal(timeKey(trades[0]!.entryTime));
        expect(timeKey(back.result.trades[0]!.exitTime)).to.equal(timeKey(trades[0]!.exitTime));
        expect(back.result.trades[0]!.type).to.equal("long");
        expect(back.result.trades[0]!.entryPrice).to.equal(105);
        expect(back.result.trades[0]!.exitReason).to.equal("signal");
        // end_of_data MUST round-trip — it is load-bearing for auto-horizon
        // calibration (excluded from closed-trade median-hold). The codec
        // encodes it as 1 and everything else collapses to "closed".
        expect(back.result.trades[1]!.exitReason).to.equal("end_of_data");
        expect(back.result.trades[1]!.type).to.equal("short");
    });

    it("compact-vs-raw miner verdicts are identical on a positive-edge fixture", () => {
        const signalIndexes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
        const targetData = (() => {
            const closes = Array.from({ length: 100 }, (_, index) => {
                for (const s of signalIndexes) {
                    const off = index - s;
                    if (off === 0) return 100;
                    if (off === 1 || off === 2) return 104;
                }
                return 99;
            });
            return closes.map((c, i) => ({
                time: (1_700_000_000_000 + i * 300_000) as Time,
                open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
            }));
        })();
        const mkPair = (sym: string, base: string, quote: string): BatchSyntheticPairArtifact => ({
            symbol: sym, baseAsset: base, quoteAsset: quote,
            data: targetData,
            signals: makeSignals(targetData, signalIndexes, "buy"),
            result: makeResult([]),
        });
        const rawArtifacts = [
            mkPair("ZEC+APT", "ZEC", "APT"),
            mkPair("ZEC+BTC", "ZEC", "BTC"),
        ];
        const compactArtifacts = rawArtifacts.map((raw) => fromCompactPairArtifact(toCompactPairArtifact(raw)));
        const target = { asset: "ZEC", symbol: "ZECUSDT", data: targetData };
        const options = { horizons: [2], lagBars: 0, minSamples: 2, minOosSamples: 1, neighborCountMin: 2, neighborCountMax: 12 };

        const rawRun = runBatchSyntheticStateMiner({ interval: "5m", targets: [target], artifacts: rawArtifacts, options });
        const compactRun = runPreparedBatchSyntheticStateMiner({
            interval: "5m",
            targets: prepareBatchSyntheticTargetArtifacts([target]),
            artifacts: prepareBatchSyntheticPairArtifacts(compactArtifacts),
            options,
        });
        // The verdict (and all evidence scalars) must match exactly. If the
        // compact round-trip dropped a load-bearing field, the evidence or
        // verdict would diverge here.
        expect(compactRun.verdicts).to.deep.equal(rawRun.verdicts);
    });
});

describe("batch miner compact artifact schema guard", () => {
    it("assertCompactSchema accepts the current schema version", () => {
        const raw: BatchSyntheticPairArtifact = {
            symbol: "A+B", baseAsset: "A", quoteAsset: "B",
            data: makeCandles(5, () => 1), signals: [], result: makeResult([]),
        };
        const compact = toCompactPairArtifact(raw);
        expect(() => assertCompactSchema(compact)).to.not.throw();
    });

    it("assertCompactSchema rejects a stale schema version (Phase 2 fallback trigger)", () => {
        const stale = { schema: 0 };
        expect(() => assertCompactSchema(stale)).to.throw(CompactArtifactSchemaError);
    });

    it("isCompactPairArtifact narrows correctly", () => {
        const raw: BatchSyntheticPairArtifact = {
            symbol: "A+B", baseAsset: "A", quoteAsset: "B",
            data: makeCandles(5, () => 1), signals: [], result: makeResult([]),
        };
        const compact = toCompactPairArtifact(raw);
        expect(isCompactPairArtifact(compact)).to.equal(true);
        expect(isCompactPairArtifact({ schema: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION })).to.equal(false);
        expect(isCompactPairArtifact(raw)).to.equal(false);
    });

    it("compact target artifact preserves timeKey parity", () => {
        const data = makeCandles(20, (i) => 50 + i);
        const target = { asset: "ZEC", symbol: "ZECUSDT", data };
        const compact = toCompactTargetArtifact(target);
        // No reverse converter is needed for targets (the miner rebuilds them
        // from loaded candles directly), but the per-bar key must match what
        // timeKey would produce — this is the invariant the Rust file-manifest
        // handoff depends on.
        for (let i = 0; i < data.length; i += 1) {
            expect(compact.timeKey[i]).to.equal(timeKey(data[i]!.time));
            expect(compact.close[i]).to.equal(data[i]!.close);
        }
    });
});
