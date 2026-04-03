import { getRequiredElement } from "./dom-utils";

export const POLYMARKET_PANEL_REQUIRED_IDS = [
    "polymarketTab",
    "polymarketBridgeConfig",
    "polymarketBridgeDownloadScript",
    "polymarketBridgeCopyEnv",
    "polymarketBridgeStatus",
    "polymarketDiagnosticsEmpty",
    "polymarketDiagnosticsSupport",
    "polymarketDiagnosticsContent",
] as const;

export function createPolymarketPanelDom(): any {
    return {
        polymarketTab: getRequiredElement("polymarketTab"),
        polymarketBridgeConfig: getRequiredElement<HTMLSelectElement>("polymarketBridgeConfig"),
        polymarketBridgeDownloadScript: getRequiredElement<HTMLButtonElement>("polymarketBridgeDownloadScript"),
        polymarketBridgeCopyEnv: getRequiredElement<HTMLButtonElement>("polymarketBridgeCopyEnv"),
        polymarketBridgeStatus: getRequiredElement("polymarketBridgeStatus"),
        polymarketDiagnosticsEmpty: getRequiredElement("polymarketDiagnosticsEmpty"),
        polymarketDiagnosticsSupport: getRequiredElement("polymarketDiagnosticsSupport"),
        polymarketDiagnosticsContent: getRequiredElement("polymarketDiagnosticsContent"),
    };
}

export type PolymarketPanelDom = ReturnType<typeof createPolymarketPanelDom>;
