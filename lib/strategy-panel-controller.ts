import { state } from "./state";
import { createStrategyPanelDom } from "./feature-dom-contracts";
import { debugLogger } from "./debug-logger";

const STORAGE_KEY = "strategyPanelLayout";
const MOBILE_BREAKPOINT_PX = 960;
const MIN_PANEL_WIDTH_PX = 280;

interface StrategyPanelLayoutState {
    activeTabId: string | null;
    collapsed: boolean;
    widthPx: number | null;
}

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
    private allowedTabs: Set<string> | null = null;
    private activeTabId: string | null = null;
    private isResizing = false;
    private pendingWidthPx: number | null = null;
    private initialized = false;
    private handlePointerMove: ((event: PointerEvent) => void) | null = null;
    private handleStopResizing: (() => void) | null = null;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createStrategyPanelDom();
        this.captureTabs();
        this.bindEvents();
        this.restoreLayoutState();
        this.initialized = true;
    }

    public destroy(): void {
        if (this.handlePointerMove) {
            window.removeEventListener("pointermove", this.handlePointerMove);
            this.handlePointerMove = null;
        }
        if (this.handleStopResizing) {
            window.removeEventListener("pointerup", this.handleStopResizing);
            window.removeEventListener("pointercancel", this.handleStopResizing);
            this.handleStopResizing = null;
        }

        this.isResizing = false;
        this.pendingWidthPx = null;
        this.initialized = false;
        this.dom = null;
    }

    public switchTab(tabId: string, options: SwitchTabOptions = {}): boolean {
        const dom = this.dom;
        const nextTab = this.tabButtons.get(tabId);
        const nextPanel = this.tabPanels.get(tabId);
        if (!dom || !nextTab || !nextPanel || !this.isTabAllowed(tabId)) {
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
        });

        if (!tabId) {
            return false;
        }

        return this.switchTab(tabId, { focus: true });
    }

    public setVisibleTabs(tabIds: Iterable<string> | null): void {
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

    private bindEvents(): void {
        const dom = this.dom;
        if (!dom) return;

        this.tabButtons.forEach((tab, tabId) => {
            tab.addEventListener("click", () => {
                this.switchTab(tabId);
            });

            tab.addEventListener("keydown", (event) => {
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
            });
        });

        dom.togglePanel.addEventListener("click", () => {
            this.toggleCollapsed();
        });

        dom.panelResizeHandle.addEventListener("pointerdown", (event) => {
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
        });

        this.handlePointerMove = (event: PointerEvent) => {
            if (!this.isResizing || !this.dom) {
                return;
            }

            const nextWidthPx = this.clampWidth(window.innerWidth - event.clientX);
            this.pendingWidthPx = nextWidthPx;
            this.dom.strategyPanel.style.setProperty("--strategy-panel-width", `${nextWidthPx}px`);
            this.syncCharts(false);
        };

        this.handleStopResizing = () => {
            if (!this.isResizing || !this.dom) {
                return;
            }

            this.isResizing = false;
            document.body.classList.remove("is-resizing");
            this.dom.panelResizeHandle.classList.remove("is-resizing");

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

        const initialTabId =
            (savedState.activeTabId && this.tabButtons.has(savedState.activeTabId) && this.isTabAllowed(savedState.activeTabId)
                ? savedState.activeTabId
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

        if (state.chart && state.equityChart) {
            state.chart.resize(0, 0);
            state.equityChart.resize(0, 0);
        }

        if (finalSync) {
            window.dispatchEvent(new Event("resize"));
        }
    }

    private readLayoutState(): StrategyPanelLayoutState {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return {
                    activeTabId: null,
                    collapsed: false,
                    widthPx: null,
                };
            }

            const parsed = JSON.parse(raw) as Partial<StrategyPanelLayoutState>;
            return {
                activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null,
                collapsed: parsed.collapsed === true,
                widthPx: typeof parsed.widthPx === "number" ? parsed.widthPx : null,
            };
        } catch {
            return {
                activeTabId: null,
                collapsed: false,
                widthPx: null,
            };
        }
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

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
        } catch {
            // Ignore storage failures; panel state is non-critical UI state.
        }
    }
}

export const strategyPanelController = new StrategyPanelController();
