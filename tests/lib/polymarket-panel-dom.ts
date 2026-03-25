import { getRequiredElement } from "./dom-utils";

export const POLYMARKET_PANEL_REQUIRED_IDS = [
    "polymarketTab",
    "polymarketBridgeConfig",
    "polymarketBridgeDownloadScript",
    "polymarketBridgeCopyEnv",
    "polymarketBridgeStatus",
    "polymarketEntryPriceCents",
    "polymarketScope",
    "polymarketPriceNote",
    "polymarketEmpty",
    "polymarketSupport",
    "polymarketContent",
    "polymarketEligibleTrades",
    "polymarketFilledTrades",
    "polymarketFillRate",
    "polymarketFilledWinRate",
    "polymarketStatus",
    "polymarketTableBody",
] as const;

export function createPolymarketPanelDom() {
    return {
        polymarketTab: getRequiredElement("polymarketTab"),
        polymarketBridgeConfig: getRequiredElement<HTMLSelectElement>("polymarketBridgeConfig"),
        polymarketBridgeDownloadScript: getRequiredElement<HTMLButtonElement>("polymarketBridgeDownloadScript"),
        polymarketBridgeCopyEnv: getRequiredElement<HTMLButtonElement>("polymarketBridgeCopyEnv"),
        polymarketBridgeStatus: getRequiredElement("polymarketBridgeStatus"),
        polymarketEntryPriceCents: getRequiredElement<HTMLInputElement>("polymarketEntryPriceCents"),
        polymarketScope: getRequiredElement<HTMLSelectElement>("polymarketScope"),
        polymarketPriceNote: getRequiredElement("polymarketPriceNote"),
        polymarketEmpty: getRequiredElement("polymarketEmpty"),
        polymarketSupport: getRequiredElement("polymarketSupport"),
        polymarketContent: getRequiredElement("polymarketContent"),
        polymarketEligibleTrades: getRequiredElement("polymarketEligibleTrades"),
        polymarketFilledTrades: getRequiredElement("polymarketFilledTrades"),
        polymarketFillRate: getRequiredElement("polymarketFillRate"),
        polymarketFilledWinRate: getRequiredElement("polymarketFilledWinRate"),
        polymarketStatus: getRequiredElement("polymarketStatus"),
        polymarketTableBody: getRequiredElement("polymarketTableBody"),
    };
}

export type PolymarketPanelDom = ReturnType<typeof createPolymarketPanelDom>;
