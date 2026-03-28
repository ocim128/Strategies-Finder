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
    type EnsemblePolymarketRunResult,
} from "./strategy-ensemble-polymarket-engine";
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
import type { OHLCVData } from "./strategies";
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
            this.syncReadouts(dom);
            this.syncPolymarketAvailability();
            this.invalidateRunContext("Target symbol changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("currentInterval", () => {
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
            option.textContent = `${recipe.name} | ${this.describeRecipeMode(recipe.mode)} | ${recipe.symbol} ${recipe.interval}`;
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
        const hasPolymarketResult = this.lastPolymarketRunResult !== null;
        const hasBestVeto = Boolean(this.lastPolymarketRunResult?.vetoScan.bestPair);

        dom.ensembleLoadConflictBacktestBtn.disabled = !hasPolymarketResult;
        dom.ensembleSaveConflictRecipeBtn.disabled = !hasPolymarketResult;
        dom.ensembleLoadBestVetoBacktestBtn.disabled = !hasBestVeto;
        dom.ensembleSaveBestVetoRecipeBtn.disabled = !hasBestVeto;
        dom.ensembleSignalRecipeDownloadScriptBtn.disabled = !selectedRecipe;
        dom.ensembleSignalRecipeCopyEnvBtn.disabled = !selectedRecipe;
        dom.ensembleSignalRecipeDeleteBtn.disabled = !selectedRecipe;

        if (selectedRecipe) {
            this.updateSignalRecipeStatus(this.describeSelectedRecipe(selectedRecipe));
            return;
        }

        if (hasPolymarketResult) {
            this.updateSignalRecipeStatus(
                "Current Polymarket run is ready. Load a preview backtest or save the conflict-filter / best-veto recipe for later export."
            );
            return;
        }

        this.updateSignalRecipeStatus(
            "Save a tradable conflict-filter or best-veto recipe from the current run to export it later as an external signal."
        );
    }

    private updateSignalRecipeStatus(message: string): void {
        this.getDom().ensembleSignalRecipeStatus.textContent = message;
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
            this.updatePolymarketStatus("Run Ensemble Polymarket to compare individual config edge, the conflict-filtered overlay, and the majority-vote overlay against matched 5m Polymarket outcomes.");
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
        if (!direction) {
            return "Both";
        }
        if (direction === "long") {
            return "Long";
        }
        if (direction === "short") {
            return "Short";
        }
        return "Both";
    }

    private describeRecipeMode(mode: EnsembleSignalRecipe["mode"]): string {
        return mode === "primary_veto" ? "Primary + Veto" : "Target Conflict Filter";
    }

    private describeSelectedRecipe(recipe: EnsembleSignalRecipe): string {
        const metrics = recipe.metrics;
        const winRateLabel = `${(metrics.winRate * 100).toFixed(1)}%`;
        const keptTradesLabel = `${metrics.keptTrades} kept trade${metrics.keptTrades === 1 ? "" : "s"}`;
        return `${recipe.name} | ${this.describeRecipeMode(recipe.mode)} | ${recipe.symbol} ${recipe.interval} | ${keptTradesLabel} | ${winRateLabel} win rate.`;
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
            parityResults: null,
            reason: "ensemble_preview",
        });

        this.updateStatus(`Loaded exact ensemble preview: ${preview.row.rule}.`);
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

    private buildConflictFilterRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const runResult = this.lastPolymarketRunResult;
        const selection = this.lastPolymarketSelection;
        if (!runResult || !selection) {
            throw new Error("Run Ensemble Polymarket first.");
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
                `${selection.symbol} ${selection.interval} conflict ${selection.targetName}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "target_conflict_filter",
            anchorConfigName: targetConfig.name,
            anchorConfig: targetConfig,
            componentConfigs: [targetConfig, ...contextConfigs],
            notes: `Aligned one-side conflict-filter overlay derived from ${selection.targetName} with ${contextConfigs.length} context config${contextConfigs.length === 1 ? "" : "s"}. This saved recipe replays the actual conflict-filtered overlay by emitting one synthetic ensemble entry whenever the selected configs agree on only one side at the same event time.`,
            metrics: {
                keptTrades: overlay.scoredEvents,
                wins: overlay.wins,
                losses: overlay.losses,
                winRate: overlay.winRate,
                retentionRate: null,
                coverage: overlay.coverage,
                overlapRate,
                winRateLift: null,
                wilsonLift: null,
            },
        };
    }

    private buildBestVetoRecipeFromCurrentRun(): EnsembleSignalRecipe {
        const runResult = this.lastPolymarketRunResult;
        const selection = this.lastPolymarketSelection;
        const bestPair = runResult?.vetoScan.bestPair ?? null;
        if (!runResult || !selection || !bestPair) {
            throw new Error("Run Ensemble Polymarket and produce a best veto pair first.");
        }

        const primaryConfig = this.loadRequiredStrategyConfigSnapshot(bestPair.primaryConfigName, "the best-veto recipe");
        const vetoConfig = this.loadRequiredStrategyConfigSnapshot(bestPair.vetoConfigName, "the best-veto recipe");
        const nowIso = new Date().toISOString();

        return {
            name: this.buildUniqueSignalRecipeName(
                `${selection.symbol} ${selection.interval} veto ${bestPair.primaryConfigName} -> ${bestPair.vetoConfigName}`
            ),
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "ensemble_polymarket",
            symbol: selection.symbol,
            interval: selection.interval,
            mode: "primary_veto",
            anchorConfigName: primaryConfig.name,
            anchorConfig: primaryConfig,
            componentConfigs: [primaryConfig, vetoConfig],
            primaryConfigName: primaryConfig.name,
            vetoConfigName: vetoConfig.name,
            notes: `Primary-veto recipe derived from the best asymmetric veto pair. Trade ${primaryConfig.name}, but skip the event when ${vetoConfig.name} fires the opposite Polymarket side on the same event.`,
            metrics: {
                keptTrades: bestPair.keptEvents,
                wins: bestPair.keptWins,
                losses: bestPair.keptLosses,
                winRate: bestPair.postVetoWinRate,
                retentionRate: bestPair.retentionRate,
                coverage: null,
                overlapRate: bestPair.overlapRate,
                winRateLift: bestPair.winRateLift,
                wilsonLift: bestPair.wilsonLift,
            },
        };
    }

    private async loadRecipeBacktest(recipe: EnsembleSignalRecipe, successMessage: string): Promise<void> {
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

        if (resolved.preparedSignals.length === 0) {
            throw new Error(`Recipe ${recipe.name} produced no prepared signals on the current chart window.`);
        }

        clearBacktestResults("ensemble_recipe_preview_reset");
        await settingsManager.applyStrategyConfig(resolved.anchorConfig);
        const preview = await backtestService.evaluateSignalsOnData(
            candles,
            recipe.interval,
            resolved.preparedSignals,
            resolved.anchorBacktestSettings,
            settingsManager.resolveCapitalFromConfig(resolved.anchorConfig)
        );
        commitBacktestResult(preview.result, "ensemble_preview", {
            parityResults: null,
            reason: "ensemble_signal_recipe_preview",
        });

        this.updateStatus(successMessage);
        this.updateSignalRecipeStatus(
            `${recipe.name} preview loaded. ${preview.result.totalTrades} backtest trade${preview.result.totalTrades === 1 ? "" : "s"} generated from ${resolved.description}.`
        );
    }

    private async loadConflictFilterBacktest(): Promise<void> {
        try {
            const recipe = this.buildConflictFilterRecipeFromCurrentRun();
            await this.loadRecipeBacktest(
                recipe,
                `Loaded aligned one-side conflict-filter overlay preview from ${recipe.anchorConfigName}.`
            );
            uiManager.showToast("Conflict-filter preview loaded.", "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
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
            uiManager.showToast("Best-veto preview loaded.", "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private saveConflictFilterRecipe(): void {
        try {
            const persisted = settingsManager.upsertEnsembleSignalRecipe(this.buildConflictFilterRecipeFromCurrentRun());
            this.syncSavedSignalRecipeOptions(persisted.name);
            this.updateSignalRecipeStatus(`Saved conflict-filter recipe: ${persisted.name}.`);
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
        const script = buildEnsembleRecipeBridgeScript(recipe, slug, botSymbol);
        this.downloadTextFile(`${slug}.bridge.ps1`, script, "text/plain;charset=utf-8");
        this.updateSignalRecipeStatus(`Downloaded recipe bridge script for ${recipe.name}.`);
        uiManager.showToast(`Downloaded bridge for ${recipe.name}`, "success");
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
        const snippet = buildEnsembleRecipeBotEnvSnippet(recipe, slug, botSymbol);
        const copied = await this.copyToClipboard(snippet);
        if (!copied) {
            const message = `Failed to copy env snippet for ${recipe.name}.`;
            this.updateSignalRecipeStatus(message);
            uiManager.showToast(message, "error");
            return;
        }

        this.updateSignalRecipeStatus(`Copied recipe env snippet for ${recipe.name}.`);
        uiManager.showToast(`Copied env snippet for ${recipe.name}`, "success");
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
                onProgress: (message) => this.updatePolymarketStatus(message),
            });

            this.lastPolymarketRunResult = result;
            this.lastPolymarketSelection = {
                targetName,
                contextNames: [...contextNames],
                symbol: state.currentSymbol,
                interval: state.currentInterval,
            };
            renderEnsemblePolymarketResults(dom, result);
            this.updatePolymarketStatus(
                `Ensemble Polymarket ready. ${selectedConfigNames.length} configs scored across ${result.ensembleSummary.totalScoredTrades} executed trades.`
            );
            this.syncSavedSignalRecipeControls();
            uiManager.showToast("Ensemble Polymarket complete.", "success");
        } catch (error) {
            this.lastPolymarketRunResult = null;
            this.lastPolymarketSelection = null;
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
