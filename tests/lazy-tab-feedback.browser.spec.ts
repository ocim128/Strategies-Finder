/**
 * Lazy-tab activation feedback and recovery (phase 7):
 *  - loading feedback appears on the tab while markup/feature activation runs
 *    and survives the placeholder -> content swap until the initializer
 *    settles; only success removes it (aria-busy mirrors the same lifecycle);
 *  - missing/invalid tab markup is an activation failure (the feature callback
 *    never ran) and offers Retry + Reload; repeated Retry clicks start one
 *    activation and a later success restores the tab and its mounted nodes;
 *  - a feature-callback failure offers Reload only and suppresses implicit
 *    tab-switch retries;
 *  - a slow activation on one tab does not disturb another tab, and reset
 *    clears feedback and failure state.
 *
 * The harness drives the real lazy-feature-init + strategy-panel-tab-markup
 * modules against a fake DOM. `?raw` partial imports are bundled as text by
 * the test runner; the fake template element decides per test whether the
 * loaded partial exposes its `#${tabId}Tab` root. No real delays are used.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    activateLazyFeature,
    attachTabLazyListener,
    isLazyFeatureInitialized,
    registerLazyFeature,
    resetLazyFeatureInitState,
} from "../lib/lazy-feature-init";
import { supportsLazyMarkupRetry } from "../lib/strategy-panel-tab-markup";
import { flushMicrotasks } from "./helpers/flush-microtasks";

// ---------------------------------------------------------------------------
// Minimal fake browser
// ---------------------------------------------------------------------------

class FakeElement {
    id = "";
    tagName = "";
    textContent = "";
    type = "";
    hidden = false;
    disabled = false;
    style: Record<string, string> = { display: "" };
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    private classNames = "";
    private attributes = new Map<string, string>();
    private handlers = new Map<string, Array<() => void>>();

    constructor(tagName = "") {
        this.tagName = tagName;
    }

    get className(): string {
        return this.classNames;
    }

    set className(value: string) {
        this.classNames = value;
    }

    hasClass(name: string): boolean {
        return this.classNames.split(/\s+/).includes(name);
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
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

    remove(): void {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
            this.parentNode = null;
        }
    }

    addEventListener(type: string, handler: () => void): void {
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
    }

    dispatchEvent(event: { type: string }): boolean {
        for (const handler of [...(this.handlers.get(event.type) ?? [])]) handler();
        return true;
    }

    /** bindFormAccessibility probes the swapped panel for form structure. */
    querySelector(): null {
        return null;
    }

    querySelectorAll(): FakeElement[] {
        return [];
    }
}

type FakeLoadedPanel = {
    childNodes: FakeElement[];
    className: string;
    attributes: Array<{ name: string; value: string }>;
};

const harnessGlobals = ["document", "window"] as const;

let globalsSnapshot: Array<PropertyDescriptor | undefined> = [];
const elementsById = new Map<string, FakeElement>();
let nextLoadedPanel: FakeLoadedPanel | null = null;
let reloadCount = 0;
let windowHandlers = new Map<string, Array<(event: unknown) => void>>();

function installFakeBrowser(): void {
    globalsSnapshot = harnessGlobals.map(
        (key) => Object.getOwnPropertyDescriptor(globalThis, key)
    );
    (globalThis as Record<string, unknown>).document = {
        getElementById: (id: string) => elementsById.get(id) ?? null,
        createElement: (tag: string) => {
            if (tag === "template") {
                // The bundle inlines the real partial text; the harness decides
                // whether its #${tabId}Tab root is "found".
                return {
                    set innerHTML(_value: string) {},
                    content: { querySelector: () => nextLoadedPanel },
                };
            }
            return new FakeElement(tag);
        },
    };
    (globalThis as Record<string, unknown>).window = {
        addEventListener: (type: string, handler: (event: unknown) => void) => {
            const list = windowHandlers.get(type) ?? [];
            list.push(handler);
            windowHandlers.set(type, list);
        },
        removeEventListener: (type: string, handler: (event: unknown) => void) => {
            const list = windowHandlers.get(type);
            if (list) windowHandlers.set(type, list.filter((entry) => entry !== handler));
        },
        dispatchEvent: (event: { type: string }) => {
            for (const handler of [...(windowHandlers.get(event.type) ?? [])]) handler(event);
            return true;
        },
        location: {
            reload: () => {
                reloadCount += 1;
            },
        },
    };
}

function restoreBrowser(): void {
    harnessGlobals.forEach((key, index) => {
        const descriptor = globalsSnapshot[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    });
    elementsById.clear();
    windowHandlers = new Map();
    nextLoadedPanel = null;
    reloadCount = 0;
}

// ---------------------------------------------------------------------------
// Fixtures and observation helpers
// ---------------------------------------------------------------------------

function mountPlaceholder(tabId: string): FakeElement {
    const panel = new FakeElement("div");
    panel.id = `${tabId}Tab`;
    panel.dataset.lazyTab = tabId;
    elementsById.set(panel.id, panel);
    return panel;
}

/** Fabricates the parsed `#${tabId}Tab` root ensureStrategyPanelTabMarkup sees. */
function loadableMarkup(tabId: string, content: FakeElement): FakeLoadedPanel {
    return {
        childNodes: [content],
        className: "research-tab",
        attributes: [
            { name: "id", value: `${tabId}Tab` },
            { name: "class", value: "research-tab" },
            { name: "data-loaded-from-partial", value: "true" },
        ],
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function statusHost(panel: FakeElement): FakeElement | undefined {
    return panel.children.find((child) => child.hasClass("lazy-tab-status"));
}

function statusMessage(host: FakeElement): FakeElement | undefined {
    return host.children.find((child) => child.hasClass("lazy-tab-status-message"));
}

function actionButton(host: FakeElement, attribute: string): FakeElement | undefined {
    const actions = host.children.find((child) => child.hasClass("lazy-tab-status-actions"));
    return actions?.children.find((child) => child.getAttribute(attribute) !== null);
}

function switchToTab(tabId: string): void {
    (globalThis as Record<string, any>).window.dispatchEvent(
        new CustomEvent("strategy-panel:tab-change", { detail: { tabId } })
    );
}

function silenceConsoleError(): () => void {
    const original = console.error;
    console.error = () => {};
    return () => {
        console.error = original;
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Lazy tab activation feedback", () => {
    beforeEach(() => {
        installFakeBrowser();
    });

    afterEach(() => {
        resetLazyFeatureInitState();
        restoreBrowser();
    });

    it("treats plain esbuild test bundles as retry-capable (dev) builds", () => {
        // The Vite env is absent in these esbuild bundles, so the retry path
        // this spec exercises is the development one; production retry support
        // (off) is pinned by the real production-build E2E scenario.
        assert.equal(supportsLazyMarkupRetry(), true);
    });

    it("shows loading feedback that survives the markup swap until the initializer settles", async () => {
        const panel = mountPlaceholder("finder");
        const content = new FakeElement("section");
        nextLoadedPanel = loadableMarkup("finder", content);
        const initGate = deferred();
        let initCount = 0;
        registerLazyFeature("finder", async () => {
            initCount += 1;
            await initGate.promise;
        });

        const activation = activateLazyFeature("finder");

        // Loading feedback is synchronous with activation start.
        assert.equal(panel.getAttribute("aria-busy"), "true");
        const loadingHost = statusHost(panel);
        assert.ok(loadingHost, "loading host should exist");
        assert.equal(loadingHost.getAttribute("data-lazy-tab-status"), "loading");
        assert.equal(loadingHost.getAttribute("aria-live"), "polite");
        assert.ok(statusMessage(loadingHost)?.textContent.length);

        await flushMicrotasks();

        // The swap mounted the partial content and kept the loading host.
        assert.equal(panel.dataset.lazyMarkupLoaded, "true");
        assert.equal(panel.getAttribute("data-loaded-from-partial"), "true");
        assert.ok(panel.children.includes(content), "mounted partial content should be preserved");
        assert.ok(panel.children.includes(loadingHost), "loading host should survive the swap");
        assert.equal(initCount, 1);
        assert.equal(isLazyFeatureInitialized("finder"), false);

        initGate.resolve();
        await activation;

        // Only success removes the feedback.
        assert.equal(statusHost(panel), undefined);
        assert.equal(panel.getAttribute("aria-busy"), null);
        assert.ok(panel.children.includes(content), "success must not disturb mounted nodes");
        assert.equal(isLazyFeatureInitialized("finder"), true);
    });

    it("treats missing markup root as an activation failure with safe Retry and Reload recovery", async () => {
        const restoreConsole = silenceConsoleError();
        try {
            const panel = mountPlaceholder("finder");
            nextLoadedPanel = null; // partial without its #finderTab root
            let initCount = 0;
            registerLazyFeature("finder", () => {
                initCount += 1;
            });

            await assert.rejects(activateLazyFeature("finder"));

            // The feature callback never ran, so retrying is safe.
            assert.equal(initCount, 0);
            assert.equal(isLazyFeatureInitialized("finder"), false);
            const failureHost = statusHost(panel);
            assert.ok(failureHost, "failure host should exist");
            assert.equal(failureHost.getAttribute("data-lazy-tab-status"), "failure");
            assert.equal(panel.getAttribute("aria-busy"), null, "settled activation clears busy state");
            const message = statusMessage(failureHost)?.textContent ?? "";
            assert.ok(message.length > 0, "failure message should be present");
            assert.ok(!message.includes("#finderTab"), "failure message must not expose internals");

            const reloadButton = actionButton(failureHost, "data-lazy-tab-reload");
            const retryButton = actionButton(failureHost, "data-lazy-tab-retry");
            assert.ok(reloadButton, "reload action should exist");
            assert.ok(retryButton, "markup failure should offer retry");

            reloadButton!.dispatchEvent({ type: "click" });
            assert.equal(reloadCount, 1);

            // Repair the markup and retry: the tab activates and cleans up.
            const content = new FakeElement("section");
            nextLoadedPanel = loadableMarkup("finder", content);
            retryButton!.dispatchEvent({ type: "click" });
            assert.equal(retryButton!.disabled, true, "retry disables itself while activating");

            await flushMicrotasks();

            assert.equal(initCount, 1);
            assert.equal(isLazyFeatureInitialized("finder"), true);
            assert.equal(statusHost(panel), undefined, "success removes failure feedback");
            assert.ok(panel.children.includes(content));
            assert.equal(panel.dataset.lazyMarkupLoaded, "true");
        } finally {
            restoreConsole();
        }
    });

    it("repeated Retry clicks start a single activation", async () => {
        const restoreConsole = silenceConsoleError();
        try {
            const panel = mountPlaceholder("finder");
            nextLoadedPanel = null;
            let initCount = 0;
            registerLazyFeature("finder", () => {
                initCount += 1;
            });

            await assert.rejects(activateLazyFeature("finder"));
            const retryButton = actionButton(statusHost(panel)!, "data-lazy-tab-retry")!;

            nextLoadedPanel = loadableMarkup("finder", new FakeElement("section"));
            retryButton.dispatchEvent({ type: "click" });
            retryButton.dispatchEvent({ type: "click" });
            retryButton.dispatchEvent({ type: "click" });

            await flushMicrotasks();

            assert.equal(initCount, 1, "deduplicated activation runs the callback once");
            assert.equal(isLazyFeatureInitialized("finder"), true);
        } finally {
            restoreConsole();
        }
    });

    it("offers Reload only after a feature-callback failure and suppresses tab-switch retries", async () => {
        const restoreConsole = silenceConsoleError();
        try {
            const panel = mountPlaceholder("finder");
            nextLoadedPanel = loadableMarkup("finder", new FakeElement("section"));
            let initCount = 0;
            registerLazyFeature("finder", () => {
                initCount += 1;
                throw new Error("boom");
            });
            attachTabLazyListener();

            switchToTab("finder");
            await flushMicrotasks();

            assert.equal(initCount, 1);
            assert.equal(isLazyFeatureInitialized("finder"), false);
            const failureHost = statusHost(panel);
            assert.ok(failureHost, "failure host should exist");
            assert.equal(failureHost.getAttribute("data-lazy-tab-status"), "failure");
            assert.equal(
                actionButton(failureHost, "data-lazy-tab-retry"),
                undefined,
                "unsafe callback failure must not offer retry"
            );
            const reloadButton = actionButton(failureHost, "data-lazy-tab-reload");
            assert.ok(reloadButton, "reload action should exist");

            // Implicit tab-switch retries are suppressed in the unsafe state.
            switchToTab("finder");
            await flushMicrotasks();
            assert.equal(initCount, 1);

            reloadButton!.dispatchEvent({ type: "click" });
            assert.equal(reloadCount, 1);
        } finally {
            restoreConsole();
        }
    });

    it("a slow activation on one tab does not disturb another tab", async () => {
        const finderPanel = mountPlaceholder("finder");
        const alertsPanel = mountPlaceholder("alerts");
        const finderContent = new FakeElement("section");
        const alertsContent = new FakeElement("section");
        const finderGate = deferred();

        registerLazyFeature("finder", async () => {
            await finderGate.promise;
        });
        registerLazyFeature("alerts", () => {});
        attachTabLazyListener();

        // The fake template hands each activation whichever markup is armed.
        nextLoadedPanel = loadableMarkup("finder", finderContent);
        switchToTab("finder");
        await flushMicrotasks();
        assert.ok(finderPanel.children.includes(finderContent));
        assert.ok(statusHost(finderPanel), "finder still loading");

        // Switch to alerts while finder is still initializing.
        nextLoadedPanel = loadableMarkup("alerts", alertsContent);
        switchToTab("alerts");
        await flushMicrotasks();

        assert.equal(isLazyFeatureInitialized("alerts"), true);
        assert.equal(statusHost(alertsPanel), undefined, "alerts success cleared its own feedback");
        assert.ok(alertsPanel.children.includes(alertsContent), "alerts mounted its own markup");
        assert.ok(statusHost(finderPanel), "finder feedback is untouched by the other tab");
        assert.equal(finderPanel.getAttribute("aria-busy"), "true");

        finderGate.resolve();
        await flushMicrotasks();

        assert.equal(isLazyFeatureInitialized("finder"), true);
        assert.equal(statusHost(finderPanel), undefined);
        assert.ok(finderPanel.children.includes(finderContent));
        assert.equal(finderPanel.getAttribute("aria-busy"), null);
    });

    it("reset clears feedback hosts and failure state", async () => {
        const restoreConsole = silenceConsoleError();
        try {
            const panel = mountPlaceholder("finder");
            nextLoadedPanel = loadableMarkup("finder", new FakeElement("section"));
            registerLazyFeature("finder", () => {
                throw new Error("boom");
            });
            attachTabLazyListener();

            await assert.rejects(activateLazyFeature("finder"));
            assert.ok(statusHost(panel), "failure host should exist before reset");

            resetLazyFeatureInitState();

            assert.equal(statusHost(panel), undefined, "reset removes feedback hosts");
            assert.equal(panel.getAttribute("aria-busy"), null);

            // After reset the tab activates cleanly again, including through
            // the tab-switch listener.
            let initCount = 0;
            registerLazyFeature("finder", () => {
                initCount += 1;
            });
            attachTabLazyListener();
            switchToTab("finder");
            await flushMicrotasks();

            assert.equal(initCount, 1);
            assert.equal(isLazyFeatureInitialized("finder"), true);
        } finally {
            restoreConsole();
        }
    });
});
