/**
 * Trade navigation through the shared `jumpToTrade` callback created in
 * setupStateSubscriptions (the same callback instance is handed to the Trades
 * list). The callback must resolve equivalent timestamp shapes
 * through the canonical candle time index and keep the ±20-bar visible range
 * behavior as datasets are replaced, appended to, and head-evicted.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { setupStateSubscriptions } from "../lib/handlers/state-subscriptions";
import { state } from "../lib/state";
import { waitFor } from "./helpers/wait-for";
import type { OHLCVData, Trade, Time } from "../lib/types/strategies";

// ---------------------------------------------------------------------------
// Minimal fake DOM (extends a global Element so `instanceof Element` works)
// ---------------------------------------------------------------------------

class FakeDomNode {
    id = "";
    className = "";
    textContent = "";
    innerHTML = "";
    value = "";
    title = "";
    hidden = false;
    isConnected = true;
    disabled = false;
    style: Record<string, string> = { display: "" };
    dataset: Record<string, string> = {};
    children: FakeDomNode[] = [];
    parentNode: FakeDomNode | null = null;
    private classes = new Set<string>();
    private handlers = new Map<string, Array<(event?: unknown) => void>>();

    get classList() {
        const classes = this.classes;
        return {
            add: (...names: string[]) => names.forEach((name) => classes.add(name)),
            remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
            toggle: (name: string, force = !classes.has(name)) => {
                if (force) classes.add(name);
                else classes.delete(name);
                return force;
            },
            contains: (name: string) => classes.has(name),
        };
    }

    appendChild<T>(child: T): T {
        const node = child as FakeDomNode;
        node.parentNode = this;
        this.children.push(node);
        return child;
    }

    replaceChildren(...nodes: FakeDomNode[]): void {
        this.children = [...nodes];
        nodes.forEach((node) => { node.parentNode = this; });
    }

    contains(node: FakeDomNode | null): boolean {
        let cursor: FakeDomNode | null = node;
        while (cursor) {
            if (cursor === this) return true;
            cursor = cursor.parentNode;
        }
        return false;
    }

    closest(selector: string): FakeDomNode | null {
        const classToken = selector.startsWith(".")
            ? selector.slice(1)
            : null;
        let cursor: FakeDomNode | null = this;
        while (cursor) {
            if (classToken !== null && cursor.classes.has(classToken)) return cursor;
            cursor = cursor.parentNode;
        }
        return null;
    }

    addEventListener(type: string, handler: (event?: unknown) => void): void {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
    }

    removeEventListener(type: string, handler: (event?: unknown) => void): void {
        const list = this.handlers.get(type);
        if (list) this.handlers.set(type, list.filter((entry) => entry !== handler));
    }

    dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
        for (const handler of this.handlers.get(event.type) ?? []) handler(event);
        return true;
    }

    setAttribute(name: string, value: string): void {
        if (name === "class") this.className = value;
    }

    getAttribute(_name: string): string | null {
        return null;
    }

    focus(): void {}

    querySelector(): FakeDomNode | null {
        return null;
    }

    querySelectorAll(): FakeDomNode[] {
        return [];
    }
}

type ElementCtor = new () => object;

const harnessGlobals = [
    "document",
    "window",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
] as const;

let globalsSnapshot: Array<PropertyDescriptor | undefined> = [];
const elementsById = new Map<string, FakeDomNode>();
const visibleLogicalRanges: Array<{ from: number; to: number }> = [];

const fakeTimeScale = {
    setVisibleLogicalRange: (range: { from: number; to: number }) => {
        visibleLogicalRanges.push(range);
    },
    scrollPosition: () => 0,
    scrollToPosition: () => {},
    fitContent: () => {},
    getVisibleLogicalRange: () => null,
};
const fakeChart = { timeScale: () => fakeTimeScale };

function fakeDocument(): Record<string, unknown> {
    return {
        getElementById: (id: string) => {
            if (!elementsById.has(id)) elementsById.set(id, new FakeDomNode());
            return elementsById.get(id)!;
        },
        createElement: () => new FakeDomNode(),
        createDocumentFragment: () => new FakeDomNode(),
        createRange: () => ({ createContextualFragment: () => new FakeDomNode() }),
        head: new FakeDomNode(),
        body: new FakeDomNode(),
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

const fakeWindow = {
    requestAnimationFrame: (_callback: () => void) => 1, // never flushes
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { href: "http://localhost/" },
};

function installFakeBrowser(): void {
    globalsSnapshot = harnessGlobals.map(
        (key) => Object.getOwnPropertyDescriptor(globalThis, key)
    );
    (globalThis as Record<string, unknown>).document = fakeDocument();
    (globalThis as Record<string, unknown>).window = fakeWindow;
    // DOM element-type globals: production code uses instanceof checks against
    // these when resolving typed elements (e.g. executionModel select).
    (globalThis as Record<string, unknown>).Element = FakeDomNode as unknown as ElementCtor;
    (globalThis as Record<string, unknown>).HTMLElement = FakeDomNode as unknown as ElementCtor;
    (globalThis as Record<string, unknown>).HTMLInputElement = FakeDomNode as unknown as ElementCtor;
    (globalThis as Record<string, unknown>).HTMLSelectElement = FakeDomNode as unknown as ElementCtor;
    (globalThis as Record<string, unknown>).HTMLButtonElement = FakeDomNode as unknown as ElementCtor;
}

function restoreBrowser(): void {
    harnessGlobals.forEach((key, index) => {
        const descriptor = globalsSnapshot[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    });
    elementsById.clear();
    visibleLogicalRanges.length = 0;
}
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TIME_SECONDS = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);

function makeCandles(count: number, startSeconds = BASE_TIME_SECONDS, stepSeconds = 60): OHLCVData[] {
    const candles: OHLCVData[] = [];
    for (let index = 0; index < count; index += 1) {
        const time = (startSeconds + index * stepSeconds) as Time;
        candles.push({ time, open: 100, high: 110, low: 95, close: 105, volume: 10 });
    }
    return candles;
}

function makeTrade(entryTime: Time): Trade {
    return {
        id: 1,
        type: "long",
        entryTime,
        entryPrice: 100,
        exitTime: entryTime,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "signal",
    };
}

function makeResult(trades: Trade[]): any {
    return {
        trades,
        totalTrades: trades.length,
        equityCurve: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 100,
        totalWinners: trades.length,
        totalLosers: 0,
        grossProfit: 0,
        grossLoss: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        profitFactor: 0,
        averageWin: 0,
        averageLoss: 0,
        expectancy: 0,
        signals: [],
    };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tradesList(): FakeDomNode {
    return elementsById.get("tradesList")!;
}

function tradesTab(): FakeDomNode {
    return elementsById.get("tradesTab")!;
}

function appendTradeItem(entryTime: Time): FakeDomNode {
    const item = new FakeDomNode();
    item.classList.add("trade-item");
    item.dataset.entryTime = encodeURIComponent(JSON.stringify(entryTime));
    tradesList().appendChild(item);
    return item;
}

function clickTradeItem(item: FakeDomNode): void {
    tradesList().dispatchEvent({ type: "click", target: item });
}

async function renderTradesThroughRealSubscription(trades: Trade[]): Promise<void> {
    visibleLogicalRanges.length = 0;
    state.set("currentBacktestResult", makeResult(trades));
    await waitFor(
        () => tradesList().innerHTML.includes("trade-item") || trades.length === 0,
        2000,
        "trades list to render the shared jumpToTrade callback"
    );
}

function lastRange(): { from: number; to: number } | null {
    return visibleLogicalRanges.length > 0
        ? visibleLogicalRanges[visibleLogicalRanges.length - 1]!
        : null;
}

// Renderer and UI-manager singletons cache their resolved DOM, so the fake
// browser (and its element registry) is installed once for the whole suite and
// only the observable state is reset per test.
before(() => {
    installFakeBrowser();
    const tradesTab = new FakeDomNode();
    elementsById.set("tradesTab", tradesTab);
    (state as unknown as { chart: unknown }).chart = fakeChart;
    (state as unknown as { equityChart: unknown }).equityChart = fakeChart;
    setupStateSubscriptions();
});

beforeEach(() => {
    state.ohlcvData = [];
    state.currentBacktestResult = null;
    tradesTab().hidden = false;
    tradesTab().style.display = "block";
    for (const element of elementsById.values()) {
        element.innerHTML = "";
        element.textContent = "";
        element.children = [];
    }
    visibleLogicalRanges.length = 0;
});

after(() => {
    state.currentBacktestResult = null;
    state.ohlcvData = [];
    (state as unknown as { chart: unknown }).chart = undefined;
    (state as unknown as { equityChart: unknown }).equityChart = undefined;
    restoreBrowser();
});

describe("trade navigation through the shared jumpToTrade callback", () => {
    it("jumps to index zero and the last candle with the ±20-bar padding", async () => {
        state.ohlcvData = makeCandles(50);
        const trades = [makeTrade(state.ohlcvData[0]!.time), makeTrade(state.ohlcvData[49]!.time)];
        await renderTradesThroughRealSubscription(trades);

        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(state.ohlcvData[0]!.time));
        assert.deepEqual(lastRange(), { from: 0, to: 20 }, "index zero is valid and clamps at zero");

        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(state.ohlcvData[49]!.time));
        assert.deepEqual(lastRange(), { from: 29, to: 49 }, "last candle clamps at the end");
    });

    it("ignores unknown times without touching the visible range", async () => {
        state.ohlcvData = makeCandles(50);
        await renderTradesThroughRealSubscription([makeTrade(state.ohlcvData[10]!.time)]);

        visibleLogicalRanges.length = 0;
        const unknownSeconds = (BASE_TIME_SECONDS + 60 * 500) as Time;
        clickTradeItem(appendTradeItem(unknownSeconds));
        assert.equal(lastRange(), null, "an unknown time must not change the visible range");
    });

    it("resolves a cloned BusinessDay to the equivalent UTC-midnight candle", async () => {
        state.ohlcvData = makeCandles(50);
        await renderTradesThroughRealSubscription([makeTrade(state.ohlcvData[0]!.time)]);

        const clonedBusinessDay = { year: 2024, month: 1, day: 2 };
        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(clonedBusinessDay as Time));
        assert.deepEqual(lastRange(), { from: 0, to: 20 }, "a structurally equal clone must hit the index");
    });

    it("treats ISO strings, milliseconds, and seconds as equivalent times", async () => {
        state.ohlcvData = makeCandles(50);
        const seconds25 = state.ohlcvData[25]!.time;
        await renderTradesThroughRealSubscription([makeTrade(seconds25)]);

        for (const equivalent of [
            seconds25,
            "2024-01-02T00:25:00.000Z" as Time,
            ((seconds25 as number) * 1000) as Time,
        ]) {
            visibleLogicalRanges.length = 0;
            clickTradeItem(appendTradeItem(equivalent));
            assert.deepEqual(lastRange(), { from: 5, to: 45 });
        }
    });

    it("navigates a replaced dataset through a rebuilt index", async () => {
        state.ohlcvData = makeCandles(50);
        await renderTradesThroughRealSubscription([makeTrade(state.ohlcvData[0]!.time)]);

        // Replacement: a fresh array on a different grid (new hour base, 5-min steps).
        const replacedStart = BASE_TIME_SECONDS + 3600;
        state.ohlcvData = makeCandles(30, replacedStart, 300);
        await renderTradesThroughRealSubscription([makeTrade(state.ohlcvData[10]!.time)]);

        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(state.ohlcvData[10]!.time));
        assert.deepEqual(lastRange(), { from: 0, to: 29 }, "replacement must rebind indices on the new dataset");

        // A timestamp that only existed in the replaced dataset is gone.
        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(BASE_TIME_SECONDS as Time));
        assert.equal(lastRange(), null, "stale timestamps from the previous dataset must not navigate");
    });

    it("keeps navigation correct after a realtime append", async () => {
        const candles = makeCandles(50);
        state.ohlcvData = candles;
        await renderTradesThroughRealSubscription([makeTrade(candles[0]!.time)]);

        const appended = ((BASE_TIME_SECONDS + 50 * 60) as Time);
        candles.push({ time: appended, open: 100, high: 110, low: 95, close: 105, volume: 10 });

        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(appended));
        assert.deepEqual(lastRange(), { from: 30, to: 50 }, "appended candle must be reachable with clamped padding");
    });

    it("remaps indices after rolling-window head eviction", async () => {
        const candles = makeCandles(50);
        state.ohlcvData = candles;
        await renderTradesThroughRealSubscription([makeTrade(candles[25]!.time)]);

        candles.splice(0, 10);

        // The same timestamp (old index 25) now lives at index 15.
        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem((BASE_TIME_SECONDS + 25 * 60) as Time));
        assert.deepEqual(
            lastRange(),
            { from: 0, to: 35 },
            "the unchanged timestamp must map to its shifted index after eviction"
        );

        // The element now at index 25 keeps a centered-enough window.
        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(candles[25]!.time));
        assert.deepEqual(lastRange(), { from: 5, to: 39 });

        // The evicted timestamp is no longer navigable.
        visibleLogicalRanges.length = 0;
        clickTradeItem(appendTradeItem(BASE_TIME_SECONDS as Time));
        assert.equal(lastRange(), null);
    });
});
