import { getRequiredElement } from "./dom-utils";

export const STRATEGY_PANEL_REQUIRED_IDS = [
    "toggleChart",
    "togglePanel",
    "strategyPanel",
    "strategyTabs",
    "panelContent",
    "panelResizeHandle",
    "panelMoreTrigger",
    "panelMoreMenu",
] as const;

export function createStrategyPanelDom() {
    return {
        toggleChart: getRequiredElement("toggleChart"),
        togglePanel: getRequiredElement("togglePanel"),
        strategyPanel: getRequiredElement("strategyPanel"),
        strategyTabs: getRequiredElement("strategyTabs"),
        panelContent: getRequiredElement("panelContent"),
        panelResizeHandle: getRequiredElement("panelResizeHandle"),
        panelMoreTrigger: getRequiredElement("panelMoreTrigger"),
        panelMoreMenu: getRequiredElement("panelMoreMenu"),
    };
}

export type StrategyPanelDom = ReturnType<typeof createStrategyPanelDom>;
