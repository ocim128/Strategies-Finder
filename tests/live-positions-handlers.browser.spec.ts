/**
 * Live-position detail modal behavior:
 *  - Phase 5 (zero P&L): a closed trade with zero realized P&L shows a numeric
 *    result in the details, matching its card, instead of the missing-value
 *    sentinel; missing values stay distinct from zero.
 *  - Phase 6 (response ownership): only the current open request may write
 *    detail content, title, or loading state — slower older results, closes
 *    (button or controller-level), disposal, and reinitialization cannot
 *    write into a newer or closed modal.
 *
 * The harness drives the real handlers against a fake DOM and patches the
 * live-positions service surface (state + getPositionDetails) with controlled
 * deferred promises. No real delays are used.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
    disposeLivePositionsHandlers,
    initLivePositionsHandlers,
} from "../lib/handlers/live-positions-handlers";
import { livePositionsService, type ClosedTrade } from "../lib/live-positions-service";
import { clearDomElementCache } from "../lib/dom-utils";
import { flushMicrotasks } from "./helpers/flush-microtasks";

// ---------------------------------------------------------------------------
// Minimal fake browser
// ---------------------------------------------------------------------------

class FakeElement {
    id = "";
    tagName = "";
    textContent = "";
    value = "";
    title = "";
    type = "";
    hidden = false;
    disabled = false;
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

    get className(): string {
        return [...this.classes].join(" ");
    }

    set className(value: string) {
        this.classes = new Set(value.split(/\s+/).filter(Boolean));
    }

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

    append(...nodes: FakeElement[]): void {
        for (const node of nodes) this.appendChild(node);
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

    closest(selector: string): FakeElement | null {
        const classToken = selector.startsWith(".") ? selector.slice(1) : null;
        let cursor: FakeElement | null = this;
        while (cursor) {
            if (classToken !== null && cursor.classes.has(classToken)) return cursor;
            cursor = cursor.parentNode;
        }
        return null;
    }

    setAttribute(name: string, value: string): void {
        if (name === "aria-pressed") {
            (this as unknown as { ariaPressed?: string }).ariaPressed = value;
        }
    }

    getAttribute(): string | null {
        return null;
    }

    hasAttribute(): boolean {
        return false;
    }

    addEventListener(type: string, handler: (event?: unknown) => void): void {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
    }

    /** Re-init re-binds listeners on persistent fake elements; drop old ones. */
    clearHandlers(): void {
        this.handlers.clear();
    }

    removeEventListener(type: string, handler: (event?: unknown) => void): void {
        const list = this.handlers.get(type);
        if (list) this.handlers.set(type, list.filter((entry) => entry !== handler));
    }

    dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
        for (const handler of [...(this.handlers.get(event.type) ?? [])]) handler(event);
        return true;
    }

    querySelector(): FakeElement | null {
        return null;
    }

    querySelectorAll(): FakeElement[] {
        return [];
    }

    focus(): void {}
}

type ElementCtor = new () => object;

const harnessGlobals = [
    "document",
    "window",
    "localStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
] as const;

let globalsSnapshot: Array<PropertyDescriptor | undefined> = [];
const elementsById = new Map<string, FakeElement>();
const localStorageStore = new Map<string, string>();

function el(id: string): FakeElement {
    if (!elementsById.has(id)) elementsById.set(id, new FakeElement());
    return elementsById.get(id)!;
}

function installFakeBrowser(): void {
    globalsSnapshot = harnessGlobals.map(
        (key) => Object.getOwnPropertyDescriptor(globalThis, key)
    );
    localStorageStore.clear();
    (globalThis as Record<string, unknown>).document = {
        getElementById: (id: string) => el(id),
        createElement: (tag: string) => new FakeElement(tag),
        createDocumentFragment: () => new FakeElement("#fragment"),
        addEventListener: () => {},
        removeEventListener: () => {},
        head: new FakeElement("head"),
        body: new FakeElement("body"),
    };
    (globalThis as Record<string, unknown>).window = {
        requestAnimationFrame: (_callback: () => void) => 1, // never flushes
        cancelAnimationFrame: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        location: { href: "http://localhost/" },
    };
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (key: string) => localStorageStore.get(key) ?? null,
        setItem: (key: string, value: string) => void localStorageStore.set(key, value),
        removeItem: (key: string) => void localStorageStore.delete(key),
    };
    // modal-accessibility calls requestAnimationFrame as a bare global.
    (globalThis as Record<string, unknown>).requestAnimationFrame = (_callback: () => void) => 1;
    (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
    for (const typeName of ["Element", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement"]) {
        (globalThis as Record<string, unknown>)[typeName] = FakeElement as unknown as ElementCtor;
    }
}

function restoreBrowser(): void {
    harnessGlobals.forEach((key, index) => {
        const descriptor = globalsSnapshot[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    });
    elementsById.clear();
    localStorageStore.clear();
    clearDomElementCache();
}

// ---------------------------------------------------------------------------
// Service surface patches (state + controlled getPositionDetails)
// ---------------------------------------------------------------------------

type DetailResult = { position: ClosedTrade | null; localTrades: never[]; workerSignals: never[] };
type DetailRequest = {
    streamId: string;
    resolve: (value: DetailResult) => void;
    reject: (error: unknown) => void;
};

let serviceListener: ((state: unknown) => void) | null = null;
let currentState: unknown = null;
let detailRequests: DetailRequest[] = [];
const originalService = {
    getState: livePositionsService.getState,
    subscribe: livePositionsService.subscribe.bind(livePositionsService),
    getPositionDetails: livePositionsService.getPositionDetails.bind(livePositionsService),
    startPolling: livePositionsService.startPolling.bind(livePositionsService),
    stopPolling: livePositionsService.stopPolling.bind(livePositionsService),
};

function emptyServiceState(): unknown {
    return {
        positions: [],
        closedTrades: [],
        lastPollTime: null,
        isPolling: false,
        viewMode: "closed",
        error: null,
    };
}

function installServicePatches(): void {
    livePositionsService.getState = (() => currentState ?? emptyServiceState()) as typeof livePositionsService.getState;
    livePositionsService.subscribe = ((listener: (state: unknown) => void) => {
        serviceListener = listener;
        return () => {
            if (serviceListener === listener) serviceListener = null;
        };
    }) as typeof livePositionsService.subscribe;
    livePositionsService.getPositionDetails = ((streamId: string) =>
        new Promise<DetailResult>((resolve, reject) => {
            detailRequests.push({ streamId, resolve, reject });
        })) as typeof livePositionsService.getPositionDetails;
    livePositionsService.startPolling = (() => {}) as typeof livePositionsService.startPolling;
    livePositionsService.stopPolling = (() => {}) as typeof livePositionsService.stopPolling;
}

function restoreServicePatches(): void {
    livePositionsService.getState = originalService.getState;
    livePositionsService.subscribe = originalService.subscribe;
    livePositionsService.getPositionDetails = originalService.getPositionDetails;
    livePositionsService.startPolling = originalService.startPolling;
    livePositionsService.stopPolling = originalService.stopPolling;
    serviceListener = null;
    currentState = null;
    detailRequests = [];
}

// ---------------------------------------------------------------------------
// Fixtures and observation helpers
// ---------------------------------------------------------------------------

function makeClosedTrade(overrides: Partial<ClosedTrade>): ClosedTrade {
    return {
        streamId: "stream-under-test",
        symbol: "ETHUSDT",
        interval: "5m",
        strategyKey: "ema_test",
        strategyParams: {},
        backtestSettings: {},
        configName: null,
        direction: "long",
        entryPrice: 100,
        entryTime: 1_700_000_000,
        currentPrice: 100,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        stopLossPrice: null,
        takeProfitPrice: null,
        isOpen: false,
        lastSignalFromWorker: null,
        localBacktestTrade: null,
        mismatch: false,
        mismatchReason: null,
        lastUpdated: 0,
        exitPrice: 0,
        exitTime: 1_700_000_060,
        realizedPnl: 0,
        realizedPnlPercent: 0,
        exitReason: "signal",
        ...overrides,
    } as ClosedTrade;
}

function emitClosedTradeState(trades: ClosedTrade[]): void {
    currentState = {
        positions: [],
        closedTrades: trades,
        lastPollTime: null,
        isPolling: false,
        viewMode: "closed",
        error: null,
    };
    serviceListener?.(currentState);
}

function closedTradeCard(): FakeElement {
    const card = el("lpList").children[0];
    assert.ok(card, "expected the closed trade card to render");
    return card;
}

function cardResult(): { cls: string; text: string } {
    const match = /lp-pos-value\s+(pnl-[a-z]+)"[^>]*>\s*([^<]+?)\s*<\/span>/.exec(
        closedTradeCard().innerHTML
    );
    assert.ok(match, "expected the card result row to render");
    return { cls: match[1]!, text: match[2]! };
}

function detailTitle(): string {
    return el("lpDetailTitle").textContent;
}

function detailPnl(): { cls: string; text: string } | null {
    const match = /<span class="label">P&L<\/span>\s*<span class="value ([a-z]+)">([^<]+)<\/span>/.exec(
        el("lpDetailContent").innerHTML
    );
    return match ? { cls: match[1]!, text: match[2]! } : null;
}

function detailExitPrice(): string | null {
    const match = /<h4>Exit<\/h4>[\s\S]*?<span class="label">Price<\/span>\s*<span class="value">([^<]+)<\/span>/.exec(
        el("lpDetailContent").innerHTML
    );
    return match ? match[1]! : null;
}

function closedTradeCardFor(streamId: string): FakeElement {
    const card = el("lpList").children.find((child) => child.dataset.positionId === streamId);
    assert.ok(card, `expected a rendered card for ${streamId}`);
    return card;
}

function openDetail(streamId: string): void {
    el("lpList").dispatchEvent({ type: "dblclick", target: closedTradeCardFor(streamId) });
}

/** Settle the NEWEST pending request for the stream, matching user intent. */
function settleDetail(streamId: string, value: DetailResult): void {
    const index = detailRequests.map((request) => request.streamId).lastIndexOf(streamId);
    assert.ok(index !== -1, `expected a pending detail request for ${streamId}`);
    const [request] = detailRequests.splice(index, 1);
    request!.resolve(value);
}

function rejectDetail(streamId: string, error: unknown): void {
    const index = detailRequests.map((request) => request.streamId).lastIndexOf(streamId);
    assert.ok(index !== -1, `expected a pending detail request for ${streamId}`);
    const [request] = detailRequests.splice(index, 1);
    request!.reject(error);
}

before(() => {
    installFakeBrowser();
    installServicePatches();
});

beforeEach(() => {
    for (const element of elementsById.values()) {
        element.innerHTML = "";
        element.textContent = "";
        element.children = [];
        element.className = "";
        element.classList.remove("active");
        element.clearHandlers();
    }
    detailRequests = [];
    initLivePositionsHandlers();
});

afterEach(() => {
    disposeLivePositionsHandlers();
});

after(() => {
    restoreServicePatches();
    restoreBrowser();
});

describe("zero and missing position detail values", () => {
    it("shows a numeric zero result matching the card instead of the missing sentinel", async () => {
        emitClosedTradeState([makeClosedTrade({})]);
        openDetail("stream-under-test");
        settleDetail("stream-under-test", { position: makeClosedTrade({}), localTrades: [], workerSignals: [] });
        await flushMicrotasks();

        const card = cardResult();
        const detail = detailPnl();
        assert.ok(detail, "expected the detail result row to render");
        assert.equal(detail.text, "+0.00 (+0.00%)", "zero P&L must not collapse to the '-' sentinel");
        assert.equal(detail.cls, "positive");
        assert.equal(detail.text, card.text, "zero P&L must agree with the card");
        assert.equal(detailExitPrice(), "0", "a zero exit price is a value, not a missing one");
    });

    it("renders positive and negative realized results unchanged", async () => {
        emitClosedTradeState([makeClosedTrade({ realizedPnl: 12.5, realizedPnlPercent: 2.5, exitPrice: 105 })]);
        openDetail("stream-under-test");
        settleDetail("stream-under-test", {
            position: makeClosedTrade({ realizedPnl: 12.5, realizedPnlPercent: 2.5, exitPrice: 105 }),
            localTrades: [], workerSignals: [],
        });
        await flushMicrotasks();

        assert.deepEqual(detailPnl(), { cls: "positive", text: "+12.50 (+2.50%)" });
        assert.equal(detailExitPrice(), "105");

        emitClosedTradeState([makeClosedTrade({ realizedPnl: -3, realizedPnlPercent: -1.5, exitPrice: 95 })]);
        openDetail("stream-under-test");
        settleDetail("stream-under-test", {
            position: makeClosedTrade({ realizedPnl: -3, realizedPnlPercent: -1.5, exitPrice: 95 }),
            localTrades: [], workerSignals: [],
        });
        await flushMicrotasks();

        assert.deepEqual(detailPnl(), { cls: "negative", text: "-3.00 (-1.50%)" });
        assert.equal(detailExitPrice(), "95");
    });

    it("keeps missing values distinct from zero", async () => {
        const missing = {
            realizedPnl: null,
            realizedPnlPercent: null,
            exitPrice: null,
        } as unknown as Partial<ClosedTrade>;
        emitClosedTradeState([makeClosedTrade(missing)]);
        openDetail("stream-under-test");
        settleDetail("stream-under-test", { position: makeClosedTrade(missing), localTrades: [], workerSignals: [] });
        await flushMicrotasks();

        assert.deepEqual(detailPnl(), { cls: "positive", text: "-" }, "missing P&L keeps the '-' sentinel");
        assert.equal(detailExitPrice(), "-", "missing exit price keeps the '-' sentinel");
    });
});

describe("position-detail response ownership", () => {
    function detailPositionFixture(streamId: string, symbol: string): DetailResult {
        return {
            position: makeClosedTrade({ streamId, symbol, realizedPnl: 7, realizedPnlPercent: 1 }),
            localTrades: [], workerSignals: [],
        };
    }

    it("lets a fast newer request win over a slower older one", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" }), makeClosedTrade({ streamId: "pos-b" })]);
        openDetail("pos-a");
        openDetail("pos-b");

        settleDetail("pos-b", detailPositionFixture("pos-b", "BTCUSDT"));
        await flushMicrotasks();
        assert.match(detailTitle(), /^BTCUSDT 5m - Position Details$/);

        settleDetail("pos-a", detailPositionFixture("pos-a", "ETHUSDT"));
        await flushMicrotasks();
        assert.match(detailTitle(), /^BTCUSDT 5m - Position Details$/, "the stale response must not replace the newer details");
        assert.deepEqual(detailPnl(), { cls: "positive", text: "+7.00 (+1.00%)" });
    });

    it("ignores a stale failure after a newer response succeeded", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" }), makeClosedTrade({ streamId: "pos-b" })]);
        openDetail("pos-a");
        openDetail("pos-b");
        settleDetail("pos-b", detailPositionFixture("pos-b", "BTCUSDT"));
        await flushMicrotasks();
        const contentAfterB = el("lpDetailContent").innerHTML;

        rejectDetail("pos-a", new Error("stale boom"));
        await flushMicrotasks();

        assert.equal(el("lpDetailContent").innerHTML, contentAfterB, "a stale error must not write the error state");
        assert.doesNotMatch(el("lpDetailContent").innerHTML, /Error loading details/);
    });

    it("does not write content after an explicit close during a load", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" })]);
        openDetail("pos-a");
        el("lpDetailClose").dispatchEvent({ type: "click" });

        settleDetail("pos-a", detailPositionFixture("pos-a", "ETHUSDT"));
        await flushMicrotasks();

        assert.equal(el("lpDetailTitle").textContent, "", "a closed modal must not receive a title");
        assert.equal(el("lpDetailContent").innerHTML, "", "a closed modal must not receive content");
    });

    it("does not write content when the modal was closed without closeDetailModal (Escape path)", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" })]);
        openDetail("pos-a");
        // modal-accessibility's Escape handler calls controller.close()
        // directly; simulate the resulting closed overlay state.
        el("lpDetailModal").classList.remove("active");

        settleDetail("pos-a", detailPositionFixture("pos-a", "ETHUSDT"));
        await flushMicrotasks();

        assert.equal(el("lpDetailTitle").textContent, "");
        assert.equal(el("lpDetailContent").innerHTML, "");
    });

    it("accepts a fresh response after closing and reopening the same stream", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" })]);
        openDetail("pos-a");
        el("lpDetailClose").dispatchEvent({ type: "click" });
        openDetail("pos-a");

        settleDetail("pos-a", detailPositionFixture("pos-a", "ETHUSDT"));
        await flushMicrotasks();

        assert.match(detailTitle(), /^ETHUSDT 5m - Position Details$/);
        assert.deepEqual(detailPnl(), { cls: "positive", text: "+7.00 (+1.00%)" });
    });

    it("renders the not-found state for a current request", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-missing" })]);
        openDetail("pos-missing");
        settleDetail("pos-missing", { position: null, localTrades: [], workerSignals: [] });
        await flushMicrotasks();

        assert.match(el("lpDetailContent").innerHTML, /Position not found/);
    });

    it("does not write after disposal, and works again after reinitialization", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" })]);
        openDetail("pos-a");
        disposeLivePositionsHandlers();

        settleDetail("pos-a", detailPositionFixture("pos-a", "ETHUSDT"));
        await flushMicrotasks();
        assert.equal(el("lpDetailContent").innerHTML, "", "disposal must invalidate in-flight requests");

        // Reinitialization re-binds listeners, so drop the stale bindings
        // first (mirrors a fresh page load where no old listeners exist).
        for (const element of elementsById.values()) element.clearHandlers();
        initLivePositionsHandlers();
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-b" })]);
        openDetail("pos-b");
        settleDetail("pos-b", detailPositionFixture("pos-b", "BTCUSDT"));
        await flushMicrotasks();
        assert.match(detailTitle(), /^BTCUSDT 5m - Position Details$/);
    });

    it("leaves no detail request pending behind stale opens", async () => {
        emitClosedTradeState([makeClosedTrade({ streamId: "pos-a" }), makeClosedTrade({ streamId: "pos-b" })]);
        openDetail("pos-a");
        openDetail("pos-b");
        settleDetail("pos-b", detailPositionFixture("pos-b", "BTCUSDT"));
        settleDetail("pos-a", detailPositionFixture("pos-a", "ETHUSDT"));
        await flushMicrotasks();

        assert.equal(detailRequests.length, 0, "every open must settle exactly one request");
        assert.equal(el("lpDetailLoading").style.display, "none");
    });
});

