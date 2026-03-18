import { strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { createEnsembleLabDom, type EnsembleLabDom } from "./feature-dom-contracts";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { state } from "./state";
import {
    applySignalPolarity,
    prepareSignalsForScanner,
    timeKey,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Signal,
    type Strategy,
    type Trade,
    type TradeDirection,
} from "./strategies";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { getOpenPositionForScanner, type OpenPosition } from "./strategies/backtest/signal-preparation";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";
import {
    selectEnsembleRuleSelection,
    type EnsembleRuleEvaluation,
    type EnsembleRuleSelection,
    type EnsembleRuleSpec,
} from "./strategy-ensemble-rule-selection";
import { renderStrategyEnsembleResults } from "./strategy-ensemble-renderer";

interface EnsembleEntryPresence {
    longEntry: boolean;
    shortEntry: boolean;
}

interface ConfigSignalArtifact {
    config: StrategyConfig;
    strategy: Strategy;
    familyKey: string;
    familyLabel: string;
    tradeDirection: TradeDirection;
    rawSignals: Signal[];
    preparedSignals: Signal[];
    entrySignals: Signal[];
    entryPresenceByTime: Map<string, EnsembleEntryPresence>;
    backtestSettings: BacktestSettings;
}

interface ConfigRunArtifact extends ConfigSignalArtifact {
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

interface EnsembleTradeSample {
    tradeIndex: number;
    direction: Trade["type"];
    isWin: boolean;
    pnl: number;
    pnlPercent: number;
    agreeCount: number;
    opposeCount: number;
}

interface EnsembleBucketSummary {
    label: string;
    sortValue: number;
    samples: number;
    winRate: number;
    lossRate: number;
    avgExpectancy: number;
    avgNetPct: number;
    avgOppose: number;
    longWinRate: number | null;
    shortWinRate: number | null;
    longSamples: number;
    shortSamples: number;
}

interface EnsembleBuilderRow {
    ruleId: string;
    rule: string;
    signals: number;
    trades: number;
    winRate: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    engineUsed: "rust" | "typescript";
    selectionMode: "validated" | "train_only" | null;
}

interface EnsembleBuilderPreview {
    row: EnsembleBuilderRow;
    result: BacktestResult;
    filteredSignals: Signal[];
}

interface ScenarioPrimaryRow {
    row: EnsembleBuilderRow;
    source: "validated" | "train_only" | "heuristic" | "baseline";
    rule: EnsembleRuleSpec | null;
}

interface EnsembleVoteProfileStats {
    samples: number;
    winRate: number;
    expectancy: number;
}

interface EnsembleVoteProfile {
    totalTrades: number;
    agreeCoverage: number;
    opposeCoverage: number;
    conflictCoverage: number;
    neutralCoverage: number;
    agreeStats: EnsembleVoteProfileStats | null;
    opposeStats: EnsembleVoteProfileStats | null;
    conflictStats: EnsembleVoteProfileStats | null;
    neutralStats: EnsembleVoteProfileStats | null;
}

interface EnsembleContributionRow {
    familyKey: string;
    familyLabel: string;
    configNames: string[];
    currentVote: "agree" | "oppose" | "neutral" | "conflict" | "n/a";
    voteProfile: EnsembleVoteProfile;
    primaryRow: ScenarioPrimaryRow;
    deltaExpectancy: number;
    deltaWinRate: number;
    tradeRetentionPercent: number;
    deltaTrades: number;
}

interface EnsembleReplacementRow {
    familyKey: string;
    familyLabel: string;
    configName: string;
    currentVote: "agree" | "oppose" | "neutral" | "conflict" | "n/a";
    primaryRow: ScenarioPrimaryRow;
    deltaExpectancyVsRemoved: number;
    deltaExpectancyVsCurrent: number;
    deltaWinRateVsCurrent: number;
    tradeRetentionPercent: number;
    deltaTradesVsCurrent: number;
}

interface EnsembleLiveContext {
    basis: "open_trade" | "latest_signal" | "none";
    direction: Trade["type"] | null;
    agreeCount: number;
    opposeCount: number;
    neutralCount: number;
    conflictedCount: number;
    rawAgreeCount: number;
    rawOpposeCount: number;
    rawNeutralCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
    agreeingFamilies: string[];
    opposingFamilies: string[];
    neutralFamilies: string[];
    conflictedFamilies: string[];
    odds: {
        sampleCount: number;
        winRate: number;
        lossRate: number;
        expectancy: number;
        label: string;
        matchType: "exact" | "nearest";
    } | null;
    openPosition: OpenPosition | null;
}

interface EnsembleRunContext {
    targetConfigName: string;
    contextConfigNames: string[];
    contextFamilyCount: number;
    symbol: string;
    interval: string;
    candles: OHLCVData[];
    artifacts: Map<string, ConfigRunArtifact>;
    targetArtifact: ConfigRunArtifact;
    tradeSamples: EnsembleTradeSample[];
    buckets: EnsembleBucketSummary[];
    baselineBucket: EnsembleBucketSummary | null;
    bestBucket: EnsembleBucketSummary | null;
    bestLongBucket: EnsembleBucketSummary | null;
    bestShortBucket: EnsembleBucketSummary | null;
    builderRows: EnsembleBuilderRow[];
    builderPreviewByRuleId: Map<string, EnsembleBuilderPreview>;
    selectedRule: EnsembleRuleSelection | null;
    liveContext: EnsembleLiveContext;
    minSamples: number;
    contributionRows: EnsembleContributionRow[];
    replacementRows: EnsembleReplacementRow[];
}

interface ContextCounts {
    agreeCount: number;
    opposeCount: number;
    neutralCount: number;
    conflictedCount: number;
    rawAgreeCount: number;
    rawOpposeCount: number;
    rawNeutralCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
    agreeingFamilies: string[];
    opposingFamilies: string[];
    neutralFamilies: string[];
    conflictedFamilies: string[];
}

interface RuleCounts {
    agreeCount: number;
    opposeCount: number;
}

interface RadarFinding {
    label: string;
    detail: string;
    quality: "positive" | "negative" | "neutral";
}

interface EnsembleScenarioEvaluation {
    contextFamilyCount: number;
    tradeSamples: EnsembleTradeSample[];
    buckets: EnsembleBucketSummary[];
    baselineBucket: EnsembleBucketSummary | null;
    bestBucket: EnsembleBucketSummary | null;
    bestLongBucket: EnsembleBucketSummary | null;
    bestShortBucket: EnsembleBucketSummary | null;
    builderRows: EnsembleBuilderRow[];
    builderPreviewByRuleId: Map<string, EnsembleBuilderPreview>;
    selectedRule: EnsembleRuleSelection | null;
    analysisRule: ScenarioPrimaryRow | null;
}

interface CurrentContextReference {
    basis: "open_trade" | "latest_signal" | "none";
    direction: Trade["type"] | null;
    timeKey: string | null;
    openPosition: OpenPosition | null;
}

interface ProxyRuleEvaluation {
    rule: EnsembleRuleSpec;
    trades: number;
    expectancy: number;
    netProfitPercent: number;
    profitFactor: number;
    maxDrawdownPercent: number;
}

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
            this.invalidateRunContext("Target symbol changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("currentInterval", () => {
            this.syncReadouts(dom);
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

    private populateConfigs(dom: EnsembleLabDom): void {
        const previousTarget = dom.ensembleTargetSelect.value.trim();
        const previousChecked = new Set(
            Array.from(this.contextCheckboxes.entries())
                .filter(([, checkbox]) => checkbox.checked)
                .map(([name]) => name)
        );
        const previousFamilyFilter = dom.ensembleContextFamilyFilter.value;
        const configs = [...settingsManager.loadAllStrategyConfigs()].sort((left, right) => {
            const familyCompare = this.getConfigFamilyLabel(left).localeCompare(this.getConfigFamilyLabel(right));
            if (familyCompare !== 0) {
                return familyCompare;
            }
            return left.name.localeCompare(right.name);
        });
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
            this.resetResultPanels();
            this.updateStatus("Save strategy configurations, then select a target and context strategies to run ensemble analysis.");
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
        this.resetResultPanels();
        this.updateStatus("Select a target config, keep one or more context configs, then run Strategy Ensemble Lab.");
    }

    private setConfigAvailability(hasConfigs: boolean): void {
        const dom = this.getDom();
        dom.ensembleEmpty.style.display = hasConfigs ? "none" : "";
        dom.ensembleContent.style.display = hasConfigs ? "" : "none";
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
            <span class="ensemble-lab__target-option-title">${this.escapeHtml(config.name)}</span>
            <span class="ensemble-lab__target-option-subtitle">${this.escapeHtml(this.getConfigFamilyLabel(config))}</span>
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
                <span class="ensemble-lab__target-trigger-caret" aria-hidden="true">▾</span>
            `;
            dom.ensembleTargetButton.disabled = this.contextConfigs.size === 0;
            return;
        }

        dom.ensembleTargetButton.innerHTML = `
            <span class="ensemble-lab__target-trigger-main">
                <span class="ensemble-lab__target-trigger-title">${this.escapeHtml(selectedConfig.name)}</span>
                <span class="ensemble-lab__target-trigger-subtitle">${this.escapeHtml(this.getConfigFamilyLabel(selectedConfig))}</span>
            </span>
            <span class="ensemble-lab__target-trigger-caret" aria-hidden="true">▾</span>
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
        this.updateStatus(message);
    }

    private updateStatus(message: string): void {
        this.getDom().ensembleStatus.textContent = message;
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
        return `<span class="ensemble-lab__config-badge"><strong>${this.escapeHtml(label)}:</strong> ${this.escapeHtml(value)}</span>`;
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
                <span class="ensemble-lab__target-name">${this.escapeHtml(config.name)}</span>
                <span class="ensemble-lab__target-pill">Target</span>
            </div>
            <div class="ensemble-lab__target-subtitle">${this.escapeHtml(familyLabel)}</div>
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

        state.set("currentBacktestResult", null);
        state.set("twoHourParityBacktestResults", null);
        await settingsManager.applyStrategyConfig(targetArtifact.config);
        state.set("currentBacktestResultSource", "ensemble_preview");
        state.set("currentBacktestResult", preview.result);

        this.updateStatus(`Loaded exact ensemble preview: ${preview.row.rule}.`);
        uiManager.showToast(`Loaded ensemble preview: ${preview.row.rule}`, "success");
    }

    private prepareCandles(): OHLCVData[] {
        if (state.ohlcvData.length < 2) {
            return [];
        }
        return sliceOhlcvByBlock(trimToClosedCandles(state.ohlcvData, state.currentInterval), state.blockRange);
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

        dom.ensembleRunBtn.disabled = true;
        dom.ensembleRunBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running ${selectedConfigNames.length} selected configs on ${state.currentSymbol} (${state.currentInterval})...`);

        try {
            for (let index = 0; index < selectedConfigNames.length; index += 1) {
                const configName = selectedConfigNames[index];
                this.updateStatus(`Running selected config ${configName} (${index + 1}/${selectedConfigNames.length})...`);
                const artifact = await this.runConfig(configName, candles);
                if (artifact) {
                    artifacts.set(configName, artifact);
                }
                await this.yieldToUi();
            }

            for (let index = 0; index < candidateConfigNames.length; index += 1) {
                const configName = candidateConfigNames[index];
                this.updateStatus(`Preparing replacement candidate ${configName} (${index + 1}/${candidateConfigNames.length})...`);
                const artifact = await this.buildSignalArtifact(configName, candles);
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

            const contextFamilyCount = this.countDistinctFamilies(contextArtifacts);
            this.updateStatus("Evaluating ensemble rule candidates...");
            const scenario = await this.evaluateScenario(targetArtifact, contextArtifacts, candles, minSamples);
            this.updateStatus("Scoring leave-one-out context contribution...");
            const currentContextReference = this.resolveCurrentContextReference(targetArtifact, candles);
            const contributionRows = await this.buildContributionRows(
                targetArtifact,
                contextArtifacts,
                scenario,
                currentContextReference
            );
            this.updateStatus("Ranking replacement candidates...");
            const replacementRows = await this.buildReplacementRows(
                targetArtifact,
                contextArtifacts,
                scenario,
                contributionRows,
                currentContextReference,
                Array.from(candidateArtifacts.values())
            );
            const liveContext = this.buildLiveContext(
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

            this.renderResults(runContext);
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
            this.resetResultPanels();
        } finally {
            dom.ensembleRunBtn.disabled = false;
            dom.ensembleRunBtn.setAttribute("aria-busy", "false");
        }
    }

    private async buildSignalArtifact(configName: string, candles: OHLCVData[]): Promise<ConfigSignalArtifact | null> {
        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) {
            return null;
        }

        const strategy = strategyRegistry.get(config.strategyKey);
        if (!strategy) {
            debugLogger.warn(`[StrategyEnsembleLab] Strategy "${config.strategyKey}" from config "${configName}" is not registered.`);
            return null;
        }

        const params = config.strategyParams ?? strategy.defaultParams;
        const backtestSettings = resolveBacktestSettingsFromRaw(
            config.backtestSettings as unknown as BacktestSettings,
            { captureSnapshots: false, coerceWithoutUiToggles: true }
        );
        const tradeDirection = this.normalizeTradeDirection(backtestSettings);

        try {
            const rawSignals = applySignalPolarity(strategy.execute(candles, params), backtestSettings);
            const preparedSignals = prepareSignalsForScanner(candles, rawSignals, backtestSettings);
            const entrySignals = this.extractEntrySignals(preparedSignals, tradeDirection);

            return {
                config,
                strategy,
                familyKey: config.strategyKey,
                familyLabel: strategy.name,
                tradeDirection,
                rawSignals,
                preparedSignals,
                entrySignals,
                entryPresenceByTime: this.buildEntryPresenceLookup(entrySignals),
                backtestSettings,
            };
        } catch (error) {
            debugLogger.warn(`[StrategyEnsembleLab] Failed to evaluate "${configName}"`, {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private async runConfig(configName: string, candles: OHLCVData[]): Promise<ConfigRunArtifact | null> {
        const artifact = await this.buildSignalArtifact(configName, candles);
        if (!artifact) {
            return null;
        }

        try {
            const runResult = await backtestService.evaluateStrategyOnData(
                candles,
                state.currentInterval,
                artifact.strategy,
                artifact.config.strategyParams ?? artifact.strategy.defaultParams,
                artifact.backtestSettings,
                settingsManager.resolveCapitalFromConfig(artifact.config)
            );

            return {
                ...artifact,
                result: runResult.result,
                engineUsed: runResult.engineUsed,
            };
        } catch (error) {
            debugLogger.warn(`[StrategyEnsembleLab] Failed to backtest "${configName}"`, {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private normalizeTradeDirection(settings: BacktestSettings): TradeDirection {
        return settings.tradeDirection === "short"
            || settings.tradeDirection === "both"
            || settings.tradeDirection === "both_flip_loss_2"
            || settings.tradeDirection === "combined"
            ? settings.tradeDirection
            : "long";
    }

    private isBothLikeTradeDirection(tradeDirection: TradeDirection): boolean {
        return tradeDirection === "both"
            || tradeDirection === "both_flip_loss_2"
            || tradeDirection === "combined";
    }

    private extractEntrySignals(signals: Signal[], tradeDirection: TradeDirection): Signal[] {
        if (this.isBothLikeTradeDirection(tradeDirection)) {
            return signals.filter((signal) => signal.type === "buy" || signal.type === "sell");
        }

        const entryType: Signal["type"] = tradeDirection === "short" ? "sell" : "buy";
        return signals.filter((signal) => signal.type === entryType);
    }

    private buildEntryPresenceLookup(signals: Signal[]): Map<string, EnsembleEntryPresence> {
        const lookup = new Map<string, EnsembleEntryPresence>();
        for (const signal of signals) {
            const key = timeKey(signal.time);
            const existing = lookup.get(key) ?? { longEntry: false, shortEntry: false };
            if (signal.type === "buy") {
                existing.longEntry = true;
            } else if (signal.type === "sell") {
                existing.shortEntry = true;
            }
            lookup.set(key, existing);
        }
        return lookup;
    }

    private countDistinctFamilies(artifacts: ConfigSignalArtifact[]): number {
        return new Set(artifacts.map((artifact) => artifact.familyKey)).size;
    }

    private buildTradeSamples(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigSignalArtifact[]
    ): EnsembleTradeSample[] {
        return targetArtifact.result.trades.map((trade, tradeIndex) => {
            const entryTimeKey = timeKey(trade.entryTime);
            const counts = this.buildContextCountsForTimeKey(trade.type, entryTimeKey, contextArtifacts);

            return {
                tradeIndex,
                direction: trade.type,
                isWin: trade.pnl > 0,
                pnl: trade.pnl,
                pnlPercent: trade.pnlPercent,
                agreeCount: counts.agreeCount,
                opposeCount: counts.opposeCount,
            };
        });
    }

    private buildContextCountsForTimeKey(
        direction: Trade["type"],
        entryTimeKey: string,
        contextArtifacts: ConfigSignalArtifact[]
    ): ContextCounts {
        let rawAgreeCount = 0;
        let rawOpposeCount = 0;
        let rawNeutralCount = 0;
        const agreeingConfigs: string[] = [];
        const opposingConfigs: string[] = [];
        const familyVotes = new Map<string, {
            label: string;
            agreeConfigs: string[];
            opposeConfigs: string[];
        }>();

        for (const artifact of contextArtifacts) {
            const vote = this.resolveContextVote(direction, artifact.entryPresenceByTime.get(entryTimeKey));
            if (vote === "agree") {
                rawAgreeCount += 1;
                agreeingConfigs.push(artifact.config.name);
            } else if (vote === "oppose") {
                rawOpposeCount += 1;
                opposingConfigs.push(artifact.config.name);
            } else {
                rawNeutralCount += 1;
            }

            const family = familyVotes.get(artifact.familyKey) ?? {
                label: artifact.familyLabel,
                agreeConfigs: [],
                opposeConfigs: [],
            };

            if (vote === "agree") {
                family.agreeConfigs.push(artifact.config.name);
            } else if (vote === "oppose") {
                family.opposeConfigs.push(artifact.config.name);
            } else if (vote === "conflict") {
                family.agreeConfigs.push(artifact.config.name);
                family.opposeConfigs.push(artifact.config.name);
            }
            familyVotes.set(artifact.familyKey, family);
        }

        let agreeCount = 0;
        let opposeCount = 0;
        let neutralCount = 0;
        let conflictedCount = 0;
        const agreeingFamilies: string[] = [];
        const opposingFamilies: string[] = [];
        const neutralFamilies: string[] = [];
        const conflictedFamilies: string[] = [];

        for (const family of familyVotes.values()) {
            const hasAgree = family.agreeConfigs.length > 0;
            const hasOppose = family.opposeConfigs.length > 0;
            if (hasAgree && hasOppose) {
                conflictedCount += 1;
                conflictedFamilies.push(family.label);
            } else if (hasAgree) {
                agreeCount += 1;
                agreeingFamilies.push(family.label);
            } else if (hasOppose) {
                opposeCount += 1;
                opposingFamilies.push(family.label);
            } else {
                neutralCount += 1;
                neutralFamilies.push(family.label);
            }
        }

        return {
            agreeCount,
            opposeCount,
            neutralCount,
            conflictedCount,
            rawAgreeCount,
            rawOpposeCount,
            rawNeutralCount,
            agreeingConfigs,
            opposingConfigs,
            agreeingFamilies,
            opposingFamilies,
            neutralFamilies,
            conflictedFamilies,
        };
    }

    private resolveContextVote(
        direction: Trade["type"],
        presence: EnsembleEntryPresence | null | undefined
    ): "agree" | "oppose" | "neutral" | "conflict" {
        if (!presence) {
            return "neutral";
        }

        const agrees = direction === "long" ? presence.longEntry : presence.shortEntry;
        const opposes = direction === "long" ? presence.shortEntry : presence.longEntry;

        if (agrees && opposes) {
            return "conflict";
        }
        if (agrees) {
            return "agree";
        }
        if (opposes) {
            return "oppose";
        }
        return "neutral";
    }

    private buildBuckets(samples: EnsembleTradeSample[], minSamples: number): EnsembleBucketSummary[] {
        if (samples.length === 0) {
            return [];
        }

        const buckets: EnsembleBucketSummary[] = [];
        const maxAgree = Math.max(0, ...samples.map((sample) => sample.agreeCount));
        const maxOppose = Math.max(0, ...samples.map((sample) => sample.opposeCount));

        for (let agree = 0; agree <= maxAgree; agree += 1) {
            const exact = samples.filter((sample) => sample.agreeCount === agree);
            if (exact.length >= minSamples) {
                buckets.push(this.summarizeBucket(`family agree = ${agree}`, agree, exact));
            }
        }

        for (let agree = 1; agree <= maxAgree; agree += 1) {
            const cumulative = samples.filter((sample) => sample.agreeCount >= agree);
            if (cumulative.length >= minSamples) {
                buckets.push(this.summarizeBucket(`family agree >= ${agree}`, 100 + agree, cumulative));
            }
        }

        for (let oppose = 0; oppose <= maxOppose; oppose += 1) {
            const exact = samples.filter((sample) => sample.opposeCount === oppose);
            if (exact.length >= minSamples) {
                buckets.push(this.summarizeBucket(`family oppose = ${oppose}`, -1 - oppose, exact));
            }
        }

        return buckets.sort((left, right) => left.sortValue - right.sortValue);
    }

    private buildBaselineBucket(samples: EnsembleTradeSample[]): EnsembleBucketSummary | null {
        if (samples.length === 0) {
            return null;
        }
        return this.summarizeBucket("baseline (all)", -999, samples);
    }

    private summarizeBucket(
        label: string,
        sortValue: number,
        samples: EnsembleTradeSample[]
    ): EnsembleBucketSummary {
        const wins = samples.filter((sample) => sample.isWin);
        const losses = samples.filter((sample) => !sample.isWin);
        const longSamples = samples.filter((sample) => sample.direction === "long");
        const shortSamples = samples.filter((sample) => sample.direction === "short");
        const longWins = longSamples.filter((sample) => sample.isWin);
        const shortWins = shortSamples.filter((sample) => sample.isWin);

        return {
            label,
            sortValue,
            samples: samples.length,
            winRate: (wins.length / samples.length) * 100,
            lossRate: (losses.length / samples.length) * 100,
            avgExpectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
            avgNetPct: samples.reduce((sum, sample) => sum + sample.pnlPercent, 0) / samples.length,
            avgOppose: samples.reduce((sum, sample) => sum + sample.opposeCount, 0) / samples.length,
            longWinRate: longSamples.length >= 3 ? (longWins.length / longSamples.length) * 100 : null,
            shortWinRate: shortSamples.length >= 3 ? (shortWins.length / shortSamples.length) * 100 : null,
            longSamples: longSamples.length,
            shortSamples: shortSamples.length,
        };
    }

    private findBestBucket(
        buckets: EnsembleBucketSummary[],
        metric: "expectancy" | "longWinRate" | "shortWinRate"
    ): EnsembleBucketSummary | null {
        if (buckets.length === 0) {
            return null;
        }

        return buckets.reduce((best, current) => {
            const bestValue = metric === "expectancy" ? best.avgExpectancy : (best[metric] ?? Number.NEGATIVE_INFINITY);
            const currentValue = metric === "expectancy" ? current.avgExpectancy : (current[metric] ?? Number.NEGATIVE_INFINITY);
            return currentValue > bestValue ? current : best;
        });
    }

    private async evaluateScenario(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[],
        minSamples: number
    ): Promise<EnsembleScenarioEvaluation> {
        const contextFamilyCount = this.countDistinctFamilies(contextArtifacts);
        const tradeSamples = this.buildTradeSamples(targetArtifact, contextArtifacts);
        const buckets = this.buildBuckets(tradeSamples, minSamples);
        const baselineBucket = this.buildBaselineBucket(tradeSamples);
        const bestBucket = this.findBestBucket(buckets, "expectancy");
        const bestLongBucket = this.findBestBucket(
            buckets.filter((bucket) => bucket.longSamples >= minSamples),
            "longWinRate"
        );
        const bestShortBucket = this.findBestBucket(
            buckets.filter((bucket) => bucket.shortSamples >= minSamples),
            "shortWinRate"
        );
        const candidateRules = this.buildRuleCandidates(contextFamilyCount, tradeSamples, minSamples);
        const shortlistedRules = this.selectShortlistedRules(candidateRules, tradeSamples, contextFamilyCount, minSamples);
        const selectedRule = await this.selectRuleForValidation(
            shortlistedRules,
            targetArtifact,
            contextArtifacts,
            candles,
            contextFamilyCount,
            minSamples
        );
        const analysisRule = this.resolveAnalysisRule(
            selectedRule,
            shortlistedRules,
            tradeSamples,
            contextFamilyCount,
            minSamples
        );
        const builderRows = await this.buildEnsembleRows(
            targetArtifact,
            contextArtifacts,
            candles,
            contextFamilyCount,
            this.selectBuilderRules(shortlistedRules, tradeSamples, contextFamilyCount, minSamples, selectedRule),
            selectedRule
        );

        return {
            contextFamilyCount,
            tradeSamples,
            buckets,
            baselineBucket,
            bestBucket,
            bestLongBucket,
            bestShortBucket,
            builderRows: builderRows.rows,
            builderPreviewByRuleId: builderRows.previewByRuleId,
            selectedRule,
            analysisRule,
        };
    }

    private resolveScenarioPrimaryRow(builderRows: EnsembleBuilderRow[]): ScenarioPrimaryRow | null {
        const selected = builderRows.find((row) => row.selectionMode === "validated");
        if (selected) {
            return { row: selected, source: "validated", rule: null };
        }

        const trainOnly = builderRows.find((row) => row.selectionMode === "train_only");
        if (trainOnly) {
            return { row: trainOnly, source: "train_only", rule: null };
        }

        const baseline = builderRows.find((row) => row.rule === "Baseline (target only)") ?? builderRows[0] ?? null;
        return baseline
            ? { row: baseline, source: "baseline", rule: null }
            : null;
    }

    private describeScenarioPrimaryRow(primaryRow: ScenarioPrimaryRow): string {
        if (primaryRow.source === "validated") {
            return `${primaryRow.row.rule} [Validated]`;
        }
        if (primaryRow.source === "train_only") {
            return `${primaryRow.row.rule} [In-sample only]`;
        }
        if (primaryRow.source === "heuristic") {
            return `${primaryRow.row.rule} [Heuristic]`;
        }
        return "Baseline (target only)";
    }

    private resolveCurrentContextReference(
        targetArtifact: ConfigRunArtifact,
        candles: OHLCVData[]
    ): CurrentContextReference {
        const openPosition = getOpenPositionForScanner(candles, targetArtifact.rawSignals, targetArtifact.backtestSettings);
        const latestPreparedSignal = targetArtifact.entrySignals[targetArtifact.entrySignals.length - 1] ?? null;

        if (openPosition) {
            return {
                basis: "open_trade",
                direction: openPosition.direction,
                timeKey: timeKey(openPosition.entryTime),
                openPosition,
            };
        }

        if (latestPreparedSignal) {
            return {
                basis: "latest_signal",
                direction: latestPreparedSignal.type === "buy" ? "long" : "short",
                timeKey: timeKey(latestPreparedSignal.time),
                openPosition,
            };
        }

        return {
            basis: "none",
            direction: null,
            timeKey: null,
            openPosition,
        };
    }

    private resolveFamilyVoteForTimeKey(
        direction: Trade["type"],
        entryTimeKey: string,
        artifacts: ConfigSignalArtifact[]
    ): "agree" | "oppose" | "neutral" | "conflict" {
        let hasAgree = false;
        let hasOppose = false;

        for (const artifact of artifacts) {
            const vote = this.resolveContextVote(direction, artifact.entryPresenceByTime.get(entryTimeKey));
            if (vote === "agree") {
                hasAgree = true;
            } else if (vote === "oppose") {
                hasOppose = true;
            } else if (vote === "conflict") {
                hasAgree = true;
                hasOppose = true;
            }
        }

        if (hasAgree && hasOppose) {
            return "conflict";
        }
        if (hasAgree) {
            return "agree";
        }
        if (hasOppose) {
            return "oppose";
        }
        return "neutral";
    }

    private summarizeVoteProfileStats(trades: Trade[]): EnsembleVoteProfileStats | null {
        if (trades.length === 0) {
            return null;
        }

        const wins = trades.filter((trade) => trade.pnl > 0).length;
        return {
            samples: trades.length,
            winRate: (wins / trades.length) * 100,
            expectancy: trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length,
        };
    }

    private buildVoteProfile(
        targetArtifact: ConfigRunArtifact,
        familyArtifacts: ConfigRunArtifact[]
    ): EnsembleVoteProfile {
        const agreeTrades: Trade[] = [];
        const opposeTrades: Trade[] = [];
        const conflictTrades: Trade[] = [];
        const neutralTrades: Trade[] = [];

        for (const trade of targetArtifact.result.trades) {
            const vote = this.resolveFamilyVoteForTimeKey(trade.type, timeKey(trade.entryTime), familyArtifacts);
            if (vote === "agree") {
                agreeTrades.push(trade);
            } else if (vote === "oppose") {
                opposeTrades.push(trade);
            } else if (vote === "conflict") {
                conflictTrades.push(trade);
            } else {
                neutralTrades.push(trade);
            }
        }

        const totalTrades = Math.max(1, targetArtifact.result.trades.length);
        return {
            totalTrades: targetArtifact.result.trades.length,
            agreeCoverage: (agreeTrades.length / totalTrades) * 100,
            opposeCoverage: (opposeTrades.length / totalTrades) * 100,
            conflictCoverage: (conflictTrades.length / totalTrades) * 100,
            neutralCoverage: (neutralTrades.length / totalTrades) * 100,
            agreeStats: this.summarizeVoteProfileStats(agreeTrades),
            opposeStats: this.summarizeVoteProfileStats(opposeTrades),
            conflictStats: this.summarizeVoteProfileStats(conflictTrades),
            neutralStats: this.summarizeVoteProfileStats(neutralTrades),
        };
    }

    private resolveCurrentVoteLabel(
        currentContextReference: CurrentContextReference,
        familyArtifacts: ConfigSignalArtifact[]
    ): "agree" | "oppose" | "neutral" | "conflict" | "n/a" {
        if (!currentContextReference.direction || !currentContextReference.timeKey) {
            return "n/a";
        }

        return this.resolveFamilyVoteForTimeKey(
            currentContextReference.direction,
            currentContextReference.timeKey,
            familyArtifacts
        );
    }

    private async buildEnsembleRows(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[],
        contextFamilyCount: number,
        candidateRules: EnsembleRuleSpec[],
        selectedRule: EnsembleRuleSelection | null
    ): Promise<{ rows: EnsembleBuilderRow[]; previewByRuleId: Map<string, EnsembleBuilderPreview> }> {
        const baselineEvaluated = await this.runFilteredBacktest(targetArtifact, targetArtifact.preparedSignals, candles);
        const previewByRuleId = new Map<string, EnsembleBuilderPreview>();
        const baselineRuleId = "baseline";
        const baselineRow = this.buildResultRow(
            baselineRuleId,
            "Baseline (target only)",
            baselineEvaluated?.result ?? targetArtifact.result,
            targetArtifact.preparedSignals,
            baselineEvaluated?.engineUsed ?? targetArtifact.engineUsed,
            null
        );
        const rows: EnsembleBuilderRow[] = [baselineRow];
        previewByRuleId.set(baselineRuleId, {
            row: baselineRow,
            result: baselineEvaluated?.result ?? targetArtifact.result,
            filteredSignals: targetArtifact.preparedSignals,
        });

        if (contextArtifacts.length === 0 || contextFamilyCount === 0) {
            return {
                rows,
                previewByRuleId,
            };
        }

        for (const rule of candidateRules) {
            const filteredSignals = this.filterSignalsByRule(targetArtifact, contextArtifacts, contextFamilyCount, rule);
            const evaluated = await this.runFilteredBacktest(targetArtifact, filteredSignals, candles);
            if (evaluated) {
                const row = this.buildResultRow(
                    rule.id,
                    rule.label,
                    evaluated.result,
                    filteredSignals,
                    evaluated.engineUsed,
                    selectedRule?.evaluation.rule.id === rule.id ? selectedRule.mode : null
                );
                rows.push(row);
                previewByRuleId.set(rule.id, {
                    row,
                    result: evaluated.result,
                    filteredSignals,
                });
            }
            await this.yieldToUi();
        }

        return {
            rows: this.dedupeBuilderRows(rows),
            previewByRuleId,
        };
    }

    private filterSignalsByRule(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        contextFamilyCount: number,
        rule: EnsembleRuleSpec
    ): Signal[] {
        return targetArtifact.preparedSignals.filter((signal) => {
            if (!this.isTargetEntrySignal(targetArtifact, signal)) {
                return true;
            }

            const signalDirection = signal.type === "buy" ? "long" : "short";
            const counts = this.buildContextCountsForTimeKey(signalDirection, timeKey(signal.time), contextArtifacts);
            return this.rulePasses(rule, counts, contextFamilyCount);
        });
    }

    private isTargetEntrySignal(targetArtifact: ConfigRunArtifact, signal: Signal): boolean {
        if (this.isBothLikeTradeDirection(targetArtifact.tradeDirection)) {
            return signal.type === "buy" || signal.type === "sell";
        }

        const entryType: Signal["type"] = targetArtifact.tradeDirection === "short" ? "sell" : "buy";
        return signal.type === entryType;
    }

    private buildRuleCandidates(
        contextFamilyCount: number,
        tradeSamples: EnsembleTradeSample[],
        minSamples: number
    ): EnsembleRuleSpec[] {
        if (contextFamilyCount === 0) {
            return [];
        }

        const rules: EnsembleRuleSpec[] = [];

        for (let minAgree = 1; minAgree <= contextFamilyCount; minAgree += 1) {
            rules.push({
                id: `minAgree:${minAgree}`,
                label: `minFamilyAgree >= ${minAgree}`,
                minFamilyAgree: minAgree,
            });
        }

        rules.push({
            id: "veto",
            label: "Veto (no family opposition)",
            maxFamilyOppose: 0,
        });

        for (let maxOppose = 1; maxOppose <= contextFamilyCount; maxOppose += 1) {
            rules.push({
                id: `maxOppose:${maxOppose}`,
                label: `maxFamilyOppose <= ${maxOppose}`,
                maxFamilyOppose: maxOppose,
            });
        }

        const ratioThresholds = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
        for (const ratio of ratioThresholds) {
            const percent = Math.round(ratio * 100);
            rules.push({
                id: `agreePct:${percent}`,
                label: `familyAgreePct >= ${percent}%`,
                minFamilyAgreeRatio: ratio,
            });
        }

        const comboEvaluations: Array<{ rule: EnsembleRuleSpec; samples: number; expectancy: number }> = [];
        for (let minAgree = 1; minAgree <= contextFamilyCount; minAgree += 1) {
            for (let maxOppose = 0; maxOppose <= contextFamilyCount; maxOppose += 1) {
                const rule: EnsembleRuleSpec = {
                    id: `combo:${minAgree}:${maxOppose}`,
                    label: `familyAgree >= ${minAgree} + familyOppose <= ${maxOppose}`,
                    minFamilyAgree: minAgree,
                    maxFamilyOppose: maxOppose,
                };
                const matchingSamples = tradeSamples.filter((sample) => this.rulePasses(rule, sample, contextFamilyCount));
                comboEvaluations.push({
                    rule,
                    samples: matchingSamples.length,
                    expectancy: matchingSamples.length > 0
                        ? matchingSamples.reduce((sum, sample) => sum + sample.pnl, 0) / matchingSamples.length
                        : Number.NEGATIVE_INFINITY,
                });
            }
        }

        comboEvaluations
            .filter((evaluation) => evaluation.samples >= minSamples)
            .sort((left, right) => {
                if (left.expectancy !== right.expectancy) {
                    return right.expectancy - left.expectancy;
                }
                return right.samples - left.samples;
            })
            .slice(0, 12)
            .forEach((evaluation) => {
                rules.push(evaluation.rule);
            });

        return this.dedupeRuleSpecs(rules);
    }

    private buildProxyRuleEvaluation(
        rule: EnsembleRuleSpec,
        tradeSamples: EnsembleTradeSample[],
        contextFamilyCount: number
    ): ProxyRuleEvaluation {
        const filteredSamples = this.filterTradeSamplesByRule(tradeSamples, contextFamilyCount, rule);
        const proxyRow = this.buildProxyResultRowFromTradeSamples(rule.label, filteredSamples, null);

        return {
            rule,
            trades: proxyRow.trades,
            expectancy: proxyRow.expectancy,
            netProfitPercent: proxyRow.netProfitPercent,
            profitFactor: proxyRow.profitFactor,
            maxDrawdownPercent: proxyRow.maxDrawdownPercent,
        };
    }

    private resolveAnalysisRule(
        selectedRule: EnsembleRuleSelection | null,
        shortlistedRules: EnsembleRuleSpec[],
        tradeSamples: EnsembleTradeSample[],
        contextFamilyCount: number,
        minSamples: number
    ): ScenarioPrimaryRow | null {
        if (selectedRule) {
            return {
                row: this.buildProxyResultRowFromTradeSamples(
                    selectedRule.evaluation.rule.label,
                    this.filterTradeSamplesByRule(tradeSamples, contextFamilyCount, selectedRule.evaluation.rule),
                    selectedRule.mode
                ),
                source: selectedRule.mode,
                rule: selectedRule.evaluation.rule,
            };
        }

        const baselineProxy = this.buildProxyResultRowFromTradeSamples("Baseline (target only)", tradeSamples, null);
        const proxyEvaluations = shortlistedRules
            .map((rule) => this.buildProxyRuleEvaluation(rule, tradeSamples, contextFamilyCount))
            .filter((evaluation) =>
                evaluation.trades >= minSamples
                && Number.isFinite(evaluation.expectancy)
            );

        const balanceCandidate = proxyEvaluations
            .filter((evaluation) =>
                evaluation.trades >= baselineProxy.trades * 0.5
                && evaluation.expectancy >= baselineProxy.expectancy
            )
            .sort((left, right) => {
                if (left.expectancy !== right.expectancy) {
                    return right.expectancy - left.expectancy;
                }
                return right.trades - left.trades;
            })[0];

        const fallback = balanceCandidate ?? proxyEvaluations
            .slice()
            .sort((left, right) => {
                if (left.expectancy !== right.expectancy) {
                    return right.expectancy - left.expectancy;
                }
                return right.trades - left.trades;
            })[0];

        return fallback
            ? {
                row: this.buildProxyResultRowFromTradeSamples(
                    fallback.rule.label,
                    this.filterTradeSamplesByRule(tradeSamples, contextFamilyCount, fallback.rule),
                    null
                ),
                source: "heuristic",
                rule: fallback.rule,
            }
            : {
                row: baselineProxy,
                source: "baseline",
                rule: null,
            };
    }

    private selectShortlistedRules(
        candidateRules: EnsembleRuleSpec[],
        tradeSamples: EnsembleTradeSample[],
        contextFamilyCount: number,
        minSamples: number
    ): EnsembleRuleSpec[] {
        if (candidateRules.length <= StrategyEnsembleService.MAX_RULE_VALIDATION_CANDIDATES) {
            return candidateRules;
        }

        const baselineProxy = this.buildProxyResultRowFromTradeSamples("Baseline (target only)", tradeSamples, null);
        const proxyEvaluations = candidateRules
            .map((rule) => this.buildProxyRuleEvaluation(rule, tradeSamples, contextFamilyCount))
            .filter((evaluation) => evaluation.trades >= minSamples);

        const selected = new Map<string, EnsembleRuleSpec>();
        const takeTop = (
            evaluations: ProxyRuleEvaluation[],
            limit: number,
            compare: (left: ProxyRuleEvaluation, right: ProxyRuleEvaluation) => number
        ) => {
            evaluations
                .slice()
                .sort(compare)
                .slice(0, limit)
                .forEach((evaluation) => {
                    selected.set(evaluation.rule.id, evaluation.rule);
                });
        };

        takeTop(
            proxyEvaluations,
            5,
            (left, right) => {
                if (left.expectancy !== right.expectancy) {
                    return right.expectancy - left.expectancy;
                }
                return right.trades - left.trades;
            }
        );
        takeTop(
            proxyEvaluations.filter((evaluation) => Math.abs(evaluation.maxDrawdownPercent) < Math.abs(baselineProxy.maxDrawdownPercent)),
            3,
            (left, right) => Math.abs(left.maxDrawdownPercent) - Math.abs(right.maxDrawdownPercent)
        );
        takeTop(
            proxyEvaluations.filter((evaluation) => evaluation.trades >= baselineProxy.trades * 0.5),
            3,
            (left, right) => {
                if (left.expectancy !== right.expectancy) {
                    return right.expectancy - left.expectancy;
                }
                return right.trades - left.trades;
            }
        );

        const baselineLikeRules = candidateRules.filter((rule) => rule.id === "veto" || rule.id.startsWith("minAgree:1") || rule.id.startsWith("maxOppose:0"));
        for (const rule of baselineLikeRules) {
            selected.set(rule.id, rule);
        }

        return Array.from(selected.values()).slice(0, StrategyEnsembleService.MAX_RULE_VALIDATION_CANDIDATES);
    }

    private selectBuilderRules(
        shortlistedRules: EnsembleRuleSpec[],
        tradeSamples: EnsembleTradeSample[],
        contextFamilyCount: number,
        minSamples: number,
        selectedRule: EnsembleRuleSelection | null
    ): EnsembleRuleSpec[] {
        const proxyEvaluations = shortlistedRules
            .map((rule) => this.buildProxyRuleEvaluation(rule, tradeSamples, contextFamilyCount))
            .filter((evaluation) => evaluation.trades >= minSamples);
        const selected = new Map<string, EnsembleRuleSpec>();

        if (selectedRule) {
            selected.set(selectedRule.evaluation.rule.id, selectedRule.evaluation.rule);
        }

        proxyEvaluations
            .slice()
            .sort((left, right) => {
                if (left.expectancy !== right.expectancy) {
                    return right.expectancy - left.expectancy;
                }
                return right.trades - left.trades;
            })
            .slice(0, StrategyEnsembleService.MAX_RULE_BUILDER_ROWS)
            .forEach((evaluation) => {
                selected.set(evaluation.rule.id, evaluation.rule);
            });

        return Array.from(selected.values());
    }

    private async runFilteredBacktest(
        targetArtifact: ConfigRunArtifact,
        signals: Signal[],
        candles: OHLCVData[]
    ): Promise<{ result: BacktestResult; engineUsed: "rust" | "typescript" } | null> {
        if (signals.length < 2) {
            return null;
        }

        try {
            return await backtestService.evaluateSignalsOnData(
                candles,
                state.currentInterval,
                signals,
                targetArtifact.backtestSettings,
                settingsManager.resolveCapitalFromConfig(targetArtifact.config)
            );
        } catch (error) {
            debugLogger.warn("[StrategyEnsembleLab] Filtered backtest failed", {
                config: targetArtifact.config.name,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private buildResultRow(
        ruleId: string,
        rule: string,
        result: BacktestResult,
        signals: Signal[],
        engineUsed: "rust" | "typescript",
        selectionMode: "validated" | "train_only" | null
    ): EnsembleBuilderRow {
        return {
            ruleId,
            rule,
            signals: signals.length,
            trades: result.totalTrades,
            winRate: result.winRate,
            netProfitPercent: result.netProfitPercent,
            expectancy: result.expectancy,
            profitFactor: result.profitFactor,
            maxDrawdownPercent: result.maxDrawdownPercent,
            engineUsed,
            selectionMode,
        };
    }

    private rulePasses(rule: EnsembleRuleSpec, counts: RuleCounts, contextFamilyCount: number): boolean {
        if (typeof rule.minFamilyAgree === "number" && counts.agreeCount < rule.minFamilyAgree) {
            return false;
        }
        if (typeof rule.maxFamilyOppose === "number" && counts.opposeCount > rule.maxFamilyOppose) {
            return false;
        }
        if (typeof rule.minFamilyAgreeRatio === "number") {
            if (contextFamilyCount <= 0) {
                return false;
            }
            if ((counts.agreeCount / contextFamilyCount) < rule.minFamilyAgreeRatio) {
                return false;
            }
        }
        return true;
    }

    private filterTradeSamplesByRule(
        tradeSamples: EnsembleTradeSample[],
        contextFamilyCount: number,
        rule: EnsembleRuleSpec | null
    ): EnsembleTradeSample[] {
        if (!rule) {
            return tradeSamples.slice();
        }

        return tradeSamples.filter((sample) => this.rulePasses(rule, sample, contextFamilyCount));
    }

    private computeApproximateMaxDrawdownPercent(samples: EnsembleTradeSample[]): number {
        if (samples.length === 0) {
            return 0;
        }

        let cumulative = 0;
        let peak = 0;
        let maxDrawdown = 0;

        for (const sample of samples) {
            cumulative += sample.pnlPercent;
            if (cumulative > peak) {
                peak = cumulative;
            }
            const drawdown = peak - cumulative;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }

        return -maxDrawdown;
    }

    private buildProxyResultRowFromTradeSamples(
        label: string,
        tradeSamples: EnsembleTradeSample[],
        selectionMode: "validated" | "train_only" | null
    ): EnsembleBuilderRow {
        const wins = tradeSamples.filter((sample) => sample.pnl > 0);
        const losses = tradeSamples.filter((sample) => sample.pnl < 0);
        const grossProfit = wins.reduce((sum, sample) => sum + sample.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((sum, sample) => sum + sample.pnl, 0));
        const totalPnl = tradeSamples.reduce((sum, sample) => sum + sample.pnl, 0);
        const totalNetPct = tradeSamples.reduce((sum, sample) => sum + sample.pnlPercent, 0);

        return {
            ruleId: `proxy:${label}`,
            rule: label,
            signals: tradeSamples.length,
            trades: tradeSamples.length,
            winRate: tradeSamples.length > 0 ? (wins.length / tradeSamples.length) * 100 : 0,
            netProfitPercent: totalNetPct,
            expectancy: tradeSamples.length > 0 ? totalPnl / tradeSamples.length : 0,
            profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
            maxDrawdownPercent: this.computeApproximateMaxDrawdownPercent(tradeSamples),
            engineUsed: "typescript",
            selectionMode,
        };
    }

    private splitCandles(candles: OHLCVData[]): { train: OHLCVData[]; validation: OHLCVData[] } {
        if (candles.length < 2) {
            return { train: candles.slice(), validation: [] };
        }

        const splitIndex = Math.min(candles.length - 1, Math.max(1, Math.floor(candles.length * 0.7)));
        return {
            train: candles.slice(0, splitIndex),
            validation: candles.slice(splitIndex),
        };
    }

    private filterSignalsToCandles(signals: Signal[], candles: OHLCVData[]): Signal[] {
        if (signals.length === 0 || candles.length === 0) {
            return [];
        }

        const keys = new Set(candles.map((candle) => timeKey(candle.time)));
        return signals.filter((signal) => keys.has(timeKey(signal.time)));
    }

    private async evaluateRuleOnBacktests(
        rule: EnsembleRuleSpec,
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[],
        contextFamilyCount: number,
        minSamples: number
    ): Promise<EnsembleRuleEvaluation | null> {
        const filteredSignals = this.filterSignalsByRule(targetArtifact, contextArtifacts, contextFamilyCount, rule);
        const fullResult = await this.runFilteredBacktest(targetArtifact, filteredSignals, candles);
        if (!fullResult) {
            return null;
        }

        const { train, validation } = this.splitCandles(candles);
        const baselineTrainSignals = this.filterSignalsToCandles(targetArtifact.preparedSignals, train);
        const baselineValidationSignals = this.filterSignalsToCandles(targetArtifact.preparedSignals, validation);
        const filteredTrainSignals = this.filterSignalsToCandles(filteredSignals, train);
        const filteredValidationSignals = this.filterSignalsToCandles(filteredSignals, validation);

        const [baselineTrain, baselineValidation, filteredTrain, filteredValidation] = await Promise.all([
            this.runFilteredBacktest(targetArtifact, baselineTrainSignals, train),
            this.runFilteredBacktest(targetArtifact, baselineValidationSignals, validation),
            this.runFilteredBacktest(targetArtifact, filteredTrainSignals, train),
            this.runFilteredBacktest(targetArtifact, filteredValidationSignals, validation),
        ]);

        const trainTrades = filteredTrain?.result.totalTrades ?? 0;
        const validationTrades = filteredValidation?.result.totalTrades ?? 0;
        const trainExpectancy = filteredTrain?.result.expectancy ?? Number.NEGATIVE_INFINITY;
        const validationExpectancy = filteredValidation?.result.expectancy ?? Number.NEGATIVE_INFINITY;

        return {
            rule,
            trainSamples: trainTrades,
            trainExpectancy,
            validationSamples: validationTrades,
            validationExpectancy,
            fullTrades: fullResult.result.totalTrades,
            fullExpectancy: fullResult.result.expectancy,
            validated: trainTrades >= minSamples
                && validationTrades >= minSamples
                && trainExpectancy >= (baselineTrain?.result.expectancy ?? Number.POSITIVE_INFINITY)
                && validationExpectancy >= (baselineValidation?.result.expectancy ?? Number.POSITIVE_INFINITY)
                && fullResult.result.totalTrades >= minSamples,
        };
    }

    private async selectRuleForValidation(
        candidateRules: EnsembleRuleSpec[],
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[],
        contextFamilyCount: number,
        minSamples: number
    ): Promise<EnsembleRuleSelection | null> {
        const evaluations: EnsembleRuleEvaluation[] = [];
        for (let index = 0; index < candidateRules.length; index += 1) {
            const evaluation = await this.evaluateRuleOnBacktests(
                candidateRules[index],
                targetArtifact,
                contextArtifacts,
                candles,
                contextFamilyCount,
                minSamples
            );
            if (evaluation) {
                evaluations.push(evaluation);
            }
            await this.yieldToUi();
        }
        return selectEnsembleRuleSelection(evaluations, minSamples);
    }

    private dedupeRuleSpecs(rules: EnsembleRuleSpec[]): EnsembleRuleSpec[] {
        const seen = new Set<string>();
        const deduped: EnsembleRuleSpec[] = [];

        for (const rule of rules) {
            if (seen.has(rule.id)) {
                continue;
            }
            seen.add(rule.id);
            deduped.push(rule);
        }

        return deduped;
    }

    private dedupeBuilderRows(rows: EnsembleBuilderRow[]): EnsembleBuilderRow[] {
        const seen = new Set<string>();
        const deduped: EnsembleBuilderRow[] = [];

        for (const row of rows) {
            const signature = [
                row.signals,
                row.trades,
                row.winRate.toFixed(6),
                row.netProfitPercent.toFixed(6),
                row.expectancy.toFixed(6),
                row.profitFactor === Infinity ? "INF" : row.profitFactor.toFixed(6),
                row.maxDrawdownPercent.toFixed(6),
                row.engineUsed,
                row.selectionMode ?? "",
            ].join("|");

            if (seen.has(signature)) {
                continue;
            }

            seen.add(signature);
            deduped.push(row);
        }

        return deduped;
    }

    private groupArtifactsByFamily<T extends ConfigSignalArtifact>(artifacts: T[]): Map<string, T[]> {
        const grouped = new Map<string, T[]>();

        for (const artifact of artifacts) {
            const existing = grouped.get(artifact.familyKey);
            if (existing) {
                existing.push(artifact);
            } else {
                grouped.set(artifact.familyKey, [artifact]);
            }
        }

        return grouped;
    }

    private async buildContributionRows(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        baseScenario: EnsembleScenarioEvaluation,
        currentContextReference: CurrentContextReference
    ): Promise<EnsembleContributionRow[]> {
        const basePrimaryRow = baseScenario.analysisRule;
        if (!basePrimaryRow) {
            return [];
        }

        const activeRule = basePrimaryRow.rule;
        const familyGroups = this.groupArtifactsByFamily(contextArtifacts);
        const rows: EnsembleContributionRow[] = [];
        const entries = Array.from(familyGroups.entries());

        for (let index = 0; index < entries.length; index += 1) {
            const [familyKey, familyArtifacts] = entries[index];
            this.updateStatus(`Scoring leave-one-out family ${index + 1}/${entries.length}: ${familyArtifacts[0]?.familyLabel ?? familyKey}...`);
            const reducedArtifacts = contextArtifacts.filter((artifact) => artifact.familyKey !== familyKey);
            const reducedTradeSamples = this.buildTradeSamples(targetArtifact, reducedArtifacts);
            const reducedContextFamilyCount = this.countDistinctFamilies(reducedArtifacts);
            const filteredSamples = this.filterTradeSamplesByRule(reducedTradeSamples, reducedContextFamilyCount, activeRule);
            const primaryRow: ScenarioPrimaryRow = {
                row: this.buildProxyResultRowFromTradeSamples(basePrimaryRow.row.rule, filteredSamples, null),
                source: basePrimaryRow.source,
                rule: activeRule,
            };

            rows.push({
                familyKey,
                familyLabel: familyArtifacts[0]?.familyLabel ?? familyKey,
                configNames: familyArtifacts.map((artifact) => artifact.config.name),
                currentVote: this.resolveCurrentVoteLabel(currentContextReference, familyArtifacts),
                voteProfile: this.buildVoteProfile(targetArtifact, familyArtifacts),
                primaryRow,
                deltaExpectancy: primaryRow.row.expectancy - basePrimaryRow.row.expectancy,
                deltaWinRate: primaryRow.row.winRate - basePrimaryRow.row.winRate,
                tradeRetentionPercent: basePrimaryRow.row.trades > 0
                    ? (primaryRow.row.trades / basePrimaryRow.row.trades) * 100
                    : 0,
                deltaTrades: primaryRow.row.trades - basePrimaryRow.row.trades,
            });
            await this.yieldToUi();
        }

        return rows.sort((left, right) => {
            if (left.deltaExpectancy !== right.deltaExpectancy) {
                return right.deltaExpectancy - left.deltaExpectancy;
            }
            if (left.deltaWinRate !== right.deltaWinRate) {
                return right.deltaWinRate - left.deltaWinRate;
            }
            return left.familyLabel.localeCompare(right.familyLabel);
        });
    }

    private async buildReplacementRows(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        baseScenario: EnsembleScenarioEvaluation,
        contributionRows: EnsembleContributionRow[],
        currentContextReference: CurrentContextReference,
        candidateArtifacts: ConfigSignalArtifact[]
    ): Promise<EnsembleReplacementRow[]> {
        const basePrimaryRow = this.resolveScenarioPrimaryRow(baseScenario.builderRows);
        if (!basePrimaryRow) {
            return [];
        }

        const activeRule = baseScenario.analysisRule?.rule ?? null;
        const worstContributor = contributionRows.find((row) => row.deltaExpectancy > 0) ?? null;
        const replacementBaseArtifacts = worstContributor
            ? contextArtifacts.filter((artifact) => artifact.familyKey !== worstContributor.familyKey)
            : contextArtifacts;
        const replacementBaseTradeSamples = worstContributor
            ? this.buildTradeSamples(targetArtifact, replacementBaseArtifacts)
            : baseScenario.tradeSamples;
        const replacementBaseContextFamilyCount = this.countDistinctFamilies(replacementBaseArtifacts);
        const replacementBaseFilteredSamples = this.filterTradeSamplesByRule(
            replacementBaseTradeSamples,
            replacementBaseContextFamilyCount,
            activeRule
        );
        const replacementBasePrimaryRow: ScenarioPrimaryRow = {
            row: this.buildProxyResultRowFromTradeSamples(
                basePrimaryRow.row.rule,
                replacementBaseFilteredSamples,
                null
            ),
            source: basePrimaryRow.source,
            rule: activeRule,
        };

        const replacementBaseFamilyKeys = new Set(contextArtifacts.map((artifact) => artifact.familyKey));
        const groupedCandidates = this.groupArtifactsByFamily(
            candidateArtifacts.filter((artifact) => !replacementBaseFamilyKeys.has(artifact.familyKey))
        );
        const familyBestRows = new Map<string, EnsembleReplacementRow>();
        const entries = Array.from(groupedCandidates.entries());

        for (let index = 0; index < entries.length; index += 1) {
            const [familyKey, artifactsInFamily] = entries[index];
            const familyLabel = artifactsInFamily[0]?.familyLabel ?? familyKey;
            this.updateStatus(`Ranking replacement family ${index + 1}/${entries.length}: ${familyLabel}...`);

            for (const candidateArtifact of artifactsInFamily) {
                const candidateTradeSamples = this.buildTradeSamples(
                    targetArtifact,
                    [...replacementBaseArtifacts, candidateArtifact]
                );
                const candidateContextFamilyCount = this.countDistinctFamilies([...replacementBaseArtifacts, candidateArtifact]);
                const candidateFilteredSamples = this.filterTradeSamplesByRule(
                    candidateTradeSamples,
                    candidateContextFamilyCount,
                    activeRule
                );
                const primaryRow: ScenarioPrimaryRow = {
                    row: this.buildProxyResultRowFromTradeSamples(
                        basePrimaryRow.row.rule,
                        candidateFilteredSamples,
                        null
                    ),
                    source: basePrimaryRow.source,
                    rule: activeRule,
                };

                const row: EnsembleReplacementRow = {
                    familyKey,
                    familyLabel,
                    configName: candidateArtifact.config.name,
                    currentVote: this.resolveCurrentVoteLabel(currentContextReference, [candidateArtifact]),
                    primaryRow,
                    deltaExpectancyVsRemoved: primaryRow.row.expectancy - replacementBasePrimaryRow.row.expectancy,
                    deltaExpectancyVsCurrent: primaryRow.row.expectancy - basePrimaryRow.row.expectancy,
                    deltaWinRateVsCurrent: primaryRow.row.winRate - basePrimaryRow.row.winRate,
                    tradeRetentionPercent: basePrimaryRow.row.trades > 0
                        ? (primaryRow.row.trades / basePrimaryRow.row.trades) * 100
                        : 0,
                    deltaTradesVsCurrent: primaryRow.row.trades - basePrimaryRow.row.trades,
                };

                const bestExisting = familyBestRows.get(familyKey);
                if (!bestExisting) {
                    familyBestRows.set(familyKey, row);
                    continue;
                }

                if (row.deltaExpectancyVsRemoved !== bestExisting.deltaExpectancyVsRemoved) {
                    if (row.deltaExpectancyVsRemoved > bestExisting.deltaExpectancyVsRemoved) {
                        familyBestRows.set(familyKey, row);
                    }
                    continue;
                }

                if (row.deltaWinRateVsCurrent > bestExisting.deltaWinRateVsCurrent) {
                    familyBestRows.set(familyKey, row);
                }
            }
            await this.yieldToUi();
        }

        return Array.from(familyBestRows.values()).sort((left, right) => {
            if (left.deltaExpectancyVsRemoved !== right.deltaExpectancyVsRemoved) {
                return right.deltaExpectancyVsRemoved - left.deltaExpectancyVsRemoved;
            }
            if (left.deltaWinRateVsCurrent !== right.deltaWinRateVsCurrent) {
                return right.deltaWinRateVsCurrent - left.deltaWinRateVsCurrent;
            }
            return left.familyLabel.localeCompare(right.familyLabel);
        }).slice(0, StrategyEnsembleService.MAX_REPLACEMENT_ROWS);
    }

    private buildLiveContext(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[],
        tradeSamples: EnsembleTradeSample[],
        minSamples: number
    ): EnsembleLiveContext {
        const currentContextReference = this.resolveCurrentContextReference(targetArtifact, candles);
        const contextFamilyCount = this.countDistinctFamilies(contextArtifacts);

        if (!currentContextReference.direction || !currentContextReference.timeKey) {
            return {
                basis: "none",
                direction: null,
                agreeCount: 0,
                opposeCount: 0,
                neutralCount: contextFamilyCount,
                conflictedCount: 0,
                rawAgreeCount: 0,
                rawOpposeCount: 0,
                rawNeutralCount: contextArtifacts.length,
                agreeingConfigs: [],
                opposingConfigs: [],
                agreeingFamilies: [],
                opposingFamilies: [],
                neutralFamilies: [],
                conflictedFamilies: [],
                odds: null,
                openPosition: currentContextReference.openPosition,
            };
        }

        const counts = this.buildContextCountsForTimeKey(
            currentContextReference.direction,
            currentContextReference.timeKey,
            contextArtifacts
        );
        const matchingSamples = tradeSamples.filter(
            (sample) => sample.direction === currentContextReference.direction
                && sample.agreeCount === counts.agreeCount
                && sample.opposeCount === counts.opposeCount
        );

        let odds: EnsembleLiveContext["odds"] = null;
        if (matchingSamples.length >= Math.max(3, minSamples)) {
            const wins = matchingSamples.filter((sample) => sample.isWin).length;
            odds = {
                sampleCount: matchingSamples.length,
                winRate: (wins / matchingSamples.length) * 100,
                lossRate: 100 - (wins / matchingSamples.length) * 100,
                expectancy: matchingSamples.reduce((sum, sample) => sum + sample.pnl, 0) / matchingSamples.length,
                label: `${currentContextReference.direction} | familyAgree=${counts.agreeCount}, familyOppose=${counts.opposeCount}`,
                matchType: "exact",
            };
        } else {
            odds = this.findNearestContextOdds(
                tradeSamples,
                currentContextReference.direction,
                counts.agreeCount,
                counts.opposeCount,
                minSamples
            );
        }

        return {
            basis: currentContextReference.basis,
            direction: currentContextReference.direction,
            agreeCount: counts.agreeCount,
            opposeCount: counts.opposeCount,
            neutralCount: counts.neutralCount,
            conflictedCount: counts.conflictedCount,
            rawAgreeCount: counts.rawAgreeCount,
            rawOpposeCount: counts.rawOpposeCount,
            rawNeutralCount: counts.rawNeutralCount,
            agreeingConfigs: counts.agreeingConfigs,
            opposingConfigs: counts.opposingConfigs,
            agreeingFamilies: counts.agreeingFamilies,
            opposingFamilies: counts.opposingFamilies,
            neutralFamilies: counts.neutralFamilies,
            conflictedFamilies: counts.conflictedFamilies,
            odds,
            openPosition: currentContextReference.openPosition,
        };
    }

    private findNearestContextOdds(
        samples: EnsembleTradeSample[],
        direction: Trade["type"],
        agreeCount: number,
        opposeCount: number,
        minSamples: number
    ): EnsembleLiveContext["odds"] {
        const grouped = new Map<string, EnsembleTradeSample[]>();

        for (const sample of samples) {
            if (sample.direction !== direction) {
                continue;
            }
            const key = `${sample.agreeCount}|${sample.opposeCount}`;
            const bucket = grouped.get(key);
            if (bucket) {
                bucket.push(sample);
            } else {
                grouped.set(key, [sample]);
            }
        }

        let best:
            | {
                agreeCount: number;
                opposeCount: number;
                samples: EnsembleTradeSample[];
                distance: number;
            }
            | null = null;

        for (const [key, bucket] of grouped.entries()) {
            if (bucket.length < Math.max(3, minSamples)) {
                continue;
            }
            const [bucketAgreeRaw, bucketOpposeRaw] = key.split("|");
            const bucketAgree = Number.parseInt(bucketAgreeRaw, 10);
            const bucketOppose = Number.parseInt(bucketOpposeRaw, 10);
            const distance = Math.abs(bucketAgree - agreeCount) + Math.abs(bucketOppose - opposeCount);

            if (!best) {
                best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
                continue;
            }

            if (distance !== best.distance) {
                if (distance < best.distance) {
                    best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
                }
                continue;
            }

            if (bucket.length > best.samples.length) {
                best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
            }
        }

        if (!best) {
            return null;
        }

        const wins = best.samples.filter((sample) => sample.isWin).length;
        return {
            sampleCount: best.samples.length,
            winRate: (wins / best.samples.length) * 100,
            lossRate: 100 - (wins / best.samples.length) * 100,
            expectancy: best.samples.reduce((sum, sample) => sum + sample.pnl, 0) / best.samples.length,
            label: `${direction} | familyAgree=${best.agreeCount}, familyOppose=${best.opposeCount}`,
            matchType: "nearest",
        };
    }

    private buildRadarFindings(context: EnsembleRunContext): RadarFinding[] {
        const findings: RadarFinding[] = [];
        const baseline = context.baselineBucket;
        const radarMinSamples = Math.max(context.minSamples * 3, 20);

        if (!baseline) {
            return [
                {
                    label: "No actionable findings",
                    detail: "The ensemble analysis did not produce enough target trades for higher-confidence signals.",
                    quality: "neutral",
                },
            ];
        }

        if (context.bestBucket && context.bestBucket.samples >= radarMinSamples && baseline.avgExpectancy !== 0) {
            const lift = ((context.bestBucket.avgExpectancy - baseline.avgExpectancy) / Math.abs(baseline.avgExpectancy)) * 100;
            if (Number.isFinite(lift) && lift > 10) {
                findings.push({
                    label: "Strongest expectancy lift",
                    detail: `"${context.bestBucket.label}" improves expectancy by ${lift.toFixed(1)}% vs baseline (${context.bestBucket.samples} samples).`,
                    quality: "positive",
                });
            }
        }

        const worstContributor = context.contributionRows.find((row) => row.deltaExpectancy > 0);
        if (worstContributor && Math.abs(worstContributor.deltaExpectancy) >= 0.1) {
            findings.push({
                label: "Weakest context family",
                detail: `Removing "${worstContributor.familyLabel}" improves active-rule expectancy by ${this.formatSignedCurrency(worstContributor.deltaExpectancy)}.`,
                quality: "negative",
            });
        }

        const bestReplacement = context.replacementRows[0];
        if (bestReplacement && bestReplacement.deltaExpectancyVsRemoved > 0) {
            findings.push({
                label: "Replacement candidate",
                detail: `"${bestReplacement.familyLabel}" via "${bestReplacement.configName}" adds ${this.formatSignedCurrency(bestReplacement.deltaExpectancyVsRemoved)} expectancy after removing the weakest family.`,
                quality: "positive",
            });
        }

        const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)");
        const bestDrawdownRow = context.builderRows
            .filter((row) => row.rule !== "Baseline (target only)" && row.trades >= radarMinSamples)
            .sort((left, right) => Math.abs(left.maxDrawdownPercent) - Math.abs(right.maxDrawdownPercent))[0];
        if (baselineRow && bestDrawdownRow && Math.abs(bestDrawdownRow.maxDrawdownPercent) < Math.abs(baselineRow.maxDrawdownPercent) * 0.8) {
            const reduction = ((Math.abs(baselineRow.maxDrawdownPercent) - Math.abs(bestDrawdownRow.maxDrawdownPercent)) / Math.abs(baselineRow.maxDrawdownPercent)) * 100;
            findings.push({
                label: "Strongest drawdown reduction",
                detail: `"${bestDrawdownRow.rule}" reduces max drawdown by ${reduction.toFixed(1)}% vs baseline.`,
                quality: "positive",
            });
        }

        const trapBucket = context.buckets.find((bucket) => bucket.label.startsWith("family agree >=") && bucket.avgExpectancy < 0 && bucket.samples >= radarMinSamples);
        if (trapBucket) {
            findings.push({
                label: "Consensus trap",
                detail: `"${trapBucket.label}" still has negative expectancy ($${trapBucket.avgExpectancy.toFixed(2)}). High agreement is not always good.`,
                quality: "negative",
            });
        }

        const rareBucket = context.buckets.find((bucket) =>
            bucket.samples >= radarMinSamples
            && bucket.samples <= baseline.samples * 0.15
            && bucket.winRate > baseline.winRate + 15
            && bucket.avgExpectancy > 0
        );
        if (rareBucket) {
            findings.push({
                label: "Rare high-value bucket",
                detail: `"${rareBucket.label}" is low frequency (${rareBucket.samples} trades) but materially outperforms baseline.`,
                quality: "positive",
            });
        }

        const oppositionBucket = context.buckets.find((bucket) => {
            if (!bucket.label.startsWith("family oppose = ")) {
                return false;
            }
            const opposeValue = Number.parseInt(bucket.label.replace("family oppose = ", ""), 10);
            return opposeValue >= 2 && bucket.avgExpectancy > 0 && bucket.samples >= radarMinSamples;
        });
        if (oppositionBucket) {
            findings.push({
                label: "Opposition still profitable",
                detail: `"${oppositionBucket.label}" remains positive expectancy ($${oppositionBucket.avgExpectancy.toFixed(2)}). Opposition does not automatically invalidate the target.`,
                quality: "neutral",
            });
        }

        if (findings.length === 0) {
            findings.push({
                label: "No strong anomaly found",
                detail: "The current config set did not surface a strong consensus edge or trap from the available data.",
                quality: "neutral",
            });
        }

        return findings;
    }

    private renderResults(context: EnsembleRunContext): void {
        renderStrategyEnsembleResults({
            resetResultPanels: () => this.resetResultPanels(),
            renderSummary: (nextContext) => this.renderSummary(nextContext),
            renderCurrentContext: (nextContext) => this.renderCurrentContext(nextContext),
            renderBuilder: (nextContext) => this.renderBuilder(nextContext),
            renderHistoricalOdds: (nextContext) => this.renderHistoricalOdds(nextContext),
            renderContribution: (nextContext) => this.renderContribution(nextContext),
            renderReplacement: (nextContext) => this.renderReplacement(nextContext),
            renderRadar: (nextContext) => this.renderRadar(nextContext),
            card: (label, value) => this.card(label, value),
        }, this.getDom(), context);
    }

    private resetResultPanels(): void {
        const dom = this.getDom();
        dom.ensembleResults.style.display = "none";
        dom.ensembleCurrentContextSection.style.display = "none";
        dom.ensembleBuilderSection.style.display = "none";
        dom.ensembleHistoricalOddsSection.style.display = "none";
        dom.ensembleDiagnosticsSection.style.display = "none";
        dom.ensembleDiagnosticsSection.open = false;
        dom.ensembleContributionSection.style.display = "none";
        dom.ensembleReplacementSection.style.display = "none";
        dom.ensembleRadarSection.style.display = "none";

        dom.ensembleSummary.innerHTML = "";
        dom.ensembleCurrentContextSummary.innerHTML = "";
        dom.ensembleCurrentContextDetails.innerHTML = "";
        dom.ensembleHistoricalOddsSummary.innerHTML = "";
        dom.ensembleHistoricalOddsTableBody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Strategy Ensemble Lab to calculate conditional outcome probabilities.
                </td>
            </tr>
        `;
        dom.ensembleBuilderSummary.innerHTML = "";
        dom.ensembleBuilderTableBody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Strategy Ensemble Lab to compare ensemble filtering rules.
                </td>
            </tr>
        `;
        dom.ensembleContributionSummary.innerHTML = "";
        dom.ensembleContributionTableBody.innerHTML = `
            <tr>
                <td colspan="12" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Strategy Ensemble Lab to identify helpful and harmful context families.
                </td>
            </tr>
        `;
        dom.ensembleReplacementSummary.innerHTML = "";
        dom.ensembleReplacementTableBody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Strategy Ensemble Lab to rank candidate replacements for the weakest context family.
                </td>
            </tr>
        `;
        dom.ensembleRadarContent.innerHTML = "";
    }

    private renderSummary(context: EnsembleRunContext): void {
        const targetResult = context.targetArtifact.result;
        this.getDom().ensembleSummary.innerHTML = [
            this.card("Target Config", context.targetConfigName),
            this.card("Strategy", context.targetArtifact.strategy.name),
            this.card("Context Configs", String(context.contextConfigNames.length)),
            this.card("Context Families", String(context.contextFamilyCount)),
            this.card("Target Trades", String(targetResult.totalTrades)),
            this.card("Win Rate", `${targetResult.winRate.toFixed(1)}%`),
            this.card("Expectancy", `$${targetResult.expectancy.toFixed(2)}`),
            this.card("Net %", `${targetResult.netProfitPercent.toFixed(2)}%`),
            this.card("Engine", context.targetArtifact.engineUsed),
        ].join("");
    }

    private renderCurrentContext(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const liveContext = context.liveContext;

        if (liveContext.basis === "none" || !liveContext.direction) {
            dom.ensembleCurrentContextSummary.innerHTML = this.card("Status", "No actionable current context");
            dom.ensembleCurrentContextDetails.innerHTML = '<div class="portfolio-lab__insight">The target config has no open trade and no latest actionable signal on the loaded closed-candle window.</div>';
            return;
        }

        const cards = [
            this.card("Basis", liveContext.basis === "open_trade" ? "Open trade" : "Latest signal"),
            this.card("Direction", liveContext.direction === "long" ? "Long" : "Short"),
            this.card("Family Agree", String(liveContext.agreeCount)),
            this.card("Family Oppose", String(liveContext.opposeCount)),
            this.card("Neutral Families", String(liveContext.neutralCount)),
            this.card("Conflicted Families", String(liveContext.conflictedCount)),
        ];

        if (liveContext.openPosition) {
            cards.push(this.card("Bars In Trade", String(liveContext.openPosition.barsInTrade)));
            cards.push(this.card("uPnL %", `${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}%`));
        }
        if (liveContext.odds) {
            cards.push(this.card("Historical Win Rate", `${liveContext.odds.winRate.toFixed(1)}%`));
            cards.push(this.card("Historical Expectancy", `$${liveContext.odds.expectancy.toFixed(2)}`));
        }
        const recommendation = this.resolveLiveRecommendation(context, liveContext);
        if (recommendation) {
            cards.push(this.card("Recommended Filter", recommendation.summary));
        }

        dom.ensembleCurrentContextSummary.innerHTML = cards.join("");

        const details: string[] = [];
        details.push(
            `<div class="portfolio-lab__insight">Raw config votes: agree=${liveContext.rawAgreeCount}, oppose=${liveContext.rawOpposeCount}, neutral=${liveContext.rawNeutralCount}. Family votes: agree=${liveContext.agreeCount}, oppose=${liveContext.opposeCount}, neutral=${liveContext.neutralCount}, conflicted=${liveContext.conflictedCount}.</div>`
        );
        if (liveContext.agreeingFamilies.length > 0) {
            details.push(`<div class="portfolio-lab__insight positive">Agreeing families: <strong>${this.escapeHtml(liveContext.agreeingFamilies.join(", "))}</strong></div>`);
        }
        if (liveContext.opposingFamilies.length > 0) {
            details.push(`<div class="portfolio-lab__insight negative">Opposing families: <strong>${this.escapeHtml(liveContext.opposingFamilies.join(", "))}</strong></div>`);
        }
        if (liveContext.conflictedFamilies.length > 0) {
            details.push(`<div class="portfolio-lab__insight">Conflicted families: <strong>${this.escapeHtml(liveContext.conflictedFamilies.join(", "))}</strong></div>`);
        }
        if (liveContext.agreeingConfigs.length > 0) {
            details.push(`<div class="portfolio-lab__insight positive">Agreeing configs: <strong>${this.escapeHtml(liveContext.agreeingConfigs.join(", "))}</strong></div>`);
        }
        if (liveContext.opposingConfigs.length > 0) {
            details.push(`<div class="portfolio-lab__insight negative">Opposing configs: <strong>${this.escapeHtml(liveContext.opposingConfigs.join(", "))}</strong></div>`);
        }
        if (liveContext.odds) {
            details.push(
                `<div class="portfolio-lab__insight">Historical ${liveContext.odds.matchType === "exact" ? "odds" : "nearest-bucket odds"} for <strong>${this.escapeHtml(liveContext.odds.label)}</strong>: ${liveContext.odds.winRate.toFixed(1)}% win rate, $${liveContext.odds.expectancy.toFixed(2)} expectancy, ${liveContext.odds.sampleCount} samples.</div>`
            );
        } else {
            details.push('<div class="portfolio-lab__insight">No exact or nearby historical bucket met the minimum sample threshold for the current context.</div>');
        }
        if (recommendation) {
            details.push(`<div class="portfolio-lab__insight ${recommendation.passes ? "positive" : "negative"}">${this.escapeHtml(recommendation.detail)}</div>`);
        }

        dom.ensembleCurrentContextDetails.innerHTML = details.join("");
    }

    private resolveLiveRecommendation(
        context: EnsembleRunContext,
        liveContext: EnsembleLiveContext
    ): { summary: string; detail: string; passes: boolean } | null {
        const selected = context.selectedRule;
        if (!selected) {
            return null;
        }

        const evaluation = this.rulePasses(selected.evaluation.rule, liveContext, context.contextFamilyCount);
        const validationLabel = selected.mode === "validated" ? "Validated" : "In-sample only";
        const validationDetail = selected.mode === "validated"
            ? `Validated on the held-out trade sample with ${selected.evaluation.validationSamples} validation trades.`
            : `No rule cleared validation. This is the strongest training-only candidate with ${selected.evaluation.trainSamples} training trades.`;

        return {
            summary: `${validationLabel}: ${selected.evaluation.rule.label} (${evaluation ? "PASS" : "BLOCK"})`,
            detail: `${validationDetail} Current context ${evaluation ? "passes" : "fails"} because familyAgree=${liveContext.agreeCount}, familyOppose=${liveContext.opposeCount}.`,
            passes: evaluation,
        };
    }

    private renderHistoricalOdds(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const rows = [context.baselineBucket, ...context.buckets].filter(
            (bucket): bucket is EnsembleBucketSummary => bucket !== null
        );

        if (rows.length === 0) {
            dom.ensembleHistoricalOddsSummary.innerHTML = this.card("Status", "No qualifying buckets");
            dom.ensembleHistoricalOddsTableBody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Not enough samples to produce conditional odds.
                    </td>
                </tr>
            `;
            return;
        }

        const summaryCards: string[] = [];
        if (context.bestBucket) {
            summaryCards.push(this.card(
                "Best Bucket",
                `${context.bestBucket.label} ($${context.bestBucket.avgExpectancy.toFixed(2)}, n=${context.bestBucket.samples})`
            ));
        }
        if (context.bestLongBucket) {
            summaryCards.push(this.card(
                "Best Long Bucket",
                `${context.bestLongBucket.label} (${context.bestLongBucket.longWinRate?.toFixed(1)}%, n=${context.bestLongBucket.longSamples})`
            ));
        }
        if (context.bestShortBucket) {
            summaryCards.push(this.card(
                "Best Short Bucket",
                `${context.bestShortBucket.label} (${context.bestShortBucket.shortWinRate?.toFixed(1)}%, n=${context.bestShortBucket.shortSamples})`
            ));
        }
        dom.ensembleHistoricalOddsSummary.innerHTML = summaryCards.join("");

        dom.ensembleHistoricalOddsTableBody.innerHTML = rows.map((bucket) => {
            const isBaseline = bucket.label === "baseline (all)";
            const isBest = context.bestBucket?.label === bucket.label;
            const rowStyle = isBaseline
                ? ' style="font-weight:600;background:var(--bg-secondary);"'
                : isBest
                    ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                    : "";

            return `
                <tr${rowStyle}>
                    <td>${this.escapeHtml(bucket.label)}</td>
                    <td>${bucket.samples}</td>
                    <td>${bucket.winRate.toFixed(1)}%</td>
                    <td>${bucket.lossRate.toFixed(1)}%</td>
                    <td>$${bucket.avgExpectancy.toFixed(2)}</td>
                    <td>${bucket.avgNetPct.toFixed(2)}%</td>
                    <td>${bucket.avgOppose.toFixed(2)}</td>
                    <td>${bucket.longWinRate === null ? "-" : `${bucket.longWinRate.toFixed(1)}%`}</td>
                    <td>${bucket.shortWinRate === null ? "-" : `${bucket.shortWinRate.toFixed(1)}%`}</td>
                </tr>
            `;
        }).join("");
    }

    private renderBuilder(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)") ?? context.builderRows[0] ?? null;
        const nonBaselineRows = context.builderRows.filter((row) => row.rule !== "Baseline (target only)" && row.trades >= context.minSamples);
        const bestExpectancyRow = nonBaselineRows.length > 0
            ? nonBaselineRows.reduce((best, row) => row.expectancy > best.expectancy ? row : best)
            : null;
        const bestDrawdownRow = nonBaselineRows.length > 0
            ? nonBaselineRows.reduce((best, row) => Math.abs(row.maxDrawdownPercent) < Math.abs(best.maxDrawdownPercent) ? row : best)
            : null;
        const bestBalanceRow = baselineRow
            ? nonBaselineRows
                .filter((row) => row.trades >= baselineRow.trades * 0.5 && row.expectancy >= baselineRow.expectancy)
                .reduce<EnsembleBuilderRow | null>((best, row) => {
                    if (!best) {
                        return row;
                    }
                    if (row.expectancy !== best.expectancy) {
                        return row.expectancy > best.expectancy ? row : best;
                    }
                    return row.trades > best.trades ? row : best;
                }, null)
            : null;

        const summaryCards: string[] = [];
        if (context.selectedRule) {
            const selectionLabel = context.selectedRule.mode === "validated" ? "Validated Filter" : "In-Sample Candidate";
            const validationTrades = context.selectedRule.mode === "validated"
                ? context.selectedRule.evaluation.validationSamples
                : context.selectedRule.evaluation.trainSamples;
            const validationExp = context.selectedRule.mode === "validated"
                ? context.selectedRule.evaluation.validationExpectancy
                : context.selectedRule.evaluation.trainExpectancy;
            summaryCards.push(this.card(
                selectionLabel,
                `${context.selectedRule.evaluation.rule.label} ($${validationExp.toFixed(2)}, n=${validationTrades})`
            ));
        }
        if (bestExpectancyRow) {
            summaryCards.push(this.card("Best Expectancy", `${bestExpectancyRow.rule} ($${bestExpectancyRow.expectancy.toFixed(2)})`));
        }
        if (bestDrawdownRow) {
            const beatsBaseline = baselineRow
                ? Math.abs(bestDrawdownRow.maxDrawdownPercent) < Math.abs(baselineRow.maxDrawdownPercent)
                : false;
            summaryCards.push(this.card(
                beatsBaseline ? "Best Max DD" : "Best Filtered Max DD",
                `${bestDrawdownRow.rule} (${bestDrawdownRow.maxDrawdownPercent.toFixed(1)}%)`
            ));
        }
        if (bestBalanceRow && baselineRow) {
            summaryCards.push(this.card(
                "Best Balance",
                `${bestBalanceRow.rule} (${((bestBalanceRow.trades / baselineRow.trades) * 100).toFixed(0)}% trades, $${bestBalanceRow.expectancy.toFixed(2)})`
            ));
        }
        dom.ensembleBuilderSummary.innerHTML = summaryCards.join("");

        dom.ensembleBuilderTableBody.innerHTML = context.builderRows.map((row) => {
            const isBaseline = row.rule === "Baseline (target only)";
            const isBest = bestExpectancyRow?.rule === row.rule;
            const isSelected = row.selectionMode !== null;
            const rowStyle = isBaseline
                ? ' style="font-weight:600;background:var(--bg-secondary);"'
                : isSelected
                    ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.10));"'
                    : isBest
                    ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                    : "";
            const label = row.selectionMode === "validated"
                ? `${row.rule} [Validated]`
                : row.selectionMode === "train_only"
                    ? `${row.rule} [In-sample only]`
                    : row.rule;

            return `
                <tr${rowStyle}>
                    <td>${this.escapeHtml(label)}</td>
                    <td>${row.signals}</td>
                    <td>${row.trades}</td>
                    <td>${row.winRate.toFixed(1)}%</td>
                    <td>${row.netProfitPercent.toFixed(2)}%</td>
                    <td>$${row.expectancy.toFixed(2)}</td>
                    <td>${row.profitFactor === Infinity ? "INF" : row.profitFactor.toFixed(2)}</td>
                    <td>${row.maxDrawdownPercent.toFixed(1)}%</td>
                    <td>${row.engineUsed}</td>
                    <td><button class="btn btn-secondary btn-compact" type="button" data-ensemble-preview-rule-id="${this.escapeHtml(row.ruleId)}">View</button></td>
                </tr>
            `;
        }).join("");
    }

    private formatSignedCurrency(value: number): string {
        if (!Number.isFinite(value)) {
            return "-";
        }
        return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
    }

    private formatSignedPercent(value: number): string {
        if (!Number.isFinite(value)) {
            return "-";
        }
        return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%`;
    }

    private formatSignedInteger(value: number): string {
        if (!Number.isFinite(value)) {
            return "-";
        }
        return `${value >= 0 ? "+" : ""}${Math.round(value)}`;
    }

    private formatOptionalExpectancy(stats: EnsembleVoteProfileStats | null): string {
        return stats ? `$${stats.expectancy.toFixed(2)} (n=${stats.samples})` : "-";
    }

    private formatVoteLabel(vote: "agree" | "oppose" | "neutral" | "conflict" | "n/a"): string {
        if (vote === "n/a") {
            return "n/a";
        }
        return vote.charAt(0).toUpperCase() + vote.slice(1);
    }

    private renderContribution(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const worstContributor = context.contributionRows.find((row) => row.deltaExpectancy > 0) ?? null;
        const bestContributor = [...context.contributionRows]
            .sort((left, right) => left.deltaExpectancy - right.deltaExpectancy)
            .find((row) => row.deltaExpectancy < 0) ?? null;

        const summaryCards: string[] = [];
        if (worstContributor) {
            summaryCards.push(this.card(
                "Worst Contributor",
                `${worstContributor.familyLabel} (${this.formatSignedCurrency(worstContributor.deltaExpectancy)})`
            ));
        } else {
            summaryCards.push(this.card("Worst Contributor", "No clear harmful family"));
        }
        if (bestContributor) {
            summaryCards.push(this.card(
                "Best Contributor",
                `${bestContributor.familyLabel} (${this.formatSignedCurrency(bestContributor.deltaExpectancy)})`
            ));
        } else {
            summaryCards.push(this.card("Best Contributor", "No clear helpful family"));
        }
        if (context.contributionRows.length > 0) {
            const highestCoverage = [...context.contributionRows].sort(
                (left, right) => right.voteProfile.agreeCoverage - left.voteProfile.agreeCoverage
            )[0];
            summaryCards.push(this.card(
                "Highest Agree Coverage",
                `${highestCoverage.familyLabel} (${highestCoverage.voteProfile.agreeCoverage.toFixed(1)}%)`
            ));
        }
        dom.ensembleContributionSummary.innerHTML = summaryCards.join("");

        if (context.contributionRows.length === 0) {
            dom.ensembleContributionTableBody.innerHTML = `
                <tr>
                    <td colspan="12" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        No context family contribution data available.
                    </td>
                </tr>
            `;
            return;
        }

        dom.ensembleContributionTableBody.innerHTML = context.contributionRows.map((row) => {
            const positiveRemoval = row.deltaExpectancy > 0;
            const negativeRemoval = row.deltaExpectancy < 0;
            const rowStyle = positiveRemoval
                ? ' style="background:var(--bg-danger-subtle,rgba(220,80,80,0.08));"'
                : negativeRemoval
                    ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                    : "";

            return `
                <tr${rowStyle}>
                    <td>${this.escapeHtml(row.familyLabel)}</td>
                    <td>${this.escapeHtml(row.configNames.join(", "))}</td>
                    <td>${this.escapeHtml(this.formatVoteLabel(row.currentVote))}</td>
                    <td>${row.voteProfile.agreeCoverage.toFixed(1)}%</td>
                    <td>${this.escapeHtml(this.formatOptionalExpectancy(row.voteProfile.agreeStats))}</td>
                    <td>${this.escapeHtml(this.formatOptionalExpectancy(row.voteProfile.opposeStats))}</td>
                    <td>${row.voteProfile.conflictCoverage.toFixed(1)}%</td>
                    <td>${this.escapeHtml(this.formatSignedCurrency(row.deltaExpectancy))}</td>
                    <td>${this.escapeHtml(this.formatSignedPercent(row.deltaWinRate))}</td>
                    <td>${row.tradeRetentionPercent.toFixed(0)}%</td>
                    <td>${this.escapeHtml(this.formatSignedInteger(row.deltaTrades))}</td>
                    <td>${this.escapeHtml(this.describeScenarioPrimaryRow(row.primaryRow))}</td>
                </tr>
            `;
        }).join("");
    }

    private renderReplacement(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const worstContributor = context.contributionRows.find((row) => row.deltaExpectancy > 0) ?? null;
        const bestReplacement = context.replacementRows[0] ?? null;

        const summaryCards: string[] = [];
        summaryCards.push(this.card(
            "Replacement Base",
            worstContributor
                ? `Remove ${worstContributor.familyLabel}`
                : "No clear weak family"
        ));
        if (bestReplacement) {
            summaryCards.push(this.card(
                "Best Replacement",
                `${bestReplacement.familyLabel} (${this.formatSignedCurrency(bestReplacement.deltaExpectancyVsRemoved)})`
            ));
            summaryCards.push(this.card(
                "Best Candidate Config",
                bestReplacement.configName
            ));
        } else {
            summaryCards.push(this.card("Best Replacement", "No qualifying candidate"));
        }
        dom.ensembleReplacementSummary.innerHTML = summaryCards.join("");

        if (context.replacementRows.length === 0) {
            dom.ensembleReplacementTableBody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        No replacement candidates improved on the evaluated context set.
                    </td>
                </tr>
            `;
            return;
        }

        dom.ensembleReplacementTableBody.innerHTML = context.replacementRows.map((row, index) => {
            const rowStyle = index === 0
                ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                : row.deltaExpectancyVsRemoved > 0
                    ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.08));"'
                    : "";

            return `
                <tr${rowStyle}>
                    <td>${this.escapeHtml(row.familyLabel)}</td>
                    <td>${this.escapeHtml(row.configName)}</td>
                    <td>${this.escapeHtml(this.formatVoteLabel(row.currentVote))}</td>
                    <td>${this.escapeHtml(this.formatSignedCurrency(row.deltaExpectancyVsRemoved))}</td>
                    <td>${this.escapeHtml(this.formatSignedCurrency(row.deltaExpectancyVsCurrent))}</td>
                    <td>${this.escapeHtml(this.formatSignedPercent(row.deltaWinRateVsCurrent))}</td>
                    <td>${row.tradeRetentionPercent.toFixed(0)}%</td>
                    <td>${this.escapeHtml(this.formatSignedInteger(row.deltaTradesVsCurrent))}</td>
                    <td>${this.escapeHtml(this.describeScenarioPrimaryRow(row.primaryRow))}</td>
                </tr>
            `;
        }).join("");
    }

    private renderRadar(context: EnsembleRunContext): void {
        const findings = this.buildRadarFindings(context);
        this.getDom().ensembleRadarContent.innerHTML = findings.map((finding) => {
            const className = finding.quality === "positive" ? "positive" : finding.quality === "negative" ? "negative" : "";
            return `<div class="portfolio-lab__insight ${className}"><strong>${this.escapeHtml(finding.label)}</strong>: ${this.escapeHtml(finding.detail)}</div>`;
        }).join("");
    }

    private card(label: string, value: string): string {
        return `
            <div class="sim-card">
                <div class="sim-card-label">${this.escapeHtml(label)}</div>
                <div class="sim-card-value">${this.escapeHtml(value)}</div>
            </div>
        `;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export const strategyEnsembleService = new StrategyEnsembleService();
