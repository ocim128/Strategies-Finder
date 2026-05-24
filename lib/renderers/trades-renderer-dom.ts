import { getRequiredElement } from "../dom-utils";

export const TRADES_RENDERER_REQUIRED_IDS = [
    "backtestDiagnostics",
    "backtestDiagnosticsContent",
    "backtestDiagnosticsSummary",
    "backtestDiagnosticsWarnings",
    "copyBacktestDiagnostics",
    "tradesList",
    "tradesTotalPnL",
    "tradesWinRate",
] as const;

export function createTradesRendererDom() {
    return {
        backtestDiagnostics: getRequiredElement("backtestDiagnostics"),
        backtestDiagnosticsContent: getRequiredElement("backtestDiagnosticsContent"),
        backtestDiagnosticsSummary: getRequiredElement("backtestDiagnosticsSummary"),
        backtestDiagnosticsWarnings: getRequiredElement("backtestDiagnosticsWarnings"),
        copyBacktestDiagnostics: getRequiredElement<HTMLButtonElement>("copyBacktestDiagnostics"),
        tradesList: getRequiredElement("tradesList"),
        tradesTotalPnL: getRequiredElement("tradesTotalPnL"),
        tradesWinRate: getRequiredElement("tradesWinRate"),
    };
}

export type TradesRendererDom = ReturnType<typeof createTradesRendererDom>;
