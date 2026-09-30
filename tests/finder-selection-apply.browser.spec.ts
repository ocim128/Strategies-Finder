/**
 * Focused tests for the extracted Finder strategy selection
 * (`lib/finder/browser/finder-strategy-selection.ts`) and candidate Apply
 * actions (`lib/finder/browser/finder-result-actions.ts`).
 *
 * Covers scope selection restoration, filtered/bulk/range (shift-click)
 * selection, the duplicate-Apply exclusion guard, and the Arm Apply
 * saved-context fallback. Frozen risk/exit settings construction stays
 * covered by finder-freeze-randomize-path-exit.spec.ts and
 * finder-arm-performance-settings.spec.ts.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import { FinderStrategySelection } from "../lib/finder/browser/finder-strategy-selection";
import { FinderResultActions } from "../lib/finder/browser/finder-result-actions";
import { FinderResultStore } from "../lib/finder/browser/finder-result-store";
import { normalizeFinderUiState } from "../lib/finder/browser/finder-settings";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "../lib/state";
import { backtestService } from "../lib/backtest-service";
import { paramManager } from "../lib/param-manager";
import { uiManager } from "../lib/ui-manager";
import { settingsManager } from "../lib/settings-manager";
import { strategyPanelController } from "../lib/strategy-panel-controller";
import { dataManager } from "../lib/data-manager";
import { createFakeFinderElement } from "./helpers/fake-finder-manager-dom";
import type { FinderManagerDom } from "../lib/finder/finder-manager-dom";
import type { FinderArmPerformanceCandidate, FinderLatestResults } from "../lib/types/finder";
import type { Strategy } from "../lib/types/strategies";

// ---------------------------------------------------------------------------
// DOM stand-in
// ---------------------------------------------------------------------------

function makeDom(): FinderManagerDom {
    const dom: Record<string, any> = {};
    for (const id of [
        "finderStrategyList", "finderStrategySearch", "finderStrategiesToggleAll",
        "finderStrategySelectVisible", "finderStrategyInvertVisible", "finderStrategySummary",
    ]) {
        dom[id] = createFakeFinderElement();
    }
    return dom as unknown as FinderManagerDom;
}

interface Harness {
    dom: FinderManagerDom;
    uiState: ReturnType<typeof normalizeFinderUiState>;
    selection: FinderStrategySelection;
    universeScope: { value: boolean };
}

function makeHarness(): Harness {
    const dom = makeDom();
    const uiState = normalizeFinderUiState(null);
    const universeScope = { value: false };
    const selection = new FinderStrategySelection({
        getDom: () => dom,
        getUiState: () => uiState,
        isUniverseSelectionScope: () => universeScope.value,
        persist: () => {},
    });
    return { dom, uiState, selection, universeScope };
}

/**
 * Populate the selection's toggle maps with one fake checkbox + item per key.
 * Mirrors `renderStrategySelection`'s DOM shape without pulling the full
 * built-in strategy manifest (its strategy implementations import
 * lightweight-charts, which the esno test runtime cannot resolve).
 */
function renderStrategies(harness: Harness, keys: string[]): void {
    const container = harness.dom.finderStrategyList;
    container.innerHTML = '';
    harness.selection.strategyToggles.clear();
    harness.selection.strategyItems.clear();
    harness.selection.strategyOrder = [];
    harness.selection.lastStrategyToggleKey = null;
    for (const key of keys) {
        const item = createFakeFinderElement();
        item.className = 'strategy-list-item';
        item.dataset.strategyKey = key;
        item.dataset.strategyName = key;
        const checkbox = createFakeFinderElement();
        checkbox.type = 'checkbox';
        checkbox.dataset.strategyKey = key;
        item.appendChild(checkbox);
        container.appendChild(item);
        harness.selection.strategyToggles.set(key, checkbox);
        harness.selection.strategyItems.set(key, item);
        harness.selection.strategyOrder.push(key);
    }
}

before(() => {
    (globalThis as any).HTMLInputElement = class {};
    (globalThis as any).HTMLSelectElement = class {};
    (globalThis as any).HTMLTextAreaElement = class {};
    const elsById = new Map<string, any>();
    (globalThis as any).document = {
        getElementById: (id: string) => {
            if (!elsById.has(id)) {
                elsById.set(id, createFakeFinderElement());
            }
            return elsById.get(id);
        },
        createElement: () => createFakeFinderElement(),
        createDocumentFragment: () => {
            const fragment = createFakeFinderElement();
            fragment.appendChild = (child: any) => {
                fragment.children.push(child);
                return child;
            };
            return fragment;
        },
        body: createFakeFinderElement(),
    };
});

after(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).HTMLInputElement;
    delete (globalThis as any).HTMLSelectElement;
    delete (globalThis as any).HTMLTextAreaElement;
});

beforeEach(() => {
    for (const key of Object.keys(strategyRegistry.getAll())) {
        strategyRegistry.unregister(key);
    }
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("FinderStrategySelection scope restoration", () => {
    it("keeps independent selected-key lists per scope and restores checkboxes on scope switch", () => {
        const harness = makeHarness();
        renderStrategies(harness, ["alpha", "beta"]);
        harness.selection.setStrategySelection(["alpha"], true);
        expect([...harness.uiState.currentChartSelectedStrategyKeys]).to.deep.equal(["alpha"]);

        // Switch to a universe-selection scope: nothing is selected there yet.
        harness.universeScope.value = true;
        expect(harness.selection.isStrategySelected("alpha")).to.equal(false);
        harness.selection.setStrategySelection(["beta"], true);
        expect([...harness.uiState.universeSelectedStrategyKeys]).to.deep.equal(["beta"]);
        expect([...harness.uiState.currentChartSelectedStrategyKeys]).to.deep.equal(["alpha"],
            "universe edits must not touch the current-chart list");

        // Switch back: the current-chart selection is restored into the DOM.
        harness.universeScope.value = false;
        harness.selection.syncStrategyToggleInputsFromState();
        const toggles = harness.selection.strategyToggles;
        expect(toggles.get("alpha")!.checked).to.equal(true);
        expect(toggles.get("beta")!.checked).to.equal(false);
    });

    it("applies the search filter to item visibility and reports it in the summary", () => {
        const harness = makeHarness();
        renderStrategies(harness, ["alpha", "beta"]);
        harness.dom.finderStrategySearch.value = "ALP";
        harness.selection.applyStrategyFilter();

        expect(harness.selection.strategyItems.get("alpha")!.hidden).to.equal(false);
        expect(harness.selection.strategyItems.get("beta")!.hidden).to.equal(true);
        expect(harness.dom.finderStrategySummary.textContent).to.include("visible");
    });

    it("selects a shift-click range over the ordered keys", () => {
        const harness = makeHarness();
        renderStrategies(harness, ["a", "b", "c", "d"]);

        const first = harness.selection.strategyToggles.get("a")!;
        first.checked = true;
        harness.selection.handleStrategyToggleClick("a", { shiftKey: false } as MouseEvent);
        // Shift-click on "c" applies the checked state of the clicked box to a..c.
        const third = harness.selection.strategyToggles.get("c")!;
        third.checked = true;
        harness.selection.handleStrategyToggleClick("c", { shiftKey: true } as MouseEvent);

        const selected = [...harness.uiState.currentChartSelectedStrategyKeys].sort();
        expect(selected).to.deep.equal(["a", "b", "c"]);
        expect(harness.selection.lastStrategyToggleKey).to.equal("c");
    });

    it("supports select-none, invert-visible, and replace selection", () => {
        const harness = makeHarness();
        renderStrategies(harness, ["a", "b", "c"]);
        harness.selection.setStrategySelection(["a", "b"], true);

        harness.selection.invertStrategySelection(["a", "c"]);
        expect([...harness.uiState.currentChartSelectedStrategyKeys].sort()).to.deep.equal(["b", "c"]);

        harness.selection.replaceStrategySelection(["c"]);
        expect([...harness.uiState.currentChartSelectedStrategyKeys]).to.deep.equal(["c"]);

        harness.selection.setStrategySelection(harness.selection.strategyOrder, false);
        expect(harness.uiState.currentChartSelectedStrategyKeys).to.deep.equal([]);
    });
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function stubApplyServices() {
    const calls = {
        appliedSettings: [] as unknown[],
        backtestRuns: 0,
        toasts: [] as Array<{ message: string; type: string }>,
        dropdown: [] as string[],
        renderStrategies: [] as string[],
        switchTab: [] as string[],
    };
    const saved = {
        showToast: uiManager.showToast,
        updateStrategyDropdown: uiManager.updateStrategyDropdown,
        render: paramManager.render,
        setValues: paramManager.setValues,
        applyBacktestSettings: settingsManager.applyBacktestSettings,
        switchTab: strategyPanelController.switchTab,
        runCurrentBacktest: backtestService.runCurrentBacktest,
        loadData: dataManager.loadData,
    };
    uiManager.showToast = (message: string, type: any = 'info') => { calls.toasts.push({ message, type }); };
    uiManager.updateStrategyDropdown = (key: string) => { calls.dropdown.push(key); };
    paramManager.render = (strategy: any) => { calls.renderStrategies.push(String(strategy?.name ?? "unknown")); };
    paramManager.setValues = () => {};
    settingsManager.applyBacktestSettings = (settings: any) => { calls.appliedSettings.push(settings); };
    strategyPanelController.switchTab = (tab: string) => { calls.switchTab.push(tab); return true; };
    backtestService.runCurrentBacktest = (async () => { calls.backtestRuns += 1; }) as any;
    dataManager.loadData = (async () => {}) as any;
    return {
        calls,
        restore() {
            Object.assign(uiManager, { showToast: saved.showToast, updateStrategyDropdown: saved.updateStrategyDropdown });
            Object.assign(paramManager, { render: saved.render, setValues: saved.setValues });
            Object.assign(settingsManager, { applyBacktestSettings: saved.applyBacktestSettings });
            Object.assign(strategyPanelController, { switchTab: saved.switchTab });
            Object.assign(backtestService, { runCurrentBacktest: saved.runCurrentBacktest });
            Object.assign(dataManager, { loadData: saved.loadData });
        },
    };
}

describe("FinderResultActions", () => {
    it("rejects a second Apply while one is in flight", async () => {
        const stubs = stubApplyServices();
        try {
            const store = new FinderResultStore(() => {});
            const actions = new FinderResultActions({
                getResultStore: () => store,
                getLastRunBacktestSettings: () => null,
                getLastFinderOptions: () => null,
                getLastFinderEvaluationData: () => null,
            });

            let release: () => void = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let firstFinished = false;
            const first = actions.runFinderApply(async () => {
                await gate;
                firstFinished = true;
            });

            let secondRan = false;
            await actions.runFinderApply(async () => { secondRan = true; });
            expect(secondRan).to.equal(false, "overlapping Apply must be excluded");
            expect(stubs.calls.toasts.some((toast) => toast.message.includes("already being applied"))).to.equal(true);

            release();
            await first;
            expect(firstFinished).to.equal(true);

            // After completion the guard is released.
            await actions.runFinderApply(async () => { secondRan = true; });
            expect(secondRan).to.equal(true);
        } finally {
            stubs.restore();
        }
    });

    it("applies an Arm candidate with the saved-context fallback when no run context exists", async () => {
        const stubs = stubApplyServices();
        try {
            const store = new FinderResultStore(() => {});
            const actions = new FinderResultActions({
                getResultStore: () => store,
                getLastRunBacktestSettings: () => null,
                getLastFinderOptions: () => null,
                getLastFinderEvaluationData: () => null,
            });
            const strategy = {
                name: "arm_apply_test",
                metadata: {},
                params: {},
                async init() {},
                generateSignal() { return null; },
                execute() { return []; },
            } as unknown as Strategy;
            strategyRegistry.register("arm_apply_test", strategy);
            state.set("currentInterval", "4h");

            const candidate: FinderArmPerformanceCandidate = {
                candidateId: "c0",
                candidateOrdinal: 0,
                strategyKey: "arm_apply_test",
                strategyName: "Arm Apply Test",
                replayMode: "horizon",
                horizon: 5,
                params: { threshold: 2 },
                backtestSettings: { executionModel: "signal_close", interval: "4h" } as any,
                pairCoverage: { requestedPairs: 1, completedPairs: 1, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
                metrics: {} as any,
                requestedEngineMode: "typescript",
                actualEngineMode: "typescript",
            };

            await actions.applyArmPerformanceCandidate(candidate);

            expect(stubs.calls.appliedSettings).to.have.length(1);
            expect(stubs.calls.backtestRuns).to.equal(1);
            expect(stubs.calls.dropdown).to.deep.equal(["arm_apply_test"]);
            expect(stubs.calls.switchTab).to.deep.equal(["trades"]);
            expect(stubs.calls.toasts.some((toast) => toast.message.includes("Applied Arm Apply Test"))).to.equal(true);
            expect(stubs.calls.toasts.some((toast) => toast.message.includes("context was unavailable"))).to.equal(true,
                "the fallback-context notice must be surfaced");
        } finally {
            stubs.restore();
        }
    });

    it("prefers the saved Arm run context over the fallback and surfaces nothing about fallback", async () => {
        const stubs = stubApplyServices();
        try {
            const store = new FinderResultStore(() => {});
            store.armPerformanceRunContext = {
                runId: "r1",
                interval: "1d",
                uiBacktestSettings: { riskSettingsToggle: true } as any,
                capitalSettings: { sizingMode: "fixed_usd" } as any,
            } as any;
            const results: FinderLatestResults = {
                scope: "arm_performance",
                results: [],
                runContext: store.armPerformanceRunContext,
                inventoryComplete: true,
            };
            store.setLatestResults(results, false);

            const actions = new FinderResultActions({
                getResultStore: () => store,
                getLastRunBacktestSettings: () => null,
                getLastFinderOptions: () => null,
                getLastFinderEvaluationData: () => null,
            });
            const strategy = {
                name: "arm_apply_saved",
                metadata: {},
                params: {},
                async init() {},
                generateSignal() { return null; },
                execute() { return []; },
            } as unknown as Strategy;
            strategyRegistry.register("arm_apply_saved", strategy);
            state.set("currentInterval", "1d");

            const candidate: FinderArmPerformanceCandidate = {
                candidateId: "c1",
                candidateOrdinal: 1,
                strategyKey: "arm_apply_saved",
                strategyName: "Arm Apply Saved",
                replayMode: "horizon",
                horizon: 5,
                params: {},
                backtestSettings: {} as any,
                pairCoverage: { requestedPairs: 1, completedPairs: 1, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
                metrics: {} as any,
                requestedEngineMode: "typescript",
                actualEngineMode: "typescript",
            };

            await actions.applyArmPerformanceCandidate(candidate);
            expect(stubs.calls.toasts.some((toast) => toast.message.includes("context was unavailable"))).to.equal(false);
            expect(stubs.calls.backtestRuns).to.equal(1);
        } finally {
            stubs.restore();
        }
    });

    it("aborts Apply with a visible error when the strategy no longer exists", async () => {
        const stubs = stubApplyServices();
        try {
            const store = new FinderResultStore(() => {});
            const actions = new FinderResultActions({
                getResultStore: () => store,
                getLastRunBacktestSettings: () => null,
                getLastFinderOptions: () => null,
                getLastFinderEvaluationData: () => null,
            });
            await actions.applyUniverseCandidate({
                strategyKey: "deleted_strategy",
                strategyName: "Deleted",
                params: {},
            } as any);

            expect(stubs.calls.toasts.some((toast) => toast.message.includes("no longer available"))).to.equal(true);
            expect(stubs.calls.backtestRuns).to.equal(0);
            expect(stubs.calls.appliedSettings).to.have.length(0);
        } finally {
            stubs.restore();
        }
    });
});
