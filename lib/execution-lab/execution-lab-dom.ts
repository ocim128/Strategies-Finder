import { getRequiredElement } from "../dom-utils";

export const EXECUTION_LAB_IDS = {
    root: "executionlabTab",
    startButton: "executionLabStartPaper",
    stopButton: "executionLabStopPaper",
    stakeInput: "executionLabStakeUsd",
    status: "executionLabStatus",
    configSnapshot: "executionLabConfigSnapshot",
    latestCandle: "executionLabLatestCandle",
    quoteSnapshot: "executionLabQuoteSnapshot",
    feedLag: "executionLabFeedLag",
    quoteAge: "executionLabQuoteAge",
    activeEvent: "executionLabActiveEvent",
    logPath: "executionLabLogPath",
    latestSignal: "executionLabLatestSignal",
    signalParity: "executionLabSignalParity",
    signalMismatch: "executionLabSignalMismatch",
    openPosition: "executionLabOpenPosition",
    sessionPnl: "executionLabSessionPnl",
    recentTrades: "executionLabRecentTrades",
} as const;

export const EXECUTION_LAB_REQUIRED_IDS = Object.values(EXECUTION_LAB_IDS);

export interface ExecutionLabDom {
    root: HTMLElement;
    startButton: HTMLButtonElement;
    stopButton: HTMLButtonElement;
    stakeInput: HTMLInputElement;
    status: HTMLElement;
    configSnapshot: HTMLElement;
    latestCandle: HTMLElement;
    quoteSnapshot: HTMLElement;
    feedLag: HTMLElement;
    quoteAge: HTMLElement;
    activeEvent: HTMLElement;
    logPath: HTMLElement;
    latestSignal: HTMLElement;
    signalParity: HTMLElement;
    signalMismatch: HTMLElement;
    openPosition: HTMLElement;
    sessionPnl: HTMLElement;
    recentTrades: HTMLElement;
}

export function queryExecutionLabDom(): ExecutionLabDom {
    return {
        root: getRequiredElement(EXECUTION_LAB_IDS.root),
        startButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.startButton),
        stopButton: getRequiredElement<HTMLButtonElement>(EXECUTION_LAB_IDS.stopButton),
        stakeInput: getRequiredElement<HTMLInputElement>(EXECUTION_LAB_IDS.stakeInput),
        status: getRequiredElement(EXECUTION_LAB_IDS.status),
        configSnapshot: getRequiredElement(EXECUTION_LAB_IDS.configSnapshot),
        latestCandle: getRequiredElement(EXECUTION_LAB_IDS.latestCandle),
        quoteSnapshot: getRequiredElement(EXECUTION_LAB_IDS.quoteSnapshot),
        feedLag: getRequiredElement(EXECUTION_LAB_IDS.feedLag),
        quoteAge: getRequiredElement(EXECUTION_LAB_IDS.quoteAge),
        activeEvent: getRequiredElement(EXECUTION_LAB_IDS.activeEvent),
        logPath: getRequiredElement(EXECUTION_LAB_IDS.logPath),
        latestSignal: getRequiredElement(EXECUTION_LAB_IDS.latestSignal),
        signalParity: getRequiredElement(EXECUTION_LAB_IDS.signalParity),
        signalMismatch: getRequiredElement(EXECUTION_LAB_IDS.signalMismatch),
        openPosition: getRequiredElement(EXECUTION_LAB_IDS.openPosition),
        sessionPnl: getRequiredElement(EXECUTION_LAB_IDS.sessionPnl),
        recentTrades: getRequiredElement(EXECUTION_LAB_IDS.recentTrades),
    };
}
