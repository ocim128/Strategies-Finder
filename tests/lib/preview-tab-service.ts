import { createPreviewTabDom, type PreviewTabDom } from "./preview-tab-dom";
import { settingsManager, sortStrategyConfigsNewestFirst, type StrategyConfig } from "./settings-manager";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { state } from "./state";
import { uiManager } from "./ui-manager";
import type { Strategy, StrategyParams, TradeDirection } from "./types/strategies";
import { buildExecutionAwarePreview } from "./preview-tab-model";
import { dataManager } from "./data-manager";

export const STRATEGY_CONFIGS_CHANGED_EVENT = "strategy-configs:changed";

type PreviewSourceMode = "current" | "saved";

class PreviewTabService {
    private static readonly STALE_REFRESH_INTERVAL_MS = 15_000;

    private dom: PreviewTabDom | null = null;
    private liveIntervalId: number | null = null;
    private activeTab = false;
    private lastPreviewStale = false;
    private lastDataRefreshAt = 0;
    private refreshInFlight: Promise<void> | null = null;

    private getDom(): PreviewTabDom {
        return this.dom ??= createPreviewTabDom();
    }

    public init(): void {
        const dom = this.getDom();
        this.bindControlEvents(dom);
        this.bindAppEvents();
        this.refreshSavedConfigOptions();
        this.refreshPreview();
    }

    public refreshPreview(): void {
        const context = this.resolvePreviewContext();
        if (!context) {
            this.lastPreviewStale = false;
            uiManager.updateEntryPreview(null);
            return;
        }

        const rawPreview = context.strategy.entryPreview
            ? context.strategy.entryPreview(state.ohlcvData, context.params)
            : null;
        const preview = rawPreview
            ? buildExecutionAwarePreview(rawPreview, context.tradeDirection)
            : null;
        this.lastPreviewStale = Boolean(preview?.meta?.isStaleData);
        uiManager.updateEntryPreview(preview);
    }

    public async refreshDataAndPreview(): Promise<void> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        const dom = this.getDom();
        const previousLabel = dom.previewRefreshBtn.textContent;
        dom.previewRefreshBtn.disabled = true;
        dom.previewRefreshBtn.textContent = "Refreshing...";

        this.refreshInFlight = (async () => {
            try {
                await dataManager.loadData(state.currentSymbol, state.currentInterval);
                this.lastDataRefreshAt = Date.now();
            } finally {
                this.refreshPreview();
                dom.previewRefreshBtn.disabled = false;
                dom.previewRefreshBtn.textContent = previousLabel;
                this.refreshInFlight = null;
            }
        })();

        return this.refreshInFlight;
    }

    private bindControlEvents(dom: PreviewTabDom): void {
        dom.previewSourceMode.addEventListener("change", () => {
            this.updateControlState();
            this.refreshPreview();
        });
        dom.previewSavedConfig.addEventListener("focus", () => this.refreshSavedConfigOptions());
        dom.previewSavedConfig.addEventListener("change", () => this.refreshPreview());
        dom.previewFollowDirectionToggle.addEventListener("change", () => this.refreshPreview());
        dom.previewLiveModeToggle.addEventListener("change", () => {
            this.syncLiveTimer();
            this.refreshPreview();
        });
        dom.previewRefreshBtn.addEventListener("click", () => {
            void this.refreshDataAndPreview();
        });

        document.addEventListener("input", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (
                target.closest("#strategyParams")
                || target.id === "tradeDirection"
                || target.id === "strategySelect"
            ) {
                this.refreshPreview();
            }
        });

        document.addEventListener("change", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (
                target.closest("#strategyParams")
                || target.id === "tradeDirection"
                || target.id === "strategySelect"
            ) {
                this.refreshPreview();
            }
        });
    }

    private bindAppEvents(): void {
        window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId?: string }>) => {
            this.activeTab = event.detail?.tabId === "preview";
            if (this.activeTab) {
                this.refreshSavedConfigOptions();
                this.refreshPreview();
            }
            this.syncLiveTimer();
        }) as EventListener);

        window.addEventListener(STRATEGY_CONFIGS_CHANGED_EVENT, () => {
            this.refreshSavedConfigOptions();
            this.refreshPreview();
        });
    }

    private updateControlState(): void {
        const dom = this.getDom();
        const sourceMode = this.getSourceMode();
        dom.previewSavedConfig.disabled = sourceMode !== "saved";
    }

    private refreshSavedConfigOptions(): void {
        const dom = this.getDom();
        const currentValue = dom.previewSavedConfig.value;
        const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());

        dom.previewSavedConfig.innerHTML = '<option value="">Select saved configuration</option>';
        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = config.name;
            dom.previewSavedConfig.appendChild(option);
        }

        if (configs.some((config) => config.name === currentValue)) {
            dom.previewSavedConfig.value = currentValue;
        }

        this.updateControlState();
    }

    private resolvePreviewContext():
        | { strategy: Strategy; params: StrategyParams; tradeDirection: TradeDirection }
        | null {
        const sourceMode = this.getSourceMode();
        if (sourceMode === "saved") {
            return this.resolveSavedConfigContext();
        }
        return this.resolveCurrentContext();
    }

    private resolveCurrentContext():
        | { strategy: Strategy; params: StrategyParams; tradeDirection: TradeDirection }
        | null {
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (!strategy) return null;

        const params = paramManager.getValues(strategy);
        const tradeDirection = settingsManager.getBacktestSettings().tradeDirection ?? "short";
        return { strategy, params, tradeDirection };
    }

    private resolveSavedConfigContext():
        | { strategy: Strategy; params: StrategyParams; tradeDirection: TradeDirection }
        | null {
        const dom = this.getDom();
        const configName = dom.previewSavedConfig.value.trim();
        if (!configName) return null;

        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) return null;

        const strategy = strategyRegistry.get(config.strategyKey);
        if (!strategy) return null;

        const tradeDirection = this.resolveTradeDirectionForConfig(config);
        return {
            strategy,
            params: config.strategyParams,
            tradeDirection,
        };
    }

    private resolveTradeDirectionForConfig(config: StrategyConfig): TradeDirection {
        const dom = this.getDom();
        if (dom.previewFollowDirectionToggle.checked) {
            return settingsManager.getBacktestSettings().tradeDirection ?? "short";
        }
        return config.backtestSettings.tradeDirection ?? "short";
    }

    private getSourceMode(): PreviewSourceMode {
        return this.getDom().previewSourceMode.value === "saved" ? "saved" : "current";
    }

    private syncLiveTimer(): void {
        if (this.liveIntervalId !== null) {
            clearInterval(this.liveIntervalId);
            this.liveIntervalId = null;
        }

        const dom = this.getDom();
        if (!this.activeTab || !dom.previewLiveModeToggle.checked) {
            return;
        }

        this.liveIntervalId = window.setInterval(() => {
            if (
                this.lastPreviewStale
                && Date.now() - this.lastDataRefreshAt >= PreviewTabService.STALE_REFRESH_INTERVAL_MS
            ) {
                void this.refreshDataAndPreview();
                return;
            }

            this.refreshPreview();
        }, 1000);
    }
}

export const previewTabService = new PreviewTabService();
