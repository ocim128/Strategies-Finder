import { strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { createEnsembleLabDom, type EnsembleLabDom } from "./strategy-ensemble-dom";
import {
    buildEnsembleRecipeBotEnvSnippet,
    buildEnsembleRecipeBridgeScript,
    resolveExternalSignalSymbol,
    slugifyEnsembleSignalRecipeName,
} from "./ensemble-signal-bridge";
import {
    buildEnsembleRecipeVariantSlug,
    describeEnsembleRecipeReplayDirectionOverride,
    normalizeEnsembleRecipeReplayDirectionOverride,
    type EnsembleRecipeReplayDirectionOverride,
} from "./ensemble-signal-direction";
import {
    buildPreparedSignalsForEnsembleRecipe,
} from "./ensemble-signal-recipes";
import {
    buildSignalArtifact,
    countDistinctFamilies,
    runConfig,
    runFilteredBacktest,
    type StrategyEnsembleEngineDeps,
} from "./strategy-ensemble-engine";
import { buildLiveContext, resolveCurrentContextReference } from "./strategy-ensemble-live-context";
import {
    buildContributionRows,
    buildReplacementRows,
    evaluateScenario,
    type StrategyEnsembleRulesRuntime,
} from "./strategy-ensemble-rules";
import {
    escapeHtml,
    renderStrategyEnsembleResults,
    resetStrategyEnsembleResultPanels,
} from "./strategy-ensemble-renderer";
import {
    runEnsemblePolymarket,
    type EnsemblePolymarketConflictPolicy,
    type EnsemblePolymarketDirectionSlice,
    type EnsemblePolymarketOverridePairResult,
    type EnsemblePolymarketRunResult,
    type EnsemblePolymarketVetoPairResult,
} from "./strategy-ensemble-polymarket-engine";
import { getPolymarket5mSeriesIdForSymbol } from "./polymarket-btc5m";
import {
    renderEnsemblePolymarketResults,
    resetEnsemblePolymarketPanel,
} from "./strategy-ensemble-polymarket-renderer";
import {
    settingsManager,
    sortEnsembleSignalRecipesNewestFirst,
    sortStrategyConfigsNewestFirst,
    type EnsembleSignalRecipe,
    type StrategyConfig,
} from "./settings-manager";
import { state } from "./state";
import { clearBacktestResults, commitBacktestResult } from "./state-actions";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { type BacktestSettings, type OHLCVData, type Signal } from "./strategies";
import { setActiveBacktestRerunContext } from "./backtest-rerun-context";
import type {
    ConfigRunArtifact,
    ConfigSignalArtifact,
    EnsembleRunContext,
} from "./strategy-ensemble-types";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";
import {
    getSupportedPolymarket5mSymbolsLabel,
    isSupportedPolymarket5mRun,
    loadPolymarket5mOutcomesForChart,
} from "./polymarket-btc5m";
import { setVisible } from "./dom-utils";
import { formatJakartaTime } from "./timezone-utils";
import { strategyPanelController } from "./strategy-panel-controller";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import { annotateTradesWithPolymarketOutcomesForRun, summarizePolymarketTradesForRun } from "./polymarket-trade-annotations";
import type { BacktestResult } from "./types/strategies";

class StrategyEnsembleService {
    private static readonly MAX_REPLACEMENT_ROWS = 12;
    private static readonly MAX_RULE_VALIDATION_CANDIDATES = 12;
    private static readonly MAX_RULE_BUILDER_ROWS = 10;

    private dom: EnsembleLabDom | null = null;
    private initialized = false;
    private runContext: EnsembleRunContext | null = null;
    private contextCheckboxes = new Map<string, HTMLInputElement>();
    private contextItems = new Map<string, HTMLElement>();
    private contextConfigs = new Map<string, StrategyConfig>();
    private targetOptionButtons = new Map<string, HTMLButtonElement>();
    private contextOrder: string[] = [];
    private lastContextToggleName: string | null = null;
    private targetMenuOpen = false;
    private lastPolymarketRunResult: EnsemblePolymarketRunResult | null = null;
    private lastPolymarketSelection: { targetName: string; contextNames: string[]; symbol: string; interval: string } | null = null;
    private lastPolymarketOutcomes: PolymarketOutcomeRow[] = [];

    private getDom(): EnsembleLabDom {
        return this.dom ??= createEnsembleLabDom();
    }

    private async yieldToUi(): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }

    public init(): void {
        if (this.initialized) {
            return;
        }

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

        dom.ensembleRunBtn.addEventListener("click", () => {
            void this.run();
        });
        dom.ensembleRunPolymarketBtn.addEventListener("click", () => {
            void this.runPolymarket();
        });
        dom.ensemblePolymarketTableBody.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const button = target.closest<HTMLButtonElement>("[data-ensemble-polymarket-config-backtest]");
            const configName = button?.dataset.ensemblePolymarketConfigBacktest?.trim();
            if (!configName) {
                return;
            }

            void this.loadPolymarketConfigBacktest(configName);
        });
        dom.ensemblePolymarketVetoTableBody.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const button = target.closest<HTMLButtonElement>("[data-ensemble-polymarket-veto-backtest]");
            const primaryConfigName = button?.dataset.ensemblePolymarketVetoBacktest?.trim();
            const vetoConfigName = button?.dataset.ensemblePolymarketVetoConfig?.trim();
            if (!primaryConfigName || !vetoConfigName) {
                return;
            }

            void this.loadPolymarketVetoPairBacktest(primaryConfigName, vetoConfigName);
        });
        dom.ensemblePolymarketOverrideTableBody.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const button = target.closest<HTMLButtonElement>("[data-ensemble-polymarket-override-backtest]");
            const primaryConfigName = button?.dataset.ensemblePolymarketOverrideBacktest?.trim();
            const secondaryConfigName = button?.dataset.ensemblePolymarketSecondaryConfig?.trim();
            if (!primaryConfigName || !secondaryConfigName) {
                return;
            }

            void this.loadPolymarketOverridePairBacktest(primaryConfigName, secondaryConfigName);
        });
        dom.ensemblePolymarketAgreement.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const selectedPolicyButton = target.closest<HTMLButtonElement>("[data-ensemble-polymarket-selected-policy-backtest]");
            if (selectedPolicyButton) {
                void this.loadConflictFilterBacktest();
                return;
            }

            const bestVetoButton = target.closest<HTMLButtonElement>("[data-ensemble-polymarket-best-veto-backtest]");
            if (bestVetoButton) {
                void this.loadBestVetoBacktest();
            }
        });
        dom.ensemblePolymarketConflictPolicy.addEventListener("change", () => {
            this.syncSavedSignalRecipeControls();
            this.invalidateRunContext("Polymarket conflict policy changed. Run Ensemble Polymarket again.");
        });
        dom.ensemblePolymarketDirectionSlice.addEventListener("change", () => {
            this.syncSavedSignalRecipeControls();
            this.invalidateRunContext("Polymarket direction slice changed. Run Ensemble Polymarket again.");
        });
        dom.ensembleLoadConflictBacktestBtn.addEventListener("click", () => {
            void this.loadConflictFilterBacktest();
        });
        dom.ensembleLoadBestVetoBacktestBtn.addEventListener("click", () => {
            void this.loadBestVetoBacktest();
        });
        dom.ensembleSaveConflictRecipeBtn.addEventListener("click", () => {
            this.saveConflictFilterRecipe();
        });
        dom.ensembleSaveBestVetoRecipeBtn.addEventListener("click", () => {
            this.saveBestVetoRecipe();
        });
        dom.ensembleSignalRecipeSelect.addEventListener("change", () => {
            this.syncSavedSignalRecipeControls();
        });
        dom.ensembleSignalRecipeDirectionSelect.addEventListener("change", () => {
            this.syncSavedSignalRecipeControls();
        });
        dom.ensembleSignalRecipeDownloadScriptBtn.addEventListener("click", () => {
            void this.downloadSelectedSignalRecipeBridge();
        });
        dom.ensembleSignalRecipeCopyEnvBtn.addEventListener("click", () => {
            void this.copySelectedSignalRecipeEnv();
        });
        dom.ensembleSignalRecipeDeleteBtn.addEventListener("click", () => {
            this.deleteSelectedSignalRecipe();
        });

        dom.ensembleRefreshConfigsBtn.addEventListener("click", () => {
            this.populateConfigs(dom);
            this.invalidateRunContext("Configs refreshed. Run Strategy Ensemble Lab again.");
        });

        dom.ensembleTargetSelect.addEventListener("change", () => {
            this.syncTargetPickerUi();
            this.syncTargetContextState();
            this.renderTargetSummary();
            this.applyContextFilter();
            this.invalidateRunContext("Target config changed. Run Strategy Ensemble Lab again.");
        });

        dom.ensembleMinSamples.addEventListener("input", () => {
            this.invalidateRunContext("Minimum sample threshold changed. Run Strategy Ensemble Lab again.");
        });

        dom.ensembleContextSearch.addEventListener("input", () => {
            this.applyContextFilter();
        });

        dom.ensembleContextFamilyFilter.addEventListener("change", () => {
            this.applyContextFilter();
        });

        dom.ensembleContextSelectAll.addEventListener("click", () => {
            this.setContextSelection(this.contextOrder, true);
        });

        dom.ensembleContextSelectNone.addEventListener("click", () => {
            this.setContextSelection(this.contextOrder, false);
        });

        dom.ensembleContextInvertVisible.addEventListener("click", () => {
            this.invertContextSelection(this.getVisibleContextNames());
        });

        dom.ensembleContextSelectVisible.addEventListener("click", () => {
            this.setContextSelection(this.getVisibleContextNames(), true);
        });

        dom.ensembleContextSelectSameFamily.addEventListener("click", () => {
            this.applyTargetFamilySelection("same");
        });

        dom.ensembleContextExcludeSameFamily.addEventListener("click", () => {
            this.applyTargetFamilySelection("exclude");
        });

        dom.ensembleBuilderTableBody.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const button = target.closest<HTMLButtonElement>("[data-ensemble-preview-rule-id]");
            if (!button) {
                return;
            }

            const ruleId = button.dataset.ensemblePreviewRuleId?.trim();
            if (!ruleId) {
                return;
            }

            void this.loadBuilderPreview(ruleId);
        });

        state.subscribe("currentSymbol", () => {
            this.clearActiveEnsemblePreview("Chart market changed. Frozen ensemble preview cleared.");
            this.syncReadouts(dom);
            this.syncPolymarketAvailability();
            this.invalidateRunContext("Target symbol changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("currentInterval", () => {
            this.clearActiveEnsemblePreview("Chart timeframe changed. Frozen ensemble preview cleared.");
            this.syncReadouts(dom);
            this.syncPolymarketAvailability();
            this.invalidateRunContext("Timeframe changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("ohlcvData", () => {
            this.invalidateRunContext("Loaded data changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("blockRange", () => {
            this.invalidateRunContext("Block selection changed. Run Strategy Ensemble Lab again.");
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
        const hasPolymarketResult = this.lastPolymarketRunResult !== null;
        const hasBestVeto = Boolean(this.lastPolymarketRunResult?.vetoScan.bestPair);

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
        dom.ensembleLoadBestVetoBacktestBtn.textContent = this.lastPolymarketRunResult?.vetoScan.bestPair
            ? `View Best Veto Backtest (${this.lastPolymarketRunResult.vetoScan.bestPair.keptEvents})`
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
        const value = this.getDom().ensemblePolymarketConflictPolicy.value;
        return value === "primary_veto"
            || value === "secondary_override"
            || value === "best_side_owner"
            || value === "skip_conflicts"
            ? value
            : "skip_conflicts";
    }

    private getSelectedPolymarketDirectionSlice(): EnsemblePolymarketDirectionSlice {
        const value = this.getDom().ensemblePolymarketDirectionSlice.value;
        return value === "long_only" || value === "short_only" || value === "all"
            ? value
            : "all";
    }

    private getSelectedPolymarketPolicyResult(): EnsemblePolymarketRunResult["selectedPolicyResult"] {
        const runResult = this.lastPolymarketRunResult;
        if (!runResult) {
            return null;
        }

        switch (this.getSelectedPolymarketConflictPolicy()) {
            case "primary_veto":
                return runResult.policyResults.primaryVeto;
            case "secondary_override":
                return runResult.policyResults.secondaryOverride;
            case "best_side_owner":
                return runResult.policyResults.bestSideOwner;
            case "skip_conflicts":
            default:
                return runResult.policyResults.skipConflicts;
        }
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
            this.lastPolymarketRunResult = null;
            this.lastPolymarketSelection = null;
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
        this.lastPolymarketRunResult = null;
        this.lastPolymarketSelection = null;
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
        this.runContext = null;
        this.lastPolymarketRunResult = null;
        this.lastPolymarketSelection = null;
        this.lastPolymarketOutcomes = [];
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
        return strategyRegistry.get(config.strategyKey)?.name ?? config.strategyKey;
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
        const context = this.runContext;
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

    private prepareCandles(): OHLCVData[] {
        if (state.ohlcvData.length < 2) {
            return [];
        }
        return sliceOhlcvByBlock(trimToClosedCandles(state.ohlcvData, state.currentInterval), state.blockRange);
    }

    private buildEngineDeps(): StrategyEnsembleEngineDeps {
        return {
            interval: state.currentInterval,
            loadStrategyConfig: (configName) => settingsManager.loadStrategyConfig(configName),
            getStrategy: (strategyKey) => strategyRegistry.get(strategyKey),
            resolveCapitalFromConfig: (config) => settingsManager.resolveCapitalFromConfig(config),
            evaluateStrategyOnData: (...args) => backtestService.evaluateStrategyOnData(...args),
            evaluateSignalsOnData: (...args) => backtestService.evaluateSignalsOnData(...args),
            warn: (message, details) => debugLogger.warn(message, details),
        };
    }

    private buildRulesRuntime(engineDeps: StrategyEnsembleEngineDeps): StrategyEnsembleRulesRuntime {
        return {
            runFilteredBacktest: (targetArtifact, signals, candles) =>
                runFilteredBacktest(targetArtifact, signals, candles, engineDeps),
            yieldToUi: () => this.yieldToUi(),
            updateStatus: (message) => this.updateStatus(message),
            maxRuleValidationCandidates: StrategyEnsembleService.MAX_RULE_VALIDATION_CANDIDATES,
            maxRuleBuilderRows: StrategyEnsembleService.MAX_RULE_BUILDER_ROWS,
            maxReplacementRows: StrategyEnsembleService.MAX_REPLACEMENT_ROWS,
        };
    }

    private cloneStrategyConfigSnapshot(config: StrategyConfig): StrategyConfig {
        return {
            ...config,
            strategyParams: { ...config.strategyParams },
            backtestSettings: { ...config.backtestSettings },
        };
    }

    private loadRequiredStrategyConfigSnapshot(configName: string, usage: string): StrategyConfig {
        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) {
            throw new Error(`Saved config "${configName}" is no longer available for ${usage}.`);
        }
        return this.cloneStrategyConfigSnapshot(config);
    }

    private buildUniqueSignalRecipeName(baseName: string): string {
        const existingNames = new Set(
            settingsManager.loadAllEnsembleSignalRecipes().map((recipe) => recipe.name)
        );

        if (!existingNames.has(baseName)) {
            return baseName;
        }

        let suffix = 2;
        let candidate = `${baseName} (${suffix})`;
        while (existingNames.has(candidate)) {
            suffix += 1;
            candidate = `${baseName} (${suffix})`;
        }
        return candidate;
    }

    private buildRecipeMetricsFromPolicyResult(
        policyResult: NonNullable<EnsemblePolymarketRunResult["selectedPolicyResult"]>,
        overlapRate: number | null = null
    ): EnsembleSignalRecipe["metrics"] {
        return {
            keptTrades: policyResult.scoredTrades,
            wins: policyResult.wins,
            losses: policyResult.losses,
            winRate: policyResult.winRate,
            retentionRate: policyResult.retentionRate,
            coverage: policyResult.coverage,
            overlapRate,
            winRateLift: policyResult.deltaVsBaseline,
            wilsonLift: null,
        };
    }

    private requirePolymarketRunContext(usage: string): {
        runResult: EnsemblePolymarketRunResult;
        selection: NonNullable<StrategyEnsembleService["lastPolymarketSelection"]>;
        outcomes: readonly PolymarketOutcomeRow[];
    } {
        if (!this.lastPolymarketRunResult || !this.lastPolymarketSelection) {
            throw new Error(`Run Ensemble Polymarket first before ${usage}.`);
        }

        return {
            runResult: this.lastPolymarketRunResult,
            selection: this.lastPolymarketSelection,
            outcomes: this.lastPolymarketOutcomes,
        };
    }

    private buildDirectionSliceRecipeSuffix(directionSlice: EnsemblePolymarketDirectionSlice): string {
        switch (directionSlice) {
            case "long_only":
                return " long";
            case "short_only":
                return " short";
            case "all":
            default:
                return "";
        }
    }

    private buildConflictFilterRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const runResult = this.lastPolymarketRunResult;
        const selection = this.lastPolymarketSelection;
        if (!runResult || !selection) {
            throw new Error("Run Ensemble Polymarket first.");
        }
        const policyResult = runResult.policyResults.skipConflicts;
        if (!policyResult) {
            throw new Error("The current run did not produce a skip-conflicts recipe.");
        }

        const targetConfig = this.loadRequiredStrategyConfigSnapshot(selection.targetName, "the conflict-filter recipe");
        const contextConfigs = selection.contextNames.map((name) =>
            this.loadRequiredStrategyConfigSnapshot(name, "the conflict-filter recipe")
        );
        const overlay = runResult.conflictFilteredOverlay;
        const nowIso = new Date().toISOString();
        const overlapRate = overlay.evaluatedEvents > 0
            ? overlay.eventsWithVotes / overlay.evaluatedEvents
            : null;

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} conflict ${selection.targetName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "target_conflict_filter",
            directionSlice: runResult.directionSlice,
            anchorConfigName: targetConfig.name,
            anchorConfig: targetConfig,
            componentConfigs: [targetConfig, ...contextConfigs],
            notes: `Target-anchored conflict-filter overlay derived from ${selection.targetName} with ${contextConfigs.length} context config${contextConfigs.length === 1 ? "" : "s"} on the ${this.describePolymarketDirectionSlice(runResult.directionSlice)} slice. This recipe replays the target config entries after removing bars where any selected context config fires the opposite side at the same event time.`,
            metrics: this.buildRecipeMetricsFromPolicyResult(policyResult, overlapRate),
        };
    }

    private buildBestVetoRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const { runResult } = this.requirePolymarketRunContext("building the best-veto recipe");
        const bestPair = runResult.vetoScan.bestPair ?? null;
        if (!bestPair) {
            throw new Error("Run Ensemble Polymarket and produce a best veto pair first.");
        }

        return this.buildVetoRecipeFromPair(bestPair);
    }

    private buildVetoRecipeFromPair(pair: EnsemblePolymarketVetoPairResult): EnsembleSignalRecipe {
        const { runResult, selection } = this.requirePolymarketRunContext("building a veto-pair recipe");
        const primaryConfig = this.loadRequiredStrategyConfigSnapshot(pair.primaryConfigName, "the veto-pair recipe");
        const vetoConfig = this.loadRequiredStrategyConfigSnapshot(pair.vetoConfigName, "the veto-pair recipe");
        const nowIso = new Date().toISOString();

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} veto ${pair.primaryConfigName} -> ${pair.vetoConfigName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "primary_veto",
            directionSlice: runResult.directionSlice,
            anchorConfigName: primaryConfig.name,
            anchorConfig: primaryConfig,
            componentConfigs: [primaryConfig, vetoConfig],
            primaryConfigName: primaryConfig.name,
            vetoConfigName: vetoConfig.name,
            notes: `Primary-veto recipe derived from ${pair.primaryConfigName} -> ${pair.vetoConfigName} on the ${this.describePolymarketDirectionSlice(runResult.directionSlice)} slice. Trade ${primaryConfig.name}, but skip the event when ${vetoConfig.name} fires the opposite Polymarket side on the same event.`,
            metrics: {
                keptTrades: pair.keptEvents,
                wins: pair.keptWins,
                losses: pair.keptLosses,
                winRate: pair.postVetoWinRate,
                retentionRate: pair.retentionRate,
                coverage: null,
                overlapRate: pair.overlapRate,
                winRateLift: pair.winRateLift,
                wilsonLift: pair.wilsonLift,
            },
        };
    }

    private buildSecondaryOverrideRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const { runResult } = this.requirePolymarketRunContext("building the best secondary-override recipe");
        const bestPair = runResult.overrideScan.bestPair ?? null;
        if (!bestPair) {
            throw new Error("Run Ensemble Polymarket and produce a best secondary-override pair first.");
        }

        return this.buildOverrideRecipeFromPair(bestPair);
    }

    private buildOverrideRecipeFromPair(pair: EnsemblePolymarketOverridePairResult): EnsembleSignalRecipe {
        const { runResult, selection } = this.requirePolymarketRunContext("building an override-pair recipe");
        const primaryConfig = this.loadRequiredStrategyConfigSnapshot(pair.primaryConfigName, "the override-pair recipe");
        const secondaryConfig = this.loadRequiredStrategyConfigSnapshot(pair.secondaryConfigName, "the override-pair recipe");
        const nowIso = new Date().toISOString();

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} override ${pair.primaryConfigName} -> ${pair.secondaryConfigName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "secondary_override",
            directionSlice: runResult.directionSlice,
            anchorConfigName: primaryConfig.name,
            anchorConfig: primaryConfig,
            componentConfigs: [primaryConfig, secondaryConfig],
            primaryConfigName: primaryConfig.name,
            secondaryConfigName: secondaryConfig.name,
            notes: `Secondary-override recipe derived from ${pair.primaryConfigName} -> ${pair.secondaryConfigName} on the ${this.describePolymarketDirectionSlice(runResult.directionSlice)} slice. Trade ${primaryConfig.name}, but when ${secondaryConfig.name} fires the opposite Polymarket side on the same event, force the secondary side instead.`,
            metrics: {
                keptTrades: pair.keptEvents,
                wins: pair.keptWins,
                losses: pair.keptLosses,
                winRate: pair.postOverrideWinRate,
                retentionRate: pair.retentionRate,
                coverage: null,
                overlapRate: pair.overlapRate,
                winRateLift: pair.winRateLift,
                wilsonLift: pair.wilsonLift,
            },
        };
    }

    private buildBestSideOwnerRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const runResult = this.lastPolymarketRunResult;
        const selection = this.lastPolymarketSelection;
        const policyResult = runResult?.policyResults.bestSideOwner ?? null;
        if (!runResult || !selection || !policyResult) {
            throw new Error("Run Ensemble Polymarket and produce a best-side-owner recipe first.");
        }

        const anchorConfig = this.loadRequiredStrategyConfigSnapshot(selection.targetName, "the best-side-owner recipe");
        const componentNames = new Set<string>([anchorConfig.name]);
        if (policyResult.longOwnerConfigName) {
            componentNames.add(policyResult.longOwnerConfigName);
        }
        if (policyResult.shortOwnerConfigName) {
            componentNames.add(policyResult.shortOwnerConfigName);
        }
        const componentConfigs = Array.from(componentNames).map((name) =>
            this.loadRequiredStrategyConfigSnapshot(name, "the best-side-owner recipe")
        );
        const nowIso = new Date().toISOString();
        const ownerLabel = [
            policyResult.longOwnerConfigName ? `long ${policyResult.longOwnerConfigName}` : "",
            policyResult.shortOwnerConfigName ? `short ${policyResult.shortOwnerConfigName}` : "",
        ].filter((part) => part.length > 0).join(" + ");

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} owners ${ownerLabel || selection.targetName}${this.buildDirectionSliceRecipeSuffix(runResult.directionSlice)}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "best_side_owner",
            directionSlice: runResult.directionSlice,
            anchorConfigName: anchorConfig.name,
            anchorConfig: anchorConfig,
            componentConfigs,
            longOwnerConfigName: policyResult.longOwnerConfigName,
            shortOwnerConfigName: policyResult.shortOwnerConfigName,
            notes: `Best-side-owner recipe on the ${this.describePolymarketDirectionSlice(runResult.directionSlice)} slice. Replay uses ${anchorConfig.name} as the anchor execution profile while delegating long and short event ownership to the strongest saved configs discovered in the current run.`,
            metrics: this.buildRecipeMetricsFromPolicyResult(policyResult, null),
        };
    }

    private buildSelectedPolicyRecipeFromCurrentRun(): EnsembleSignalRecipe {
        switch (this.getSelectedPolymarketConflictPolicy()) {
            case "primary_veto":
                return this.buildBestVetoRecipeFromCurrentRun();
            case "secondary_override":
                return this.buildSecondaryOverrideRecipeFromCurrentRun();
            case "best_side_owner":
                return this.buildBestSideOwnerRecipeFromCurrentRun();
            case "skip_conflicts":
            default:
                return this.buildConflictFilterRecipeFromCurrentRun();
        }
    }

    private async loadRecipeBacktest(recipe: EnsembleSignalRecipe, successMessage: string): Promise<void> {
        await this.loadRecipeBacktestWithOptions(recipe, successMessage, {
            snapshotModeLabel: "Rebuilt Recipe Snapshot",
            freezeInstruction: "Frozen to the candle snapshot used when you loaded this preview. Rerun Ensemble Polymarket if you want it rebuilt on fresh candles.",
        });
    }

    private async loadRecipeBacktestWithOptions(
        recipe: EnsembleSignalRecipe,
        successMessage: string,
        options?: {
            overridePreparedSignals?: (candles: OHLCVData[]) => Signal[];
            overrideDescription?: string;
            registerRerun?: boolean;
            silent?: boolean;
            snapshotModeLabel?: string;
            freezeInstruction?: string;
        }
    ): Promise<void> {
        if (recipe.symbol !== state.currentSymbol || recipe.interval !== state.currentInterval) {
            throw new Error(`Recipe ${recipe.name} is pinned to ${recipe.symbol} ${recipe.interval}. Switch the chart to that market first.`);
        }

        const candles = this.prepareCandles();
        if (candles.length < 2) {
            throw new Error("Not enough closed candle data loaded to preview this recipe.");
        }

        const resolved = buildPreparedSignalsForEnsembleRecipe({
            recipe,
            candles,
            getStrategy: (strategyKey) => strategyRegistry.get(strategyKey),
        });
        const overridePreparedSignals = options?.overridePreparedSignals?.(candles) ?? [];
        const preparedSignals = overridePreparedSignals.length > 0
            ? overridePreparedSignals
            : resolved.preparedSignals;
        if (preparedSignals.length === 0) {
            throw new Error(`Recipe ${recipe.name} produced no prepared signals on the current chart window.`);
        }

        clearBacktestResults("ensemble_recipe_preview_reset");
        await settingsManager.applyStrategyConfig(resolved.anchorConfig);
        const preview = await backtestService.evaluateSignalsOnData(
            candles,
            recipe.interval,
            preparedSignals,
            resolved.anchorBacktestSettings,
            settingsManager.resolveCapitalFromConfig(resolved.anchorConfig)
        );
        const previewResult = this.attachPolymarketOutcomesToBacktestResult(
            preview.result,
            this.lastPolymarketOutcomes,
            recipe.interval
        );
        commitBacktestResult(previewResult, "ensemble_preview", {
            reason: "ensemble_signal_recipe_preview",
        });
        const snapshotStatus = this.buildPreviewSnapshotStatus({
            recipe,
            anchorConfig: resolved.anchorConfig,
            candles,
            totalTrades: previewResult.totalTrades,
            snapshotModeLabel: options?.snapshotModeLabel ?? "Rebuilt Recipe Snapshot",
            freezeInstruction: options?.freezeInstruction ?? "Frozen to the candle snapshot used when you loaded this preview.",
        });
        const frozenPreviewResult = previewResult;
        const frozenAnchorConfig = this.cloneStrategyConfigSnapshot(resolved.anchorConfig);
        if (options?.registerRerun !== false) {
            setActiveBacktestRerunContext({
                source: "ensemble_preview",
                label: recipe.name,
                rerun: async () => {
                    clearBacktestResults("ensemble_recipe_preview_rerun_reset");
                    await settingsManager.applyStrategyConfig(frozenAnchorConfig);
                    commitBacktestResult(frozenPreviewResult, "ensemble_preview", {
                        reason: "ensemble_signal_recipe_preview_rerun",
                    });
                    this.updateStatus(`Refreshed frozen ensemble preview: ${recipe.name}.`);
                    this.updatePolymarketStatus(`Refreshed frozen ensemble preview: ${recipe.name}.`);
                    this.updateSignalRecipeStatus(snapshotStatus);
                },
            });
        }

        this.updateStatus(successMessage);
        this.updatePolymarketStatus(successMessage);
        this.updateSignalRecipeStatus(snapshotStatus);
        strategyPanelController.switchTab("results");
        if (!options?.silent) {
            uiManager.showToast(successMessage, "success");
        }
    }

    private async loadConflictFilterRecipePreview(
        recipe: EnsembleSignalRecipe,
        options?: { silent?: boolean }
    ): Promise<void> {
        await this.loadRecipeBacktestWithOptions(
            recipe,
            `Loaded target-anchored conflict-filter overlay preview from ${recipe.anchorConfigName}.`,
            {
                silent: options?.silent,
                snapshotModeLabel: "Rebuilt Target-Anchored Recipe Snapshot",
                freezeInstruction: "Frozen to the candle snapshot used when you loaded this target-anchored conflict-filter preview. Rerun Ensemble Polymarket if you want it rebuilt on fresh candles.",
            }
        );
    }

    private async loadConflictFilterBacktest(): Promise<void> {
        try {
            const recipe = this.buildSelectedPolicyRecipeFromCurrentRun();
            if (recipe.mode === "target_conflict_filter") {
                await this.loadConflictFilterRecipePreview(recipe);
            } else {
                await this.loadRecipeBacktest(
                    recipe,
                    `Loaded ${this.describeRecipeMode(recipe.mode).toLowerCase()} backtest preview from ${recipe.anchorConfigName}.`
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updatePolymarketStatus(message);
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private async loadBestVetoBacktest(): Promise<void> {
        try {
            const recipe = this.buildBestVetoRecipeFromCurrentRun();
            await this.loadRecipeBacktest(
                recipe,
                `Loaded primary-veto backtest preview from ${recipe.anchorConfigName}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updatePolymarketStatus(message);
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private attachPolymarketOutcomesToBacktestResult(
        result: BacktestResult,
        outcomes: readonly PolymarketOutcomeRow[],
        interval = state.currentInterval
    ): BacktestResult {
        if (outcomes.length === 0) {
            return result;
        }

        const annotatedTrades = annotateTradesWithPolymarketOutcomesForRun(
            result.trades,
            outcomes,
            interval
        );
        const summary = summarizePolymarketTradesForRun({
            trades: result.trades,
            outcomes,
            interval,
        });
        const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;
        const existingSummary = result.polymarketTradeSummary;
        const symbol = state.currentSymbol;

        return {
            ...result,
            trades: annotatedTrades,
            polymarketTradeSummary: {
                seriesId: getPolymarket5mSeriesIdForSymbol(symbol) || outcomes[0]?.series_id || "",
                outcomeRowsLoaded: existingSummary?.outcomeRowsLoaded && existingSummary.outcomeRowsLoaded > 0
                    ? existingSummary.outcomeRowsLoaded
                    : outcomes.length,
                scoredTrades: existingSummary?.scoredTrades ?? summary.scoredTrades,
                missingOutcomeTrades: existingSummary?.missingOutcomeTrades ?? summary.missingOutcomeTrades,
                unscoredTrades: existingSummary?.unscoredTrades ?? summary.unscoredTrades ?? Math.max(0, totalTrades - summary.scoredTrades),
                duplicateTradesIgnored: existingSummary?.duplicateTradesIgnored ?? summary.duplicateTradesIgnored,
                entryOffset: existingSummary?.entryOffset ?? undefined,
                timingProfile: existingSummary?.timingProfile ?? summary.timingProfile,
            },
        };
    }

    private async loadPolymarketConfigBacktest(configName: string): Promise<void> {
        try {
            const { selection, outcomes } = this.requirePolymarketRunContext(`viewing ${configName}`);
            const allowedNames = new Set([selection.targetName, ...selection.contextNames]);
            if (!allowedNames.has(configName)) {
                throw new Error(`Config "${configName}" is not part of the current Ensemble Polymarket run.`);
            }

            const candles = this.prepareCandles();
            if (candles.length < 2) {
                throw new Error("Not enough closed candle data loaded to preview this config.");
            }

            const artifact = await runConfig(configName, candles, this.buildEngineDeps());
            if (!artifact) {
                throw new Error(`Config "${configName}" could not be evaluated.`);
            }

            const previewResult = this.attachPolymarketOutcomesToBacktestResult(artifact.result, outcomes);
            clearBacktestResults("ensemble_polymarket_config_preview_reset");
            await settingsManager.applyStrategyConfig(artifact.config);
            commitBacktestResult(previewResult, "ensemble_preview", {
                reason: "ensemble_polymarket_config_preview",
            });
            const frozenPreviewResult = previewResult;
            const frozenConfig = this.cloneStrategyConfigSnapshot(artifact.config);
            setActiveBacktestRerunContext({
                source: "ensemble_preview",
                label: `Ensemble Polymarket config: ${configName}`,
                rerun: async () => {
                    clearBacktestResults("ensemble_polymarket_config_preview_rerun_reset");
                    await settingsManager.applyStrategyConfig(frozenConfig);
                    commitBacktestResult(frozenPreviewResult, "ensemble_preview", {
                        reason: "ensemble_polymarket_config_preview_rerun",
                    });
                    this.updatePolymarketStatus(`Refreshed frozen config preview: ${configName}.`);
                },
            });

            strategyPanelController.switchTab("results");
            this.updatePolymarketStatus(`Viewing backtest for ${configName}. Loaded the frozen Polymarket-scored snapshot into Results and Trades.`);
            uiManager.showToast(`Viewing backtest: ${configName}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updatePolymarketStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private async loadPolymarketVetoPairBacktest(primaryConfigName: string, vetoConfigName: string): Promise<void> {
        try {
            const { runResult } = this.requirePolymarketRunContext(`viewing ${primaryConfigName} -> ${vetoConfigName}`);
            const pair = runResult.vetoScan.pairResults.find((candidate) =>
                candidate.primaryConfigName === primaryConfigName && candidate.vetoConfigName === vetoConfigName
            );
            if (!pair) {
                throw new Error(`Veto pair "${primaryConfigName} -> ${vetoConfigName}" is not part of the current run.`);
            }

            await this.loadRecipeBacktest(
                this.buildVetoRecipeFromPair(pair),
                `Viewing veto-pair backtest: ${primaryConfigName} -> ${vetoConfigName}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updatePolymarketStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private async loadPolymarketOverridePairBacktest(primaryConfigName: string, secondaryConfigName: string): Promise<void> {
        try {
            const { runResult } = this.requirePolymarketRunContext(`viewing ${primaryConfigName} -> ${secondaryConfigName}`);
            const pair = runResult.overrideScan.pairResults.find((candidate) =>
                candidate.primaryConfigName === primaryConfigName && candidate.secondaryConfigName === secondaryConfigName
            );
            if (!pair) {
                throw new Error(`Override pair "${primaryConfigName} -> ${secondaryConfigName}" is not part of the current run.`);
            }

            await this.loadRecipeBacktest(
                this.buildOverrideRecipeFromPair(pair),
                `Viewing override-pair backtest: ${primaryConfigName} -> ${secondaryConfigName}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updatePolymarketStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private saveConflictFilterRecipe(): void {
        try {
            const persisted = settingsManager.upsertEnsembleSignalRecipe(this.buildSelectedPolicyRecipeFromCurrentRun());
            this.syncSavedSignalRecipeOptions(persisted.name);
            this.updateSignalRecipeStatus(`Saved ${this.describeRecipeMode(persisted.mode).toLowerCase()} recipe: ${persisted.name}.`);
            uiManager.showToast(`Saved recipe: ${persisted.name}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private saveBestVetoRecipe(): void {
        try {
            const persisted = settingsManager.upsertEnsembleSignalRecipe(this.buildBestVetoRecipeFromCurrentRun());
            this.syncSavedSignalRecipeOptions(persisted.name);
            this.updateSignalRecipeStatus(`Saved best-veto recipe: ${persisted.name}.`);
            uiManager.showToast(`Saved recipe: ${persisted.name}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private buildPreviewSnapshotStatus(args: {
        recipe: EnsembleSignalRecipe;
        anchorConfig: StrategyConfig;
        candles: readonly OHLCVData[];
        totalTrades: number;
        snapshotModeLabel: string;
        freezeInstruction: string;
    }): string {
        const lastCandle = args.candles[args.candles.length - 1] ?? null;
        const lastCandleLabel = lastCandle
            ? formatJakartaTime(lastCandle.time, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })
            : "n/a";

        return [
            args.recipe.name,
            args.snapshotModeLabel,
            `${args.recipe.symbol} ${args.recipe.interval}`,
            this.formatPreviewExecutionSettings(args.anchorConfig),
            `${args.candles.length} candles`,
            `last candle ${lastCandleLabel}`,
            `${args.totalTrades} backtest trade${args.totalTrades === 1 ? "" : "s"}`,
            args.freezeInstruction,
        ].join(" | ");
    }

    private async downloadSelectedSignalRecipeBridge(): Promise<void> {
        const recipe = this.getSelectedSignalRecipe();
        if (!recipe) {
            const message = "Select a saved ensemble signal recipe first.";
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const botSymbol = resolveExternalSignalSymbol(recipe.symbol);
        if (!botSymbol) {
            const message = `Recipe ${recipe.name} uses unsupported external-signal symbol ${recipe.symbol}.`;
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const slug = slugifyEnsembleSignalRecipeName(recipe.name);
        const directionOverride = this.getSelectedRecipeDirectionOverride();
        const variantSlug = buildEnsembleRecipeVariantSlug(slug, directionOverride);
        const variantLabel = describeEnsembleRecipeReplayDirectionOverride(directionOverride);
        const script = buildEnsembleRecipeBridgeScript(recipe, slug, botSymbol, directionOverride);
        this.downloadTextFile(`${variantSlug}.bridge.ps1`, script, "text/plain;charset=utf-8");
        this.updateSignalRecipeStatus(`Downloaded recipe bridge script for ${recipe.name} (${variantLabel}).`);
        uiManager.showToast(`Downloaded bridge for ${recipe.name} (${variantLabel})`, "success");
    }

    private async copySelectedSignalRecipeEnv(): Promise<void> {
        const recipe = this.getSelectedSignalRecipe();
        if (!recipe) {
            const message = "Select a saved ensemble signal recipe first.";
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const botSymbol = resolveExternalSignalSymbol(recipe.symbol);
        if (!botSymbol) {
            const message = `Recipe ${recipe.name} uses unsupported external-signal symbol ${recipe.symbol}.`;
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        const slug = slugifyEnsembleSignalRecipeName(recipe.name);
        const directionOverride = this.getSelectedRecipeDirectionOverride();
        const variantLabel = describeEnsembleRecipeReplayDirectionOverride(directionOverride);
        const snippet = buildEnsembleRecipeBotEnvSnippet(recipe, slug, botSymbol, directionOverride);
        const copied = await this.copyToClipboard(snippet);
        if (!copied) {
            const message = `Failed to copy env snippet for ${recipe.name}.`;
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        this.updateSignalRecipeStatus(`Copied recipe env snippet for ${recipe.name} (${variantLabel}).`);
        uiManager.showToast(`Copied env snippet for ${recipe.name} (${variantLabel})`, "success");
    }

    private deleteSelectedSignalRecipe(): void {
        const recipe = this.getSelectedSignalRecipe();
        if (!recipe) {
            const message = "Select a saved ensemble signal recipe first.";
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        if (!window.confirm(`Delete saved ensemble signal recipe "${recipe.name}"?`)) {
            return;
        }

        const deleted = settingsManager.deleteEnsembleSignalRecipe(recipe.name);
        if (!deleted) {
            const message = `Failed to delete recipe ${recipe.name}.`;
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        this.syncSavedSignalRecipeOptions();
        this.updateSignalRecipeStatus(`Deleted recipe ${recipe.name}.`);
        uiManager.showToast(`Deleted recipe: ${recipe.name}`, "success");
    }

    private downloadTextFile(fileName: string, content: string, mime: string): void {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    private async copyToClipboard(text: string): Promise<boolean> {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(textarea);
            return copied;
        }
    }

    private async runPolymarket(): Promise<void> {
        const dom = this.getDom();
        const targetName = this.getSelectedTargetName();

        if (!targetName) {
            uiManager.showToast("Select a target config first.", "error");
            this.updatePolymarketStatus("Select a target config first.");
            return;
        }

        const contextNames = this.getSelectedContextNames();
        if (contextNames.length === 0) {
            uiManager.showToast("Select at least one context config.", "error");
            this.updatePolymarketStatus("Select at least one context config.");
            return;
        }

        if (!isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval)) {
            const message = `Ensemble Polymarket currently supports ${getSupportedPolymarket5mSymbolsLabel()} on 5m.`;
            uiManager.showToast(message, "error");
            this.updatePolymarketStatus(message);
            this.syncPolymarketAvailability();
            return;
        }

        const candles = this.prepareCandles();
        if (candles.length < 50) {
            uiManager.showToast("Not enough closed candle data loaded. Load more data first.", "error");
            this.updatePolymarketStatus("Not enough closed candle data to run Ensemble Polymarket.");
            return;
        }

        const selectedConfigNames = [targetName, ...contextNames];
        const engineDeps = this.buildEngineDeps();
        const conflictPolicy = this.getSelectedPolymarketConflictPolicy();
        const directionSlice = this.getSelectedPolymarketDirectionSlice();

        dom.ensembleRunPolymarketBtn.disabled = true;
        dom.ensembleRunPolymarketBtn.setAttribute("aria-busy", "true");
        this.updatePolymarketStatus(`Loading Polymarket outcomes for ${state.currentSymbol} (${state.currentInterval})...`);

        try {
            const outcomes = await loadPolymarket5mOutcomesForChart(state.currentSymbol, candles);
            const result = await runEnsemblePolymarket({
                targetName,
                contextNames,
                candles,
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                outcomes,
                deps: engineDeps,
                conflictPolicy,
                directionSlice,
                onProgress: (message) => this.updatePolymarketStatus(message),
            });

            this.lastPolymarketRunResult = result;
            this.lastPolymarketSelection = {
                targetName,
                contextNames: [...contextNames],
                symbol: state.currentSymbol,
                interval: state.currentInterval,
            };
            this.lastPolymarketOutcomes = [...outcomes];
            renderEnsemblePolymarketResults(dom, result);
            this.updatePolymarketStatus(
                `Ensemble Polymarket ready. ${selectedConfigNames.length} configs scored on ${this.describePolymarketDirectionSlice(directionSlice)} with ${this.describePolymarketConflictPolicy(conflictPolicy)} selected.`
            );
            this.syncSavedSignalRecipeControls();
            uiManager.showToast("Ensemble Polymarket complete.", "success");
        } catch (error) {
            this.lastPolymarketRunResult = null;
            this.lastPolymarketSelection = null;
            this.lastPolymarketOutcomes = [];
            console.error("[StrategyEnsembleLab][Polymarket] Run failed", error);
            resetEnsemblePolymarketPanel(dom);
            this.syncPolymarketAvailability();
            this.syncSavedSignalRecipeControls();
            uiManager.showToast(
                `Ensemble Polymarket failed: ${error instanceof Error ? error.message : String(error)}`,
                "error"
            );
            this.updatePolymarketStatus(
                `Ensemble Polymarket failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            dom.ensembleRunPolymarketBtn.disabled = this.contextConfigs.size === 0
                || !isSupportedPolymarket5mRun(state.currentSymbol, state.currentInterval);
            dom.ensembleRunPolymarketBtn.setAttribute("aria-busy", "false");
        }
    }

    private async run(): Promise<void> {
        const dom = this.getDom();
        const targetName = this.getSelectedTargetName();

        if (!targetName) {
            uiManager.showToast("Select a target config first.", "error");
            this.updateStatus("Select a target config first.");
            return;
        }

        const contextNames = this.getSelectedContextNames();
        if (contextNames.length === 0) {
            uiManager.showToast("Select at least one context config.", "error");
            this.updateStatus("Select at least one context config.");
            return;
        }

        const candles = this.prepareCandles();
        if (candles.length < 50) {
            uiManager.showToast("Not enough closed candle data loaded. Load more data first.", "error");
            this.updateStatus("Not enough closed candle data to run Strategy Ensemble Lab.");
            return;
        }

        const minSamples = this.readMinSamples();
        const allConfigs = settingsManager.loadAllStrategyConfigs();
        const selectedConfigNames = [targetName, ...contextNames];
        const candidateConfigNames = allConfigs
            .map((config) => config.name)
            .filter((name) => !selectedConfigNames.includes(name));
        const artifacts = new Map<string, ConfigRunArtifact>();
        const candidateArtifacts = new Map<string, ConfigSignalArtifact>();
        const engineDeps = this.buildEngineDeps();
        const rulesRuntime = this.buildRulesRuntime(engineDeps);

        dom.ensembleRunBtn.disabled = true;
        dom.ensembleRunBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running ${selectedConfigNames.length} selected configs on ${state.currentSymbol} (${state.currentInterval})...`);

        try {
            for (let index = 0; index < selectedConfigNames.length; index += 1) {
                const configName = selectedConfigNames[index];
                this.updateStatus(`Running selected config ${configName} (${index + 1}/${selectedConfigNames.length})...`);
                const artifact = await runConfig(configName, candles, engineDeps);
                if (artifact) {
                    artifacts.set(configName, artifact);
                }
                await this.yieldToUi();
            }

            for (let index = 0; index < candidateConfigNames.length; index += 1) {
                const configName = candidateConfigNames[index];
                this.updateStatus(`Preparing replacement candidate ${configName} (${index + 1}/${candidateConfigNames.length})...`);
                const artifact = await buildSignalArtifact(configName, candles, engineDeps);
                if (artifact) {
                    candidateArtifacts.set(configName, artifact);
                }
                await this.yieldToUi();
            }

            const targetArtifact = artifacts.get(targetName);
            if (!targetArtifact) {
                throw new Error(`Target config "${targetName}" could not be evaluated.`);
            }

            const contextArtifacts = contextNames
                .map((name) => artifacts.get(name) ?? null)
                .filter((artifact): artifact is ConfigRunArtifact => artifact !== null);

            if (contextArtifacts.length === 0) {
                throw new Error("No context configs could be evaluated.");
            }

            const contextFamilyCount = countDistinctFamilies(contextArtifacts);
            this.updateStatus("Evaluating ensemble rule candidates...");
            const scenario = await evaluateScenario(targetArtifact, contextArtifacts, candles, minSamples, rulesRuntime);
            this.updateStatus("Scoring leave-one-out context contribution...");
            const currentContextReference = resolveCurrentContextReference(targetArtifact, candles);
            const contributionRows = await buildContributionRows(
                targetArtifact,
                contextArtifacts,
                scenario,
                currentContextReference,
                rulesRuntime
            );
            this.updateStatus("Ranking replacement candidates...");
            const replacementRows = await buildReplacementRows(
                targetArtifact,
                contextArtifacts,
                scenario,
                contributionRows,
                currentContextReference,
                Array.from(candidateArtifacts.values()),
                rulesRuntime
            );
            const liveContext = buildLiveContext(
                targetArtifact,
                contextArtifacts,
                candles,
                scenario.tradeSamples,
                minSamples
            );

            const runContext: EnsembleRunContext = {
                targetConfigName: targetName,
                contextConfigNames: contextArtifacts.map((artifact) => artifact.config.name),
                contextFamilyCount,
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                candles,
                artifacts,
                targetArtifact,
                tradeSamples: scenario.tradeSamples,
                buckets: scenario.buckets,
                baselineBucket: scenario.baselineBucket,
                bestBucket: scenario.bestBucket,
                bestLongBucket: scenario.bestLongBucket,
                bestShortBucket: scenario.bestShortBucket,
                builderRows: scenario.builderRows,
                builderPreviewByRuleId: scenario.builderPreviewByRuleId,
                selectedRule: scenario.selectedRule,
                liveContext,
                minSamples,
                contributionRows,
                replacementRows,
            };
            this.runContext = runContext;

            renderStrategyEnsembleResults(this.getDom(), runContext);
            this.updateStatus(
                `Strategy Ensemble Lab ready. ${scenario.tradeSamples.length} target trades analyzed across ${contextArtifacts.length} context configs in ${contextFamilyCount} families.`
            );
            uiManager.showToast("Strategy Ensemble Lab complete.", "success");
        } catch (error) {
            this.runContext = null;
            console.error("[StrategyEnsembleLab] Run failed", error);
            uiManager.showToast(
                `Strategy Ensemble Lab failed: ${error instanceof Error ? error.message : String(error)}`,
                "error"
            );
            this.updateStatus("Strategy Ensemble Lab failed. Check console for details.");
            resetStrategyEnsembleResultPanels(this.getDom());
        } finally {
            dom.ensembleRunBtn.disabled = false;
            dom.ensembleRunBtn.setAttribute("aria-busy", "false");
        }
    }
}

export const strategyEnsembleService = new StrategyEnsembleService();
