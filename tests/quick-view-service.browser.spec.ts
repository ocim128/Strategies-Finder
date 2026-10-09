/**
 * Quick View preparation is bounded: only the displayed 100-trade window is
 * copied/reversed regardless of total history size, full-history counts and
 * the limit notice stay accurate, both ordering modes keep their window, the
 * input array is never reordered, and replacing the result during pending
 * idle rendering cancels the stale chunks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { quickViewManager } from "../lib/quick-view/quick-view-service";
import { buildShell } from "../lib/quick-view/quick-view-renderer";
import { clearDomElementCache } from "../lib/dom-utils";
import type { BacktestResult, Trade } from "../lib/types/strategies";
import type { Time } from "lightweight-charts";

// ---------------------------------------------------------------------------
// Minimal fake browser
// ---------------------------------------------------------------------------

class FakeElement {
    id = "";
    tagName = "";
    className = "";
    textContent = "";
    value = "";
    title = "";
    hidden = false;
    isConnected = true;
    style: Record<string, string> = { display: "" };
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    private classes = new Set<string>();
    private handlers = new Map<string, Array<(event?: unknown) => void>>();
    private html = "";

    constructor(tagName = "") {
        this.tagName = tagName;
    }

    /** Real-DOM semantics: assigning innerHTML replaces all children. */
    get innerHTML(): string {
        return this.html;
    }

    set innerHTML(value: string) {
        this.html = value;
        this.children = [];
    }

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
        const node = child as FakeElement;
        node.parentNode = this;
        this.children.push(node);
        return child;
    }

    replaceChildren(...nodes: FakeElement[]): void {
        this.children = [];
        for (const node of nodes) this.appendChild(node);
    }

    contains(node: FakeElement | null): boolean {
        let cursor: FakeElement | null = node;
        while (cursor) {
            if (cursor === this) return true;
            cursor = cursor.parentNode;
        }
        return false;
    }

    removeChild(node: FakeElement): FakeElement {
        this.children = this.children.filter((child) => child !== node);
        node.parentNode = null;
        return node;
    }

    closest(selector: string): FakeElement | null {
        const classToken = selector.startsWith(".") ? selector.slice(1) : null;
        let cursor: FakeElement | null = this;
        while (cursor) {
            if (classToken !== null && cursor.classes.has(classToken)) return cursor;
            cursor = cursor.parentNode;
        }
        return null;
    }

    setAttribute(): void {}
    getAttribute(): string | null {
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
        for (const handler of [...(this.handlers.get(event.type) ?? [])]) handler(event);
        return true;
    }

    querySelector(selector: string): FakeElement | null {
        // The overlay shell is an HTML string; resolve id selectors against it
        // so runtime bindings (close, sort toggle) land on registry elements.
        const idMatch = /#([\w-]+)/.exec(selector);
        if (idMatch && this.innerHTML.includes(`id="${idMatch[1]}"`)) {
            return elementsById.get(idMatch[1]) ?? null;
        }
        return null;
    }

    querySelectorAll(): FakeElement[] {
        return [];
    }

    focus(): void {}
}

type ElementCtor = new () => object;

const harnessGlobals = ["document", "window", "Element", "HTMLElement"] as const;

let globalsSnapshot: Array<PropertyDescriptor | undefined> = [];
const elementsById = new Map<string, FakeElement>();
let chartWrapper: FakeElement;
let idleQueue: Array<(() => void) | null> = [];

function el(id: string): FakeElement {
    if (!elementsById.has(id)) elementsById.set(id, new FakeElement());
    return elementsById.get(id)!;
}

function installFakeBrowser(): void {
    globalsSnapshot = harnessGlobals.map(
        (key) => Object.getOwnPropertyDescriptor(globalThis, key)
    );
    chartWrapper = new FakeElement("div");
    chartWrapper.className = "chart-wrapper";
    (globalThis as Record<string, unknown>).document = {
        getElementById: (id: string) => el(id),
        createElement: (tag: string) => new FakeElement(tag),
        createDocumentFragment: () => new FakeElement("#fragment"),
        createRange: () => ({
            // ProgressiveListRenderer appends deferred chunks as fragments;
            // keep their HTML inspectable through innerHTML.
            createContextualFragment: (html: string) => {
                const fragment = new FakeElement("#fragment");
                fragment.innerHTML = html;
                return fragment;
            },
        }),
        querySelector: (selector: string) => (selector === ".chart-wrapper" ? chartWrapper : null),
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        head: new FakeElement("head"),
        body: new FakeElement("body"),
    };
    (globalThis as Record<string, unknown>).window = {
        requestIdleCallback: (callback: () => void) => {
            idleQueue.push(callback);
            return idleQueue.length;
        },
        cancelIdleCallback: (handle: number) => {
            idleQueue[handle - 1] = null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        location: { href: "http://localhost/" },
    };
    (globalThis as Record<string, unknown>).Element = FakeElement as unknown as ElementCtor;
    (globalThis as Record<string, unknown>).HTMLElement = FakeElement as unknown as ElementCtor;
}

function restoreBrowser(): void {
    harnessGlobals.forEach((key, index) => {
        const descriptor = globalsSnapshot[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    });
    elementsById.clear();
    idleQueue = [];
    clearDomElementCache();
}

function flushIdleQueue(): void {
    const queued = idleQueue;
    idleQueue = [];
    for (const callback of queued) callback?.();
}

// ---------------------------------------------------------------------------
// Fixtures and observation helpers
// ---------------------------------------------------------------------------

const MAX_RENDERED_TRADES = 100;

function makeTrade(index: number): Trade {
    return {
        id: index + 1,
        type: index % 2 === 0 ? "long" : "short",
        entryTime: (1_700_000_000 + index * 60) as Time,
        entryPrice: 100 + index,
        exitTime: (1_700_000_000 + index * 60 + 30) as Time,
        exitPrice: 101 + index,
        pnl: index % 3 === 0 ? -1 : 2,
        pnlPercent: index % 3 === 0 ? -0.5 : 1,
        size: 1,
        exitReason: "signal",
    };
}

function makeTrades(count: number): Trade[] {
    return Array.from({ length: count }, (_unused, index) => makeTrade(index));
}

function makeResult(trades: Trade[]): BacktestResult {
    return {
        trades,
        totalTrades: trades.length,
        equityCurve: [],
        netProfit: 10,
        netProfitPercent: 1,
        winRate: 66,
        totalWinners: 2,
        totalLosers: 1,
        winningTrades: 2,
        losingTrades: 1,
        grossProfit: 12,
        grossLoss: -2,
        maxDrawdown: 2,
        maxDrawdownPercent: 0.2,
        sharpeRatio: 1.2,
        sortinoRatio: 1.4,
        profitFactor: 6,
        averageWin: 2,
        averageLoss: -2,
        avgWin: 2,
        avgLoss: -2,
        avgTrade: 2,
        expectancy: 0.8,
        signals: [],
    } as unknown as BacktestResult;
}

function renderedHtml(): string {
    const list = el("qvTradesList");
    return [list.innerHTML, ...list.children.map((child) => child.innerHTML)].join("\n");
}

function renderedEntryTimes(): unknown[] {
    const times: unknown[] = [];
    const pattern = /data-entry-time="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(renderedHtml())) !== null) {
        times.push(JSON.parse(decodeURIComponent(match[1]!)));
    }
    return times;
}

function limitNoticeText(): string {
    const match = /Showing (\d+) of (\d+) trades/.exec(renderedHtml());
    return match ? match[0] : "";
}

/**
 * init() cannot run in the esbuild CJS bundle (`new URL(..., import.meta.url)`
 * has no valid base there), so the harness replicates its DOM wiring: inject
 * the shell overlay into the chart wrapper. Ordering modes are driven through
 * the real render path via the manager's sort state.
 */
function injectOverlayForTest(): void {
    const manager = quickViewManager as unknown as {
        overlay: FakeElement | null;
        enabled: boolean;
        sortNewestFirst: boolean;
    };
    const overlay = new FakeElement("div");
    overlay.id = "quickViewOverlay";
    overlay.innerHTML = buildShell();
    chartWrapper.appendChild(overlay);
    manager.overlay = overlay;
    manager.enabled = true;
    manager.sortNewestFirst = true;
}

function setSortNewestFirst(sortNewestFirst: boolean): void {
    (quickViewManager as unknown as { sortNewestFirst: boolean }).sortNewestFirst = sortNewestFirst;
}

before(() => {
    installFakeBrowser();
    injectOverlayForTest();
});

beforeEach(() => {
    for (const element of elementsById.values()) {
        element.innerHTML = "";
        element.children = [];
        element.textContent = "";
    }
    idleQueue = [];
});

after(() => {
    quickViewManager.destroy();
    restoreBrowser();
});

describe("Quick View bounded preparation", () => {
    it("renders the empty state for an empty history", async () => {
        await quickViewManager.show(makeResult([]));

        assert.match(el("qvTradesList").innerHTML, /No trades/);
        assert.equal(el("qvTradesCount").textContent, "0");
    });

    it("renders every trade below the cap, newest first", async () => {
        const trades = makeTrades(7);
        await quickViewManager.show(makeResult(trades));
        flushIdleQueue();

        assert.equal(renderedEntryTimes().length, 7);
        assert.deepEqual(renderedEntryTimes(), [...trades].reverse().map((trade) => trade.entryTime));
        assert.equal(limitNoticeText(), "", "below-cap histories must not show a limit notice");
        assert.equal(el("qvTradesCount").textContent, "7");
    });

    it("renders exactly the cap with no notice for an exact-cap history", async () => {
        const trades = makeTrades(MAX_RENDERED_TRADES);
        await quickViewManager.show(makeResult(trades));
        flushIdleQueue();

        assert.equal(renderedEntryTimes().length, MAX_RENDERED_TRADES);
        assert.equal(limitNoticeText(), "");
        assert.equal(el("qvTradesCount").textContent, String(MAX_RENDERED_TRADES));
    });

    it("prepares only the newest 100 of a larger history and keeps counts accurate", async () => {
        const trades = makeTrades(250);
        await quickViewManager.show(makeResult(trades));
        flushIdleQueue();

        const times = renderedEntryTimes();
        assert.equal(times.length, MAX_RENDERED_TRADES, "preparation must stay at the 100-item display window");
        assert.deepEqual(times[0], trades[249]!.entryTime, "newest first starts at the newest trade");
        assert.deepEqual(times[MAX_RENDERED_TRADES - 1], trades[150]!.entryTime, "the window ends at the oldest displayed trade");
        assert.equal(el("qvTradesCount").textContent, "250", "the count must describe full history");
        assert.equal(limitNoticeText(), "Showing 100 of 250 trades");
        // Input immutability.
        assert.equal(trades.length, 250);
        assert.deepEqual(trades.map((trade) => trade.entryTime), makeTrades(250).map((trade) => trade.entryTime));
    });

    it("keeps the displayed window anchored to the oldest trades in oldest-first mode", async () => {
        const trades = makeTrades(250);
        await quickViewManager.show(makeResult(trades));
        flushIdleQueue();

        setSortNewestFirst(false);
        await quickViewManager.show(makeResult(trades));
        flushIdleQueue();

        const times = renderedEntryTimes();
        assert.equal(times.length, MAX_RENDERED_TRADES);
        assert.deepEqual(times[0], trades[0]!.entryTime, "oldest first starts at the oldest trade");
        assert.deepEqual(times[MAX_RENDERED_TRADES - 1], trades[99]!.entryTime);
        assert.equal(el("qvSortLabel").textContent, "Oldest first");
        assert.equal(el("qvTradesCount").textContent, "250");
        assert.equal(limitNoticeText(), "Showing 100 of 250 trades");
        assert.equal(trades.length, 250, "the input array must stay untouched");

        setSortNewestFirst(true);
    });

    it("replaces pending idle rendering when a newer result arrives", async () => {
        const first = makeTrades(250);
        await quickViewManager.show(makeResult(first));
        assert.ok(idleQueue.length > 0, "the first render should have deferred chunks pending");

        const second = makeTrades(120).map((trade, index) => ({
            ...trade,
            entryTime: (9_000_000_000 + index * 60) as Time,
        }));
        await quickViewManager.show(makeResult(second));
        flushIdleQueue();

        const times = renderedEntryTimes();
        assert.equal(times.length, MAX_RENDERED_TRADES);
        assert.ok(
            times.every((time) => (time as number) >= 9_000_000_000),
            "no stale chunk from the replaced render may land"
        );
        assert.equal(el("qvTradesCount").textContent, "120");
        assert.equal(limitNoticeText(), "Showing 100 of 120 trades");
    });

    it("keeps preparation constant for a very large history", async () => {
        const trades = makeTrades(5_000);
        await quickViewManager.show(makeResult(trades));
        flushIdleQueue();

        assert.equal(renderedEntryTimes().length, MAX_RENDERED_TRADES);
        assert.equal(el("qvTradesCount").textContent, "5000");
        assert.equal(limitNoticeText(), `Showing 100 of 5000 trades`);
    });
});
