import { ensureLazyStylesheet } from "../lazy-styles";
import {
    getStrategyList,
    isBuiltInStrategyKey,
    loadBuiltInStrategyByKey,
    getStrategyKind,
    getStrategyKindTitle,
    strategyRegistry,
} from "../../strategyRegistry";
import { backtestService } from "../backtest-service";
import { dataManager } from "../data-manager";
import { debugLogger } from "../debug-logger";
import { parseInputNumber } from "../dom-input-readers";
import { setVisible } from "../dom-utils";
import { mergeFinderRiskParamsIntoBacktestSettings } from "../finder/finder-runner-core";
import { getFinderMetricValue } from "../finder/finder-engine";
import { paramManager } from "../param-manager";
import {
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    resolvePolymarketPostSignalLimitEntryMode,
    resolvePolymarketPostSignalLimitExitMode,
} from "../polymarket-post-signal-limit-entry";
import { isSameEventPolymarketExitMode, resolvePolymarketExitMode } from "../polymarket-exit-mode";
import { settingsManager, sortStrategyConfigsNewestFirst } from "../settings-manager";
import { clearBacktestResults, setBlockRange, setCurrentStrategyKey } from "../state-actions";
import { state } from "../state";
import { strategyPanelController } from "../strategy-panel-controller";
import { uiManager } from "../ui-manager";
import { createHuntDom, type HuntDom } from "./hunt-dom";
import {
    captureCurrentUiAsHuntProfile,
    createHuntProfileFromSavedConfigAndCurrentChart,
    parseHuntProfilesFromImport,
} from "./hunt-profile-capture";
import { formatHuntMetricValue, getFinderMetricLabel } from "./hunt-results";
import {
    createHuntRunController,
    type HuntRunController,
    type HuntRunMessage,
    type HuntRunOutput,
    type HuntRunProgress,
} from "./hunt-runner";
import {
    cloneBlockRange,
    cloneHuntProfile,
    normalizeHuntPolymarketRankMode,
    cloneHuntUiState,
    createHuntEntityId,
    createHuntProfileExportPayload,
    getMarketSelectionAutoReloadSuppressCount,
    mergeCapitalSettingsIntoBacktestSettingsData,
    normalizeStoredHuntProfile,
    type HuntProfile,
    type HuntProfileRunResult,
    type HuntResultsView,
    type HuntRunSettings,
    type HuntSurvivorGroup,
    DEFAULT_HUNT_UI_STATE,
    HUNT_MAX_TRADES_UNBOUNDED,
} from "./hunt-model";
import {
    deleteHuntProfile,
    loadHuntProfiles,
    loadHuntUiState,
    saveHuntProfiles,
    saveHuntUiState,
    sortHuntProfilesNewestFirst,
} from "./hunt-storage";

function sanitizeProfileName(name: string): string {
    return name.trim().replace(/\s+/g, " ");
}

function formatParamValue(value: number): string {
    if (Number.isInteger(value)) {
        return String(value);
    }
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatParams(params: Record<string, number>): string {
    return Object.entries(params)
        .map(([key, value]) => `${key}=${formatParamValue(value)}`)
        .join(", ");
}

class HuntService {
    private dom: HuntDom | null = null;
    private initialized = false;
    private profiles: HuntProfile[] = [];
    private uiState = cloneHuntUiState(DEFAULT_HUNT_UI_STATE);
    private runController: HuntRunController | null = null;
    private runOutput: HuntRunOutput | null = null;
    private progressMessages: HuntRunMessage[] = [];
    private strategyToggles: Map<string, HTMLInputElement> = new Map();
    private strategyItems: Map<string, HTMLDivElement> = new Map();
    private strategyOrder: string[] = [];
    private lastStrategyToggleKey: string | null = null;

    private getDom(): HuntDom {
        return this.dom ??= createHuntDom();
    }

    public init(): void {
        ensureLazyStylesheet("hunt-styles", new URL("../../styles/hunt.css", import.meta.url).href);
        if (this.initialized) {
            return;
        }

        this.profiles = loadHuntProfiles();
        this.uiState = loadHuntUiState();
        this.reconcileUiState();

        const dom = this.getDom();
        this.bindEvents(dom);
        this.renderStrategySelection();
        this.populateSavedConfigs();
        this.applyRunSettingsToDom();
        this.renderProfiles();
        this.renderResults();
        this.renderProgress({
            percent: 0,
            status: "Idle",
            currentProfileLabel: "Idle",
            currentStrategyLabel: "0 / 0",
            processedProfiles: 0,
            totalProfiles: this.getEnabledProfiles().length,
            processedStrategies: 0,
            totalStrategies: 0,
        });
        this.initialized = true;
    }

    private bindEvents(dom: HuntDom): void {
        dom.huntCaptureCurrentUiBtn.addEventListener("click", () => {
            this.captureCurrentUiProfile();
        });
        dom.huntCreateFromSavedConfigBtn.addEventListener("click", () => {
            this.captureSavedConfigProfile();
        });
        dom.huntImportJsonBtn.addEventListener("click", () => {
            void this.importFromText();
        });
        dom.huntImportFileBtn.addEventListener("click", () => {
            dom.huntImportFileInput.click();
        });
        dom.huntImportFileInput.addEventListener("change", () => {
            void this.importFromFile();
        });
        dom.huntExportProfilesBtn.addEventListener("click", () => {
            this.exportProfiles();
        });

        dom.huntProfileList.addEventListener("change", (event: Event) => {
            const target = event.target as HTMLElement | null;
            const toggle = target?.closest<HTMLInputElement>(".hunt-profile-enabled");
            if (!toggle?.dataset.profileId) {
                return;
            }

            const enabled = new Set(this.uiState.enabledProfileIds);
            if (toggle.checked) {
                enabled.add(toggle.dataset.profileId);
            } else {
                enabled.delete(toggle.dataset.profileId);
            }
            this.uiState.enabledProfileIds = [...enabled];
            this.persistUiState();
            this.renderProfiles();
        });

        dom.huntProfileList.addEventListener("click", (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest(".hunt-profile-toggle")) {
                return;
            }

            const button = target?.closest<HTMLButtonElement>("[data-hunt-profile-action]");
            if (button?.dataset.profileId) {
                const profile = this.findProfile(button.dataset.profileId);
                if (!profile) {
                    return;
                }

                switch (button.dataset.huntProfileAction) {
                    case "apply":
                        void this.applyProfileToUi(profile);
                        return;
                    case "duplicate":
                        this.duplicateProfile(profile);
                        return;
                    case "rename":
                        this.renameProfile(profile);
                        return;
                    case "delete":
                        this.removeProfile(profile);
                        return;
                    default:
                        return;
                }
            }

            const row = target?.closest<HTMLElement>(".hunt-profile-row");
            if (!row?.dataset.profileId) {
                return;
            }
            this.uiState.selectedProfileId = row.dataset.profileId;
            this.persistUiState();
            this.renderProfiles();
        });

        dom.huntStrategiesToggleAll.addEventListener("change", (event: Event) => {
            this.setStrategySelection(this.strategyOrder, (event.target as HTMLInputElement).checked);
        });
        dom.huntStrategyList.addEventListener("click", (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
            const strategyKey = checkbox?.dataset.strategyKey;
            if (!checkbox || !strategyKey || !dom.huntStrategyList.contains(checkbox)) {
                return;
            }
            this.handleStrategyToggleClick(strategyKey, event);
        });
        dom.huntStrategyList.addEventListener("change", (event: Event) => {
            const target = event.target as HTMLElement | null;
            const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
            if (!checkbox?.dataset.strategyKey || !dom.huntStrategyList.contains(checkbox)) {
                return;
            }
            this.syncStrategySelectionUi();
            this.persistSelectedStrategies();
        });
        dom.huntStrategySearch.addEventListener("input", () => {
            this.applyStrategyFilter();
        });
        dom.huntStrategySelectAll.addEventListener("click", () => {
            this.setStrategySelection(this.strategyOrder, true);
        });
        dom.huntStrategySelectNone.addEventListener("click", () => {
            this.setStrategySelection(this.strategyOrder, false);
        });
        dom.huntStrategyInvertVisible.addEventListener("click", () => {
            this.invertStrategySelection(this.getVisibleStrategyKeys());
        });
        dom.huntStrategySelectVisible.addEventListener("click", () => {
            this.setStrategySelection(this.getVisibleStrategyKeys(), true);
        });

        dom.huntAdvancedToggle.addEventListener("change", () => {
            this.syncAdvancedUi();
        });
        dom.huntPolymarketToggle.addEventListener("change", () => {
            this.persistRunSettingsFromDom();
            this.syncAdvancedUi();
        });
        dom.huntTradesToggle.addEventListener("change", () => {
            this.persistRunSettingsFromDom();
            this.syncAdvancedUi();
        });
        dom.huntPolymarketExitMode.addEventListener("change", () => {
            this.persistRunSettingsFromDom();
            this.syncAdvancedUi();
        });

        [
            dom.huntPolymarketRankMode,
            dom.huntPolymarketMinScored,
            dom.huntPolymarketLockOffset,
            dom.huntPolymarketAfterTakeProfitOnly,
            dom.huntPolymarketSignalExitAllowMultipleTradesPerEvent,
            dom.huntFreezeRiskManagementToggle,
            dom.huntTradesMin,
            dom.huntTradesMax,
            dom.huntRunSelectedProfileOnly,
        ].forEach((element) => {
            element.addEventListener("change", () => {
                this.persistRunSettingsFromDom();
            });
            element.addEventListener("input", () => {
                this.persistRunSettingsFromDom();
            });
        });

        dom.huntRunBtn.addEventListener("click", () => {
            void this.runHunt();
        });
        dom.huntCancelBtn.addEventListener("click", () => {
            this.runController?.cancel();
        });
        dom.huntViewSurvivors.addEventListener("click", () => {
            this.setResultsView("survivors");
        });
        dom.huntViewPerProfile.addEventListener("click", () => {
            this.setResultsView("per_profile");
        });

        dom.huntSurvivorList.addEventListener("click", (event: MouseEvent) => {
            const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-hunt-apply-survivor]");
            if (!button) {
                return;
            }
            const index = Number(button.dataset.index);
            const survivor = this.runOutput?.survivors[index];
            if (survivor) {
                void this.applyRunResult(survivor.bestCandidate);
            }
        });

        dom.huntPerProfileList.addEventListener("click", (event: MouseEvent) => {
            const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-hunt-apply-profile-result]");
            if (!button) {
                return;
            }
            const index = Number(button.dataset.index);
            const result = this.runOutput?.profileResults[index];
            if (result) {
                void this.applyRunResult(result);
            }
        });

        strategyRegistry.subscribe(() => {
            this.reconcileUiState();
            this.renderStrategySelection();
        });
    }

    private reconcileUiState(): void {
        const profileIds = new Set(this.profiles.map((profile) => profile.id));
        this.uiState.runSettings.selectedStrategyKeys = this.uiState.runSettings.selectedStrategyKeys
            .filter((key) => strategyRegistry.has(key) || isBuiltInStrategyKey(key));
        this.uiState.enabledProfileIds = this.uiState.enabledProfileIds
            .filter((id) => profileIds.has(id));

        if (this.uiState.enabledProfileIds.length === 0 && this.profiles.length > 0) {
            this.uiState.enabledProfileIds = this.profiles.map((profile) => profile.id);
        }

        if (!this.uiState.selectedProfileId || !profileIds.has(this.uiState.selectedProfileId)) {
            this.uiState.selectedProfileId = this.profiles[0]?.id ?? null;
        }
    }

    private findProfile(profileId: string): HuntProfile | undefined {
        return this.profiles.find((profile) => profile.id === profileId);
    }

    private getEnabledProfiles(): HuntProfile[] {
        const enabled = new Set(this.uiState.enabledProfileIds);
        return this.profiles.filter((profile) => enabled.has(profile.id));
    }

    private getSelectedProfile(): HuntProfile | null {
        const selectedProfileId = this.uiState.selectedProfileId;
        if (!selectedProfileId) {
            return null;
        }
        return this.findProfile(selectedProfileId) ?? null;
    }

    private buildUniqueProfileName(baseName: string, excludeId?: string): string {
        const normalizedBase = sanitizeProfileName(baseName) || "Untitled Hunt Profile";
        const existingNames = new Set(
            this.profiles
                .filter((profile) => profile.id !== excludeId)
                .map((profile) => profile.name.toLowerCase())
        );
        if (!existingNames.has(normalizedBase.toLowerCase())) {
            return normalizedBase;
        }

        let attempt = 2;
        while (existingNames.has(`${normalizedBase} (${attempt})`.toLowerCase())) {
            attempt += 1;
        }
        return `${normalizedBase} (${attempt})`;
    }

    private persistProfiles(): void {
        this.profiles = sortHuntProfilesNewestFirst(this.profiles);
        saveHuntProfiles(this.profiles);
    }

    private persistUiState(): void {
        saveHuntUiState(this.uiState);
    }

    private addProfile(profile: HuntProfile, options: { enable?: boolean; select?: boolean } = {}): HuntProfile {
        const nowIso = new Date().toISOString();
        const normalized = normalizeStoredHuntProfile({
            ...cloneHuntProfile(profile),
            id: this.profiles.some((entry) => entry.id === profile.id) ? createHuntEntityId("hunt-profile") : profile.id,
            name: this.buildUniqueProfileName(profile.name),
            createdAt: profile.createdAt || nowIso,
            updatedAt: nowIso,
        });
        if (!normalized) {
            throw new Error("Failed to persist Hunt profile.");
        }

        this.profiles = sortHuntProfilesNewestFirst([...this.profiles, normalized]);
        if (options.enable !== false) {
            const enabled = new Set(this.uiState.enabledProfileIds);
            enabled.add(normalized.id);
            this.uiState.enabledProfileIds = [...enabled];
        }
        if (options.select !== false) {
            this.uiState.selectedProfileId = normalized.id;
        }
        this.persistProfiles();
        this.persistUiState();
        this.renderProfiles();
        return normalized;
    }

    private updateProfile(profile: HuntProfile): void {
        this.profiles = this.profiles.map((entry) => (entry.id === profile.id ? cloneHuntProfile(profile) : entry));
        this.persistProfiles();
        this.persistUiState();
        this.renderProfiles();
    }

    private captureCurrentUiProfile(): void {
        try {
            const profile = captureCurrentUiAsHuntProfile();
            this.addProfile(profile);
            this.setImportStatus(`Captured ${profile.symbol} ${profile.interval} from the current UI.`);
            uiManager.showToast(`Captured Hunt profile: ${profile.name}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setImportStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private captureSavedConfigProfile(): void {
        const configName = this.getDom().huntSavedConfigSelect.value;
        if (!configName) {
            uiManager.showToast("Select a saved config first.", "error");
            return;
        }

        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) {
            uiManager.showToast(`Saved config "${configName}" was not found.`, "error");
            return;
        }

        try {
            const profile = createHuntProfileFromSavedConfigAndCurrentChart(config);
            this.addProfile(profile);
            this.setImportStatus(`Created ${profile.name} from saved config "${config.name}".`);
            uiManager.showToast(`Created Hunt profile from ${config.name}`, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setImportStatus(message);
            uiManager.showToast(message, "error");
        }
    }

    private async importFromText(): Promise<void> {
        const text = this.getDom().huntImportJsonInput.value.trim();
        if (!text) {
            uiManager.showToast("Paste Hunt export or endpoint snapshot JSON first.", "error");
            return;
        }

        try {
            const parsed = JSON.parse(text) as unknown;
            this.importParsedPayload(parsed);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setImportStatus(`Invalid JSON: ${message}`);
            uiManager.showToast("Invalid Hunt import JSON.", "error");
        }
    }

    private async importFromFile(): Promise<void> {
        const input = this.getDom().huntImportFileInput;
        const file = input.files?.[0];
        input.value = "";
        if (!file) {
            return;
        }

        try {
            const text = await file.text();
            const parsed = JSON.parse(text) as unknown;
            this.importParsedPayload(parsed);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setImportStatus(`File import failed: ${message}`);
            uiManager.showToast("Failed to import Hunt JSON file.", "error");
        }
    }

    private importParsedPayload(payload: unknown): void {
        const parsed = parseHuntProfilesFromImport(payload);
        const idMap = new Map<string, string>();
        const importedProfiles: HuntProfile[] = [];

        for (const profile of parsed.profiles) {
            const importedId = profile.id;
            const stored = this.addProfile({
                ...cloneHuntProfile(profile),
                id: this.profiles.some((entry) => entry.id === profile.id) ? createHuntEntityId("hunt-profile") : profile.id,
                name: this.buildUniqueProfileName(profile.name),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            idMap.set(importedId, stored.id);
            importedProfiles.push(stored);
        }

        if (parsed.uiState) {
            this.uiState.runSettings = parsed.uiState.runSettings;
            this.uiState.resultsView = parsed.uiState.resultsView;
            const mappedEnabled = parsed.uiState.enabledProfileIds
                .map((id) => idMap.get(id))
                .filter((id): id is string => Boolean(id));
            if (mappedEnabled.length > 0) {
                this.uiState.enabledProfileIds = [...new Set([...this.uiState.enabledProfileIds, ...mappedEnabled])];
            }
            const mappedSelected = parsed.uiState.selectedProfileId ? idMap.get(parsed.uiState.selectedProfileId) ?? null : null;
            if (mappedSelected) {
                this.uiState.selectedProfileId = mappedSelected;
            }
            this.persistUiState();
            this.applyRunSettingsToDom();
        }

        this.renderProfiles();
        this.renderStrategySelection();
        this.setImportStatus(`Imported ${importedProfiles.length} Hunt profile${importedProfiles.length === 1 ? "" : "s"}.`);
        uiManager.showToast(`Imported ${importedProfiles.length} Hunt profile${importedProfiles.length === 1 ? "" : "s"}.`, "success");
    }

    private exportProfiles(): void {
        if (this.profiles.length === 0) {
            uiManager.showToast("No Hunt profiles to export.", "info");
            return;
        }

        const payload = createHuntProfileExportPayload(this.profiles, this.uiState);
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const date = new Date().toISOString().slice(0, 10);
        link.href = url;
        link.download = `hunt-profiles-${date}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        uiManager.showToast("Hunt profiles exported.", "success");
    }

    private duplicateProfile(profile: HuntProfile): void {
        const duplicate = cloneHuntProfile(profile);
        duplicate.id = createHuntEntityId("hunt-profile");
        duplicate.name = this.buildUniqueProfileName(`${profile.name} Copy`);
        duplicate.createdAt = new Date().toISOString();
        duplicate.updatedAt = duplicate.createdAt;
        this.addProfile(duplicate);
        uiManager.showToast(`Duplicated ${profile.name}`, "success");
    }

    private renameProfile(profile: HuntProfile): void {
        const nextName = window.prompt("Rename Hunt profile", profile.name);
        if (nextName === null) {
            return;
        }

        const normalizedName = sanitizeProfileName(nextName);
        if (!normalizedName) {
            uiManager.showToast("Profile name cannot be empty.", "error");
            return;
        }

        profile.name = this.buildUniqueProfileName(normalizedName, profile.id);
        profile.updatedAt = new Date().toISOString();
        this.updateProfile(profile);
        uiManager.showToast(`Renamed profile to ${profile.name}`, "success");
    }

    private removeProfile(profile: HuntProfile): void {
        if (!window.confirm(`Delete Hunt profile "${profile.name}"?`)) {
            return;
        }

        if (!deleteHuntProfile(profile.id)) {
            uiManager.showToast(`Failed to delete ${profile.name}`, "error");
            return;
        }

        this.profiles = this.profiles.filter((entry) => entry.id !== profile.id);
        this.uiState.enabledProfileIds = this.uiState.enabledProfileIds.filter((id) => id !== profile.id);
        if (this.uiState.selectedProfileId === profile.id) {
            this.uiState.selectedProfileId = this.profiles[0]?.id ?? null;
        }
        this.persistUiState();
        this.renderProfiles();
        uiManager.showToast(`Deleted Hunt profile: ${profile.name}`, "success");
    }

    private async applyProfileToUi(profile: HuntProfile): Promise<void> {
        clearBacktestResults("hunt.apply_profile");
        settingsManager.applyBacktestSettings(profile.backtestSettings);
        dataManager.suppressNextAutoReload(getMarketSelectionAutoReloadSuppressCount(
            {
                symbol: state.currentSymbol,
                interval: state.currentInterval,
            },
            profile
        ));
        await dataManager.loadData(profile.symbol, profile.interval);
        setBlockRange(cloneBlockRange(profile.blockRange));
        this.uiState.selectedProfileId = profile.id;
        this.persistUiState();
        this.renderProfiles();
        this.setImportStatus(`Applied ${profile.name} to the main UI.`);
        uiManager.showToast(`Applied Hunt profile: ${profile.name}`, "success");
    }

    private renderProfiles(): void {
        const dom = this.getDom();
        const enabled = new Set(this.uiState.enabledProfileIds);
        dom.huntProfileList.innerHTML = "";

        if (this.profiles.length === 0) {
            setVisible(dom.huntProfileEmpty, true);
            this.renderReadyStatus();
            return;
        }

        setVisible(dom.huntProfileEmpty, false);
        const fragment = document.createDocumentFragment();

        for (const profile of this.profiles) {
            const row = document.createElement("div");
            row.className = "hunt-profile-row";
            row.dataset.profileId = profile.id;
            if (profile.id === this.uiState.selectedProfileId) {
                row.classList.add("is-selected");
            }

            const polymarketSymbol = profile.backtestSettings.polymarketOutcomeSymbol?.trim();
            const sourceLabel = profile.source.replaceAll("_", " ");
            row.innerHTML = `
                <div class="hunt-profile-main">
                    <label class="hunt-profile-toggle">
                        <input type="checkbox" class="hunt-profile-enabled" data-profile-id="${profile.id}" ${enabled.has(profile.id) ? "checked" : ""}>
                    </label>
                    <div class="hunt-profile-copy">
                        <div class="hunt-profile-name">${profile.name}</div>
                        <div class="hunt-profile-meta">${sourceLabel} | ${profile.updatedAt.slice(0, 10)}</div>
                        <div class="hunt-profile-badges">
                            <span class="hunt-badge">${profile.symbol}</span>
                            <span class="hunt-badge">${profile.interval}</span>
                            ${profile.blockRange ? '<span class="hunt-badge">block</span>' : ""}
                            ${polymarketSymbol ? `<span class="hunt-badge">poly ${polymarketSymbol}</span>` : ""}
                        </div>
                    </div>
                </div>
                <div class="hunt-profile-actions-row">
                    <button class="btn btn-secondary btn-compact" type="button" data-hunt-profile-action="apply" data-profile-id="${profile.id}">Apply To UI</button>
                    <button class="btn btn-secondary btn-compact" type="button" data-hunt-profile-action="duplicate" data-profile-id="${profile.id}">Duplicate</button>
                    <button class="btn btn-secondary btn-compact" type="button" data-hunt-profile-action="rename" data-profile-id="${profile.id}">Rename</button>
                    <button class="btn btn-secondary btn-compact" type="button" data-hunt-profile-action="delete" data-profile-id="${profile.id}">Delete</button>
                </div>
            `;
            fragment.appendChild(row);
        }

        dom.huntProfileList.appendChild(fragment);
        this.renderReadyStatus();
    }

    private renderStrategySelection(): void {
        const container = this.getDom().huntStrategyList;
        const selected = new Set(this.uiState.runSettings.selectedStrategyKeys);
        container.innerHTML = "";
        this.strategyToggles.clear();
        this.strategyItems.clear();
        this.strategyOrder = [];
        this.lastStrategyToggleKey = null;

        const fragment = document.createDocumentFragment();
        const strategies = strategyRegistry.getAll();
        getStrategyList().forEach(({ key, name }) => {
            const strategy = strategies[key];
            const displayName = strategy?.name ?? name;
            const kind = getStrategyKind(key, strategy);
            const item = document.createElement("div");
            item.className = "strategy-list-item";
            item.dataset.strategyKey = key;
            item.dataset.strategyName = `${key} ${displayName}`.toLowerCase();
            item.dataset.strategyKind = kind;
            item.title = getStrategyKindTitle(kind);

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = `hunt-strategy-${key}`;
            checkbox.checked = selected.has(key);
            checkbox.dataset.strategyKey = key;

            const label = document.createElement("label");
            label.htmlFor = `hunt-strategy-${key}`;
            label.textContent = key;
            label.title = displayName;

            item.appendChild(checkbox);
            item.appendChild(label);
            fragment.appendChild(item);

            this.strategyToggles.set(key, checkbox);
            this.strategyItems.set(key, item);
            this.strategyOrder.push(key);
        });

        container.appendChild(fragment);
        this.applyStrategyFilter();
        this.syncStrategySelectionUi();
    }

    private handleStrategyToggleClick(strategyKey: string, event: MouseEvent): void {
        const checkbox = this.strategyToggles.get(strategyKey);
        if (!checkbox) {
            return;
        }

        if (event.shiftKey && this.lastStrategyToggleKey) {
            const orderedKeys = this.getStrategyKeysForRangeSelection();
            const startIndex = orderedKeys.indexOf(this.lastStrategyToggleKey);
            const endIndex = orderedKeys.indexOf(strategyKey);
            if (startIndex !== -1 && endIndex !== -1) {
                const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
                this.setStrategySelection(orderedKeys.slice(from, to + 1), checkbox.checked, false);
            }
        }

        this.lastStrategyToggleKey = strategyKey;
    }

    private getStrategyKeysForRangeSelection(): string[] {
        const visibleKeys = this.getVisibleStrategyKeys();
        return visibleKeys.length > 0 ? visibleKeys : this.strategyOrder;
    }

    private getVisibleStrategyKeys(): string[] {
        return this.strategyOrder.filter((key) => {
            const item = this.strategyItems.get(key);
            return item ? !item.hidden : false;
        });
    }

    private setStrategySelection(strategyKeys: Iterable<string>, checked: boolean, syncUi = true): void {
        for (const key of strategyKeys) {
            const toggle = this.strategyToggles.get(key);
            if (toggle) {
                toggle.checked = checked;
            }
        }

        if (syncUi) {
            this.syncStrategySelectionUi();
            this.persistSelectedStrategies();
        }
    }

    private invertStrategySelection(strategyKeys: Iterable<string>): void {
        for (const key of strategyKeys) {
            const toggle = this.strategyToggles.get(key);
            if (toggle) {
                toggle.checked = !toggle.checked;
            }
        }
        this.syncStrategySelectionUi();
        this.persistSelectedStrategies();
    }

    private applyStrategyFilter(): void {
        const query = this.getDom().huntStrategySearch.value.trim().toLowerCase();
        this.strategyItems.forEach((item) => {
            const strategyName = item.dataset.strategyName ?? "";
            item.hidden = query.length > 0 && !strategyName.includes(query);
        });
        this.syncStrategySelectionUi();
    }

    private syncStrategySelectionUi(): void {
        const dom = this.getDom();
        const visibleKeys = this.getVisibleStrategyKeys();
        const visibleSet = new Set(visibleKeys);
        let selectedCount = 0;
        let visibleSelectedCount = 0;

        this.strategyToggles.forEach((toggle, key) => {
            if (!toggle.checked) {
                return;
            }
            selectedCount += 1;
            if (visibleSet.has(key)) {
                visibleSelectedCount += 1;
            }
        });

        dom.huntStrategiesToggleAll.checked = selectedCount > 0 && selectedCount === this.strategyOrder.length;
        dom.huntStrategiesToggleAll.indeterminate = selectedCount > 0 && selectedCount < this.strategyOrder.length;
        dom.huntStrategySelectVisible.disabled = visibleKeys.length === 0;
        dom.huntStrategyInvertVisible.disabled = visibleKeys.length === 0;

        const hasFilter = dom.huntStrategySearch.value.trim().length > 0;
        dom.huntStrategySummary.textContent = hasFilter
            ? `${selectedCount} selected | ${visibleKeys.length} visible | ${visibleSelectedCount} visible selected`
            : `${selectedCount} selected`;
    }

    private persistSelectedStrategies(): void {
        this.uiState.runSettings.selectedStrategyKeys = this.strategyOrder.filter((key) => {
            const toggle = this.strategyToggles.get(key);
            return Boolean(toggle?.checked);
        });
        this.persistUiState();
    }

    private populateSavedConfigs(): void {
        const dom = this.getDom();
        const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());
        const previousValue = dom.huntSavedConfigSelect.value;
        dom.huntSavedConfigSelect.innerHTML = '<option value="">-- Select configuration --</option>';

        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = `${config.name} | ${config.strategyKey}`;
            dom.huntSavedConfigSelect.appendChild(option);
        }

        if (configs.some((config) => config.name === previousValue)) {
            dom.huntSavedConfigSelect.value = previousValue;
        }
    }

    private applyRunSettingsToDom(): void {
        const dom = this.getDom();
        const settings = this.uiState.runSettings;
        dom.huntPolymarketToggle.checked = settings.polymarketScoringEnabled;
        dom.huntPolymarketExitMode.value = settings.polymarketExitMode;
        dom.huntPolymarketRankMode.value = settings.polymarketRankMode;
        dom.huntPolymarketMinScored.value = String(settings.polymarketMinScoredPredictions);
        dom.huntPolymarketLockOffset.checked = settings.polymarketLockOffset;
        dom.huntPolymarketAfterTakeProfitOnly.checked = settings.polymarketAfterTakeProfitOnly;
        dom.huntPolymarketSignalExitAllowMultipleTradesPerEvent.checked = settings.polymarketSignalExitAllowMultipleTradesPerEvent;
        dom.huntFreezeRiskManagementToggle.checked = settings.freezeRiskManagement;
        dom.huntTradesToggle.checked = settings.tradeCountFilterEnabled;
        dom.huntTradesMin.value = String(settings.minTrades);
        dom.huntTradesMax.value = settings.maxTrades >= HUNT_MAX_TRADES_UNBOUNDED ? "" : String(settings.maxTrades);
        this.syncAdvancedUi();
    }

    private persistRunSettingsFromDom(): void {
        this.uiState.runSettings = this.readRunSettingsFromDom();
        const dom = this.getDom();
        if (dom.huntPolymarketRankMode.value !== this.uiState.runSettings.polymarketRankMode) {
            dom.huntPolymarketRankMode.value = this.uiState.runSettings.polymarketRankMode;
        }
        this.persistUiState();
        this.renderReadyStatus();
    }

    private readRunSettingsFromDom(): HuntRunSettings {
        const dom = this.getDom();
        const tradeCountFilterEnabled = dom.huntTradesToggle.checked;
        const minTrades = tradeCountFilterEnabled ? Math.max(0, Math.round(this.readNumber(dom.huntTradesMin.value, 40))) : 0;
        const maxTradesInput = parseInputNumber(dom.huntTradesMax.value);
        const maxTrades = !tradeCountFilterEnabled || maxTradesInput === null || maxTradesInput <= 0
            ? HUNT_MAX_TRADES_UNBOUNDED
            : Math.max(minTrades, Math.round(maxTradesInput));
        const polymarketExitMode = resolvePolymarketExitMode(dom.huntPolymarketExitMode.value);
        const polymarketRankMode = normalizeHuntPolymarketRankMode(
            dom.huntPolymarketRankMode.value as HuntRunSettings["polymarketRankMode"],
            polymarketExitMode
        );

        return {
            ...this.uiState.runSettings,
            selectedStrategyKeys: [...this.uiState.runSettings.selectedStrategyKeys],
            polymarketScoringEnabled: dom.huntPolymarketToggle.checked,
            polymarketRankMode,
            polymarketMinScoredPredictions: Math.max(0, Math.round(this.readNumber(dom.huntPolymarketMinScored.value, 0))),
            polymarketLockOffset: dom.huntPolymarketLockOffset.checked,
            polymarketAfterTakeProfitOnly: dom.huntPolymarketAfterTakeProfitOnly.checked,
            polymarketSignalExitAllowMultipleTradesPerEvent: dom.huntPolymarketSignalExitAllowMultipleTradesPerEvent.checked,
            polymarketExitMode,
            freezeRiskManagement: dom.huntFreezeRiskManagementToggle.checked,
            tradeCountFilterEnabled,
            minTrades,
            maxTrades,
        };
    }

    private readNumber(value: string, fallback: number): number {
        const parsed = parseInputNumber(value);
        return parsed === null ? fallback : parsed;
    }

    private syncAdvancedUi(): void {
        const dom = this.getDom();
        setVisible(dom.huntAdvancedSettings, dom.huntAdvancedToggle.checked);
        dom.huntPolymarketSettings.classList.toggle("is-disabled", !dom.huntPolymarketToggle.checked);
        dom.huntPolymarketExitMode.disabled = !dom.huntPolymarketToggle.checked;
        dom.huntPolymarketRankMode.disabled = !dom.huntPolymarketToggle.checked;
        dom.huntPolymarketMinScored.disabled = !dom.huntPolymarketToggle.checked;
        dom.huntPolymarketLockOffset.disabled = !dom.huntPolymarketToggle.checked;
        dom.huntPolymarketAfterTakeProfitOnly.disabled = !dom.huntPolymarketToggle.checked;
        dom.huntPolymarketSignalExitAllowMultipleTradesPerEvent.disabled = !dom.huntPolymarketToggle.checked;
        this.syncPolymarketRankModeOptions();

        const exitMode = this.uiState.runSettings.polymarketExitMode;
        if (isSameEventPolymarketExitMode(exitMode)) {
            dom.huntPolymarketLockOffset.disabled = true;
        } else {
            dom.huntPolymarketSignalExitAllowMultipleTradesPerEvent.disabled = true;
        }

        dom.huntTradesMin.disabled = !dom.huntTradesToggle.checked;
        dom.huntTradesMax.disabled = !dom.huntTradesToggle.checked;
        dom.huntTradeFilters.classList.toggle("is-disabled", !dom.huntTradesToggle.checked);
        this.renderReadyStatus();
    }

    private syncPolymarketRankModeOptions(): void {
        const dom = this.getDom();
        const isSameEventExit = isSameEventPolymarketExitMode(this.uiState.runSettings.polymarketExitMode);
        for (const option of Array.from(dom.huntPolymarketRankMode.options)) {
            option.disabled = isSameEventExit && option.value !== normalizeHuntPolymarketRankMode(
                option.value as HuntRunSettings["polymarketRankMode"],
                this.uiState.runSettings.polymarketExitMode
            );
        }
        const normalizedRankMode = normalizeHuntPolymarketRankMode(
            dom.huntPolymarketRankMode.value as HuntRunSettings["polymarketRankMode"],
            this.uiState.runSettings.polymarketExitMode
        );
        if (dom.huntPolymarketRankMode.value !== normalizedRankMode) {
            dom.huntPolymarketRankMode.value = normalizedRankMode;
        }
    }

    private setResultsView(view: HuntResultsView): void {
        this.uiState.resultsView = view;
        this.persistUiState();
        this.renderResults();
    }

    private setImportStatus(message: string): void {
        this.getDom().huntImportStatus.textContent = message;
    }

    private renderProgress(progress: HuntRunProgress): void {
        const dom = this.getDom();
        dom.huntProgressFill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
        dom.huntProgressText.textContent = progress.status;
        dom.huntCurrentProfileLabel.textContent = progress.currentProfileLabel;
        dom.huntCurrentStrategyLabel.textContent = progress.currentStrategyLabel;
        dom.huntProgressCounts.textContent = `${progress.processedProfiles} / ${progress.totalProfiles}`;
        dom.huntStatus.textContent = progress.status;
    }

    private appendProgressMessage(message: HuntRunMessage): void {
        this.progressMessages = [...this.progressMessages, message].slice(-12);
        this.renderMessages();
    }

    private renderMessages(): void {
        const container = this.getDom().huntMessages;
        container.innerHTML = "";

        for (const message of this.progressMessages) {
            const row = document.createElement("div");
            row.className = `hunt-message hunt-message--${message.level}`;
            row.textContent = message.text;
            container.appendChild(row);
        }
    }

    private renderReadyStatus(): void {
        if (this.runController) {
            return;
        }

        const dom = this.getDom();
        const enabledProfiles = this.getEnabledProfiles();
        const selectedProfile = this.getSelectedProfile();
        const selectedProfileOnly = dom.huntRunSelectedProfileOnly.checked;

        if (enabledProfiles.length === 0) {
            dom.huntStatus.textContent = "Ready. No Hunt profiles are enabled.";
            return;
        }

        if (selectedProfileOnly) {
            if (!selectedProfile) {
                dom.huntStatus.textContent = "Ready. Selected-profile-only mode is enabled, but no profile is selected.";
                return;
            }
            dom.huntStatus.textContent = `Ready. Selected-profile-only mode will run ${selectedProfile.name}. ${enabledProfiles.length} profile${enabledProfiles.length === 1 ? "" : "s"} are enabled.`;
            return;
        }

        dom.huntStatus.textContent = `Ready. ${enabledProfiles.length} enabled profile${enabledProfiles.length === 1 ? "" : "s"} will run.`;
    }

    private renderResults(): void {
        const dom = this.getDom();
        const resultsView = this.uiState.resultsView;
        const hasResults = Boolean(this.runOutput && (this.runOutput.profileResults.length > 0 || this.runOutput.survivors.length > 0));
        setVisible(dom.huntResultsEmpty, !hasResults);
        setVisible(dom.huntSurvivorList, hasResults && resultsView === "survivors");
        setVisible(dom.huntPerProfileList, hasResults && resultsView === "per_profile");

        dom.huntViewSurvivors.disabled = resultsView === "survivors";
        dom.huntViewPerProfile.disabled = resultsView === "per_profile";

        if (!this.runOutput) {
            dom.huntResultsSummary.textContent = "No Hunt results yet.";
            dom.huntSurvivorList.innerHTML = "";
            dom.huntPerProfileList.innerHTML = "";
            this.renderMessages();
            return;
        }

        const visibleSurvivors = this.runOutput.survivors.slice(0, this.runOutput.runSettings.globalTopN);
        dom.huntResultsSummary.textContent = `${this.runOutput.survivors.length} survivor groups from ${this.runOutput.profileResults.length} kept candidates across the latest Hunt run.`;

        this.renderSurvivors(visibleSurvivors);
        this.renderPerProfile(this.runOutput.profileResults);
        this.progressMessages = [...this.runOutput.messages];
        this.renderMessages();
    }

    private renderSurvivors(survivors: readonly HuntSurvivorGroup[]): void {
        const container = this.getDom().huntSurvivorList;
        container.innerHTML = "";
        const primaryMetric = this.runOutput?.primaryMetric ?? "expectancy";
        const metricLabel = getFinderMetricLabel(primaryMetric);
        const totalProfiles = this.runOutput
            ? this.runOutput.profileResults.reduce((set, result) => {
                set.add(result.profileId);
                return set;
            }, new Set<string>()).size
            : 0;

        survivors.forEach((survivor, index) => {
            const row = document.createElement("div");
            row.className = "finder-row";
            row.innerHTML = `
                <div class="finder-rank">${index + 1}</div>
                <div class="finder-main">
                    <div class="finder-title">${survivor.strategyName}</div>
                    <div class="finder-sub">${survivor.strategyKey} | survived ${survivor.appearances}/${totalProfiles || survivor.appearances} profiles | best ${survivor.bestCandidate.profileName}</div>
                    <div class="finder-params">${formatParams(survivor.params)}</div>
                    <div class="finder-metrics">
                        <span>${metricLabel} best ${formatHuntMetricValue(primaryMetric, survivor.bestPrimaryMetric)}</span>
                        <span>${metricLabel} median ${formatHuntMetricValue(primaryMetric, survivor.medianPrimaryMetric)}</span>
                        <span>Best rank ${survivor.bestLocalRank}</span>
                        <span>Median rank ${survivor.medianLocalRank.toFixed(1)}</span>
                    </div>
                </div>
                <button class="btn btn-secondary finder-apply" type="button" data-hunt-apply-survivor="true" data-index="${index}">Apply Result</button>
            `;
            container.appendChild(row);
        });
    }

    private renderPerProfile(results: readonly HuntProfileRunResult[]): void {
        const container = this.getDom().huntPerProfileList;
        container.innerHTML = "";
        const primaryMetric = this.runOutput?.primaryMetric ?? "expectancy";

        results.forEach((entry, index) => {
            const metricValue = getFinderMetricValue(entry.result, primaryMetric);
            const row = document.createElement("div");
            row.className = "finder-row";
            row.innerHTML = `
                <div class="finder-rank">${entry.localRank}</div>
                <div class="finder-main">
                    <div class="finder-title">${entry.result.name}</div>
                    <div class="finder-sub">${entry.profileName} | ${entry.symbol} ${entry.interval}</div>
                    <div class="finder-params">${formatParams(entry.result.params)}</div>
                    <div class="finder-metrics">
                        <span>${getFinderMetricLabel(primaryMetric)} ${formatHuntMetricValue(primaryMetric, metricValue)}</span>
                        <span>Trades ${entry.result.selectionResult.totalTrades}</span>
                        <span>PF ${formatHuntMetricValue("profitFactor", entry.result.selectionResult.profitFactor)}</span>
                        <span>DD ${formatHuntMetricValue("maxDrawdownPercent", entry.result.selectionResult.maxDrawdownPercent)}</span>
                    </div>
                </div>
                <button class="btn btn-secondary finder-apply" type="button" data-hunt-apply-profile-result="true" data-index="${index}">Apply Result</button>
            `;
            container.appendChild(row);
        });
    }

    private resolveRunnableProfiles(): HuntProfile[] {
        const dom = this.getDom();
        if (!dom.huntRunSelectedProfileOnly.checked) {
            return this.getEnabledProfiles();
        }

        const selectedProfileId = this.uiState.selectedProfileId;
        if (!selectedProfileId) {
            return [];
        }

        const selected = this.findProfile(selectedProfileId);
        return selected ? [selected] : [];
    }

    private async runHunt(): Promise<void> {
        if (this.runController) {
            return;
        }

        const runSettings = this.readRunSettingsFromDom();
        this.uiState.runSettings = runSettings;
        this.persistUiState();

        const enabledProfiles = this.getEnabledProfiles();
        const runnableProfiles = this.resolveRunnableProfiles();
        const selectedProfileOnly = this.getDom().huntRunSelectedProfileOnly.checked;
        const selectedProfile = this.getSelectedProfile();
        if (runnableProfiles.length === 0) {
            uiManager.showToast("Enable a Hunt profile, or select one profile to run.", "error");
            return;
        }
        if (runSettings.selectedStrategyKeys.length === 0) {
            uiManager.showToast("Select at least one strategy for Hunt.", "error");
            return;
        }

        if (selectedProfileOnly && enabledProfiles.length > 1 && selectedProfile) {
            uiManager.showToast(
                `Run Selected Profile Only is enabled. Hunt will run ${selectedProfile.name} only.`,
                "info"
            );
        }

        const dom = this.getDom();
        dom.huntRunBtn.disabled = true;
        setVisible(dom.huntCancelBtn, true);
        this.progressMessages = [];
        this.renderMessages();
        this.runOutput = null;
        this.renderResults();

        this.runController = createHuntRunController(
            {
                profiles: runnableProfiles,
                runSettings,
            },
            {
                onProgress: (progress) => {
                    this.renderProgress(progress);
                },
                onMessage: (message) => {
                    this.appendProgressMessage(message);
                },
            }
        );

        try {
            const output = await this.runController.run();
            this.runOutput = output;
            this.renderResults();
            const processedProfiles = output.profileResults.reduce((ids, result) => {
                ids.add(result.profileId);
                return ids;
            }, new Set<string>()).size;
            const selectedOnlySummary = selectedProfileOnly && enabledProfiles.length > runnableProfiles.length && selectedProfile
                ? `${selectedProfile.name} only. ${enabledProfiles.length} profiles were enabled.`
                : null;
            this.renderProgress({
                percent: 100,
                status: output.cancelled
                    ? selectedOnlySummary ? `Hunt cancelled. Selected-profile-only mode ran ${selectedOnlySummary}` : "Hunt cancelled."
                    : selectedOnlySummary ? `Hunt completed. Selected-profile-only mode ran ${selectedOnlySummary}` : "Hunt completed.",
                currentProfileLabel: output.cancelled
                    ? (selectedOnlySummary && selectedProfile ? selectedProfile.name : "Cancelled")
                    : (selectedOnlySummary && selectedProfile ? selectedProfile.name : "Complete"),
                currentStrategyLabel: `${output.runSettings.selectedStrategyKeys.length} strategy libs`,
                processedProfiles,
                totalProfiles: runnableProfiles.length,
                processedStrategies: output.runSettings.selectedStrategyKeys.length,
                totalStrategies: output.runSettings.selectedStrategyKeys.length,
            });
            uiManager.showToast(output.cancelled ? "Hunt cancelled." : "Hunt completed.", output.cancelled ? "info" : "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLogger.error("hunt.run_failed", { error: message });
            this.renderProgress({
                percent: 0,
                status: `Hunt failed. ${message}`,
                currentProfileLabel: "Idle",
                currentStrategyLabel: "0 / 0",
                processedProfiles: 0,
                totalProfiles: runnableProfiles.length,
                processedStrategies: 0,
                totalStrategies: runSettings.selectedStrategyKeys.length,
            });
            uiManager.showToast("Hunt run failed. Check the Hunt status panel for details.", "error");
        } finally {
            this.runController = null;
            dom.huntRunBtn.disabled = false;
            setVisible(dom.huntCancelBtn, false);
        }
    }

    private async applyRunResult(tagged: HuntProfileRunResult): Promise<void> {
        const profile = this.findProfile(tagged.profileId);
        if (!profile) {
            uiManager.showToast("The Hunt profile for this result no longer exists.", "error");
            return;
        }

        clearBacktestResults("hunt.apply_result");
        const mergedBacktestSettings = mergeFinderRiskParamsIntoBacktestSettings(
            mergeCapitalSettingsIntoBacktestSettingsData(profile.backtestSettings, profile.capitalSettings),
            tagged.result.params,
            this.runOutput?.finderOptions
        );
        const effectiveExitMode = this.runOutput?.finderOptions?.polymarketExitMode ?? "resolve_hold";
        const applyLimitEntryEvalSettings = (): void => {
            const evalSummary = tagged.result.polymarketEval;
            if (!evalSummary?.limitEntryEnabled) {
                return;
            }
            mergedBacktestSettings.polymarketPostSignalLimitEntryEnabled = true;
            mergedBacktestSettings.polymarketPostSignalLimitEntryMode = resolvePolymarketPostSignalLimitEntryMode(
                evalSummary.limitEntryMode
            );
            mergedBacktestSettings.polymarketPostSignalLimitEntryPriceCents = clampPolymarketPostSignalLimitEntryPriceCents(
                evalSummary.limitEntryPriceCents ?? mergedBacktestSettings.polymarketPostSignalLimitEntryPriceCents
            );
            mergedBacktestSettings.polymarketPostSignalLimitEntryOffsetCents = clampPolymarketPostSignalLimitOffsetCents(
                evalSummary.limitEntryOffsetCents ?? mergedBacktestSettings.polymarketPostSignalLimitEntryOffsetCents
            );
            mergedBacktestSettings.polymarketPostSignalLimitExitEnabled = evalSummary.limitExitEnabled === true;
            mergedBacktestSettings.polymarketPostSignalLimitExitMode = resolvePolymarketPostSignalLimitExitMode(
                evalSummary.limitExitMode
            );
            mergedBacktestSettings.polymarketPostSignalLimitExitPriceCents = clampPolymarketPostSignalLimitExitPriceCents(
                evalSummary.limitExitPriceCents ?? mergedBacktestSettings.polymarketPostSignalLimitExitPriceCents
            );
            mergedBacktestSettings.polymarketPostSignalLimitExitOffsetCents = clampPolymarketPostSignalLimitOffsetCents(
                evalSummary.limitExitOffsetCents ?? mergedBacktestSettings.polymarketPostSignalLimitExitOffsetCents
            );
        };
        if (isSameEventPolymarketExitMode(effectiveExitMode)) {
            mergedBacktestSettings.polymarketAnnotationEnabled = true;
            mergedBacktestSettings.polymarketExitMode = effectiveExitMode;
            mergedBacktestSettings.polymarketSignalExitAllowMultipleTradesPerEvent = this.runOutput?.finderOptions?.polymarketSignalExitAllowMultipleTradesPerEvent === true;
            if (tagged.result.polymarketEval?.limitEntryEnabled) {
                applyLimitEntryEvalSettings();
            }
        } else if (tagged.result.polymarketEval?.limitEntryEnabled) {
            mergedBacktestSettings.polymarketAnnotationEnabled = true;
            applyLimitEntryEvalSettings();
        } else if (Number.isFinite(tagged.result.params.polymarketEntryOffset)) {
            mergedBacktestSettings.polymarketEntryOffset = Math.max(
                0,
                Math.min(4, Math.round(Number(tagged.result.params.polymarketEntryOffset)))
            );
            if (tagged.result.polymarketEval) {
                mergedBacktestSettings.polymarketAnnotationEnabled = true;
            }
        }

        settingsManager.applyBacktestSettings(mergedBacktestSettings);
        dataManager.suppressNextAutoReload(getMarketSelectionAutoReloadSuppressCount(
            {
                symbol: state.currentSymbol,
                interval: state.currentInterval,
            },
            profile
        ));
        await dataManager.loadData(profile.symbol, profile.interval);
        setBlockRange(cloneBlockRange(profile.blockRange));

        setCurrentStrategyKey(tagged.result.key);
        const strategy = strategyRegistry.get(tagged.result.key)
            ?? await loadBuiltInStrategyByKey(tagged.result.key);
        if (!strategy) {
            uiManager.showToast(`Strategy "${tagged.result.key}" is no longer available.`, "error");
            return;
        }

        paramManager.setValues(strategy, tagged.result.params);
        strategyPanelController.switchTab("trades");

        if (tagged.result.endpointAdjusted) {
            uiManager.showToast(
                "Hunt ranked this row on an endpoint-adjusted selection snapshot. Running the raw backtest now.",
                "info"
            );
        }

        try {
            await backtestService.runCurrentBacktest();
            if (tagged.result.polymarketEval) {
                uiManager.showToast(
                    `Applied Polymarket params: ${(tagged.result.polymarketEval.winRate * 100).toFixed(1)}% Finder win rate, ${tagged.result.polymarketEval.scoredPredictions} scored predictions. Backtest trades refreshed below.`,
                    "success"
                );
            } else {
                uiManager.showToast(`Applied Hunt result from ${tagged.profileName}.`, "success");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLogger.error("hunt.apply_result_failed", {
                profileId: tagged.profileId,
                strategyKey: tagged.result.key,
                error: message,
            });
            uiManager.showToast("Backtest rerun failed after applying Hunt result.", "error");
        }
    }
}

export const huntService = new HuntService();
