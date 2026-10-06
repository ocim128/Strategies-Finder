import type { FinderManagerDom } from "../finder-manager-dom";

export function refreshFinderSettingsSummaries(dom: FinderManagerDom): void {
    const summaries: Record<string, string> = {
        risk: dom.finderFreezeRiskManagementToggle.checked ? "Risk settings fixed" : "Risk parameters varied",
        exit: dom.finderExitStrategyOverrideToggle.checked ? "Override search selected" : "Override search off",
        trades: dom.finderTradesToggle.checked
            ? `${dom.finderTradesMin.value || "0"}–${dom.finderTradesMax.value || "unlimited"} trades`
            : "Trade filter off",
        universe: `Active ≥ ${dom.finderUniverseMinActiveSymbols.value || "0"} · Trades ≥ ${dom.finderUniverseMinTotalTrades.value || "0"} · Profitable ratio ≥ ${dom.finderUniverseMinProfitableActiveRatio.value || "0"}`,
    };
    dom.finderConfiguration.querySelectorAll<HTMLElement>("[data-finder-setting-summary]").forEach((summary) => {
        summary.textContent = summaries[summary.dataset.finderSettingSummary ?? ""] ?? "";
    });
}
