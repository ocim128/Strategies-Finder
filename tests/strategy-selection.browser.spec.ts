/**
 * Strategy selection is latest-wins: only the newest selection request may
 * commit the strategy and its parameter form (including the Exit Strategy
 * Override sub-section), registry notifications during loading must not reset
 * the intended dropdown option, and external configuration application must
 * supersede any pending selection — including same-key restores.
 *
 * Loader promises are controlled through the real built-in catalog loaders so
 * the production code paths (registry registration, dropdown rendering, param
 * rendering) all execute unchanged.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { setupEventHandlers } from "../lib/handlers/ui-event-handlers";
import { uiManager } from "../lib/ui-manager";
import { state } from "../lib/state";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "../lib/strategy-defaults";
import { setCurrentStrategyKey } from "../lib/state-actions";
import { FinderResultActions } from "../lib/finder/browser/finder-result-actions";
import { backtestService } from "../lib/backtest-service";
import { strategyPanelController } from "../lib/strategy-panel-controller";
import {
    strategyRegistry,
    loadBuiltInStrategies,
} from "../strategyRegistry";
import {
    getBuiltInStrategyKeys,
    unregisterLoadedBuiltInStrategy,
} from "../lib/strategies/built-in-catalog";
import { builtInStrategyLoaders } from "../lib/strategies/manifest-loaders";
import { settingsManager } from "../lib/settings-manager";
import { waitFor } from "./helpers/wait-for";
import { flushMicrotasks } from "./helpers/flush-microtasks";
import type { Strategy, StrategyParams } from "../lib/types/strategies";

// ---------------------------------------------------------------------------
// Minimal fake browser
// ---------------------------------------------------------------------------

class FakeElement {
    id = "";
    tagName = "";
    className = "";
    textContent = "";
    innerHTML = "";
    value = "";
    title = "";
    type = "";
    hidden = false;
    disabled = false;
    checked = false;
    readOnly = false;
    isConnected = true;
    htmlFor = "";
    style: Record<string, string> = { display: "" };
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    private classes = new Set<string>();
    private attributes = new Map<string, string>();
    private handlers = new Map<string, Array<(event?: unknown) => void>>();

    constructor(tagName = "div") {
        this.tagName = tagName;
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
        this.attributes.set(name, value);
        if (name === "class") this.className = value;
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }

    toggleAttribute(name: string, force?: boolean): boolean {
        const next = force ?? !this.attributes.has(name);
        if (next) this.setAttribute(name, "");
        else this.attributes.delete(name);
        return next;
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
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "HTMLLabelElement",
] as const;

let globalsSnapshot: Array<PropertyDescriptor | undefined> = [];
const elementsById = new Map<string, FakeElement>();
const toasts: Array<{ message: string; type: string }> = [];

function fakeDocument(): Record<string, unknown> {
    return {
        getElementById: (id: string) => {
            if (!elementsById.has(id)) elementsById.set(id, new FakeElement());
            return elementsById.get(id)!;
        },
        createElement: (tag: string) => new FakeElement(tag),
        createDocumentFragment: () => new FakeElement("#document-fragment"),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
        head: new FakeElement("head"),
        body: new FakeElement("body"),
    };
}

const fakeWindow = {
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
    for (const typeName of ["Element", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "HTMLLabelElement"]) {
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
    toasts.length = 0;
}

// ---------------------------------------------------------------------------
// Controlled loaders through the real built-in catalog
// ---------------------------------------------------------------------------

type LoaderGate = {
    loader: () => Promise<Strategy>;
    resolve: (strategy: Strategy) => void;
    reject: (error: unknown) => void;
    calls: () => number;
};

function makeGate(): LoaderGate {
    let calls = 0;
    let resolveRef!: (strategy: Strategy) => void;
    let rejectRef!: (error: unknown) => void;
    const promise = new Promise<Strategy>((resolve, reject) => {
        resolveRef = resolve;
        rejectRef = reject;
    });
    return {
        loader: () => {
            calls += 1;
            return promise;
        },
        resolve: (strategy) => resolveRef(strategy),
        reject: (error) => rejectRef(error),
        calls: () => calls,
    };
}

function makeStrategy(name: string, period: number): Strategy {
    return {
        name,
        description: `${name} fixture`,
        defaultParams: { period },
        paramLabels: { period: "Period" },
        execute: () => [],
    };
}

function makeParamsStrategy(name: string, defaultParams: StrategyParams): Strategy {
    return {
        name,
        description: `${name} fixture`,
        defaultParams,
        paramLabels: Object.fromEntries(Object.keys(defaultParams).map((key) => [key, key])),
        execute: () => [],
    };
}

const nonDefaultKeys = getBuiltInStrategyKeys()
    .filter((key) => key !== DEFAULT_BUILT_IN_STRATEGY_KEY);
const [keyA, keyB, keyC, keyD] = nonDefaultKeys;
if (!keyA || !keyB || !keyC || !keyD) {
    throw new Error("Expected at least four non-default built-in strategy keys");
}

// Per-test loader gates. `ensureBuiltInStrategyLoaded` dedupes in-flight loads
// through the catalog's loadingPromises, so every test must start with fresh,
// unresolved gates and stranded gates from a prior test must be drained before
// the registry/state reset below.
const originalLoaders = new Map<string, () => Promise<Strategy>>();
const activeGates = new Map<string, LoaderGate>();

function gateFor(key: string): LoaderGate {
    let gate = activeGates.get(key);
    if (!gate) {
        gate = makeGate();
        activeGates.set(key, gate);
    }
    return gate;
}

const gatedKeys = [keyA, keyB, keyC, keyD];

function installGatedLoaders(): void {
    const loaderMap = builtInStrategyLoaders as Record<string, () => Promise<Strategy>>;
    for (const key of gatedKeys) {
        originalLoaders.set(key, loaderMap[key]);
        loaderMap[key] = () => gateFor(key).loader();
    }
}

function restoreLoaders(): void {
    const loaderMap = builtInStrategyLoaders as Record<string, () => Promise<Strategy>>;
    for (const [key, loader] of originalLoaders) {
        loaderMap[key] = loader;
    }
    originalLoaders.clear();
    activeGates.clear();
}

async function drainStrandedGates(): Promise<void> {
    // Resolve whatever the previous test left pending so the catalog's
    // loadingPromises entries settle (and clear) before this test's reset.
    for (const gate of activeGates.values()) {
        gate.resolve(makeStrategy("drained", 0));
    }
    await flushMicrotasks();
    activeGates.clear();
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

function el(id: string): FakeElement {
    if (!elementsById.has(id)) elementsById.set(id, new FakeElement());
    return elementsById.get(id)!;
}

function selectStrategy(key: string): void {
    el("strategySelect").value = key;
    el("strategySelect").dispatchEvent({ type: "change" });
}

function renderedStrategyParamValues(): Record<string, string> {
    const row = el("strategyParams").children[0];
    const values: Record<string, string> = {};
    for (const group of row?.children ?? []) {
        const input = group.children[1];
        if (input) values[input.dataset.param ?? ""] = input.value;
    }
    return values;
}

function exitHiddenParams(): Record<string, unknown> {
    return JSON.parse(el("exitStrategyParams").value || "{}") as Record<string, unknown>;
}

function expectedDefaultParamValues(key: string): Record<string, string> {
    const strategy = strategyRegistry.get(key);
    assert.ok(strategy, `expected ${key} to be registered`);
    const values: Record<string, string> = {};
    for (const [param, value] of Object.entries(strategy.defaultParams)) {
        values[param] = String(value);
    }
    return values;
}

const originalShowToast = uiManager.showToast;

before(async () => {
    installFakeBrowser();
    installGatedLoaders();
    uiManager.showToast = (message: string, type: "success" | "error" | "info" | "warning" = "info") => {
        toasts.push({ message, type });
    };

    // Mirror the production wiring: the app-bootstrap registry subscription
    // plus the state-subscriptions currentStrategyKey listener.
    strategyRegistry.subscribe((event) => {
        uiManager.updateStrategyDropdown(state.currentStrategyKey);
        if (event.strategyKey === state.currentStrategyKey) {
            state.emit("currentStrategyKey", state.currentStrategyKey);
        }
    });
    state.subscribe("currentStrategyKey", (key) => {
        uiManager.updateStrategyDropdown(key);
        uiManager.updateStrategyParams(key);
    });

    await loadBuiltInStrategies([DEFAULT_BUILT_IN_STRATEGY_KEY]);
    setupEventHandlers();
    // Mirror the bootstrap initial-ui-sync step.
    uiManager.updateStrategyDropdown(state.currentStrategyKey);
    uiManager.updateStrategyParams(state.currentStrategyKey);
});

beforeEach(async () => {
    await drainStrandedGates();
    toasts.length = 0;
    // A failed prior test may leave a pending selection intent behind; clear
    // it so guarded renders cannot leak into this test.
    uiManager.cancelPendingStrategySelection();
    state.currentStrategyKey = DEFAULT_BUILT_IN_STRATEGY_KEY;
    strategyRegistry.clear();
    await loadBuiltInStrategies([DEFAULT_BUILT_IN_STRATEGY_KEY]);
    unregisterLoadedBuiltInStrategy(keyA);
    unregisterLoadedBuiltInStrategy(keyB);
    unregisterLoadedBuiltInStrategy(keyC);
    unregisterLoadedBuiltInStrategy(keyD);
    for (const element of elementsById.values()) {
        element.value = "";
        element.checked = false;
        element.children = [];
        element.innerHTML = "";
        element.textContent = "";
        element.disabled = false;
        element.hidden = false;
    }
    uiManager.updateStrategyDropdown(state.currentStrategyKey);
    uiManager.updateStrategyParams(state.currentStrategyKey);
    await flushMicrotasks();
});

after(() => {
    state.currentStrategyKey = DEFAULT_BUILT_IN_STRATEGY_KEY;
    state.currentBacktestResult = null;
    uiManager.showToast = originalShowToast;
    restoreLoaders();
    restoreBrowser();
});

describe("latest-wins strategy selection", () => {
    it("commits the latest selection when loads finish out of order", async () => {
        selectStrategy(keyA);
        selectStrategy(keyB);
        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY, "nothing may commit while loads are in flight");

        gateFor(keyB).resolve(makeStrategy("Beta", 21));
        await waitFor(() => state.currentStrategyKey === keyB, 2000, "selection B to commit");
        assert.equal(el("strategySelect").value, keyB);
        assert.deepEqual(renderedStrategyParamValues(), { period: "21" });

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await flushMicrotasks();
        assert.equal(state.currentStrategyKey, keyB, "the stale load must not commit");
        assert.equal(el("strategySelect").value, keyB);
        assert.deepEqual(renderedStrategyParamValues(), { period: "21" });
        assert.deepEqual(toasts, []);
    });

    it("commits the latest selection when loads finish in order", async () => {
        selectStrategy(keyA);
        selectStrategy(keyB);

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await flushMicrotasks();
        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY, "superseded A must not commit");

        gateFor(keyB).resolve(makeStrategy("Beta", 21));
        await waitFor(() => state.currentStrategyKey === keyB, 2000, "selection B to commit");
        assert.equal(el("strategySelect").value, keyB);
        assert.deepEqual(renderedStrategyParamValues(), { period: "21" });
    });

    it("handles A-B-A by committing the newest A request", async () => {
        selectStrategy(keyA);
        selectStrategy(keyB);
        selectStrategy(keyA);
        assert.equal(gateFor(keyA).calls(), 1, "a repeated in-flight load dedupes onto the same loader promise");

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await waitFor(() => state.currentStrategyKey === keyA, 2000, "the newest A request to commit");
        assert.equal(el("strategySelect").value, keyA);
        assert.deepEqual(renderedStrategyParamValues(), { period: "7" });

        gateFor(keyB).resolve(makeStrategy("Beta", 21));
        await flushMicrotasks();
        assert.equal(state.currentStrategyKey, keyA, "the stale B load must not commit");
        assert.deepEqual(renderedStrategyParamValues(), { period: "7" });
    });

    it("keeps the intended dropdown option while registry notifications fire during loading", async () => {
        selectStrategy(keyA);
        assert.equal(el("strategySelect").value, keyA, "the intended option stays selected while loading");

        // Registry noise while the load is pending: register an unrelated
        // custom strategy and re-emit registry events.
        strategyRegistry.register("custom_noise_strategy", makeStrategy("Noise", 1));
        await flushMicrotasks();

        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.equal(el("strategySelect").value, keyA, "registry notifications must not reset the intended option");

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await waitFor(() => state.currentStrategyKey === keyA, 2000, "selection A to commit");
        assert.equal(el("strategySelect").value, keyA);
    });

    it("commits already-loaded and custom strategies immediately", async () => {
        strategyRegistry.register("custom_fast_strategy", makeStrategy("Custom", 5));

        selectStrategy("custom_fast_strategy");
        await waitFor(() => state.currentStrategyKey === "custom_fast_strategy", 2000, "custom strategy to commit");
        assert.equal(el("strategySelect").value, "custom_fast_strategy");
        assert.deepEqual(renderedStrategyParamValues(), { period: "5" });

        selectStrategy(DEFAULT_BUILT_IN_STRATEGY_KEY);
        await waitFor(() => state.currentStrategyKey === DEFAULT_BUILT_IN_STRATEGY_KEY, 2000, "already-loaded strategy to commit");
        assert.equal(el("strategySelect").value, DEFAULT_BUILT_IN_STRATEGY_KEY);
    });

    it("keeps the last valid configuration when the selected strategy is missing", async () => {
        selectStrategy("not_a_real_strategy");
        await waitFor(() => toasts.length > 0, 2000, "the unavailable-strategy toast");

        assert.deepEqual(toasts, [{ message: 'Strategy "not_a_real_strategy" is not available. The previous selection was kept.', type: "error" }]);
        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.equal(el("strategySelect").value, DEFAULT_BUILT_IN_STRATEGY_KEY, "the dropdown must reflect the retained configuration");
    });

    it("lets an external configuration restore supersede a pending selection", async () => {
        selectStrategy(keyA);
        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY);

        await settingsManager.applyStrategyConfig({
            name: "external restore",
            createdAt: "2026-10-09T00:00:00Z",
            updatedAt: "2026-10-09T00:00:00Z",
            strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
            strategyParams: {},
            backtestSettings: settingsManager.getDefaultBacktestSettings(),
        });

        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.deepEqual(
            renderedStrategyParamValues(),
            expectedDefaultParamValues(DEFAULT_BUILT_IN_STRATEGY_KEY),
            "the restored strategy form must win over the pending selection"
        );

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await flushMicrotasks();
        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY, "the pending selection must not commit after an external restore");
        assert.equal(el("strategySelect").value, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.deepEqual(renderedStrategyParamValues(), expectedDefaultParamValues(DEFAULT_BUILT_IN_STRATEGY_KEY));
    });

    it("lets a same-key external restore supersede the pending selection", async () => {
        selectStrategy(keyA);
        const restore = settingsManager.applyStrategyConfig({
            name: "same key restore",
            createdAt: "2026-10-09T00:00:00Z",
            updatedAt: "2026-10-09T00:00:00Z",
            strategyKey: keyA,
            strategyParams: { period: 42 },
            backtestSettings: settingsManager.getDefaultBacktestSettings(),
        });
        await flushMicrotasks();

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await restore;
        await flushMicrotasks();

        assert.equal(state.currentStrategyKey, keyA);
        assert.equal(el("strategySelect").value, keyA);
        assert.deepEqual(renderedStrategyParamValues(), { period: "42" }, "the restored params must survive the settling selection");
    });

    it("a same-key external restore immediately resyncs the dropdown", async () => {
        selectStrategy(keyB);
        gateFor(keyB).resolve(makeStrategy("Beta", 21));
        await waitFor(() => state.currentStrategyKey === keyB, 2000, "selection B to commit");

        // A pending dropdown selection moves the option while its load runs;
        // the restore supersedes it without waiting for it to settle.
        selectStrategy(keyA);
        assert.equal(el("strategySelect").value, keyA);

        await settingsManager.applyStrategyConfig({
            name: "same-key dropdown resync",
            createdAt: "2026-10-09T00:00:00Z",
            updatedAt: "2026-10-09T00:00:00Z",
            strategyKey: keyB,
            strategyParams: { period: 42 },
            backtestSettings: settingsManager.getDefaultBacktestSettings(),
        });

        // While keyA's load is still unresolved, every surface describes B.
        assert.equal(state.currentStrategyKey, keyB);
        assert.equal(el("strategySelect").value, keyB, "the dropdown must show the restored configuration immediately");
        assert.equal(el("strategyMetaName").textContent, "Beta");
        assert.deepEqual(renderedStrategyParamValues(), { period: "42" });

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await flushMicrotasks();

        assert.equal(state.currentStrategyKey, keyB);
        assert.equal(el("strategySelect").value, keyB);
        assert.equal(el("strategyMetaName").textContent, "Beta");
        assert.deepEqual(renderedStrategyParamValues(), { period: "42" });
    });
});

// ---------------------------------------------------------------------------
// Finder Apply vs. the selection-ownership boundary
//
// Finder Apply is external configuration application: a dropdown selection
// still loading when Apply commits must not commit over the applied result
// afterwards. All four Apply flows (Current Chart, Universe, Asset
// Opportunity, Arm Performance) share this contract.
// ---------------------------------------------------------------------------

type FinderResultActionsCtor = ConstructorParameters<typeof FinderResultActions>[0];

function makeFinderActions(): FinderResultActions {
    return new FinderResultActions({
        getResultStore: () => ({ latestResults: { scope: "current_chart", results: [] } }),
        getLastRunBacktestSettings: () => null,
        getLastFinderOptions: () => null,
        getLastFinderEvaluationData: () => null,
    } as unknown as FinderResultActionsCtor);
}

async function withFinderApplyPatches(run: () => Promise<void>): Promise<void> {
    const owner = backtestService as unknown as Record<string, unknown>;
    const panel = strategyPanelController as unknown as Record<string, unknown>;
    const originalRun = owner.runCurrentBacktest;
    const originalSwitch = panel.switchTab;
    owner.runCurrentBacktest = async () => undefined;
    panel.switchTab = () => true;
    try {
        await run();
    } finally {
        owner.runCurrentBacktest = originalRun;
        panel.switchTab = originalSwitch;
    }
}

function assertAppliedConfiguration(appliedKey: string, appliedName: string): void {
    assert.equal(state.currentStrategyKey, appliedKey, "state key must stay the applied strategy");
    assert.equal(el("strategySelect").value, appliedKey, "dropdown must stay on the applied strategy");
    assert.equal(el("strategyMetaName").textContent, appliedName, "workspace metadata must describe the applied strategy");
    assert.deepEqual(renderedStrategyParamValues(), { period: "99" }, "visible parameters must stay the applied ones");
}

const finderApplyPaths: Array<{ label: string; apply: (actions: FinderResultActions, appliedKey: string) => Promise<void> }> = [
    {
        label: "Current Chart",
        apply: (actions, appliedKey) => actions.applyCurrentChartResult({
            key: appliedKey,
            name: "Finder applied",
            params: { period: 99 },
        } as unknown as Parameters<FinderResultActions["applyCurrentChartResult"]>[0]),
    },
    {
        label: "Universe",
        apply: (actions, appliedKey) => actions.applyUniverseCandidate({
            strategyKey: appliedKey,
            strategyName: "Finder applied",
            params: { period: 99 },
            profitableSymbols: 3,
            activeSymbols: 4,
            totalTrades: 30,
        } as unknown as Parameters<FinderResultActions["applyUniverseCandidate"]>[0]),
    },
    {
        label: "Asset Opportunity",
        apply: (actions, appliedKey) => actions.applyAssetOpportunityResult({
            strategyKey: appliedKey,
            symbol: state.currentSymbol,
            grade: "A",
            historicalRank: 2,
            params: { period: 99 },
            selectionResult: { expectancy: 0.4 },
        } as unknown as Parameters<FinderResultActions["applyAssetOpportunityResult"]>[0]),
    },
    {
        label: "Arm Performance",
        apply: (actions, appliedKey) => actions.applyArmPerformanceCandidate({
            candidateId: "audit-arm-1",
            candidateOrdinal: 0,
            strategyKey: appliedKey,
            strategyName: "Finder applied",
            params: { period: 99 },
            backtestSettings: settingsManager.getDefaultBacktestSettings(),
        } as unknown as Parameters<FinderResultActions["applyArmPerformanceCandidate"]>[0]),
    },
];

describe("Finder Apply supersedes pending selection intent", () => {
    for (const path of finderApplyPaths) {
        it(`Finder Apply supersedes an earlier pending dropdown selection (${path.label})`, async () => {
            await withFinderApplyPatches(async () => {
                const appliedKey = "custom_finder_applied";
                strategyRegistry.register(appliedKey, makeStrategy("Finder applied", 99));
                const actions = makeFinderActions();

                selectStrategy(keyA);
                assert.equal(el("strategySelect").value, keyA, "the pending selection shows its intent");

                await path.apply(actions, appliedKey);

                assertAppliedConfiguration(appliedKey, "Finder applied");
                const appliedSettings = settingsManager.getBacktestSettings();

                gateFor(keyA).resolve(makeStrategy("Alpha", 7));
                await flushMicrotasks();

                assertAppliedConfiguration(appliedKey, "Finder applied");
                assert.deepEqual(
                    settingsManager.getBacktestSettings(),
                    appliedSettings,
                    "the applied backtest settings must survive the stale selection"
                );
            });
        });
    }

    it("aborted Apply for a missing strategy leaves the pending selection ownership intact", async () => {
        await withFinderApplyPatches(async () => {
            const actions = makeFinderActions();
            selectStrategy(keyA);

            await actions.applyCurrentChartResult({
                key: "missing_strategy_key",
                name: "Missing",
                params: {},
            } as unknown as Parameters<FinderResultActions["applyCurrentChartResult"]>[0]);

            assert.ok(
                toasts.some((toast) => toast.type === "error" && toast.message.includes("missing_strategy_key")),
                "the missing-strategy toast must surface"
            );
            assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY, "a missing strategy must not commit");

            // Ownership was never cancelled by the aborted Apply, so the
            // pending selection can still commit normally.
            gateFor(keyA).resolve(makeStrategy("Alpha", 7));
            await waitFor(() => state.currentStrategyKey === keyA, 2000, "the pending selection to commit after the aborted Apply");
            assert.equal(el("strategySelect").value, keyA);
            assert.deepEqual(renderedStrategyParamValues(), { period: "7" });
        });
    });
});

describe("parameter render ownership", () => {
    it("an awaited parameter render cannot overwrite a newer committed strategy", async () => {
        state.currentStrategyKey = keyA;
        const oldRender = uiManager.updateStrategyParams(keyA);
        const newerKey = "custom_newer_committed";
        strategyRegistry.register(newerKey, makeStrategy("Newer committed", 42));
        setCurrentStrategyKey(newerKey);
        assert.deepEqual(renderedStrategyParamValues(), { period: "42" }, "the newer commit renders synchronously");

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await oldRender;
        await flushMicrotasks();

        assert.equal(state.currentStrategyKey, newerKey);
        assert.equal(el("strategySelect").value, newerKey);
        assert.equal(el("strategyMetaName").textContent, "Newer committed");
        assert.deepEqual(renderedStrategyParamValues(), { period: "42" }, "params must match the current committed strategy");
    });

    it("a stale render cannot overwrite a newer commit after the selection intent was cancelled", async () => {
        state.currentStrategyKey = keyA;
        const staleRender = uiManager.updateStrategyParams(keyA);
        uiManager.cancelPendingStrategySelection();
        const newerKey = "custom_after_cancel";
        strategyRegistry.register(newerKey, makeStrategy("After cancel", 42));
        setCurrentStrategyKey(newerKey);

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await staleRender;
        await flushMicrotasks();

        assert.equal(state.currentStrategyKey, newerKey);
        assert.deepEqual(renderedStrategyParamValues(), { period: "42" });
    });

    it("an external configuration restore supersedes an in-flight render of another strategy", async () => {
        state.currentStrategyKey = keyA;
        const staleRender = uiManager.updateStrategyParams(keyA);

        await settingsManager.applyStrategyConfig({
            name: "restore over in-flight render",
            createdAt: "2026-10-09T00:00:00Z",
            updatedAt: "2026-10-09T00:00:00Z",
            strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
            strategyParams: {},
            backtestSettings: settingsManager.getDefaultBacktestSettings(),
        });

        gateFor(keyA).resolve(makeStrategy("Alpha", 7));
        await staleRender;
        await flushMicrotasks();

        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.deepEqual(
            renderedStrategyParamValues(),
            expectedDefaultParamValues(DEFAULT_BUILT_IN_STRATEGY_KEY),
            "the restored form must win over the stale in-flight render"
        );
    });
});

describe("strategy selection failures retain a valid setup", () => {
    it("keeps the last valid configuration when the current load fails", async () => {
        selectStrategy(keyC);
        gateFor(keyC).reject(new Error("loader exploded"));
        await waitFor(() => toasts.length > 0, 2000, "the load-failure toast");

        assert.deepEqual(toasts, [{ message: "Loading the selected strategy failed. The previous selection was kept.", type: "error" }]);
        assert.equal(state.currentStrategyKey, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.equal(el("strategySelect").value, DEFAULT_BUILT_IN_STRATEGY_KEY);
        assert.equal(strategyRegistry.has(keyC), false, "a failed load must not register the strategy");
    });

    it("ignores stale load failures in the UI", async () => {
        selectStrategy(keyA);
        selectStrategy(keyB);
        gateFor(keyB).resolve(makeStrategy("Beta", 21));
        await waitFor(() => state.currentStrategyKey === keyB, 2000, "selection B to commit");
        toasts.length = 0;

        gateFor(keyA).reject(new Error("stale boom"));
        await flushMicrotasks();

        assert.deepEqual(toasts, [], "stale failures must not surface a toast");
        assert.equal(state.currentStrategyKey, keyB);
        assert.equal(el("strategySelect").value, keyB);
    });
});

describe("exit strategy override latest-wins rendering", () => {
    it("renders only the newest exit-strategy selection into the form and hidden input", async () => {
        const exitKeySelect = el("exitStrategyKey");
        exitKeySelect.value = keyA;
        exitKeySelect.dispatchEvent({ type: "change" });
        exitKeySelect.value = keyB;
        exitKeySelect.dispatchEvent({ type: "change" });

        gateFor(keyB).resolve(makeStrategy("BetaExit", 33));
        await waitFor(() => exitHiddenParams().period === 33, 2000, "exit params to reflect B");
        assert.deepEqual(exitHiddenParams(), { period: 33 });

        gateFor(keyA).resolve(makeStrategy("AlphaExit", 11));
        await flushMicrotasks();
        assert.deepEqual(exitHiddenParams(), { period: 33 }, "the stale exit selection must not write the hidden input");

        const row = el("exitStrategyParamsContainer").children[0];
        const inputValues = (row?.children ?? []).map((group) => group.children[1]?.value);
        assert.deepEqual(inputValues, ["33"], "the visible form must show the newest selection");
    });

    // The stale-failure case runs before any test rejects keyD so its loader
    // gate is still fresh and controllable: the catalog caches rejected load
    // promises per key, so a poisoned key could never pend again. The newer
    // selection is a registered custom strategy with a distinct param name —
    // hidden params carry over across exit-strategy switches by contract, so
    // a same-shaped strategy could not prove which render won.
    it("a stale exit-strategy failure must not roll back a newer successful selection", async () => {
        const exitKeySelect = el("exitStrategyKey");
        exitKeySelect.value = keyB;
        exitKeySelect.dispatchEvent({ type: "change" });
        gateFor(keyB).resolve(makeStrategy("BetaExit", 33));
        await waitFor(() => exitHiddenParams().period === 33, 2000, "the valid exit form");

        exitKeySelect.value = keyD;
        exitKeySelect.dispatchEvent({ type: "change" });
        strategyRegistry.register("custom_exit_strategy", {
            name: "CustomExit",
            description: "CustomExit fixture",
            defaultParams: { hold: 9 },
            paramLabels: { hold: "Hold" },
            execute: () => [],
        });
        exitKeySelect.value = "custom_exit_strategy";
        exitKeySelect.dispatchEvent({ type: "change" });
        await waitFor(() => exitHiddenParams().hold === 9, 2000, "the newest exit selection to render");

        gateFor(keyD).reject(new Error("stale exit boom"));
        await flushMicrotasks();

        assert.deepEqual(toasts.filter((toast) => toast.type === "error"), [], "a stale failure must not surface a toast");
        assert.equal(exitKeySelect.value, "custom_exit_strategy", "the newer successful selection must stay selected");
        assert.equal(el("exitStrategyParamsContainer").children.length, 1);
        assert.deepEqual(exitHiddenParams(), { hold: 9 });
    });

    it("retains the last valid exit configuration when a new selection fails to load", async () => {
        const exitKeySelect = el("exitStrategyKey");
        exitKeySelect.value = keyB;
        exitKeySelect.dispatchEvent({ type: "change" });
        gateFor(keyB).resolve(makeStrategy("BetaExit", 33));
        await waitFor(() => exitHiddenParams().period === 33, 2000, "the valid exit form");

        // The user edits the visible parameter before trying another strategy;
        // the container-level delegated listener syncs the hidden JSON.
        const periodInput = ((el("exitStrategyParamsContainer").children[0] as FakeElement).children[0] as FakeElement).children[1] as FakeElement;
        periodInput.value = "44";
        el("exitStrategyParamsContainer").dispatchEvent({ type: "input" });
        assert.deepEqual(exitHiddenParams(), { period: 44 }, "the edit must sync into the hidden JSON");

        // keyD's load was rejected by the stale-failure case above, so the
        // catalog returns that rejection immediately — the failure still hits
        // the current generation and must retain the edited configuration.
        exitKeySelect.value = keyD;
        exitKeySelect.dispatchEvent({ type: "change" });
        await waitFor(() => toasts.some((toast) => toast.type === "error"), 2000, "the exit-failure toast");

        assert.deepEqual(
            toasts.filter((toast) => toast.type === "error"),
            [{ message: "Loading exit strategy parameters failed. The previous exit configuration was kept.", type: "error" }],
            "one actionable toast for the current failure"
        );
        assert.equal(exitKeySelect.value, keyB, "the dropdown must revert to the retained valid strategy");
        assert.equal(el("exitStrategyParamsContainer").children.length, 1, "the retained form must stay usable");
        assert.deepEqual(exitHiddenParams(), { period: 44 }, "the edited parameters and hidden JSON must stay coherent");
    });

    it("retains the last valid exit configuration when the selected strategy is missing", async () => {
        const exitKeySelect = el("exitStrategyKey");
        exitKeySelect.value = keyB;
        exitKeySelect.dispatchEvent({ type: "change" });
        gateFor(keyB).resolve(makeStrategy("BetaExit", 33));
        await waitFor(() => exitHiddenParams().period === 33, 2000, "the valid exit form");

        exitKeySelect.value = "not_a_real_exit_strategy";
        exitKeySelect.dispatchEvent({ type: "change" });
        await waitFor(() => toasts.some((toast) => toast.type === "error"), 2000, "the unavailable-exit toast");

        assert.equal(exitKeySelect.value, keyB, "the dropdown must revert to the retained configuration");
        assert.equal(el("exitStrategyParamsContainer").children.length, 1, "the retained form must stay usable");
        assert.deepEqual(exitHiddenParams(), { period: 33 }, "the retained parameters must stay coherent");
    });

    // The rollback-snapshot cases run last: they reject keyB's (otherwise
    // never-rejected) loader gate and rely on that controlled rejection, not
    // on rejections inherited from earlier cases. The retained configuration
    // is a registered custom strategy, which loads synchronously without a
    // loader gate.
    it("exit rollback restores retained edits even when incoming configuration overwrote the hidden input", async () => {
        const exitKeySelect = el("exitStrategyKey");
        strategyRegistry.register("custom_exit_snapshot", makeParamsStrategy("SnapshotExit", { hold: 33 }));
        exitKeySelect.value = "custom_exit_snapshot";
        exitKeySelect.dispatchEvent({ type: "change" });
        await waitFor(() => exitHiddenParams().hold === 33, 2000, "the retained custom exit form");

        // Legitimate edit to the active configuration.
        const holdInput = ((el("exitStrategyParamsContainer").children[0] as FakeElement).children[0] as FakeElement).children[1] as FakeElement;
        holdInput.value = "44";
        el("exitStrategyParamsContainer").dispatchEvent({ type: "input" });
        assert.deepEqual(exitHiddenParams(), { hold: 44 }, "the edit must sync into the hidden JSON");

        // Incoming configuration for another strategy arrives through the real
        // settings path (with a differently named parameter) while keyB's load
        // is still pending.
        settingsManager.applyBacktestSettings({
            ...settingsManager.getDefaultBacktestSettings(),
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: keyB,
            exitStrategyParams: { period: 88 },
        });
        await flushMicrotasks();
        assert.equal(exitKeySelect.value, keyB, "the incoming key is selected while its load runs");
        assert.deepEqual(exitHiddenParams(), { period: 88 }, "the incoming params overwrite the hidden input while pending");

        gateFor(keyB).reject(new Error("incoming exit strategy failed"));
        await waitFor(() => toasts.some((toast) => toast.type === "error"), 2000, "the rollback toast");

        assert.equal(exitKeySelect.value, "custom_exit_snapshot", "the dropdown must revert to the retained strategy");
        assert.deepEqual(
            exitHiddenParams(),
            { hold: 44 },
            "failed incoming params (different name) must not replace retained edits"
        );
        const holdAfterRollback = ((el("exitStrategyParamsContainer").children[0] as FakeElement).children[0] as FakeElement).children[1] as FakeElement;
        assert.equal(holdAfterRollback.value, "44", "the retained form value must come from the snapshot");

        // A matching-name incoming set (hold=88) fails the same way and must
        // not replace the retained hold=44 either.
        settingsManager.applyBacktestSettings({
            ...settingsManager.getDefaultBacktestSettings(),
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: keyB,
            exitStrategyParams: { hold: 88 },
        });
        await waitFor(() => toasts.filter((toast) => toast.type === "error").length === 2, 2000, "the second rollback");

        assert.equal(exitKeySelect.value, "custom_exit_snapshot");
        assert.deepEqual(exitHiddenParams(), { hold: 44 }, "failed matching-name incoming params must not replace retained edits");
        assert.equal(
            ((el("exitStrategyParamsContainer").children[0] as FakeElement).children[0] as FakeElement).children[1].value,
            "44"
        );
    });

    it("a successful incoming exit configuration becomes the retained snapshot for later rollbacks", async () => {
        const exitKeySelect = el("exitStrategyKey");
        strategyRegistry.register("custom_exit_incoming", makeParamsStrategy("IncomingExit", { hold: 66 }));
        settingsManager.applyBacktestSettings({
            ...settingsManager.getDefaultBacktestSettings(),
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: "custom_exit_incoming",
            exitStrategyParams: { hold: 66 },
        });
        await waitFor(() => exitHiddenParams().hold === 66, 2000, "the successful incoming configuration");
        assert.equal(exitKeySelect.value, "custom_exit_incoming", "the successful incoming key stays selected");

        // A same-key external hidden write is a legitimate configuration
        // update and must move the retained snapshot with it.
        el("exitStrategyParams").value = JSON.stringify({ hold: 77 });
        el("exitStrategyParams").dispatchEvent({ type: "change" });
        await flushMicrotasks();
        const sameKeyInput = ((el("exitStrategyParamsContainer").children[0] as FakeElement).children[0] as FakeElement).children[1] as FakeElement;
        assert.equal(sameKeyInput.value, "77", "the same-key update syncs into the form");

        // keyB's loader was rejected by the previous case, so this selection
        // fails immediately and must roll back to the updated incoming
        // configuration rather than to anything earlier.
        exitKeySelect.value = keyB;
        exitKeySelect.dispatchEvent({ type: "change" });
        await waitFor(() => toasts.some((toast) => toast.type === "error"), 2000, "the rollback toast");

        assert.equal(exitKeySelect.value, "custom_exit_incoming", "the rollback must return to the successful incoming configuration");
        assert.deepEqual(exitHiddenParams(), { hold: 77 }, "the same-key updated snapshot must survive the rollback");
        assert.equal(
            ((el("exitStrategyParamsContainer").children[0] as FakeElement).children[0] as FakeElement).children[1].value,
            "77"
        );
    });
});
