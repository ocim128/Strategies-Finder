import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBatchResultsView } from "../lib/batch-backtest/browser/batch-results-view";
import { sortBatchResults } from "../lib/batch-backtest/batch-results-sort";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import { createEmptyBacktestResult } from "../lib/strategies/backtest/position-stats";
import { createFakeBatchBacktestDom } from "./helpers/fake-batch-backtest-dom";

describe("Batch scheduled result rendering", () => {
    it("keeps sorted rows ordered on a frame flush and rejects a stale frame", () => {
        const savedWindow = globalThis.window;
        let frame!: FrameRequestCallback;
        globalThis.window = {
            requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1; },
            cancelAnimationFrame: () => {},
        } as unknown as Window & typeof globalThis;
        const dom = createFakeBatchBacktestDom();
        const rows: BatchBacktestSymbolResult[] = [];
        let token = 1;
        let renders = 0;
        const view = createBatchResultsView({ isRunTokenCurrent: (queued) => queued === token });
        const renderSorted = (): void => {
            renders += 1;
            dom.batchBacktestResults.textContent = sortBatchResults(rows, {
                key: "netProfit", direction: "desc",
            }).map((row) => row.symbol).join(",");
        };
        try {
            for (const [symbol, netProfit] of [["LOW", 1], ["HIGH", 10]] as const) {
                const row: BatchBacktestSymbolResult = {
                    symbol, status: "profitable", barCount: 200,
                    result: { ...createEmptyBacktestResult(), netProfit },
                };
                rows.push(row);
                view.queueLiveRender(dom, row, token, renderSorted);
            }
            assert.equal(renders, 0);
            frame(0);
            assert.equal(renders, 1);
            assert.equal(dom.batchBacktestResults.textContent, "HIGH,LOW");

            view.queueLiveRender(dom, rows[0]!, token, renderSorted);
            token += 1;
            frame(0);
            assert.equal(renders, 1);
            assert.equal(dom.batchBacktestResults.textContent, "HIGH,LOW");
            view.flushLiveRenderNow(dom, token, renderSorted);
            assert.equal(renders, 1, "stale rows were dropped");
        } finally {
            view.cancelLiveRenderRaf();
            if (savedWindow === undefined) Reflect.deleteProperty(globalThis, "window");
            else globalThis.window = savedWindow;
        }
    });
});
