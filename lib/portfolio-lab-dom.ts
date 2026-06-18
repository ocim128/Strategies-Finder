import {
    getRequiredDomElements,
    getRequiredDomIds,
    type RequiredDomElementMap,
} from "./dom-utils";

const PORTFOLIO_LAB_DOM_IDS = {
    portfolioTab: "portfolioTab",
    portfolioEmpty: "portfolioEmpty",
    portfolioContent: "portfolioContent",
    portfolioSymbolList: "portfolioSymbolList",
    portfolioBenchmarkSymbol: "portfolioBenchmarkSymbol",
    portfolioAnchorSymbol: "portfolioAnchorSymbol",
    portfolioLookbackBars: "portfolioLookbackBars",
    portfolioWindowMode: "portfolioWindowMode",
    portfolioConsensusLagBars: "portfolioConsensusLagBars",
    portfolioConsensusMinSamples: "portfolioConsensusMinSamples",
    portfolioUseCurrentBtn: "portfolioUseCurrentBtn",
    portfolioFillMajorsBtn: "portfolioFillMajorsBtn",
    portfolioRunBtn: "portfolioRunBtn",
    portfolioStatus: "portfolioStatus",
    portfolioResults: "portfolioResults",
    portfolioSummary: "portfolioSummary",
    portfolioLiveContextSection: "portfolioLiveContextSection",
    portfolioLiveContextSummary: "portfolioLiveContextSummary",
    portfolioLiveContextDetails: "portfolioLiveContextDetails",
    portfolioForecastSection: "portfolioForecastSection",
    portfolioForecastSummary: "portfolioForecastSummary",
    portfolioForecastDetails: "portfolioForecastDetails",
    portfolioForecastTableBody: "portfolioForecastTableBody",
    portfolioInsightSection: "portfolioInsightSection",
    portfolioInsights: "portfolioInsights",
    portfolioSyntheticConnectionSection: "portfolioSyntheticConnectionSection",
    portfolioSyntheticConnectionSummary: "portfolioSyntheticConnectionSummary",
    portfolioSyntheticConnectionTableBody: "portfolioSyntheticConnectionTableBody",
    portfolioExecutionSection: "portfolioExecutionSection",
    portfolioExecutionSummary: "portfolioExecutionSummary",
    portfolioConsensusSection: "portfolioConsensusSection",
    portfolioConsensusSummary: "portfolioConsensusSummary",
    portfolioConsensusTableBody: "portfolioConsensusTableBody",
    portfolioBreadthMinAgree: "portfolioBreadthMinAgree",
    portfolioMaxOppose: "portfolioMaxOppose",
    portfolioRunBreadthBacktestBtn: "portfolioRunBreadthBacktestBtn",
    portfolioRunFilterBacktestBtn: "portfolioRunFilterBacktestBtn",
    portfolioRunBreadthSweepBtn: "portfolioRunBreadthSweepBtn",
    portfolioRunOppositionSweepBtn: "portfolioRunOppositionSweepBtn",
    portfolioBreadthSweepSection: "portfolioBreadthSweepSection",
    portfolioBreadthSweepTableBody: "portfolioBreadthSweepTableBody",
    portfolioOppositionSweepSection: "portfolioOppositionSweepSection",
    portfolioOppositionSweepTableBody: "portfolioOppositionSweepTableBody",
    portfolioRankingSection: "portfolioRankingSection",
    portfolioRankingSummary: "portfolioRankingSummary",
    portfolioRankingTableBody: "portfolioRankingTableBody",
    portfolioSizingSection: "portfolioSizingSection",
    portfolioSizingSummary: "portfolioSizingSummary",
    portfolioSizingTableBody: "portfolioSizingTableBody",
    portfolioMatrixSection: "portfolioMatrixSection",
    portfolioCorrelationMatrix: "portfolioCorrelationMatrix",
    portfolioPairsTableBody: "portfolioPairsTableBody",
    portfolioIntervalBadge: "portfolioIntervalBadge",
    portfolioStrategyBadge: "portfolioStrategyBadge",
} as const;

export const PORTFOLIO_LAB_REQUIRED_IDS = getRequiredDomIds(PORTFOLIO_LAB_DOM_IDS);

type PortfolioLabTypedControls = {
    portfolioSymbolList: HTMLTextAreaElement;
    portfolioBenchmarkSymbol: HTMLInputElement;
    portfolioAnchorSymbol: HTMLInputElement;
    portfolioLookbackBars: HTMLInputElement;
    portfolioWindowMode: HTMLSelectElement;
    portfolioConsensusLagBars: HTMLInputElement;
    portfolioConsensusMinSamples: HTMLInputElement;
    portfolioUseCurrentBtn: HTMLButtonElement;
    portfolioFillMajorsBtn: HTMLButtonElement;
    portfolioRunBtn: HTMLButtonElement;
    portfolioBreadthMinAgree: HTMLInputElement;
    portfolioMaxOppose: HTMLInputElement;
    portfolioRunBreadthBacktestBtn: HTMLButtonElement;
    portfolioRunFilterBacktestBtn: HTMLButtonElement;
    portfolioRunBreadthSweepBtn: HTMLButtonElement;
    portfolioRunOppositionSweepBtn: HTMLButtonElement;
};

export type PortfolioLabDom =
    Omit<RequiredDomElementMap<typeof PORTFOLIO_LAB_DOM_IDS>, keyof PortfolioLabTypedControls>
    & PortfolioLabTypedControls;

export function createPortfolioLabDom(): PortfolioLabDom {
    return getRequiredDomElements(PORTFOLIO_LAB_DOM_IDS) as PortfolioLabDom;
}
