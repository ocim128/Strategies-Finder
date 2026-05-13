export const SECOND_MARKET_VIEWER_IDS = {
    tab: "secondmarketTab",
    symbol: "secondMarketSymbol",
    windowSec: "secondMarketWindowSec",
    autoRefresh: "secondMarketAutoRefresh",
    refresh: "secondMarketRefresh",
    status: "secondMarketStatus",
    metricBinance: "secondMarketMetricBinance",
    metricClob: "secondMarketMetricClob",
    metricReference: "secondMarketMetricReference",
    metricCoverage: "secondMarketMetricCoverage",
    metricQuoteAge: "secondMarketMetricQuoteAge",
    metricLag: "secondMarketMetricLag",
    activeEvent: "secondMarketActiveEvent",
    latestTime: "secondMarketLatestTime",
    gammaYes: "secondMarketGammaYes",
    gammaNo: "secondMarketGammaNo",
    binanceChart: "secondMarketBinanceChart",
    clobChart: "secondMarketClobChart",
    referenceChart: "secondMarketReferenceChart",
} as const;

export const SECOND_MARKET_VIEWER_REQUIRED_IDS = Object.values(SECOND_MARKET_VIEWER_IDS);

export type SecondMarketViewerDom = {
    tab: HTMLElement;
    symbolSelect: HTMLSelectElement;
    windowSelect: HTMLSelectElement;
    autoRefreshInput: HTMLInputElement;
    refreshButton: HTMLButtonElement;
    status: HTMLElement;
    metricBinance: HTMLElement;
    metricClob: HTMLElement;
    metricReference: HTMLElement;
    metricCoverage: HTMLElement;
    metricQuoteAge: HTMLElement;
    metricLag: HTMLElement;
    activeEvent: HTMLElement;
    latestTime: HTMLElement;
    gammaYes: HTMLElement;
    gammaNo: HTMLElement;
    binanceChart: HTMLElement;
    clobChart: HTMLElement;
    referenceChart: HTMLElement;
};

function requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing second-market viewer element: ${id}`);
    }
    return element as T;
}

export function querySecondMarketViewerDom(): SecondMarketViewerDom {
    return {
        tab: requireElement(SECOND_MARKET_VIEWER_IDS.tab),
        symbolSelect: requireElement<HTMLSelectElement>(SECOND_MARKET_VIEWER_IDS.symbol),
        windowSelect: requireElement<HTMLSelectElement>(SECOND_MARKET_VIEWER_IDS.windowSec),
        autoRefreshInput: requireElement<HTMLInputElement>(SECOND_MARKET_VIEWER_IDS.autoRefresh),
        refreshButton: requireElement<HTMLButtonElement>(SECOND_MARKET_VIEWER_IDS.refresh),
        status: requireElement(SECOND_MARKET_VIEWER_IDS.status),
        metricBinance: requireElement(SECOND_MARKET_VIEWER_IDS.metricBinance),
        metricClob: requireElement(SECOND_MARKET_VIEWER_IDS.metricClob),
        metricReference: requireElement(SECOND_MARKET_VIEWER_IDS.metricReference),
        metricCoverage: requireElement(SECOND_MARKET_VIEWER_IDS.metricCoverage),
        metricQuoteAge: requireElement(SECOND_MARKET_VIEWER_IDS.metricQuoteAge),
        metricLag: requireElement(SECOND_MARKET_VIEWER_IDS.metricLag),
        activeEvent: requireElement(SECOND_MARKET_VIEWER_IDS.activeEvent),
        latestTime: requireElement(SECOND_MARKET_VIEWER_IDS.latestTime),
        gammaYes: requireElement(SECOND_MARKET_VIEWER_IDS.gammaYes),
        gammaNo: requireElement(SECOND_MARKET_VIEWER_IDS.gammaNo),
        binanceChart: requireElement(SECOND_MARKET_VIEWER_IDS.binanceChart),
        clobChart: requireElement(SECOND_MARKET_VIEWER_IDS.clobChart),
        referenceChart: requireElement(SECOND_MARKET_VIEWER_IDS.referenceChart),
    };
}
