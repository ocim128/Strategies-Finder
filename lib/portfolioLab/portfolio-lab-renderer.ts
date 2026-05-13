import type { PortfolioLabDom } from "../portfolio-lab-dom";
import { renderEmptyTableRow } from "../ui-render-helpers";

type RowWithNetProfit = {
    result: {
        netProfitPercent: number;
    };
};

function setDisplay(element: HTMLElement, visible: boolean): void {
    element.style.display = visible ? "" : "none";
}

export interface PortfolioLabRenderHost<
    TRow extends RowWithNetProfit,
    TConsensus,
    TLiveContext,
    TForecast,
    TBreadthSweepRow,
    TOppositionSweepRow,
    TRankingRow,
    TSizingRow,
    TDataCache,
    TWindowMode extends string
> {
    renderSummary(rows: TRow[], benchmarkSymbol: string): string;
    renderLiveContextSummary(liveContext: TLiveContext): string;
    renderLiveContextDetails(liveContext: TLiveContext): string;
    renderForecastSummary(forecast: TForecast): string;
    renderForecastDetails(forecast: TForecast): string;
    renderForecastTable(forecast: TForecast): string;
    renderInsights(rows: TRow[], benchmarkSymbol: string, skipped: string[], windowMode: TWindowMode): string;
    renderExecutionSummary(
        breadthRows: TBreadthSweepRow[],
        oppositionRows: TOppositionSweepRow[],
        currentFilter: any,
        targetSymbol: string,
        minAgree: number,
        maxOppose: number
    ): string;
    renderConsensusSummary(consensus: TConsensus): string;
    renderConsensusTable(consensus: TConsensus): string;
    renderBreadthSweep(rows: TBreadthSweepRow[]): void;
    renderOppositionSweep(rows: TOppositionSweepRow[]): void;
    renderRankingSummary(rows: TRankingRow[]): string;
    renderRankingTable(rows: TRankingRow[], benchmarkSymbol: string): string;
    renderSizingSummary(rows: TSizingRow[]): string;
    renderSizingTable(rows: TSizingRow[]): string;
    renderCorrelationMatrix(rows: TRow[], selectedSymbols: string[], dataCache: TDataCache): string;
    renderRow(row: TRow, benchmarkSymbol: string): string;
    bindRowActions(): void;
    findBestFilterRun(
        breadthRows: TBreadthSweepRow[],
        oppositionRows: TOppositionSweepRow[],
        minAgree: number,
        maxOppose: number
    ): any;
    updateStatus(message: string): void;
}

export interface PortfolioLabRenderInput<
    TRow extends RowWithNetProfit,
    TConsensus,
    TLiveContext,
    TForecast,
    TBreadthSweepRow,
    TOppositionSweepRow,
    TRankingRow,
    TSizingRow,
    TDataCache,
    TWindowMode extends string
> {
    dom: PortfolioLabDom;
    rows: TRow[];
    selectedSymbols: string[];
    dataCache: TDataCache;
    benchmarkSymbol: string;
    skipped: string[];
    consensus: TConsensus;
    windowMode: TWindowMode;
    breadthSweep: TBreadthSweepRow[];
    oppositionSweep: TOppositionSweepRow[];
    rankingRows: TRankingRow[];
    sizingRows: TSizingRow[];
    liveContext: TLiveContext;
    forecast: TForecast;
    minAgree: number;
    maxOppose: number;
    currentInterval: string;
}

export function renderPortfolioLab<
    TRow extends RowWithNetProfit,
    TConsensus,
    TLiveContext,
    TForecast,
    TBreadthSweepRow,
    TOppositionSweepRow,
    TRankingRow,
    TSizingRow,
    TDataCache,
    TWindowMode extends string
>(
    host: PortfolioLabRenderHost<TRow, TConsensus, TLiveContext, TForecast, TBreadthSweepRow, TOppositionSweepRow, TRankingRow, TSizingRow, TDataCache, TWindowMode>,
    input: PortfolioLabRenderInput<TRow, TConsensus, TLiveContext, TForecast, TBreadthSweepRow, TOppositionSweepRow, TRankingRow, TSizingRow, TDataCache, TWindowMode>
): void {
    const {
        dom,
        rows,
        selectedSymbols,
        dataCache,
        benchmarkSymbol,
        skipped,
        consensus,
        windowMode,
        breadthSweep,
        oppositionSweep,
        rankingRows,
        sizingRows,
        liveContext,
        forecast,
        minAgree,
        maxOppose,
        currentInterval,
    } = input;

    const hasRows = rows.length > 0;
    dom.portfolioContent.style.display = "";
    setDisplay(dom.portfolioEmpty, !hasRows);
    [
        dom.portfolioResults,
        dom.portfolioLiveContextSection,
        dom.portfolioForecastSection,
        dom.portfolioInsightSection,
        dom.portfolioExecutionSection,
        dom.portfolioConsensusSection,
        dom.portfolioRankingSection,
        dom.portfolioSizingSection,
    ].forEach((section) => setDisplay(section, hasRows));
    setDisplay(dom.portfolioMatrixSection, rows.length > 1);

    if (!hasRows) {
        dom.portfolioSummary.innerHTML = "";
        dom.portfolioLiveContextSummary.innerHTML = "";
        dom.portfolioLiveContextDetails.innerHTML = "";
        dom.portfolioForecastSummary.innerHTML = "";
        dom.portfolioForecastDetails.innerHTML = "";
        dom.portfolioForecastTableBody.innerHTML = renderEmptyTableRow(9, "Run Portfolio Lab to estimate open-trade win/loss odds from historical analog states.");
        dom.portfolioInsights.innerHTML = "";
        dom.portfolioExecutionSummary.innerHTML = "";
        dom.portfolioConsensusSummary.innerHTML = "";
        dom.portfolioConsensusTableBody.innerHTML = renderEmptyTableRow(9, "No usable pair runs. Check the symbol list and data availability.");
        dom.portfolioBreadthSweepSection.style.display = "none";
        dom.portfolioBreadthSweepTableBody.innerHTML = renderEmptyTableRow(8, "Run Breadth Sweep to compare agreement thresholds.");
        dom.portfolioOppositionSweepSection.style.display = "none";
        dom.portfolioOppositionSweepTableBody.innerHTML = renderEmptyTableRow(8, "Run Sweep Opposition to compare conflict thresholds.");
        dom.portfolioRankingSummary.innerHTML = "";
        dom.portfolioRankingTableBody.innerHTML = renderEmptyTableRow(8, "Run Portfolio Lab to rank pairs by quality, diversification, and context response.");
        dom.portfolioSizingSummary.innerHTML = "";
        dom.portfolioSizingTableBody.innerHTML = renderEmptyTableRow(8, "Run Portfolio Lab to compare context-weighted sizing scenarios.");
        dom.portfolioCorrelationMatrix.innerHTML = "";
        dom.portfolioPairsTableBody.innerHTML = renderEmptyTableRow(10, "No usable pair runs. Check the symbol list and data availability.");
        host.updateStatus(skipped.length > 0 ? `No usable results. Skipped: ${skipped.join(", ")}` : "No usable results.");
        return;
    }

    dom.portfolioSummary.innerHTML = host.renderSummary(rows, benchmarkSymbol);
    dom.portfolioLiveContextSummary.innerHTML = host.renderLiveContextSummary(liveContext);
    dom.portfolioLiveContextDetails.innerHTML = host.renderLiveContextDetails(liveContext);
    dom.portfolioForecastSummary.innerHTML = host.renderForecastSummary(forecast);
    dom.portfolioForecastDetails.innerHTML = host.renderForecastDetails(forecast);
    dom.portfolioForecastTableBody.innerHTML = host.renderForecastTable(forecast);
    dom.portfolioInsights.innerHTML = host.renderInsights(rows, benchmarkSymbol, skipped, windowMode);
    dom.portfolioExecutionSummary.innerHTML = host.renderExecutionSummary(
        breadthSweep,
        oppositionSweep,
        host.findBestFilterRun(breadthSweep, oppositionSweep, minAgree, maxOppose),
        benchmarkSymbol,
        minAgree,
        maxOppose
    );
    dom.portfolioConsensusSummary.innerHTML = host.renderConsensusSummary(consensus);
    dom.portfolioConsensusTableBody.innerHTML = host.renderConsensusTable(consensus);
    host.renderBreadthSweep(breadthSweep);
    host.renderOppositionSweep(oppositionSweep);
    dom.portfolioRankingSummary.innerHTML = host.renderRankingSummary(rankingRows);
    dom.portfolioRankingTableBody.innerHTML = host.renderRankingTable(rankingRows, benchmarkSymbol);
    dom.portfolioSizingSummary.innerHTML = host.renderSizingSummary(sizingRows);
    dom.portfolioSizingTableBody.innerHTML = host.renderSizingTable(sizingRows);
    dom.portfolioCorrelationMatrix.innerHTML = host.renderCorrelationMatrix(rows, selectedSymbols, dataCache);
    dom.portfolioPairsTableBody.innerHTML = rows.map((row) => host.renderRow(row, benchmarkSymbol)).join("");
    host.bindRowActions();

    const profitablePairs = rows.filter((row) => row.result.netProfitPercent > 0).length;
    const skippedSuffix = skipped.length > 0 ? ` Skipped ${skipped.length}.` : "";
    host.updateStatus(
        `${rows.length} pairs completed on ${currentInterval}. ` +
        `${profitablePairs}/${rows.length} profitable vs ${benchmarkSymbol}.${skippedSuffix}`
    );
}
