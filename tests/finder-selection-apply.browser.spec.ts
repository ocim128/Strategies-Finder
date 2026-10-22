/**
 * Focused tests for the extracted Finder strategy selection
 * (`lib/finder/browser/finder-strategy-selection.ts`) and candidate Apply
 * actions (`lib/finder/browser/finder-result-actions.ts`).
 *
 * Covers scope selection restoration, filtered/bulk/range (shift-click)
 * selection, the duplicate-Apply exclusion guard, and the Arm Apply
 * saved-context fallback. Frozen risk/exit settings construction stays
 * covered by finder-arm-performance-settings.spec.ts.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "node:test";
import { FINDER_STRATEGY_PRESETS, FinderStrategySelection } from "../lib/finder/browser/finder-strategy-selection";
import { builtInStrategyKeys } from "../lib/strategies/manifest-keys";
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
import type { BacktestSettings, OHLCVData, Strategy } from "../lib/types/strategies";
import { executeBacktest } from "../lib/backtest-executor";
import { runFinderUniverseExecution } from "../lib/finder/finder-runner-universe";
import { sliceFinderDataWindow } from "../lib/finder/finder-manager-logic";
import { decay_anchor_reversion } from "../lib/strategies/lib/decay_anchor_reversion";
import { DEFAULT_BACKTEST_SETTINGS } from "../lib/settings-model";

// ---------------------------------------------------------------------------
// DOM stand-in
// ---------------------------------------------------------------------------

function makeDom(): FinderManagerDom {
    const dom: Record<string, any> = {};
    for (const id of [
        "finderStrategyList", "finderStrategySearch", "finderStrategiesToggleAll",
        "finderStrategySelectVisible", "finderStrategyInvertVisible", "finderStrategySummary",
        "finderStrategySelectFollow", "finderStrategySelectReversion",
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
    it("renders saved selections and switches scope without stale membership", () => {
        const harness = makeHarness();
        const [chartKey, universeKey] = builtInStrategyKeys;
        harness.uiState.currentChartSelectedStrategyKeys = [chartKey!];
        harness.uiState.universeSelectedStrategyKeys = [universeKey!];
        harness.selection.renderStrategySelection();
        expect(harness.selection.strategyToggles.get(chartKey!)!.checked).to.equal(true);
        expect(harness.selection.strategyToggles.get(universeKey!)!.checked).to.equal(false);
        harness.universeScope.value = true;
        harness.selection.syncStrategyToggleInputsFromState();
        expect(harness.selection.strategyToggles.get(chartKey!)!.checked).to.equal(false);
        expect(harness.selection.strategyToggles.get(universeKey!)!.checked).to.equal(true);
        harness.selection.setStrategySelection([chartKey!], true);
        harness.selection.syncStrategyToggleInputsFromState();
        expect(harness.selection.strategyToggles.get(chartKey!)!.checked).to.equal(true);
    });

    it("reports preset availability against the built-in catalog and preserves empty-preset selections", () => {
        const harness = makeHarness();
        renderStrategies(harness, [...builtInStrategyKeys]);
        const selectedKey = builtInStrategyKeys[0]!;
        harness.selection.setStrategySelection([selectedKey], true);
        for (const preset of FINDER_STRATEGY_PRESETS) {
            const available = preset.keys.filter((key) => builtInStrategyKeys.includes(key));
            const button = harness.dom[preset.button];
            expect(button.disabled).to.equal(available.length === 0);
            expect(button.textContent).to.equal(`${preset.label} (${available.length})`);
            harness.selection.replaceStrategySelection(preset.keys);
            expect(harness.uiState.currentChartSelectedStrategyKeys).to.deep.equal(
                available.length > 0 ? available : [selectedKey],
            );
            harness.selection.setStrategySelection(harness.selection.strategyOrder, false);
            harness.selection.setStrategySelection([selectedKey], true);
        }
        harness.selection.replaceStrategySelection(["unavailable_preset_strategy"]);
        expect(harness.uiState.currentChartSelectedStrategyKeys).to.deep.equal([selectedKey]);
        expect(harness.selection.strategyToggles.get(selectedKey)!.checked).to.equal(true);
    });

    it("re-enables a preset when its strategies become available", () => {
        const harness = makeHarness();
        renderStrategies(harness, ["existing"]);
        harness.selection.syncStrategySelectionUi();
        expect(harness.dom.finderStrategySelectFollow.disabled).to.equal(true);
        const followKey = FINDER_STRATEGY_PRESETS[0].keys[0];
        renderStrategies(harness, ["existing", followKey]);
        harness.selection.syncStrategySelectionUi();
        expect(harness.dom.finderStrategySelectFollow.disabled).to.equal(false);
        expect(harness.dom.finderStrategySelectFollow.textContent).to.equal("Follow (1)");
        harness.selection.replaceStrategySelection(FINDER_STRATEGY_PRESETS[0].keys);
        expect(harness.uiState.currentChartSelectedStrategyKeys).to.deep.equal([followKey]);
    });

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
    for (const tradeDirection of ['long', 'short'] as const) {
        it(`reproduces the Universe IS result on a full-history 50/50 chart (${tradeDirection})`, async () => {
            const stubs = stubApplyServices();
            const saved = { symbol: state.currentSymbol, interval: state.currentInterval, strategy: state.currentStrategyKey,
                data: state.ohlcvData, block: state.blockRange };
            try {
                const symbol = 'SMCI\u2022+AAPL\u2022@50/50';
                const start = Date.parse('2026-01-01T00:00:00Z') / 1000;
                const data: OHLCVData[] = Array.from({ length: 1200 }, (_, i) => {
                    const base = 100 + 9 * Math.sin(i / 30) + i * 0.006;
                    const quote = 100 + i * 0.01;
                    const ratio = base / quote;
                    return { time: (start + i * 1800) as OHLCVData['time'], open: ratio,
                        high: Math.max(ratio, (base + 0.03) / (quote + 0.03)), low: Math.min(ratio, (base - 0.03) / (quote - 0.03)),
                        close: ratio, volume: 1,
                        pairLegs: [[base, base + 0.03, base - 0.03, base, quote, quote + 0.03, quote - 0.03, quote]],
                    };
                });
                const settings = { executionModel: 'next_open', tradeDirection, slippageBps: 1,
                    stopLossEnabled: false, stopLossPercent: 5.97, takeProfitEnabled: false, takeProfitPercent: 7.38,
                } as BacktestSettings;
                const capitalSettings = { initialCapital: 10000, positionSize: 10, commission: 0.1,
                    sizingMode: 'fixed' as const, fixedTradeAmount: 1000 };
                const options = { scope: 'symbol_universe', mode: 'random', sortPriority: ['netProfit'], useAdvancedSort: false,
                    dataSlice: 'date_range', dataRangeFrom: '2026-01-07', dataRangeTo: '2026-01-18',
                    topN: 1, steps: 1, rangePercent: 0, maxRuns: 1, tradeFilterEnabled: false, minTrades: 0, maxTrades: Infinity,
                    freezeRiskManagement: true,
                    universe: { symbols: [symbol], minActiveSymbols: 1, minTotalTrades: 1, minProfitableActiveRatio: 0, sortPriority: [] },
                } as const;
                const key = 'decay_anchor_apply_test';
                strategyRegistry.register(key, decay_anchor_reversion);
                const universe = await runFinderUniverseExecution({
                    interval: '30m', settings, capitalSettings,
                    selectedStrategy: { key, name: decay_anchor_reversion.name, strategy: decay_anchor_reversion },
                    options: { ...options, sortPriority: [...options.sortPriority], universe: { ...options.universe, symbols: [symbol], sortPriority: [] } },
                    loadDataset: async () => sliceFinderDataWindow(data, options.dataSlice, { from: options.dataRangeFrom, to: options.dataRangeTo }),
                    generateParamSets: () => [{ decay: 1 }],
                }, { setProgress() {}, setStatus() {}, yieldControl: async () => {}, isCancelled: () => false });
                const candidate = universe.results[0]!;
                expect(candidate, 'fixture must produce a survivor').to.exist;
                const expected = candidate.symbols[0].result!;
                expect(expected.totalTrades).to.be.greaterThan(0);
                // Exercise shorthand matching and a conflicting pre-existing block.
                state.set('currentSymbol', symbol.replace('@50/50', '@'));
                state.set('currentInterval', '30m');
                state.set('ohlcvData', data);
                state.set('blockRange', { from: start, to: start + 1800 });
                const store = new FinderResultStore(() => {});
                const actions = new FinderResultActions({
                    getResultStore: () => store, getLastRunBacktestSettings: () => ({ ...DEFAULT_BACKTEST_SETTINGS, ...settings }),
                    // A restored result still has row bounds even without the original options.
                    getLastFinderOptions: () => null, getLastFinderEvaluationData: () => null,
                });
                const replay = async (blockRange: typeof state.blockRange) => (await executeBacktest({
                    ohlcvData: state.ohlcvData, interval: state.currentInterval, primarySymbol: state.currentSymbol,
                    strategyKey: key, strategy: strategyRegistry.get(key), strategyParams: candidate.params,
                    backtestSettings: (stubs.calls.appliedSettings[0] ?? settings) as BacktestSettings, capitalSettings,
                    context: { engineMode: 'typescript', nowSec: 1792705762, blockRange },
                })).result;
                backtestService.runCurrentBacktest = (async () => {
                    stubs.calls.backtestRuns++;
                    const actual = await replay(state.blockRange);
                    for (const metric of ['totalTrades', 'winningTrades', 'losingTrades', 'netProfit', 'expectancy', 'profitFactor', 'winRate'] as const) {
                        if (Number.isFinite(expected[metric])) expect(actual[metric], metric).to.be.closeTo(expected[metric], 1e-9);
                        else expect(actual[metric], metric).to.equal(expected[metric]);
                    }
                    expect(actual.trades.every(trade => trade.legs?.base && trade.legs.quote)).to.equal(true);
                }) as typeof backtestService.runCurrentBacktest;
                await actions.applyUniverseCandidate(candidate);
                expect(stubs.calls.backtestRuns).to.equal(1);
                expect(stubs.calls.toasts.some(toast => toast.type === 'error')).to.equal(false, 'Apply must not swallow a parity assertion');
                expect(state.blockRange).to.deep.equal({ from: candidate.symbols[0].firstTime, to: candidate.symbols[0].lastTime });
                const full = await replay(null);
                expect(full.netProfit).not.to.equal(expected.netProfit, 'full-history run must reproduce the original discrepancy');
            } finally {
                state.set('currentSymbol', saved.symbol);
                state.set('currentInterval', saved.interval);
                state.set('currentStrategyKey', saved.strategy);
                state.set('ohlcvData', saved.data);
                state.set('blockRange', saved.block);
                stubs.restore();
            }
        });
    }

    for (const bounds of [
        { symbol: 'SMCI\u2022+AAPL\u2022', firstTime: 100, lastTime: 200 },
        { symbol: 'SMCI\u2022+AAPL\u2022@50/50', firstTime: 'invalid', lastTime: 200 },
        { symbol: 'SMCI\u2022+AAPL\u2022@50/50', firstTime: 200, lastTime: 100 },
    ]) {
        it(`keeps the chart range when the retained window is unavailable: ${JSON.stringify(bounds)}`, async () => {
            const stubs = stubApplyServices();
            const saved = { symbol: state.currentSymbol, block: state.blockRange, strategy: state.currentStrategyKey };
            try {
                strategyRegistry.register('apply_without_window', decay_anchor_reversion);
                state.set('currentSymbol', 'SMCI\u2022+AAPL\u2022@50/50');
                state.set('blockRange', { from: 50, to: 70 });
                const store = new FinderResultStore(() => {});
                const actions = new FinderResultActions({
                    getResultStore: () => store, getLastRunBacktestSettings: () => DEFAULT_BACKTEST_SETTINGS,
                    getLastFinderOptions: () => null, getLastFinderEvaluationData: () => null,
                });
                await actions.applyUniverseCandidate({ strategyKey: 'apply_without_window', params: { decay: 1 },
                    symbols: [bounds], profitableSymbols: 1, activeSymbols: 1, totalTrades: 2,
                } as unknown as Parameters<FinderResultActions['applyUniverseCandidate']>[0]);
                expect(stubs.calls.backtestRuns).to.equal(1);
                expect(state.blockRange).to.deep.equal({ from: 50, to: 70 });
                expect(stubs.calls.toasts.some(toast => toast.message.includes('original symbol window unavailable'))).to.equal(true);
            } finally {
                state.set('currentSymbol', saved.symbol);
                state.set('currentStrategyKey', saved.strategy);
                state.set('blockRange', saved.block);
                stubs.restore();
            }
        });
    }

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
