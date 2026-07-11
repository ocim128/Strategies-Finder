import { getRequiredElement } from "./dom-utils";

export const STRATEGY_PANEL_REQUIRED_IDS = [
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
