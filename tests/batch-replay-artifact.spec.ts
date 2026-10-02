import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore, __testInternals } from "../lib/batch-backtest/batch-backtest-vite-plugin";
import { runOpenScoreUsdReplay } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import { createEmptyBacktestResult } from "../lib/strategies/backtest/position-stats";
import type { OHLCVData, Trade, Time } from "../lib/types/strategies";

async function* fromArray<T>(values: readonly T[]): AsyncIterable<T> {
    yield* values;
}

describe("Batch temporary replay artifacts", () => {
    it("preserves full replay results for ordinary, tied, gapped, and missing-target data", async () => {
        const data: OHLCVData[] = Array.from({ length: 12 }, (_, i) => ({
            time: (1_700_000_000 + i * 1_000) as Time, open: 100 + i,
            high: 101 + i, low: 99 + i, close: 100 + i, volume: 1,
        }));
        const trade = (type: "long" | "short", entry: number, exit: number, pnl: number, exitReason: Trade["exitReason"] = "signal"): Trade => ({
            id: entry, type, entryTime: data[entry]!.time, exitTime: data[exit]!.time,
            entryPrice: 100, exitPrice: 101, pnl, pnlPercent: pnl, size: 1, exitReason,
        });
        const full: BatchSyntheticPairArtifact[] = ["AAA", "BBB", "DDD", "CCC"].map((asset, index) => ({
            symbol: `${asset}USDT+QQQUSDT`, baseAsset: asset, quoteAsset: "QQQ",
            baseSymbol: `${asset}USDT`, quoteSymbol: "QQQUSDT",
            data, signals: [{ time: data[0]!.time, type: "buy", price: 100 }],
            result: {
                ...createEmptyBacktestResult(), netProfit: 5,
                trades: [trade("long", 0, 1, 5), trade(index === 3 ? "short" : "long", 2, 11, 0, "end_of_data")],
                equityCurve: data.map((bar) => ({ time: bar.time, value: 1_000 })),
            },
        }));
        const store = new ArtifactStore();
        try {
            for (const [index, artifact] of full.entries()) {
                const row: BatchBacktestSymbolResult = {
                    ...artifact, status: "profitable", barCount: data.length,
                };
                await store.store(index, row);
            }
            await store.flush();
            const lean = await Promise.all(store.collectMetas().map((meta) => store.loadStored(meta)));
            assert.equal(lean.length, full.length);
            for (const mode of ["ordinary", "ties", "gaps", "missing-targets"]) {
                const targets = ["AAA", "BBB", "DDD", "CCC", "QQQ"]
                    .filter((asset) => mode !== "missing-targets" || asset !== "BBB")
                    .map((asset) => ({
                        asset, symbol: `${asset}USDT`,
                        data: data.filter((_bar, index) => mode !== "gaps" || asset !== "AAA" || index !== 4)
                            .map((bar) => mode === "ties"
                                ? { ...bar, open: 100, high: 100, low: 100, close: 100 }
                                : bar),
                    }));
                const options = {
                    horizons: [2, 4], slippageRate: 0.001, commissionRate: 0.001,
                    blockCount: 1, includeEventDetails: true,
                };
                const before = await runOpenScoreUsdReplay(() => fromArray(full), () => fromArray(targets), options);
                const after = await runOpenScoreUsdReplay(() => fromArray(lean), () => fromArray(targets), options);
                const withoutElapsed = (result: typeof before) => ({
                    ...result, reportLines: result.reportLines.filter((line) => !line.startsWith("elapsed=")),
                });
                assert.ok(before.totalEvents > 0, `${mode} must exercise decisions`);
                if (mode === "missing-targets") assert.ok(before.omittedAssets > 0);
                else assert.ok(before.eventDetails?.length, `${mode} must exercise selector outcomes`);
                assert.deepEqual(withoutElapsed(after), withoutElapsed(before), mode);
            }
        } finally {
            const detached = store.detach();
            await Promise.all(detached.writes);
            if (detached.dir) {
                assert.ok(detached.dir.startsWith(join(tmpdir(), __testInternals.MINE_ARTIFACT_DIR_PREFIX_FOR_TESTS)));
                await rm(detached.dir, { recursive: true, force: true });
            }
        }
    });
});
