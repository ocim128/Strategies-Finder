import { getRequiredElement } from "./dom-utils";

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
