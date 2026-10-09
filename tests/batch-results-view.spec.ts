import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBatchResultsView } from "../lib/batch-backtest/browser/batch-results-view";
import { sortBatchResults } from "../lib/batch-backtest/batch-results-sort";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import { createEmptyBacktestResult } from "../lib/strategies/backtest/position-stats";
import { createFakeElement } from "./helpers/fake-element";
import { createFakeBatchBacktestDom } from "./helpers/fake-batch-backtest-dom";

describe("Batch scheduled result rendering", () => {
    it("coalesces a 1000-row sorted burst and flushes the terminal tail without another frame", () => {
        const savedWindow = globalThis.window;
        let frame!: FrameRequestCallback;
        let schedules = 0;
        let renders = 0;
        const rows: BatchBacktestSymbolResult[] = [];
        globalThis.window = {
            requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; schedules++; return 1; },
            cancelAnimationFrame: () => {},
        } as unknown as Window & typeof globalThis;
        const dom = createFakeBatchBacktestDom();
        const view = createBatchResultsView({ isRunTokenCurrent: () => true });
        const render = (): void => {
            renders++;
            dom.batchBacktestResults.textContent = sortBatchResults(rows, {
                key: "netProfit", direction: "desc",
            }).map((row) => row.symbol).join(",");
        };
        try {
            for (let i = 0; i < 1_000; i++) {
                const row: BatchBacktestSymbolResult = { symbol: String(i), status: "profitable", barCount: 200,
                    result: { ...createEmptyBacktestResult(), netProfit: i } };
                rows.push(row);
                view.queueLiveRender(dom, row, 1, render);
            }
            assert.equal(renders, 0, "the 50-row cap must not trigger full sorted renders");
            assert.equal(schedules, 1);
            frame(0);
            assert.equal(renders, 1);
            assert.equal(dom.batchBacktestResults.textContent.split(",")[0], "999");
            const tail = { ...rows[0]!, symbol: "TAIL", result: { ...rows[0]!.result!, netProfit: 2_000 } };
            rows.push(tail);
            view.queueLiveRender(dom, tail, 1, render);
            view.cancelLiveRenderRaf();
            view.flushLiveRenderNow(dom, 1, render);
            assert.equal(renders, 2);
            assert.equal(dom.batchBacktestResults.textContent.split(",")[0], "TAIL");
            view.flushLiveRenderNow(dom, 1, render);
            assert.equal(renders, 2, "a terminal flush must drain the dirty flag");
        } finally {
            view.cancelLiveRenderRaf();
            if (savedWindow === undefined) Reflect.deleteProperty(globalThis, "window");
            else globalThis.window = savedWindow;
        }
    });

    it("still appends unsorted bursts at the 50-row cap", () => {
        const savedDocument = globalThis.document;
        const savedWindow = globalThis.window;
        globalThis.document = {
            createElement: createFakeElement, createDocumentFragment: createFakeElement,
        } as unknown as Document;
        globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} } as unknown as Window & typeof globalThis;
        const dom = createFakeBatchBacktestDom();
        const view = createBatchResultsView({ isRunTokenCurrent: () => true });
        try {
            for (let i = 0; i < 49; i++) {
                view.queueLiveRender(dom, { symbol: String(i), status: "skipped", barCount: 0 }, 1);
            }
            assert.equal((dom.batchBacktestResults as any).children.length, 0);
            view.queueLiveRender(dom, { symbol: "49", status: "skipped", barCount: 0 }, 1);
            assert.equal((dom.batchBacktestResults as any).children[0].children.length, 50);
        } finally {
            view.cancelLiveRenderRaf();
            if (savedDocument === undefined) Reflect.deleteProperty(globalThis, "document");
            else globalThis.document = savedDocument;
            if (savedWindow === undefined) Reflect.deleteProperty(globalThis, "window");
            else globalThis.window = savedWindow;
        }
    });
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
    it("reuses immutable row nodes across sorted stream flushes and keeps replacements distinct", () => {
        const savedDocument = globalThis.document;
        const savedWindow = globalThis.window;
        const elements: any[] = [];
        globalThis.document = {
            createElement: () => { const el = createFakeElement(); elements.push(el); return el; },
            createDocumentFragment: createFakeElement,
        } as unknown as Document;
        globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} } as unknown as Window & typeof globalThis;
        const dom = createFakeBatchBacktestDom();
        const rows: BatchBacktestSymbolResult[] = [];
        const view = createBatchResultsView({ isRunTokenCurrent: () => true });
        const renderSorted = (): void => view.renderResultRows(dom, rows, { key: "netProfit", direction: "desc" });
        try {
            for (let i = 0; i < 1_000; i++) {
                const row: BatchBacktestSymbolResult = { symbol: "PAIR", status: "profitable", barCount: 200,
                    result: { ...createEmptyBacktestResult(), netProfit: i } };
                rows.push(row);
                view.queueLiveRender(dom, row, 1, renderSorted);
            }
            view.flushLiveRenderNow(dom, 1, renderSorted);
            const createdRows = elements.filter((el) => el.className === "batch-result-row");
            assert.equal(createdRows.length, 1_000, "each streamed row is built once, even when symbols match");
            const descending = ((dom.batchBacktestResults as any).children[0].children as unknown[]).slice();
            view.renderResultRows(dom, rows, { key: "netProfit", direction: "asc" });
            const ascending = (dom.batchBacktestResults as any).children[0].children;
            assert.deepEqual(ascending, descending.reverse(), "sorting reorders the same nodes");
            assert.equal(elements.filter((el) => el.className === "batch-result-row").length, 1_000);
            const replacement = { ...rows[0]!, result: { ...rows[0]!.result!, netProfit: -123 } };
            view.renderResultRows(dom, [replacement], null);
            const replaced = (dom.batchBacktestResults as any).children[0].children[0];
            assert.notEqual(replaced, ascending[0], "a new result object creates fresh metric content");
            assert.equal(elements.filter((el) => el.className === "batch-result-row").length, 1_001);
        } finally {
            view.cancelLiveRenderRaf();
            if (savedDocument === undefined) Reflect.deleteProperty(globalThis, "document");
            else globalThis.document = savedDocument;
            if (savedWindow === undefined) Reflect.deleteProperty(globalThis, "window");
            else globalThis.window = savedWindow;
        }
    });

});
