import { settingsManager } from "../settings-manager";
import { state } from "../state";
import { STRATEGY_PANEL_SETTINGS_SECTIONS } from "../strategy-panel-settings-registry";
import { getSettingsSectionSummary, settingsSnapshotKey } from "../settings-workspace-model";
import type { SettingsWorkspaceDom } from "../ui-manager-dom";
import { strategyPanelController } from "../strategy-panel-controller";
import { strategyRegistry } from "../../strategyRegistry";
import { paramManager } from "../param-manager";
import { backtestService } from "../backtest-service";
import { getCurrentUiBacktestEndpointSnapshot } from "../backtest-endpoint-copy";
import { formatDecimal, formatPercentPoints, formatProfitFactor, formatSignedCurrency, formatSignedPercentPoints } from "../ui-formatters";

const SECTION_LABELS: Record<string, string> = {
    direction: "Direction", risk: "Risk", sizing: "Sizing", confirmation: "Confirmation", realism: "Execution", engine: "Engine",
};

export function initSettingsWorkspace(dom: SettingsWorkspaceDom): void {
    const metricElements = dom.settingsBacktestSummary.querySelectorAll<HTMLElement>('[data-backtest-metric]');
    let completedConfiguration: string | null = null;
    const syncPerformanceVisibility = (): void => {
        dom.settingsBacktestSummary.hidden = !state.currentBacktestResult
            || strategyPanelController.getActiveTabId() !== 'settings';
    };
    const updatePerformanceStatus = (): void => {
        if (!state.currentBacktestResult) return;
        const source = state.currentBacktestResultSource;
        if (completedConfiguration === null) {
            dom.settingsBacktestStatus.textContent = source === 'finder_selection' ? 'Finder selection'
                : source === 'walk_forward_oos' ? 'Walk-forward OOS' : 'Last completed backtest';
            dom.settingsBacktestStatus.dataset.state = 'result';
            return;
        }
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        const current = settingsSnapshotKey({
            symbol: state.currentSymbol, interval: state.currentInterval,
            strategyKey: state.currentStrategyKey,
            strategyParams: strategy ? paramManager.getValues(strategy) : {},
            backtestSettings: backtestService.getBacktestSettings(),
            capitalSettings: backtestService.getCapitalSettings(), blockRange: state.blockRange,
        });
        const changed = current !== completedConfiguration;
        dom.settingsBacktestStatus.dataset.state = changed ? 'changed' : 'result';
        dom.settingsBacktestStatus.textContent = changed ? 'Settings changed · Run to update'
            : source === 'endpoint_preview' ? 'Endpoint preview' : 'Last completed backtest';
    };
    const renderPerformance = (): void => {
        const result = state.currentBacktestResult;
        syncPerformanceVisibility();
        if (!result) {
            completedConfiguration = null;
            return;
        }
        // Reuse the request captured by the run, including edits made while it awaited execution.
        const snapshot = getCurrentUiBacktestEndpointSnapshot();
        completedConfiguration = snapshot ? settingsSnapshotKey({
            symbol: snapshot.symbol, interval: snapshot.interval, strategyKey: snapshot.strategyKey,
            strategyParams: snapshot.strategyParams, backtestSettings: snapshot.backtestSettings,
            capitalSettings: snapshot.capitalSettings, blockRange: snapshot.blockRange,
        }) : null;
        const metrics: Record<string, string> = {
            netProfit: formatSignedCurrency(result.netProfit), netProfitPercent: formatSignedPercentPoints(result.netProfitPercent),
            profitFactor: formatProfitFactor(result.profitFactor), maxDrawdownPercent: formatPercentPoints(result.maxDrawdownPercent),
            winRate: formatPercentPoints(result.winRate, 1), totalTrades: String(result.totalTrades), sharpeRatio: formatDecimal(result.sharpeRatio, 2),
        };
        metricElements.forEach(element => {
            element.textContent = metrics[element.dataset.backtestMetric!];
            if (element.dataset.backtestMetric!.startsWith('netProfit')) {
                element.dataset.tone = result.netProfit >= 0 ? 'positive' : 'negative';
            }
        });
        updatePerformanceStatus();
    };
    dom.settingsBacktestResults.addEventListener('click', () => strategyPanelController.switchTab('results', { focus: true }));
    dom.settingsBacktestTrades.addEventListener('click', () => strategyPanelController.switchTab('trades', { focus: true }));
    state.subscribe('currentBacktestResult', renderPerformance);
    window.addEventListener('strategy-panel:tab-change', syncPerformanceVisibility);
    const sections = STRATEGY_PANEL_SETTINGS_SECTIONS.map(definition => ({
        definition,
        element: dom.strategyWorkspaceSections.querySelector<HTMLElement>(`[data-section="${definition.id}"]`)!,
        summary: document.createElement("span"),
    }));

    for (const { definition, element, summary } of sections) {
        summary.className = "settings-section-summary";
        summary.dataset.settingsSummary = definition.id;
        element.querySelector(".section-heading-group")!.append(summary);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-ghost btn-compact";
        button.textContent = SECTION_LABELS[definition.id];
        button.setAttribute("aria-controls", definition.accordionBodyId);
        button.addEventListener("click", () => revealSection(element));
        dom.settingsQuickNav.append(button);
    }

    const revealSection = (section: HTMLElement, control?: HTMLElement): void => {
        // Simple mode hides some sections. Reveal the section through the
        // existing display preset without changing any execution settings.
        if (section.hidden) dom.settingsTab.querySelector<HTMLButtonElement>('[data-preset="standard"]')!.click();
        const header = section.querySelector<HTMLElement>(".section-header.collapsible")!;
        (section as HTMLDetailsElement).open = true;
        dom.settingsTab.querySelectorAll(".settings-search-match").forEach(element => element.classList.remove("settings-search-match"));
        // A field can remain unavailable because its feature/mode is off.
        // Focus the section header in that case; never enable a feature as a
        // side effect of navigating to a search result.
        const target = control && !control.matches(":disabled") && control.getClientRects().length > 0 ? control : header;
        target.closest(".param-group")?.classList.add("settings-search-match");
        target.scrollIntoView({ block: target === header ? "start" : "center" });
        target.focus({ preventScroll: true });
    };

    const renderSearch = (): void => {
        const query = dom.settingsSearch.value.trim().toLocaleLowerCase();
        dom.settingsSearchResults.replaceChildren();
        dom.settingsSearchResults.hidden = !query;
        if (!query) {
            dom.settingsTab.querySelectorAll(".settings-search-match").forEach(element => element.classList.remove("settings-search-match"));
            return;
        }
        const words = query.split(/\s+/);
        let count = 0;
        const targets = [
            { element: dom.settingsTab.querySelector<HTMLElement>(".strategy-workspace-card--strategy")!, name: "Strategy" },
            ...sections.map(({ element, definition }) => ({ element, name: SECTION_LABELS[definition.id] })),
        ];
        for (const { element, name } of targets) {
            for (const label of Array.from(element.querySelectorAll<HTMLLabelElement>(".param-label"))) {
                const group = label.closest(".param-group");
                const text = `${name} ${label.textContent} ${group?.querySelector(".param-hint")?.textContent ?? ""}`.toLocaleLowerCase();
                if (!words.every(word => text.includes(word))) continue;
                count += 1;
                const control = (label.htmlFor ? document.getElementById(label.htmlFor) : label.nextElementSibling) as HTMLElement | null;
                const button = document.createElement("button");
                button.type = "button";
                button.className = "settings-search-result";
                button.textContent = `${name} · ${label.textContent?.trim()}${control?.matches(":disabled") || control?.closest(".is-hidden, .section-feature-body[inert]") ? " (currently inactive)" : ""}`;
                button.addEventListener("click", () => {
                    if (element.classList.contains("settings-section")) revealSection(element, control ?? undefined);
                    else {
                        element.scrollIntoView({ block: "start" });
                        control?.focus({ preventScroll: true });
                    }
                });
                dom.settingsSearchResults.append(button);
            }
        }
        const message = document.createElement("div");
        message.className = "settings-search-count";
        message.textContent = count ? `${count} matching controls. Inactive controls remain off.` : "No matching settings. Try a control name such as slippage or capital.";
        dom.settingsSearchResults.prepend(message);
    };

    const refresh = (): void => {
        updatePerformanceStatus();
        const settings = settingsManager.getBacktestSettings();
        for (const { definition, summary } of sections) summary.textContent = getSettingsSectionSummary(definition.id, settings);
        const feedback = settingsManager.getWorkspaceFeedback();
        dom.settingsSaveStatus.dataset.state = feedback.saveStatus;
        dom.settingsSaveStatus.textContent = {
            ready: "Autosave ready", pending: "Saving…", saved: "Saved in this browser", error: "Could not save in this browser",
        }[feedback.saveStatus];
        dom.settingsConfigStatus.dataset.state = feedback.modified ? "modified" : "matched";
        dom.settingsConfigStatus.textContent = feedback.configurationName
            ? `${feedback.configurationName} · ${feedback.modified ? "Modified" : "Matches saved setup"}` : "No configuration loaded";
        dom.restoreSettingsConfigBtn.disabled = !feedback.modified || dom.restoreSettingsConfigBtn.dataset.restoring === "true";
        dom.restoreSettingsConfigBtn.setAttribute("aria-label", feedback.configurationName ? `Restore configuration ${feedback.configurationName}` : "Restore configuration");
    };
    let refreshQueued = false;
    const queueRefresh = (): void => {
        if (refreshQueued) return;
        refreshQueued = true;
        queueMicrotask(() => {
            refreshQueued = false;
            refresh();
            if (dom.settingsSearch.value) renderSearch();
        });
    };
    dom.settingsSearch.addEventListener("input", renderSearch);
    dom.settingsSearch.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            dom.settingsSearch.value = "";
            renderSearch();
        }
        if (event.key === "Enter") {
            event.preventDefault();
            dom.settingsSearchResults.querySelector<HTMLButtonElement>("button")?.click();
        }
    });
    dom.settingsTab.addEventListener("input", queueRefresh);
    dom.settingsTab.addEventListener("change", queueRefresh);
    settingsManager.subscribeFeedback(queueRefresh);
    state.subscribe("currentStrategyKey", queueRefresh);
    state.subscribe("blockRange", queueRefresh);
    state.subscribe("currentSymbol", queueRefresh);
    state.subscribe("currentInterval", queueRefresh);
    // Strategy controls are rendered asynchronously when selection changes.
    new MutationObserver(() => { queueRefresh(); if (dom.settingsSearch.value) renderSearch(); })
        .observe(dom.settingsTab.querySelector("#strategyParams")!, { childList: true, subtree: true });
    refresh();
    renderPerformance();
}
