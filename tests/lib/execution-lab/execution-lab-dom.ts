import { getRequiredElement } from "../dom-utils";

export const EXECUTION_LAB_IDS = {
    root: "executionlabTab",
    startButton: "executionLabStartPaper",
    stopButton: "executionLabStopPaper",
    startMinerButton: "executionLabStartMiner",
    stopMinerButton: "executionLabStopMiner",
    stakeInput: "executionLabStakeUsd",
    status: "executionLabStatus",
    configSnapshot: "executionLabConfigSnapshot",
    latestCandle: "executionLabLatestCandle",
    quoteSnapshot: "executionLabQuoteSnapshot",
    feedLag: "executionLabFeedLag",
    quoteAge: "executionLabQuoteAge",
    activeEvent: "executionLabActiveEvent",
    minerStatus: "executionLabMinerStatus",
    logPath: "executionLabLogPath",
    latestSignal: "executionLabLatestSignal",
    signalParity: "executionLabSignalParity",
    signalMismatch: "executionLabSignalMismatch",
    openPosition: "executionLabOpenPosition",
    sessionPnl: "executionLabSessionPnl",
    paperMetrics: "executionLabPaperMetrics",
    comparisonSource: "executionLabComparisonSource",
    comparisonSavedConfig: "executionLabComparisonSavedConfig",
    runComparisonButton: "executionLabRunComparison",
    comparisonStatus: "executionLabComparisonStatus",
    comparisonMetrics: "executionLabComparisonMetrics",
    recentTrades: "executionLabRecentTrades",
} as const;

export const EXECUTION_LAB_REQUIRED_IDS = Object.values(EXECUTION_LAB_IDS);

export interface ExecutionLabDom {
    root: HTMLElement;
    startButton: HTMLButtonElement;
    stopButton: HTMLButtonElement;
    startMinerButton: HTMLButtonElement;
    stopMinerButton: HTMLButtonElement;
    stakeInput: HTMLInputElement;
    status: HTMLElement;
    configSnapshot: HTMLElement;
    latestCandle: HTMLElement;
    quoteSnapshot: HTMLElement;
    feedLag: HTMLElement;
    quoteAge: HTMLElement;
    activeEvent: HTMLElement;
    minerStatus: HTMLElement;
    logPath: HTMLElement;
    latestSignal: HTMLElement;
    signalParity: HTMLElement;
    signalMismatch: HTMLElement;
    openPosition: HTMLElement;
    sessionPnl: HTMLElement;
    paperMetrics: HTMLElement;
    comparisonSource: HTMLSelectElement;
    comparisonSavedConfig: HTMLSelectElement;
    runComparisonButton: HTMLButtonElement;
    comparisonStatus: HTMLElement;
    comparisonMetrics: HTMLElement;
    recentTrades: HTMLElement;
}

export function queryExecutionLabDom(): ExecutionLabDom {
    return {
        root: getRequiredElement(EXECUTION_LAB_IDS.root),
        startButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.startButton),
        stopButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.stopButton),
        startMinerButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.startMinerButton),
        stopMinerButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.stopMinerButton),
        stakeInput: getRequiredElement<HTMLInputElement>(EXECUTION_LAB_IDS.stakeInput),
        status: getRequiredElement(EXECUTION_LAB_IDS.status),
        configSnapshot: getRequiredElement(EXECUTION_LAB_IDS.configSnapshot),
        latestCandle: getRequiredElement(EXECUTION_LAB_IDS.latestCandle),
        quoteSnapshot: getRequiredElement(EXECUTION_LAB_IDS.quoteSnapshot),
        feedLag: getRequiredElement(EXECUTION_LAB_IDS.feedLag),
        quoteAge: getRequiredElement(EXECUTION_LAB_IDS.quoteAge),
        activeEvent: getRequiredElement(EXECUTION_LAB_IDS.activeEvent),
        minerStatus: getRequiredElement(EXECUTION_LAB_IDS.minerStatus),
        logPath: getRequiredElement(EXECUTION_LAB_IDS.logPath),
        latestSignal: getRequiredElement(EXECUTION_LAB_IDS.latestSignal),
        signalParity: getRequiredElement(EXECUTION_LAB_IDS.signalParity),
        signalMismatch: getRequiredElement(EXECUTION_LAB_IDS.signalMismatch),
        openPosition: getRequiredElement(EXECUTION_LAB_IDS.openPosition),
        sessionPnl: getRequiredElement(EXECUTION_LAB_IDS.sessionPnl),
        paperMetrics: getRequiredElement(EXECUTION_LAB_IDS.paperMetrics),
        comparisonSource: getRequiredElement<HTMLSelectElement>(EXECUTION_LAB_IDS.comparisonSource),
        comparisonSavedConfig: getRequiredElement<HTMLSelectElement>(EXECUTION_LAB_IDS.comparisonSavedConfig),
        runComparisonButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.runComparisonButton),
        comparisonStatus: getRequiredElement(EXECUTION_LAB_IDS.comparisonStatus),
        comparisonMetrics: getRequiredElement(EXECUTION_LAB_IDS.comparisonMetrics),
        recentTrades: getRequiredElement(EXECUTION_LAB_IDS.recentTrades),
    };
}
