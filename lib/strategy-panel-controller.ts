import { state } from "./state";
import { createStrategyPanelDom } from "./strategy-panel-dom";
import { debugLogger } from "./debug-logger";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import { coalesceAnimationFrame } from "./render-scheduler";

const STORAGE_KEY = "strategyPanelLayout";
const MOBILE_BREAKPOINT_PX = 960;
const MIN_PANEL_WIDTH_PX = 280;

interface StrategyPanelLayoutState {
    activeTabId: string | null;
    collapsed: boolean;
    widthPx: number | null;
    chartHidden: boolean;
}

const DEFAULT_LAYOUT_STATE: StrategyPanelLayoutState = {
    activeTabId: null,
    collapsed: false,
    widthPx: null,
    chartHidden: true,
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
    private allowedTabs: Set<string> | null = null;
    private activeTabId: string | null = null;
    private isResizing = false;
    private pendingWidthPx: number | null = null;
    private initialized = false;
    private events: AbortController | null = null;
    private resizePointerId: number | null = null;
    private readonly chartSyncFrame = coalesceAnimationFrame(() => this.resizeCharts());
    private moreMenuOpen = false;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createStrategyPanelDom();
        this.events = new AbortController();
        this.captureTabs();
        this.captureMoreItems();
        this.bindEvents();
        this.restoreLayoutState();
        this.initialized = true;
    }

    public destroy(): void {
        this.stopResizing(false);
        this.events?.abort();
        this.events = null;
        this.chartSyncFrame.cancel();
        this.closeMoreMenu();
        this.pendingWidthPx = null;
        this.initialized = false;
        this.dom = null;
        this.tabButtons.clear();
        this.tabPanels.clear();
        this.moreItems.clear();
        this.orderedTabIds = [];
        this.activeTabId = null;
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

        this.tabButtons.forEach((tab, id) => {
            const isActive = id === tabId;
            tab.classList.toggle("active", isActive);
            tab.setAttribute("aria-selected", String(isActive));
            tab.tabIndex = isActive ? 0 : -1;
            if (focus && isActive) tab.focus();
        });
        this.tabPanels.forEach((panel, id) => {
            panel.hidden = id !== tabId;
            panel.style.display = id === tabId ? "block" : "none";
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

    public setChartHidden(chartHidden: boolean, persist = true): void {
        const dom = this.dom;
        if (!dom) return;

        document.body.classList.toggle("chart-hidden", chartHidden);
        dom.toggleChart.setAttribute("aria-pressed", String(!chartHidden));

        if (persist) {
            this.saveLayoutState();
        }

        this.syncCharts(true);
    }

    public toggleChartHidden(): void {
        const dom = this.dom;
        if (!dom) return;

        this.setChartHidden(!document.body.classList.contains("chart-hidden"));
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
        for (const panel of Array.from(dom.panelContent.children) as HTMLElement[]) {
            if (panel.id.endsWith("Tab")) {
                this.tabPanels.set(panel.id.slice(0, -3), panel);
            }
        }

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
        if (!dom || !this.events) return;
        const options = { signal: this.events.signal };

        dom.strategyTabs.addEventListener("click", (event) => {
            const tab = (event.target as Element).closest<HTMLButtonElement>(".panel-tab");
            if (tab && dom.strategyTabs.contains(tab)) this.switchTab(tab.dataset.tab!);
        }, options);
        dom.strategyTabs.addEventListener("keydown", (event: KeyboardEvent) => {
            const tab = (event.target as Element).closest<HTMLButtonElement>(".panel-tab");
            const tabs = this.getVisibleTabs();
            const index = tab ? tabs.indexOf(tab) : -1;
            if (index < 0) return;
            let next: HTMLButtonElement | undefined;
            switch (event.key) {
                case "ArrowDown": case "ArrowRight": next = tabs[(index + 1) % tabs.length]; break;
                case "ArrowUp": case "ArrowLeft": next = tabs[(index - 1 + tabs.length) % tabs.length]; break;
                case "Home": next = tabs[0]; break;
                case "End": next = tabs[tabs.length - 1]; break;
                case "Enter": case " ": this.switchTab(tab!.dataset.tab!, { focus: true }); break;
                default: return;
            }
            event.preventDefault();
            next?.focus();
        }, options);
        dom.togglePanel.addEventListener("click", () => this.toggleCollapsed(), options);
        dom.toggleChart.addEventListener("click", () => this.toggleChartHidden(), options);
        dom.panelMoreTrigger.addEventListener("click", () => this.toggleMoreMenu(), options);
        dom.panelMoreMenu.addEventListener("click", (event) => {
            const item = (event.target as Element).closest<HTMLButtonElement>("button[data-tab]");
            if (!item || !dom.panelMoreMenu.contains(item)) return;
            this.switchTab(item.dataset.tab!);
            this.closeMoreMenu();
        }, options);
        dom.panelMoreMenu.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Escape" && this.moreMenuOpen) {
                event.preventDefault();
                this.closeMoreMenu();
                dom.panelMoreTrigger.focus();
            }
        }, options);
        document.addEventListener("click", (event) => {
            const target = event.target as Node | null;
            if (this.moreMenuOpen && target
                && !dom.panelMoreMenu.contains(target) && !dom.panelMoreTrigger.contains(target)) {
                this.closeMoreMenu();
            }
        }, options);

        dom.panelResizeHandle.addEventListener("pointerdown", (event: PointerEvent) => {
            if (this.isMobileLayout() || event.button !== 0) return;
            this.isResizing = true;
            this.resizePointerId = event.pointerId;
            document.body.classList.add("is-resizing");
            dom.panelResizeHandle.classList.add("is-resizing");
            dom.panelResizeHandle.setPointerCapture(event.pointerId);
            event.preventDefault();
        }, options);
        window.addEventListener("pointermove", (event: PointerEvent) => {
            if (!this.isResizing || event.pointerId !== this.resizePointerId) return;
            if (this.isMobileLayout()) {
                this.stopResizing();
                return;
            }
            const width = this.clampWidth(window.innerWidth - event.clientX);
            this.pendingWidthPx = width;
            dom.strategyPanel.style.setProperty("--strategy-panel-width", `${width}px`);
            this.syncCharts(false);
        }, options);
        const stop = (event: PointerEvent) => {
            if (event.pointerId === this.resizePointerId) this.stopResizing();
        };
        window.addEventListener("pointerup", stop, options);
        window.addEventListener("pointercancel", stop, options);
        dom.panelResizeHandle.addEventListener("lostpointercapture", stop, options);
    }

    private stopResizing(persist = true): void {
        if (!this.isResizing || !this.dom) return;
        this.isResizing = false;
        document.body.classList.remove("is-resizing");
        const handle = this.dom.panelResizeHandle;
        handle.classList.remove("is-resizing");
        if (this.resizePointerId !== null && handle.hasPointerCapture(this.resizePointerId)) {
            handle.releasePointerCapture(this.resizePointerId);
        }
        this.resizePointerId = null;
        if (persist) {
            if (this.pendingWidthPx !== null) this.saveLayoutState();
            this.syncCharts(true);
        }
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

        this.setChartHidden(savedState.chartHidden, false);

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
            this.chartSyncFrame.schedule();
            return;
        }

        this.chartSyncFrame.cancel();

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
                    // Old payloads predate chartHidden; absent means the new default (hidden).
                    chartHidden: parsed.chartHidden !== false,
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
            chartHidden: document.body.classList.contains("chart-hidden"),
        };

        writePersistedJson({
            ...STRATEGY_PANEL_LAYOUT_STORAGE,
            data: nextState,
        });
    }
}

export const strategyPanelController = new StrategyPanelController();
