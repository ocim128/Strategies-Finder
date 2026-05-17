import { getRequiredElement } from "./dom-utils";

export const STRATEGY_PANEL_REQUIRED_IDS = [
    "togglePanel",
    "strategyPanel",
    "strategyTabs",
    "panelContent",
    "panelResizeHandle",
] as const;

export function createStrategyPanelDom() {
    return {
        togglePanel: getRequiredElement("togglePanel"),
        strategyPanel: getRequiredElement("strategyPanel"),
        strategyTabs: getRequiredElement("strategyTabs"),
        panelContent: getRequiredElement("panelContent"),
        panelResizeHandle: getRequiredElement("panelResizeHandle"),
    };
}

export type StrategyPanelDom = ReturnType<typeof createStrategyPanelDom>;
