import { getRequiredElement } from "../dom-utils";

export const TRADES_RENDERER_REQUIRED_IDS = [
    "tradesList",
    "tradesTotalPnL",
    "tradesWinRate",
] as const;

export function createTradesRendererDom() {
    return {
        tradesList: getRequiredElement("tradesList"),
        tradesTotalPnL: getRequiredElement("tradesTotalPnL"),
        tradesWinRate: getRequiredElement("tradesWinRate"),
    };
}

export type TradesRendererDom = ReturnType<typeof createTradesRendererDom>;
