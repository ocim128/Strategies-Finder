import { state } from "./state";
import { createStrategyPanelDom } from "./strategy-panel-dom";
import { debugLogger } from "./debug-logger";
import { readPersistedJson, writePersistedJson } from "./persisted-json";

const STORAGE_KEY = "strategyPanelLayout";
const MOBILE_BREAKPOINT_PX = 960;
const MIN_PANEL_WIDTH_PX = 280;

interface StrategyPanelLayoutState {
    activeTabId: string | null;
    collapsed: boolean;
    widthPx: number | null;
}

const DEFAULT_LAYOUT_STATE: StrategyPanelLayoutState = {
    activeTabId: null,
    collapsed: false,
    widthPx: null,
};

const STRATEGY_PANEL_LAYOUT_STORAGE = {
    key: STORAGE_KEY,
    schema: "strategy-panel.layout",
    version: 1,
} as const;

interface SwitchTabOptions {
    focus?: boolean;
    persist?: boolean;
    revealPanel?: boolean;
}

class StrategyPanelController {
    private dom: ReturnType<typeof createStrategyPanelDom> | null = null;
    private orderedTabIds: string[] = [];
    private tabButtons = new Map<string, HTMLButtonElement>();
    private tabPanels = new Map<string, HTMLElement>();
    private moreItems = new Map<string, HTMLButtonElement>();
    private secondaryPanels = new Map<string, HTMLElement>();
    private allowedTabs: Set<string> | null = null;
    private activeTabId: string | null = null;
    private isResizing = false;
    private pendingWidthPx: number | null = null;
    private initialized = false;
    private handlePointerMove: ((event: PointerEvent) => void) | null = null;
    private handleStopResizing: ((event?: PointerEvent) => void) | null = null;
    private tabClickListeners = new Map<string, () => void>();
    private tabKeydownListeners = new Map<string, (event: KeyboardEvent) => void>();
    private togglePanelClickListener: (() => void) | null = null;
    private panelResizeHandlePointerDownListener: ((event: PointerEvent) => void) | null = null;
    private pendingChartSyncFrame: number | null = null;
    private moreMenuOpen = false;
    private moreTriggerClickListener: (() => void) | null = null;
    private moreMenuItemClickListener = new Map<string, () => void>();
    private moreMenuKeydownListener: ((event: KeyboardEvent) => void) | null = null;
    private documentClickListenerForMore: ((event: MouseEvent) => void) | null = null;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createStrategyPanelDom();
        this.captureTabs();
        this.captureMoreItems();
        this.bindEvents();
        this.restoreLayoutState();
        this.initialized = true;
    }

    public destroy(): void {
        const dom = this.dom;

        if (dom) {
            this.tabButtons.forEach((tab, tabId) => {
                const clickListener = this.tabClickListeners.get(tabId);
                const keydownListener = this.tabKeydownListeners.get(tabId);
                
                if (clickListener) {
                    tab.removeEventListener("click", clickListener);
                }
                if (keydownListener) {
                    tab.removeEventListener("keydown", keydownListener as EventListener);
                }
            });

            if (this.togglePanelClickListener) {
                dom.togglePanel.removeEventListener("click", this.togglePanelClickListener);
            }

            if (this.panelResizeHandlePointerDownListener) {
                dom.panelResizeHandle.removeEventListener("pointerdown", this.panelResizeHandlePointerDownListener as EventListener);
            }

            if (this.moreTriggerClickListener) {
                dom.panelMoreTrigger.removeEventListener("click", this.moreTriggerClickListener);
            }

            this.moreItems.forEach((item, tabId) => {
                const listener = this.moreMenuItemClickListener.get(tabId);
                if (listener) {
                    item.removeEventListener("click", listener);
                }
            });

            if (this.moreMenuKeydownListener) {
                dom.panelMoreMenu.removeEventListener("keydown", this.moreMenuKeydownListener as EventListener);
            }
        }

        if (this.documentClickListenerForMore) {
            document.removeEventListener("click", this.documentClickListenerForMore);
        }

        this.tabClickListeners.clear();
        this.tabKeydownListeners.clear();
        this.togglePanelClickListener = null;
        this.panelResizeHandlePointerDownListener = null;
        this.moreTriggerClickListener = null;
        this.moreMenuItemClickListener.clear();
        this.moreMenuKeydownListener = null;
        this.documentClickListenerForMore = null;
        this.moreMenuOpen = false;

        if (this.handlePointerMove) {
            window.removeEventListener("pointermove", this.handlePointerMove as EventListener);
            this.handlePointerMove = null;
        }
        if (this.handleStopResizing) {
            window.removeEventListener("pointerup", this.handleStopResizing as EventListener);
            window.removeEventListener("pointercancel", this.handleStopResizing as EventListener);
            this.handleStopResizing = null;
        }
        if (this.pendingChartSyncFrame !== null) {
            cancelAnimationFrame(this.pendingChartSyncFrame);
            this.pendingChartSyncFrame = null;
        }

        this.isResizing = false;
        this.pendingWidthPx = null;
        this.initialized = false;
        this.dom = null;
    }

    public switchTab(tabId: string, options: SwitchTabOptions = {}): boolean {
        const dom = this.dom;
        if (!dom || !this.isTabAllowed(tabId)) {
            return false;
        }

        const nextTab = this.tabButtons.get(tabId);
        const nextPanel = this.tabPanels.get(tabId)
            ?? dom.panelContent.querySelector<HTMLElement>(`#${tabId}Tab`);
        if (!nextPanel) {
            return false;
        }

        const {
            focus = false,
            persist = true,
            revealPanel = true,
        } = options;

        if (revealPanel) {
            this.setCollapsed(false, persist);
        }

        this.activeTabId = tabId;

        this.orderedTabIds.forEach((id) => {
            const tab = this.tabButtons.get(id);
            const panel = this.tabPanels.get(id);
            const isActive = id === tabId;

            if (tab) {
                tab.classList.toggle("active", isActive);
                tab.setAttribute("aria-selected", String(isActive));
                tab.tabIndex = isActive ? 0 : -1;
                if (focus && isActive) {
                    tab.focus();
                }
            }

            if (panel) {
                panel.hidden = !isActive;
                panel.style.display = isActive ? "block" : "none";
            }
        });

        // Secondary destinations are reached via the More menu, not via the
        // persistent tab list, so the loop above only manages persistent
        // panels. Remember any secondary panel we show so it can be hidden
        // again when the user switches back to a persistent tab.
        if (!this.tabPanels.has(tabId)) {
            this.secondaryPanels.set(tabId, nextPanel);
        }
        this.secondaryPanels.forEach((panel, id) => {
            const isActive = id === tabId;
            panel.hidden = !isActive;
            panel.style.display = isActive ? "block" : "none";
        });

        if (focus && !nextTab) {
            // A More-menu destination has no persistent tab to focus; keep focus
            // on the trigger so keyboard users land somewhere sensible.
            dom.panelMoreTrigger.focus();
        }

        this.syncMoreTrigger(tabId);

        if (persist) {
            this.saveLayoutState();
        }

        debugLogger.event("ui.tab.switch", { tab: tabId });

        window.dispatchEvent(new CustomEvent("strategy-panel:tab-change", {
            detail: { tabId },
        }));

        return true;
    }

    public switchToShortcut(shortcut: string): boolean {
        const tabId = this.orderedTabIds.find((id) => {
            const tab = this.tabButtons.get(id);
            return tab?.dataset.shortcut === shortcut && this.isTabAllowed(id);
        }) ?? Array.from(this.moreItems.keys()).find((id) => {
            const item = this.moreItems.get(id);
            return item?.dataset.shortcut === shortcut && this.isTabAllowed(id);
        });

        if (!tabId) {
            return false;
        }

        return this.switchTab(tabId, { focus: true });
    }

    public getActiveTabId(): string | null {
        return this.activeTabId;
    }

    public setVisibleTabs(tabIds: Iterable<string> | null): void {
        const dom = this.dom;
        this.allowedTabs = tabIds ? new Set(tabIds) : null;

        this.orderedTabIds.forEach((id) => {
            const tab = this.tabButtons.get(id);
            if (!tab) return;

            const isVisible = this.isTabAllowed(id);
            tab.style.display = isVisible ? "" : "none";
            tab.hidden = !isVisible;
            tab.setAttribute("aria-hidden", String(!isVisible));
            tab.tabIndex = isVisible && id === this.activeTabId ? 0 : -1;
            tab.disabled = !isVisible;
        });

        // Hide the More trigger when the view is restricted (e.g. shared-link
        // mode) to a subset that excludes every secondary destination.
        if (dom) {
            const anySecondaryAllowed = Array.from(this.moreItems.keys()).some((id) => this.isTabAllowed(id));
            const moreContainer = dom.panelMoreTrigger.parentElement;
            if (moreContainer) {
                moreContainer.style.display = anySecondaryAllowed ? "" : "none";
            }
            if (!anySecondaryAllowed) {
                this.closeMoreMenu();
            }
        }

        const activeTabStillVisible = this.activeTabId ? this.isTabAllowed(this.activeTabId) : false;
        if (activeTabStillVisible && this.activeTabId) {
            this.switchTab(this.activeTabId, { persist: false, revealPanel: false });
            return;
        }

        const fallbackTabId = this.getFirstVisibleTabId();
        if (!fallbackTabId) {
            this.activeTabId = null;
            this.tabPanels.forEach((panel) => {
                panel.hidden = true;
                panel.style.display = "none";
            });
            this.secondaryPanels.forEach((panel) => {
                panel.hidden = true;
                panel.style.display = "none";
            });
            return;
        }

        this.switchTab(fallbackTabId, { persist: false });
    }

    public setCollapsed(collapsed: boolean, persist = true): void {
        const dom = this.dom;
        if (!dom) return;

        dom.strategyPanel.classList.toggle("collapsed", collapsed);
        dom.togglePanel.setAttribute("aria-expanded", String(!collapsed));

        if (persist) {
            this.saveLayoutState();
        }

        this.syncCharts(true);
    }

    public toggleCollapsed(): void {
        const dom = this.dom;
        if (!dom) return;

        this.setCollapsed(!dom.strategyPanel.classList.contains("collapsed"));
    }

    private toggleMoreMenu(): void {
        if (this.moreMenuOpen) {
            this.closeMoreMenu();
        } else {
            this.openMoreMenu();
        }
    }

    private openMoreMenu(): void {
        const dom = this.dom;
        if (!dom || this.moreMenuOpen) return;

        this.moreMenuOpen = true;
        dom.panelMoreTrigger.setAttribute("aria-expanded", "true");
        dom.panelMoreMenu.classList.remove("is-hidden");
    }

    private closeMoreMenu(): void {
        const dom = this.dom;
        if (!dom || !this.moreMenuOpen) return;

        this.moreMenuOpen = false;
        dom.panelMoreTrigger.setAttribute("aria-expanded", "false");
        dom.panelMoreMenu.classList.add("is-hidden");
    }

    private syncMoreTrigger(tabId: string): void {
        const dom = this.dom;
        if (!dom) return;

        const isMoreTab = !this.tabButtons.has(tabId);

        dom.panelMoreTrigger.classList.toggle("is-more-active", isMoreTab);

        this.moreItems.forEach((item, id) => {
            item.classList.toggle("active", id === tabId);
            item.setAttribute("aria-current", id === tabId ? "page" : "false");
        });

        // Keep the trigger label fixed as "More". The active tool name belongs
        // in the content heading, not in the navigation strip — renaming the
        // trigger causes the tab geometry to shift after each navigation.
    }

    private captureTabs(): void {
        const dom = this.dom;
        if (!dom) return;

        const tabs = Array.from(dom.strategyTabs.querySelectorAll<HTMLButtonElement>(".panel-tab"));

        this.orderedTabIds = [];
        this.tabButtons.clear();
        this.tabPanels.clear();

        tabs.forEach((tab) => {
            const tabId = tab.dataset.tab?.trim();
            if (!tabId) {
                return;
            }

            const panel = dom.panelContent.querySelector<HTMLElement>(`#${tabId}Tab`);
            if (!panel) {
                return;
            }

            tab.id ||= `strategy-panel-tab-${tabId}`;
            tab.setAttribute("aria-controls", panel.id);
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", tab.id);

            this.orderedTabIds.push(tabId);
            this.tabButtons.set(tabId, tab);
            this.tabPanels.set(tabId, panel);
        });
    }

    private captureMoreItems(): void {
        const dom = this.dom;
        if (!dom) return;

        this.moreItems.clear();
        const items = Array.from(dom.panelMoreMenu.querySelectorAll<HTMLButtonElement>("button[data-tab]"));
        items.forEach((item) => {
            const tabId = item.dataset.tab?.trim();
            if (!tabId) {
                return;
            }
            this.moreItems.set(tabId, item);
        });
    }

    private bindEvents(): void {
        const dom = this.dom;
        if (!dom) return;

        this.tabButtons.forEach((tab, tabId) => {
            const clickListener = () => {
                this.switchTab(tabId);
            };
            this.tabClickListeners.set(tabId, clickListener);
            tab.addEventListener("click", clickListener);

            const keydownListener = (event: KeyboardEvent) => {
                const tabs = this.getVisibleTabs();
                const currentIndex = tabs.indexOf(tab);
                if (currentIndex === -1) {
                    return;
                }

                if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                    event.preventDefault();
                    tabs[(currentIndex + 1) % tabs.length]?.focus();
                    return;
                }

                if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    tabs[(currentIndex - 1 + tabs.length) % tabs.length]?.focus();
                    return;
                }

                if (event.key === "Home") {
                    event.preventDefault();
                    tabs[0]?.focus();
                    return;
                }

                if (event.key === "End") {
                    event.preventDefault();
                    tabs[tabs.length - 1]?.focus();
                    return;
                }

                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    this.switchTab(tabId, { focus: true });
                }
            };
            this.tabKeydownListeners.set(tabId, keydownListener);
            tab.addEventListener("keydown", keydownListener);
        });

        this.togglePanelClickListener = () => {
            this.toggleCollapsed();
        };
        dom.togglePanel.addEventListener("click", this.togglePanelClickListener);

        this.panelResizeHandlePointerDownListener = (event: PointerEvent) => {
            if (this.isMobileLayout()) {
                return;
            }

            if (event.button !== 0) {
                return;
            }

            this.isResizing = true;
            document.body.classList.add("is-resizing");
            dom.panelResizeHandle.classList.add("is-resizing");
            dom.panelResizeHandle.setPointerCapture(event.pointerId);
            event.preventDefault();
        };
        dom.panelResizeHandle.addEventListener("pointerdown", this.panelResizeHandlePointerDownListener);

        this.moreTriggerClickListener = () => {
            this.toggleMoreMenu();
        };
        dom.panelMoreTrigger.addEventListener("click", this.moreTriggerClickListener);

        this.moreItems.forEach((item, tabId) => {
            const itemClickListener = () => {
                this.switchTab(tabId);
                this.closeMoreMenu();
            };
            this.moreMenuItemClickListener.set(tabId, itemClickListener);
            item.addEventListener("click", itemClickListener);
        });

        this.moreMenuKeydownListener = (event: KeyboardEvent) => {
            if (event.key === "Escape" && this.moreMenuOpen) {
                event.preventDefault();
                this.closeMoreMenu();
                dom.panelMoreTrigger.focus();
            }
        };
        dom.panelMoreMenu.addEventListener("keydown", this.moreMenuKeydownListener);

        this.documentClickListenerForMore = (event: MouseEvent) => {
            if (!this.moreMenuOpen) {
                return;
            }
            const target = event.target as Node | null;
            if (target && dom.panelMoreMenu.contains(target)) {
                return;
            }
            if (target && dom.panelMoreTrigger.contains(target)) {
                return;
            }
            this.closeMoreMenu();
        };
        document.addEventListener("click", this.documentClickListenerForMore);

        this.handlePointerMove = (event: PointerEvent) => {
            if (!this.isResizing || !this.dom) {
                return;
            }

            if (this.isMobileLayout()) {
                this.handleStopResizing?.(event);
                return;
            }

            const nextWidthPx = this.clampWidth(window.innerWidth - event.clientX);
            this.pendingWidthPx = nextWidthPx;
            this.dom.strategyPanel.style.setProperty("--strategy-panel-width", `${nextWidthPx}px`);
            this.syncCharts(false);
        };

        this.handleStopResizing = (event?: PointerEvent) => {
            if (!this.isResizing || !this.dom) {
                return;
            }

            this.isResizing = false;
            document.body.classList.remove("is-resizing");
            this.dom.panelResizeHandle.classList.remove("is-resizing");
            
            if (event && dom.panelResizeHandle.hasPointerCapture(event.pointerId)) {
                dom.panelResizeHandle.releasePointerCapture(event.pointerId);
            }

            if (this.pendingWidthPx !== null) {
                this.dom.strategyPanel.style.setProperty("--strategy-panel-width", `${this.pendingWidthPx}px`);
                this.saveLayoutState();
            }

            this.syncCharts(true);
        };

        window.addEventListener("pointermove", this.handlePointerMove);
        window.addEventListener("pointerup", this.handleStopResizing);
        window.addEventListener("pointercancel", this.handleStopResizing);
    }

    private restoreLayoutState(): void {
        const dom = this.dom;
        if (!dom) return;

        const savedState = this.readLayoutState();
        if (typeof savedState.widthPx === "number" && Number.isFinite(savedState.widthPx)) {
            const widthPx = this.clampWidth(savedState.widthPx);
            this.pendingWidthPx = widthPx;
            dom.strategyPanel.style.setProperty("--strategy-panel-width", `${widthPx}px`);
        }

        this.setCollapsed(savedState.collapsed, false);

        const savedTabKnown =
            typeof savedState.activeTabId === "string"
            && (this.tabButtons.has(savedState.activeTabId) || this.moreItems.has(savedState.activeTabId))
            && this.isTabAllowed(savedState.activeTabId);

        const initialTabId =
            (savedTabKnown
                ? savedState.activeTabId!
                : this.orderedTabIds.find((id) => this.tabButtons.get(id)?.classList.contains("active") && this.isTabAllowed(id)))
            ?? this.getFirstVisibleTabId();

        if (initialTabId) {
            this.switchTab(initialTabId, { persist: false, revealPanel: false });
        }
    }

    private getVisibleTabs(): HTMLButtonElement[] {
        return this.orderedTabIds
            .filter((id) => this.isTabAllowed(id))
            .map((id) => this.tabButtons.get(id))
            .filter((tab): tab is HTMLButtonElement => Boolean(tab));
    }

    private getFirstVisibleTabId(): string | null {
        return this.orderedTabIds.find((id) => this.isTabAllowed(id)) ?? null;
    }

    private isTabAllowed(tabId: string): boolean {
        return !this.allowedTabs || this.allowedTabs.has(tabId);
    }

    private isMobileLayout(): boolean {
        return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
    }

    private clampWidth(widthPx: number): number {
        return Math.min(Math.round(window.innerWidth * 0.8), Math.max(MIN_PANEL_WIDTH_PX, Math.round(widthPx)));
    }

    private syncCharts(finalSync: boolean): void {
        if (typeof window === "undefined") {
            return;
        }

        if (!finalSync) {
            if (this.pendingChartSyncFrame !== null) {
                return;
            }
            this.pendingChartSyncFrame = requestAnimationFrame(() => {
                this.pendingChartSyncFrame = null;
                this.resizeCharts();
            });
            return;
        }

        if (this.pendingChartSyncFrame !== null) {
            cancelAnimationFrame(this.pendingChartSyncFrame);
            this.pendingChartSyncFrame = null;
        }

        this.resizeCharts();
        window.dispatchEvent(new Event("resize"));
    }

    private resizeCharts(): void {
        if (state.chart && state.equityChart) {
            state.chart.resize(0, 0);
            state.equityChart.resize(0, 0);
        }
    }

    private readLayoutState(): StrategyPanelLayoutState {
        return readPersistedJson<StrategyPanelLayoutState>({
            ...STRATEGY_PANEL_LAYOUT_STORAGE,
            fallback: DEFAULT_LAYOUT_STATE,
            migrate: ({ data }) => {
                const parsed = data as Partial<StrategyPanelLayoutState>;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    return DEFAULT_LAYOUT_STATE;
                }
                return {
                    activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null,
                    collapsed: parsed.collapsed === true,
                    widthPx: typeof parsed.widthPx === "number" ? parsed.widthPx : null,
                };
            },
        });
    }

    private saveLayoutState(): void {
        const dom = this.dom;
        if (!dom) return;

        const widthValue = dom.strategyPanel.style.getPropertyValue("--strategy-panel-width").trim();
        const widthPx = widthValue.endsWith("px") ? Number.parseInt(widthValue, 10) : null;

        const nextState: StrategyPanelLayoutState = {
            activeTabId: this.activeTabId,
            collapsed: dom.strategyPanel.classList.contains("collapsed"),
            widthPx: Number.isFinite(widthPx) ? widthPx : null,
        };

        writePersistedJson({
            ...STRATEGY_PANEL_LAYOUT_STORAGE,
            data: nextState,
        });
    }
}

export const strategyPanelController = new StrategyPanelController();
