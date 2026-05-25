import { ensureLazyStylesheet } from "./lazy-styles";
import { getBuiltInMeta, strategyRegistry } from "../strategyRegistry";
import { createEnsembleLabDom, type EnsembleLabDom } from "./strategy-ensemble-dom";
import {
    describeEnsembleRecipeReplayDirectionOverride,
    normalizeEnsembleRecipeReplayDirectionOverride,
    type EnsembleRecipeReplayDirectionOverride,
} from "./ensemble-signal-direction";
import { StrategyEnsembleExport } from "./strategy-ensemble-export";
import { StrategyEnsembleRecipeBuilder } from "./strategy-ensemble-recipe-builder";
import { StrategyEnsemblePolymarketRunner } from "./strategy-ensemble-polymarket-runner";
import { StrategyEnsembleRecipeRunner } from "./strategy-ensemble-recipe-runner";
import {
    EnsembleRunOrchestrator,
} from "./strategy-ensemble-run-orchestrator";
import {
    escapeHtml,
    resetStrategyEnsembleResultPanels,
} from "./strategy-ensemble-renderer";
import {
    type EnsemblePolymarketConflictPolicy,
    type EnsemblePolymarketDirectionSlice,
    type EnsemblePolymarketOverridePairResult,
    type EnsemblePolymarketRunResult,
    type EnsemblePolymarketVetoPairResult,
} from "./strategy-ensemble-polymarket-engine";
import {
    resetEnsemblePolymarketPanel,
} from "./strategy-ensemble-polymarket-renderer";
import {
    settingsManager,
    sortEnsembleSignalRecipesNewestFirst,
    sortStrategyConfigsNewestFirst,
    type EnsembleSignalRecipe,
    type StrategyConfig,
} from "./settings-manager";
import { state, type StateKey } from "./state";
import { clearBacktestResults, commitBacktestResult } from "./state-actions";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { type BacktestSettings } from "./strategies";
import { setActiveBacktestRerunContext } from "./backtest-rerun-context";
import { uiManager } from "./ui-manager";
import {
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
} from "./polymarket-btc5m";
import { setVisible } from "./dom-utils";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { BacktestResult } from "./types/strategies";

class StrategyEnsembleService {
    private static readonly MAX_REPLACEMENT_ROWS = 12;
    private static readonly MAX_RULE_VALIDATION_CANDIDATES = 12;
    private static readonly MAX_RULE_BUILDER_ROWS = 10;

    private dom: EnsembleLabDom | null = null;
    private initialized = false;
    private orchestrator!: EnsembleRunOrchestrator;
    private contextCheckboxes = new Map<string, HTMLInputElement>();
    private contextItems = new Map<string, HTMLElement>();
    private contextConfigs = new Map<string, StrategyConfig>();
    private targetOptionButtons = new Map<string, HTMLButtonElement>();
    private contextOrder: string[] = [];
    private lastContextToggleName: string | null = null;
    private targetMenuOpen = false;
    private polymarketRunner: StrategyEnsemblePolymarketRunner | null = null;
    private recipeBuilder: StrategyEnsembleRecipeBuilder | null = null;
    private exportModule: StrategyEnsembleExport | null = null;
    private recipeRunner: StrategyEnsembleRecipeRunner | null = null;

    private getDom(): EnsembleLabDom {
        return this.dom ??= createEnsembleLabDom();
    }

    private async yieldToUi(): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }

    private bindAsyncClick(button: HTMLButtonElement, action: () => Promise<void>): void {
        button.addEventListener("click", () => {
            void action();
        });
    }

    private bindDelegatedButtonClick(
        container: HTMLElement,
        selector: string,
        action: (button: HTMLButtonElement) => void
    ): void {
        container.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const button = target.closest<HTMLButtonElement>(selector);
            if (!button) {
                return;
            }

            action(button);
        });
    }

    private bindInvalidatingEvent(
        element: HTMLInputElement | HTMLSelectElement,
        eventName: "change" | "input",
        message: string,
        beforeInvalidate?: () => void
    ): void {
        element.addEventListener(eventName, () => {
            beforeInvalidate?.();
            this.invalidateRunContext(message);
        });
    }

    private subscribeAndInvalidate(
        key: StateKey,
        message: string,
        beforeInvalidate?: () => void
    ): void {
        state.subscribe(key, () => {
            beforeInvalidate?.();
            this.invalidateRunContext(message);
        });
    }

    public init(): void {
        ensureLazyStylesheet("strategy-ensemble-styles", new URL("../styles/strategy-ensemble.css", import.meta.url).href);
        if (this.initialized) {
            return;
        }

        this.exportModule = new StrategyEnsembleExport({
            getSelectedSignalRecipe: () => this.getSelectedSignalRecipe(),
            updateSignalRecipeStatus: (msg) => this.updateSignalRecipeStatus(msg),
            getSelectedRecipeDirectionOverride: () => this.getSelectedRecipeDirectionOverride(),
            syncSavedSignalRecipeOptions: () => this.syncSavedSignalRecipeOptions(),
        });
        this.polymarketRunner = new StrategyEnsemblePolymarketRunner({
            getDom: () => this.getDom(),
            updateStatus: (msg) => this.updateStatus(msg),
            updatePolymarketStatus: (msg) => this.updatePolymarketStatus(msg),
            syncPolymarketAvailability: () => this.syncPolymarketAvailability(),
            syncSavedSignalRecipeOptions: () => this.syncSavedSignalRecipeOptions(),
            syncSavedSignalRecipeControls: () => this.syncSavedSignalRecipeControls(),
            getSelectedTargetName: () => this.getSelectedTargetName(),
            getSelectedContextNames: () => this.getSelectedContextNames(),
            prepareCandles: () => this.orchestrator.prepareCandles(),
            invalidateRunContext: (msg) => this.invalidateRunContext(msg),
            cloneStrategyConfigSnapshot: (config) => this.cloneStrategyConfigSnapshot(config),
            buildVetoRecipeFromPair: (pair) => this.buildVetoRecipeFromPair(pair),
            buildOverrideRecipeFromPair: (pair) => this.buildOverrideRecipeFromPair(pair),
            loadRecipeBacktest: (recipe, msg) => this.loadRecipeBacktest(recipe, msg),
        });
        this.recipeBuilder = new StrategyEnsembleRecipeBuilder({
            getLastPolymarketRunResult: () => this.polymarketRunner?.lastPolymarketRunResult ?? null,
            getLastPolymarketSelection: () => this.polymarketRunner?.lastPolymarketSelection ?? null,
            requirePolymarketRunContext: (usage) => this.requirePolymarketRunContext(usage),
            describePolymarketDirectionSlice: (slice) => this.describePolymarketDirectionSlice(slice),
            getSelectedPolymarketConflictPolicy: () => this.getSelectedPolymarketConflictPolicy(),
        });
        this.recipeRunner = new StrategyEnsembleRecipeRunner({
            getDom: () => this.getDom(),
            updateStatus: (msg) => this.updateStatus(msg),
            updateSignalRecipeStatus: (msg) => this.updateSignalRecipeStatus(msg),
            updatePolymarketStatus: (msg) => this.updatePolymarketStatus(msg),
            prepareCandles: () => this.orchestrator.prepareCandles(),
            buildSelectedPolicyRecipeFromCurrentRun: () => this.buildSelectedPolicyRecipeFromCurrentRun(),
            buildBestVetoRecipeFromCurrentRun: () => this.buildBestVetoRecipeFromCurrentRun(),
            buildVetoRecipeFromPair: (pair) => this.buildVetoRecipeFromPair(pair),
            buildOverrideRecipeFromPair: (pair) => this.buildOverrideRecipeFromPair(pair),
            attachPolymarketOutcomesToBacktestResult: (result, outcomes, interval) => this.attachPolymarketOutcomesToBacktestResult(result, outcomes, interval),
            getLastPolymarketOutcomes: () => this.polymarketRunner?.lastPolymarketOutcomes ?? [],
            cloneStrategyConfigSnapshot: (config) => this.cloneStrategyConfigSnapshot(config),
            syncSavedSignalRecipeOptions: (name) => this.syncSavedSignalRecipeOptions(name),
            describeRecipeMode: (mode) => this.describeRecipeMode(mode),
            formatPreviewExecutionSettings: (config) => this.formatPreviewExecutionSettings(config),
        });

        this.orchestrator = new EnsembleRunOrchestrator(
            {
                getDom: () => this.getDom(),
                updateStatus: (msg) => this.updateStatus(msg),
                yieldToUi: () => this.yieldToUi(),
                getSelectedTargetName: () => this.getSelectedTargetName(),
                getSelectedContextNames: () => this.getSelectedContextNames(),
                readMinSamples: () => this.readMinSamples(),
                showToast: (msg, type) => uiManager.showToast(msg, type),
            },
            {
                maxRuleValidationCandidates: StrategyEnsembleService.MAX_RULE_VALIDATION_CANDIDATES,
                maxRuleBuilderRows: StrategyEnsembleService.MAX_RULE_BUILDER_ROWS,
                maxReplacementRows: StrategyEnsembleService.MAX_REPLACEMENT_ROWS,
            }
        );

        const dom = this.getDom();
        this.bindEvents(dom);
        this.syncReadouts(dom);
        this.populateConfigs(dom);
        this.syncPolymarketAvailability();
        this.syncSavedSignalRecipeOptions();
        this.initialized = true;
    }

    private bindEvents(dom: EnsembleLabDom): void {
        dom.ensembleTargetButton.addEventListener("click", () => {
            this.toggleTargetPicker();
        });

        dom.ensembleTargetSearch.addEventListener("input", () => {
            this.applyTargetPickerFilter();
        });

        dom.ensembleTargetSearch.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                this.closeTargetPicker();
                dom.ensembleTargetButton.focus();
            }
        });

        this.bindAsyncClick(dom.ensembleRunBtn, () => this.run());
        this.bindAsyncClick(dom.ensembleRunPolymarketBtn, () => this.runPolymarket());
        this.bindDelegatedButtonClick(
            dom.ensemblePolymarketTableBody,
            "[data-ensemble-polymarket-config-backtest]",
            (button) => {
                const configName = button.dataset.ensemblePolymarketConfigBacktest?.trim();
                if (!configName) {
                    return;
                }

                void this.loadPolymarketConfigBacktest(configName);
            }
        );
        this.bindDelegatedButtonClick(
            dom.ensemblePolymarketVetoTableBody,
            "[data-ensemble-polymarket-veto-backtest]",
            (button) => {
                const primaryConfigName = button.dataset.ensemblePolymarketVetoBacktest?.trim();
                const vetoConfigName = button.dataset.ensemblePolymarketVetoConfig?.trim();
                if (!primaryConfigName || !vetoConfigName) {
                    return;
                }

                void this.loadPolymarketVetoPairBacktest(primaryConfigName, vetoConfigName);
            }
        );
        this.bindDelegatedButtonClick(
            dom.ensemblePolymarketOverrideTableBody,
            "[data-ensemble-polymarket-override-backtest]",
            (button) => {
                const primaryConfigName = button.dataset.ensemblePolymarketOverrideBacktest?.trim();
                const secondaryConfigName = button.dataset.ensemblePolymarketSecondaryConfig?.trim();
                if (!primaryConfigName || !secondaryConfigName) {
                    return;
                }

                void this.loadPolymarketOverridePairBacktest(primaryConfigName, secondaryConfigName);
            }
        );
        this.bindDelegatedButtonClick(
            dom.ensemblePolymarketAgreement,
            "[data-ensemble-polymarket-selected-policy-backtest], [data-ensemble-polymarket-best-veto-backtest]",
            (button) => {
                if (button.matches("[data-ensemble-polymarket-selected-policy-backtest]")) {
                    void this.loadConflictFilterBacktest();
                    return;
                }

                void this.loadBestVetoBacktest();
            }
        );
        [
            {
                element: dom.ensemblePolymarketConflictPolicy,
                message: "Polymarket conflict policy changed. Run Ensemble Polymarket again.",
            },
            {
                element: dom.ensemblePolymarketDirectionSlice,
                message: "Polymarket direction slice changed. Run Ensemble Polymarket again.",
            },
        ].forEach(({ element, message }) => {
            this.bindInvalidatingEvent(element, "change", message, () => {
                this.syncSavedSignalRecipeControls();
            });
        });
        this.bindAsyncClick(dom.ensembleLoadConflictBacktestBtn, () => this.loadConflictFilterBacktest());
        this.bindAsyncClick(dom.ensembleLoadBestVetoBacktestBtn, () => this.loadBestVetoBacktest());
        [
            { button: dom.ensembleSaveConflictRecipeBtn, action: () => this.saveConflictFilterRecipe() },
            { button: dom.ensembleSaveBestVetoRecipeBtn, action: () => this.saveBestVetoRecipe() },
            { button: dom.ensembleSignalRecipeDeleteBtn, action: () => this.exportModule!.deleteSelectedSignalRecipe() },
        ].forEach(({ button, action }) => {
            button.addEventListener("click", action);
        });
        [
            dom.ensembleSignalRecipeSelect,
            dom.ensembleSignalRecipeDirectionSelect,
        ].forEach((element) => {
            element.addEventListener("change", () => {
                this.syncSavedSignalRecipeControls();
            });
        });
        this.bindAsyncClick(dom.ensembleSignalRecipeDownloadScriptBtn, () => this.exportModule!.downloadSelectedSignalRecipeBridge());
        this.bindAsyncClick(dom.ensembleSignalRecipeCopyEnvBtn, () => this.exportModule!.copySelectedSignalRecipeEnv());

        dom.ensembleRefreshConfigsBtn.addEventListener("click", () => {
            this.populateConfigs(dom);
            this.invalidateRunContext("Configs refreshed. Run Strategy Ensemble Lab again.");
        });

        this.bindInvalidatingEvent(
            dom.ensembleTargetSelect,
            "change",
            "Target config changed. Run Strategy Ensemble Lab again.",
            () => {
                this.syncTargetPickerUi();
                this.syncTargetContextState();
                this.renderTargetSummary();
                this.applyContextFilter();
            }
        );

        this.bindInvalidatingEvent(
            dom.ensembleMinSamples,
            "input",
            "Minimum sample threshold changed. Run Strategy Ensemble Lab again."
        );

        dom.ensembleContextSearch.addEventListener("input", () => {
            this.applyContextFilter();
        });

        dom.ensembleContextFamilyFilter.addEventListener("change", () => {
            this.applyContextFilter();
        });

        [
            { button: dom.ensembleContextSelectAll, action: () => this.setContextSelection(this.contextOrder, true) },
            { button: dom.ensembleContextSelectNone, action: () => this.setContextSelection(this.contextOrder, false) },
            { button: dom.ensembleContextInvertVisible, action: () => this.invertContextSelection(this.getVisibleContextNames()) },
            { button: dom.ensembleContextSelectVisible, action: () => this.setContextSelection(this.getVisibleContextNames(), true) },
            { button: dom.ensembleContextSelectSameFamily, action: () => this.applyTargetFamilySelection("same") },
            { button: dom.ensembleContextExcludeSameFamily, action: () => this.applyTargetFamilySelection("exclude") },
        ].forEach(({ button, action }) => {
            button.addEventListener("click", action);
        });

        this.bindDelegatedButtonClick(dom.ensembleBuilderTableBody, "[data-ensemble-preview-rule-id]", (button) => {
            const ruleId = button.dataset.ensemblePreviewRuleId?.trim();
            if (!ruleId) {
                return;
            }

            void this.loadBuilderPreview(ruleId);
        });

        [
            {
                key: "currentSymbol" as const,
                message: "Target symbol changed. Run Strategy Ensemble Lab again.",
                beforeInvalidate: () => {
                    this.clearActiveEnsemblePreview("Chart market changed. Frozen ensemble preview cleared.");
                    this.syncReadouts(dom);
                    this.syncPolymarketAvailability();
                },
            },
            {
                key: "currentInterval" as const,
                message: "Timeframe changed. Run Strategy Ensemble Lab again.",
                beforeInvalidate: () => {
                    this.clearActiveEnsemblePreview("Chart timeframe changed. Frozen ensemble preview cleared.");
                    this.syncReadouts(dom);
                    this.syncPolymarketAvailability();
                },
            },
            {
                key: "ohlcvData" as const,
                message: "Loaded data changed. Run Strategy Ensemble Lab again.",
            },
            {
                key: "blockRange" as const,
                message: "Block selection changed. Run Strategy Ensemble Lab again.",
            },
        ].forEach(({ key, message, beforeInvalidate }) => {
            this.subscribeAndInvalidate(key, message, beforeInvalidate);
        });

        document.addEventListener("click", (event) => {
            if (!this.targetMenuOpen) {
                return;
            }

            const target = event.target;
            if (!(target instanceof Node)) {
                return;
            }

            if (!dom.ensembleTargetPicker.contains(target)) {
                this.closeTargetPicker();
            }
        });
    }

    private syncReadouts(dom: EnsembleLabDom): void {
        dom.ensembleSymbolBadge.textContent = state.currentSymbol;
        dom.ensembleIntervalBadge.textContent = state.currentInterval;
    }

    private syncSavedSignalRecipeOptions(preferredName?: string): void {
        const dom = this.getDom();
        const recipes = sortEnsembleSignalRecipesNewestFirst(settingsManager.loadAllEnsembleSignalRecipes());
        const selectedName = preferredName ?? dom.ensembleSignalRecipeSelect.value;

        dom.ensembleSignalRecipeSelect.innerHTML = '<option value="">Select saved ensemble signal recipe</option>';
        for (const recipe of recipes) {
            const option = document.createElement("option");
            option.value = recipe.name;
            option.textContent = `${recipe.name} | ${this.describeRecipeMode(recipe.mode)} | ${this.describePolymarketDirectionSlice(recipe.directionSlice)} | ${recipe.symbol} ${recipe.interval}`;
            dom.ensembleSignalRecipeSelect.appendChild(option);
        }

        if (selectedName && recipes.some((recipe) => recipe.name === selectedName)) {
            dom.ensembleSignalRecipeSelect.value = selectedName;
        } else {
            dom.ensembleSignalRecipeSelect.value = recipes[0]?.name ?? "";
        }

        this.syncSavedSignalRecipeControls();
    }

    private syncSavedSignalRecipeControls(): void {
        const dom = this.getDom();
        const selectedRecipe = this.getSelectedSignalRecipe();
        const selectedPolicyResult = this.getSelectedPolymarketPolicyResult();
        const hasPolymarketResult = (this.polymarketRunner?.lastPolymarketRunResult ?? null) !== null;
        const hasBestVeto = Boolean(this.polymarketRunner?.lastPolymarketRunResult?.vetoScan.bestPair);

        dom.ensembleLoadConflictBacktestBtn.disabled = !selectedPolicyResult;
        dom.ensembleSaveConflictRecipeBtn.disabled = !selectedPolicyResult;
        dom.ensembleLoadBestVetoBacktestBtn.disabled = !hasBestVeto;
        dom.ensembleSaveBestVetoRecipeBtn.disabled = !hasBestVeto;
        dom.ensembleSignalRecipeDownloadScriptBtn.disabled = !selectedRecipe;
        dom.ensembleSignalRecipeCopyEnvBtn.disabled = !selectedRecipe;
        dom.ensembleSignalRecipeDeleteBtn.disabled = !selectedRecipe;
        dom.ensembleLoadConflictBacktestBtn.textContent = selectedPolicyResult
            ? `View Selected Policy Backtest (${selectedPolicyResult.scoredTrades})`
            : "View Selected Policy Backtest";
        dom.ensembleLoadBestVetoBacktestBtn.textContent = this.polymarketRunner?.lastPolymarketRunResult?.vetoScan.bestPair
            ? `View Best Veto Backtest (${this.polymarketRunner.lastPolymarketRunResult.vetoScan.bestPair.keptEvents})`
            : "View Best Veto Backtest";

        if (selectedRecipe) {
            this.updateSignalRecipeStatus(this.describeSelectedRecipe(selectedRecipe));
            return;
        }

        if (hasPolymarketResult) {
            this.updateSignalRecipeStatus(
                selectedPolicyResult
                    ? `Current Polymarket run is ready. Load or save the selected ${this.describePolymarketConflictPolicy(selectedPolicyResult.policy)} recipe, or save the best-veto recipe for later export.`
                    : "Current Polymarket run is ready. Switch to a policy with a valid executable recipe, or save the best-veto recipe for later export."
            );
            return;
        }

        this.updateSignalRecipeStatus(
            "Save a tradable selected-policy or best-veto recipe from the current run to export it later as an external signal."
        );
    }

    private updateSignalRecipeStatus(message: string): void {
        this.getDom().ensembleSignalRecipeStatus.textContent = message;
    }

    private getSelectedRecipeDirectionOverride(): EnsembleRecipeReplayDirectionOverride {
        return normalizeEnsembleRecipeReplayDirectionOverride(
            this.getDom().ensembleSignalRecipeDirectionSelect.value,
            "auto"
        );
    }

    private getSelectedPolymarketConflictPolicy(): EnsemblePolymarketConflictPolicy {
        return this.polymarketRunner!.getSelectedPolymarketConflictPolicy();
    }

    private getSelectedPolymarketPolicyResult(): EnsemblePolymarketRunResult["selectedPolicyResult"] {
        return this.polymarketRunner!.getSelectedPolymarketPolicyResult();
    }

    private clearActiveEnsemblePreview(message: string): void {
        if (state.currentBacktestResultSource !== "ensemble_preview" || !state.currentBacktestResult) {
            return;
        }

        clearBacktestResults("ensemble_preview_context_changed");
        this.updateSignalRecipeStatus(`${message} Load the preview again after switching back to the original market.`);
    }

    private getSelectedSignalRecipe(): EnsembleSignalRecipe | null {
        const selectedName = this.getDom().ensembleSignalRecipeSelect.value.trim();
        if (!selectedName) {
            return null;
        }
        return settingsManager.loadEnsembleSignalRecipe(selectedName);
    }

    private populateConfigs(dom: EnsembleLabDom): void {
        const previousTarget = dom.ensembleTargetSelect.value.trim();
        const previousChecked = new Set(
            Array.from(this.contextCheckboxes.entries())
                .filter(([, checkbox]) => checkbox.checked)
                .map(([name]) => name)
        );
        const previousFamilyFilter = dom.ensembleContextFamilyFilter.value;
        const previousRecipeSelection = dom.ensembleSignalRecipeSelect.value;
        const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());

        this.contextCheckboxes.clear();
        this.contextItems.clear();
        this.contextConfigs.clear();
        this.targetOptionButtons.clear();
        this.contextOrder = [];
        this.lastContextToggleName = null;
        this.closeTargetPicker();
        dom.ensembleTargetSearch.value = "";
        dom.ensembleTargetSelect.innerHTML = '<option value="" disabled>Select target config</option>';
        dom.ensembleTargetList.innerHTML = "";

        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = this.buildConfigLabel(config);
            dom.ensembleTargetSelect.appendChild(option);
            this.contextConfigs.set(config.name, config);
            dom.ensembleTargetList.appendChild(this.createTargetOption(config));
        }

        if (previousTarget && configs.some((config) => config.name === previousTarget)) {
            dom.ensembleTargetSelect.value = previousTarget;
        } else if (configs.length > 0) {
            dom.ensembleTargetSelect.value = configs[0].name;
        }

        this.syncTargetPickerUi();
        this.applyTargetPickerFilter();
        this.populateFamilyFilter(configs, previousFamilyFilter);

        if (configs.length === 0) {
            dom.ensembleTargetSummary.textContent = "Save a strategy configuration first to define the target and its confirming context set.";
            dom.ensembleContextList.innerHTML = "";
            dom.ensembleContextHelper.style.display = "none";
            dom.ensembleContextEmptyState.style.display = "none";
            dom.ensembleContextSummary.textContent = "0 selected";
            this.setConfigAvailability(false);
            resetStrategyEnsembleResultPanels(this.getDom());
            resetEnsemblePolymarketPanel(this.getDom());
            this.polymarketRunner?.clearState();
            this.updateStatus("Save strategy configurations, then select a target and context strategies to run ensemble analysis.");
            this.syncSavedSignalRecipeOptions(previousRecipeSelection);
            return;
        }

        dom.ensembleContextList.innerHTML = "";
        for (const config of configs) {
            const row = document.createElement("label");
            row.className = "ensemble-lab__config-item";
            row.dataset.configName = config.name;
            row.dataset.configNameLower = config.name.toLowerCase();
            row.dataset.familyKey = config.strategyKey;
            row.dataset.familyLabel = this.getConfigFamilyLabel(config).toLowerCase();
            row.dataset.strategyName = this.getConfigFamilyLabel(config).toLowerCase();
            row.dataset.tradeDirection = this.describeTradeDirection(config.backtestSettings.tradeDirection).toLowerCase();

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = previousChecked.size === 0 ? true : previousChecked.has(config.name);
            checkbox.dataset.configName = config.name;
            checkbox.addEventListener("click", (event) => {
                this.handleContextToggleClick(config.name, event as MouseEvent);
            });
            checkbox.addEventListener("change", () => {
                this.syncContextSelectionUi();
                this.invalidateRunContext("Context configs changed. Run Strategy Ensemble Lab again.");
            });

            const body = document.createElement("div");
            body.className = "ensemble-lab__config-body";

            const titleRow = document.createElement("div");
            titleRow.className = "ensemble-lab__config-title-row";

            const title = document.createElement("span");
            title.className = "ensemble-lab__config-title";
            title.textContent = config.name;

            const strategy = document.createElement("span");
            strategy.className = "ensemble-lab__config-strategy";
            strategy.textContent = this.getConfigFamilyLabel(config);

            titleRow.appendChild(title);
            titleRow.appendChild(strategy);

            const metaRow = document.createElement("div");
            metaRow.className = "ensemble-lab__config-meta";
            metaRow.innerHTML = [
                this.buildConfigBadge("Direction", this.describeTradeDirection(config.backtestSettings.tradeDirection)),
                this.buildConfigBadge("Updated", this.formatConfigTimestamp(config.updatedAt || config.createdAt)),
                this.buildConfigBadge("Key", config.strategyKey),
            ].join("");

            body.appendChild(titleRow);
            body.appendChild(metaRow);

            row.appendChild(checkbox);
            row.appendChild(body);

            this.contextCheckboxes.set(config.name, checkbox);
            this.contextItems.set(config.name, row);
            this.contextOrder.push(config.name);
            dom.ensembleContextList.appendChild(row);
        }

        this.setConfigAvailability(true);
        dom.ensembleContextHelper.style.display = "";
        this.syncTargetContextState();
        this.renderTargetSummary();
        this.applyContextFilter();
        resetStrategyEnsembleResultPanels(this.getDom());
        resetEnsemblePolymarketPanel(this.getDom());
        this.polymarketRunner?.clearState();
        this.syncPolymarketAvailability();
        this.syncSavedSignalRecipeOptions(previousRecipeSelection);
        this.updateStatus("Select a target config, keep one or more context configs, then run Strategy Ensemble Lab.");
    }

    private setConfigAvailability(hasConfigs: boolean): void {
        const dom = this.getDom();
        dom.ensembleEmpty.style.display = hasConfigs ? "none" : "";
        dom.ensembleContent.style.display = hasConfigs ? "" : "none";
        dom.ensemblePolymarketSection.style.display = hasConfigs ? "" : "none";
    }

    private buildConfigLabel(config: StrategyConfig): string {
        return config.name;
    }

    private createTargetOption(config: StrategyConfig): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ensemble-lab__target-option";
        button.dataset.configName = config.name;
        button.dataset.configNameLower = config.name.toLowerCase();
        button.dataset.familyLabel = this.getConfigFamilyLabel(config).toLowerCase();
        button.setAttribute("role", "option");
        button.innerHTML = `
            <span class="ensemble-lab__target-option-title">${escapeHtml(config.name)}</span>
            <span class="ensemble-lab__target-option-subtitle">${escapeHtml(this.getConfigFamilyLabel(config))}</span>
        `;
        button.addEventListener("click", () => {
            const dom = this.getDom();
            dom.ensembleTargetSelect.value = config.name;
            dom.ensembleTargetSelect.dispatchEvent(new Event("change"));
            this.closeTargetPicker();
            dom.ensembleTargetButton.focus();
        });
        this.targetOptionButtons.set(config.name, button);
        return button;
    }

    private toggleTargetPicker(force?: boolean): void {
        const dom = this.getDom();
        const nextState = force ?? !this.targetMenuOpen;
        if (nextState && this.contextConfigs.size === 0) {
            return;
        }

        this.targetMenuOpen = nextState;
        dom.ensembleTargetButton.setAttribute("aria-expanded", nextState ? "true" : "false");
        dom.ensembleTargetMenu.classList.toggle("is-hidden", !nextState);

        if (nextState) {
            this.applyTargetPickerFilter();
            dom.ensembleTargetSearch.focus();
            dom.ensembleTargetSearch.select();
        } else {
            dom.ensembleTargetSearch.value = "";
            this.applyTargetPickerFilter();
        }
    }

    private closeTargetPicker(): void {
        if (!this.targetMenuOpen) {
            return;
        }
        this.toggleTargetPicker(false);
    }

    private applyTargetPickerFilter(): void {
        const dom = this.getDom();
        const query = dom.ensembleTargetSearch.value.trim().toLowerCase();
        let visibleCount = 0;

        for (const [name, button] of this.targetOptionButtons.entries()) {
            const matches = query.length === 0 || [
                name.toLowerCase(),
                button.dataset.configNameLower ?? "",
                button.dataset.familyLabel ?? "",
            ].some((value) => value.includes(query));
            button.hidden = !matches;
            if (matches) {
                visibleCount += 1;
            }
        }

        dom.ensembleTargetPickerEmptyState.style.display = visibleCount === 0 ? "" : "none";
    }

    private syncTargetPickerUi(): void {
        const dom = this.getDom();
        const selectedName = this.getSelectedTargetName();
        const selectedConfig = this.contextConfigs.get(selectedName);

        for (const [name, button] of this.targetOptionButtons.entries()) {
            const isSelected = name === selectedName;
            button.classList.toggle("is-selected", isSelected);
            button.setAttribute("aria-selected", isSelected ? "true" : "false");
        }

        if (!selectedConfig) {
            dom.ensembleTargetButton.innerHTML = `
                <span class="ensemble-lab__target-trigger-main">
                    <span class="ensemble-lab__target-trigger-title">Select target config</span>
                    <span class="ensemble-lab__target-trigger-subtitle">Choose one saved config to treat as the target.</span>
                </span>
                <span class="ensemble-lab__target-trigger-caret" aria-hidden="true">&#9662;</span>
            `;
            dom.ensembleTargetButton.disabled = this.contextConfigs.size === 0;
            return;
        }

        dom.ensembleTargetButton.innerHTML = `
            <span class="ensemble-lab__target-trigger-main">
                <span class="ensemble-lab__target-trigger-title">${escapeHtml(selectedConfig.name)}</span>
                <span class="ensemble-lab__target-trigger-subtitle">${escapeHtml(this.getConfigFamilyLabel(selectedConfig))}</span>
            </span>
            <span class="ensemble-lab__target-trigger-caret" aria-hidden="true">&#9662;</span>
        `;
        dom.ensembleTargetButton.disabled = false;
    }

    private getSelectedTargetName(): string {
        return this.getDom().ensembleTargetSelect.value.trim();
    }

    private getSelectedContextNames(): string[] {
        const target = this.getSelectedTargetName();
        const names: string[] = [];
        for (const [name, checkbox] of this.contextCheckboxes.entries()) {
            if (name !== target && checkbox.checked) {
                names.push(name);
            }
        }
        return names;
    }

    private readMinSamples(): number {
        const raw = Number.parseInt(this.getDom().ensembleMinSamples.value, 10);
        if (!Number.isFinite(raw)) {
            return 5;
        }
        return Math.max(3, Math.min(200, raw));
    }

    private invalidateRunContext(message: string): void {
        this.orchestrator.runContext = null;
        this.polymarketRunner?.clearState();
        this.updateStatus(message);
        resetEnsemblePolymarketPanel(this.getDom());
        this.syncPolymarketAvailability();
        this.syncSavedSignalRecipeControls();
    }

    private updateStatus(message: string): void {
        this.getDom().ensembleStatus.textContent = message;
    }

    private updatePolymarketStatus(message: string): void {
        this.getDom().ensemblePolymarketStatus.textContent = message;
    }

    private syncPolymarketAvailability(): void {
        const dom = this.getDom();
        const hasConfigs = this.contextConfigs.size > 0;
        const supportedRun = isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval);
        const supportMessage = `Ensemble Polymarket currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`;

        dom.ensemblePolymarketSection.style.display = hasConfigs ? "" : "none";
        dom.ensembleRunPolymarketBtn.disabled = !hasConfigs || !supportedRun;
        dom.ensembleRunPolymarketBtn.title = supportedRun ? "" : supportMessage;

        if (!hasConfigs) {
            return;
        }

        setVisible(dom.ensemblePolymarketEmpty, !supportedRun);
        if (!supportedRun) {
            dom.ensemblePolymarketEmpty.textContent = supportMessage;
            this.updatePolymarketStatus(supportMessage);
            return;
        }

        dom.ensemblePolymarketEmpty.textContent = supportMessage;
        if (!dom.ensembleRunPolymarketBtn.disabled) {
            this.updatePolymarketStatus("Run Ensemble Polymarket to compare executable config edge, conflict policies, veto pairs, and override pairs against matched 5m Polymarket outcomes.");
        }
    }

    private getConfigFamilyLabel(config: StrategyConfig): string {
        return strategyRegistry.get(config.strategyKey)?.name
            ?? getBuiltInMeta(config.strategyKey)?.name
            ?? config.strategyKey;
    }

    private populateFamilyFilter(configs: StrategyConfig[], previousValue: string): void {
        const select = this.getDom().ensembleContextFamilyFilter;
        const families = new Map<string, string>();
        for (const config of configs) {
            if (!families.has(config.strategyKey)) {
                families.set(config.strategyKey, this.getConfigFamilyLabel(config));
            }
        }

        select.innerHTML = '<option value="">All families</option>';
        Array.from(families.entries())
            .sort((left, right) => left[1].localeCompare(right[1]))
            .forEach(([familyKey, familyLabel]) => {
                const option = document.createElement("option");
                option.value = familyKey;
                option.textContent = familyLabel;
                select.appendChild(option);
            });

        if (previousValue && families.has(previousValue)) {
            select.value = previousValue;
        }
    }

    private buildConfigBadge(label: string, value: string): string {
        return `<span class="ensemble-lab__config-badge"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`;
    }

    private formatConfigTimestamp(value: string): string {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return "Unknown";
        }
        return new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    }

    private describeTradeDirection(direction: string | null | undefined): string {
        switch (direction) {
            case "long":
                return "Long";
            case "short":
                return "Short";
            case "combined":
                return "Combine";
            case "both_flip_loss_2":
                return "Both Flip Loss 2";
            case "both":
            case undefined:
            case null:
            case "":
                return "Both";
            default:
                return String(direction);
        }
    }

    private describeExecutionModel(model: string | null | undefined): string {
        switch (model) {
            case "signal_close":
                return "Signal Close";
            case "next_open":
                return "Next Open";
            case "next_close":
                return "Next Close";
            case undefined:
            case null:
            case "":
                return "Next Open";
            default:
                return String(model);
        }
    }

    private formatPreviewExecutionSettings(config: StrategyConfig): string {
        const settings = resolveBacktestSettingsFromRaw(
            config.backtestSettings as BacktestSettings,
            { coerceWithoutUiToggles: true }
        );
        return [
            `direction ${this.describeTradeDirection(settings.tradeDirection)}`,
            `execution ${this.describeExecutionModel(settings.executionModel)}`,
        ].join(" | ");
    }

    private describePolymarketConflictPolicy(policy: EnsemblePolymarketConflictPolicy): string {
        switch (policy) {
            case "primary_veto":
                return "Primary + Secondary Veto";
            case "secondary_override":
                return "Secondary Override";
            case "best_side_owner":
                return "Best-Side Owner";
            case "skip_conflicts":
            default:
                return "Skip Conflicts";
        }
    }

    private describePolymarketDirectionSlice(directionSlice: EnsemblePolymarketDirectionSlice): string {
        switch (directionSlice) {
            case "long_only":
                return "Long Only";
            case "short_only":
                return "Short Only";
            case "all":
            default:
                return "All";
        }
    }

    private describeRecipeMode(mode: EnsembleSignalRecipe["mode"]): string {
        switch (mode) {
            case "primary_veto":
                return "Primary + Veto";
            case "secondary_override":
                return "Secondary Override";
            case "best_side_owner":
                return "Best-Side Owner";
            case "target_conflict_filter":
            default:
                return "Target Conflict Filter";
        }
    }

    private describeSelectedRecipe(recipe: EnsembleSignalRecipe): string {
        const metrics = recipe.metrics;
        const winRateLabel = `${(metrics.winRate * 100).toFixed(1)}%`;
        const keptTradesLabel = `${metrics.keptTrades} kept trade${metrics.keptTrades === 1 ? "" : "s"}`;
        const directionVariant = describeEnsembleRecipeReplayDirectionOverride(this.getSelectedRecipeDirectionOverride());
        return `${recipe.name} | ${this.describeRecipeMode(recipe.mode)} | ${recipe.symbol} ${recipe.interval} | ${this.describePolymarketDirectionSlice(recipe.directionSlice)} | ${keptTradesLabel} | ${winRateLabel} win rate | Export Variant: ${directionVariant}.`;
    }

    private renderTargetSummary(): void {
        const dom = this.getDom();
        const targetName = this.getSelectedTargetName();
        const config = this.contextConfigs.get(targetName);
        if (!config) {
            dom.ensembleTargetSummary.textContent = "Select a target config to inspect how the current context set will confirm or oppose it.";
            return;
        }

        const familyLabel = this.getConfigFamilyLabel(config);
        dom.ensembleTargetSummary.innerHTML = `
            <div class="ensemble-lab__target-title-row">
                <span class="ensemble-lab__target-name">${escapeHtml(config.name)}</span>
                <span class="ensemble-lab__target-pill">Target</span>
            </div>
            <div class="ensemble-lab__target-subtitle">${escapeHtml(familyLabel)}</div>
            <div class="ensemble-lab__target-meta">
                ${this.buildConfigBadge("Direction", this.describeTradeDirection(config.backtestSettings.tradeDirection))}
                ${this.buildConfigBadge("Updated", this.formatConfigTimestamp(config.updatedAt || config.createdAt))}
                ${this.buildConfigBadge("Key", config.strategyKey)}
            </div>
            <div class="ensemble-lab__target-note">
                Context selections automatically exclude the target. Use <strong>Target Family</strong> or <strong>Exclude Family</strong> to tune family overlap fast.
            </div>
        `;
    }

    private handleContextToggleClick(configName: string, event: MouseEvent): void {
        const checkbox = this.contextCheckboxes.get(configName);
        if (!checkbox || checkbox.disabled) {
            return;
        }

        if (event.shiftKey && this.lastContextToggleName) {
            const orderedNames = this.getContextNamesForRangeSelection();
            const startIndex = orderedNames.indexOf(this.lastContextToggleName);
            const endIndex = orderedNames.indexOf(configName);

            if (startIndex !== -1 && endIndex !== -1) {
                const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
                this.setContextSelection(orderedNames.slice(from, to + 1), checkbox.checked, false);
            }
        }

        this.lastContextToggleName = configName;
        this.syncContextSelectionUi();
    }

    private getContextNamesForRangeSelection(): string[] {
        const visibleNames = this.getVisibleContextNames();
        return visibleNames.length > 0 ? visibleNames : this.contextOrder.filter((name) => !this.isTargetContext(name));
    }

    private getVisibleContextNames(): string[] {
        return this.contextOrder.filter((name) => {
            const item = this.contextItems.get(name);
            return item ? !item.hidden && !this.isTargetContext(name) : false;
        });
    }

    private setContextSelection(configNames: Iterable<string>, checked: boolean, syncUi = true): void {
        for (const name of configNames) {
            if (this.isTargetContext(name)) {
                continue;
            }
            const checkbox = this.contextCheckboxes.get(name);
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = checked;
            }
        }

        if (syncUi) {
            this.syncContextSelectionUi();
            this.invalidateRunContext("Context configs changed. Run Strategy Ensemble Lab again.");
        }
    }

    private invertContextSelection(configNames: Iterable<string>): void {
        for (const name of configNames) {
            if (this.isTargetContext(name)) {
                continue;
            }
            const checkbox = this.contextCheckboxes.get(name);
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = !checkbox.checked;
            }
        }

        this.syncContextSelectionUi();
        this.invalidateRunContext("Context configs changed. Run Strategy Ensemble Lab again.");
    }

    private applyTargetFamilySelection(mode: "same" | "exclude"): void {
        const target = this.contextConfigs.get(this.getSelectedTargetName());
        if (!target) {
            return;
        }

        for (const name of this.contextOrder) {
            if (this.isTargetContext(name)) {
                continue;
            }
            const config = this.contextConfigs.get(name);
            const checkbox = this.contextCheckboxes.get(name);
            if (!config || !checkbox || checkbox.disabled) {
                continue;
            }
            const sameFamily = config.strategyKey === target.strategyKey;
            checkbox.checked = mode === "same" ? sameFamily : !sameFamily;
        }

        this.syncContextSelectionUi();
        this.invalidateRunContext("Context configs changed. Run Strategy Ensemble Lab again.");
    }

    private isTargetContext(configName: string): boolean {
        return configName === this.getSelectedTargetName();
    }

    private syncTargetContextState(): void {
        const targetName = this.getSelectedTargetName();
        for (const [name, item] of this.contextItems.entries()) {
            const checkbox = this.contextCheckboxes.get(name);
            if (!checkbox) {
                continue;
            }

            const isTarget = name === targetName;
            item.classList.toggle("is-target", isTarget);
            checkbox.disabled = isTarget;
            if (isTarget) {
                checkbox.checked = false;
            }
        }
    }

    private applyContextFilter(): void {
        const dom = this.getDom();
        const query = dom.ensembleContextSearch.value.trim().toLowerCase();
        const familyFilter = dom.ensembleContextFamilyFilter.value.trim();

        this.contextItems.forEach((item, name) => {
            const matchesQuery = query.length === 0 || [
                item.dataset.configNameLower ?? "",
                item.dataset.strategyName ?? "",
                item.dataset.familyLabel ?? "",
                item.dataset.tradeDirection ?? "",
                name.toLowerCase(),
            ].some((value) => value.includes(query));
            const matchesFamily = familyFilter.length === 0 || item.dataset.familyKey === familyFilter;
            item.hidden = !(matchesQuery && matchesFamily);
        });

        this.syncContextSelectionUi();
    }

    private syncContextSelectionUi(): void {
        const dom = this.getDom();
        const visibleNames = this.getVisibleContextNames();
        const hasFilter = dom.ensembleContextSearch.value.trim().length > 0 || dom.ensembleContextFamilyFilter.value.trim().length > 0;
        let selectedCount = 0;
        let visibleSelectedCount = 0;

        for (const [name, checkbox] of this.contextCheckboxes.entries()) {
            if (this.isTargetContext(name) || !checkbox.checked) {
                continue;
            }
            selectedCount += 1;
            if (visibleNames.includes(name)) {
                visibleSelectedCount += 1;
            }
        }

        dom.ensembleContextSummary.textContent = hasFilter
            ? `${selectedCount} selected | ${visibleNames.length} visible | ${visibleSelectedCount} visible selected`
            : `${selectedCount} selected`;

        dom.ensembleContextEmptyState.style.display = this.contextOrder.length > 0 && visibleNames.length === 0 ? "" : "none";
        dom.ensembleContextSelectVisible.disabled = visibleNames.length === 0;
        dom.ensembleContextInvertVisible.disabled = visibleNames.length === 0;
        dom.ensembleContextSelectAll.disabled = this.contextOrder.length <= 1;
        dom.ensembleContextSelectNone.disabled = this.contextOrder.length === 0;

        const target = this.contextConfigs.get(this.getSelectedTargetName());
        const hasTargetFamilyPeers = target
            ? this.contextOrder.some((name) => {
                if (this.isTargetContext(name)) {
                    return false;
                }
                return this.contextConfigs.get(name)?.strategyKey === target.strategyKey;
            })
            : false;
        dom.ensembleContextSelectSameFamily.disabled = !hasTargetFamilyPeers;
        dom.ensembleContextExcludeSameFamily.disabled = !target;
    }

    private async loadBuilderPreview(ruleId: string): Promise<void> {
        const context = this.orchestrator.runContext;
        if (!context) {
            uiManager.showToast("Run Strategy Ensemble Lab first.", "error");
            return;
        }

        const preview = context.builderPreviewByRuleId.get(ruleId);
        if (!preview) {
            uiManager.showToast("Exact ensemble preview is not available for this row.", "error");
            return;
        }

        const targetArtifact = context.targetArtifact;
        clearBacktestResults("ensemble_preview_reset");
        await settingsManager.applyStrategyConfig(targetArtifact.config);
        commitBacktestResult(preview.result, "ensemble_preview", {
            reason: "ensemble_preview",
        });
        const frozenPreviewResult = preview.result;
        const frozenTargetConfig = this.cloneStrategyConfigSnapshot(targetArtifact.config);
        const frozenRuleLabel = preview.row.rule;
        const previewExecutionLabel = this.formatPreviewExecutionSettings(frozenTargetConfig);
        setActiveBacktestRerunContext({
            source: "ensemble_preview",
            label: `Ensemble rule preview: ${frozenRuleLabel}`,
            rerun: async () => {
                clearBacktestResults("ensemble_preview_rerun_reset");
                await settingsManager.applyStrategyConfig(frozenTargetConfig);
                commitBacktestResult(frozenPreviewResult, "ensemble_preview", {
                    reason: "ensemble_preview_rerun",
                });
                this.updateStatus(`Refreshed frozen ensemble preview: ${frozenRuleLabel} | ${previewExecutionLabel}.`);
            },
        });

        this.updateStatus(`Loaded exact ensemble preview: ${preview.row.rule} | ${previewExecutionLabel}.`);
        uiManager.showToast(`Loaded ensemble preview: ${preview.row.rule}`, "success");
    }

    private cloneStrategyConfigSnapshot(config: StrategyConfig): StrategyConfig {
        return this.recipeBuilder!.cloneStrategyConfigSnapshot(config);
    }

    private requirePolymarketRunContext(usage: string): {
        runResult: EnsemblePolymarketRunResult;
        selection: { targetName: string; contextNames: string[]; symbol: string; interval: string };
        outcomes: readonly PolymarketOutcomeRow[];
    } {
        return this.polymarketRunner!.requirePolymarketRunContext(usage);
    }

    private buildBestVetoRecipeFromCurrentRun(): EnsembleSignalRecipe {
        return this.recipeBuilder!.buildBestVetoRecipeFromCurrentRun();
    }

    private buildVetoRecipeFromPair(pair: EnsemblePolymarketVetoPairResult): EnsembleSignalRecipe {
        return this.recipeBuilder!.buildVetoRecipeFromPair(pair);
    }

    private buildOverrideRecipeFromPair(pair: EnsemblePolymarketOverridePairResult): EnsembleSignalRecipe {
        return this.recipeBuilder!.buildOverrideRecipeFromPair(pair);
    }

    private buildSelectedPolicyRecipeFromCurrentRun(): EnsembleSignalRecipe {
        return this.recipeBuilder!.buildSelectedPolicyRecipeFromCurrentRun();
    }

    private async loadRecipeBacktest(recipe: EnsembleSignalRecipe, successMessage: string): Promise<void> {
        return this.recipeRunner!.loadRecipeBacktest(recipe, successMessage);
    }

    private async loadConflictFilterBacktest(): Promise<void> {
        return this.recipeRunner!.loadConflictFilterBacktest();
    }

    private async loadBestVetoBacktest(): Promise<void> {
        return this.recipeRunner!.loadBestVetoBacktest();
    }

    private attachPolymarketOutcomesToBacktestResult(
        result: BacktestResult,
        outcomes: readonly PolymarketOutcomeRow[],
        interval = state.currentInterval
    ): BacktestResult {
        return this.polymarketRunner!.attachPolymarketOutcomesToBacktestResult(result, outcomes, interval);
    }

    private async loadPolymarketConfigBacktest(configName: string): Promise<void> {
        return this.polymarketRunner!.loadPolymarketConfigBacktest(configName);
    }

    private async loadPolymarketVetoPairBacktest(primaryConfigName: string, vetoConfigName: string): Promise<void> {
        return this.polymarketRunner!.loadPolymarketVetoPairBacktest(primaryConfigName, vetoConfigName);
    }

    private async loadPolymarketOverridePairBacktest(primaryConfigName: string, secondaryConfigName: string): Promise<void> {
        return this.polymarketRunner!.loadPolymarketOverridePairBacktest(primaryConfigName, secondaryConfigName);
    }

    private saveConflictFilterRecipe(): void {
        return this.recipeRunner!.saveConflictFilterRecipe();
    }

    private saveBestVetoRecipe(): void {
        return this.recipeRunner!.saveBestVetoRecipe();
    }

    private async runPolymarket(): Promise<void> {
        return this.polymarketRunner!.runPolymarket();
    }

    private async run(): Promise<void> {
        await this.orchestrator.run();
    }
}

export const strategyEnsembleService = new StrategyEnsembleService();
