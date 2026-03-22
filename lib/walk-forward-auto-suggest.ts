import { deriveWalkForwardTradeThresholds } from "./walk-forward-thresholds";

export type WalkForwardWindowSuggestion = {
    optimizationWindow: number;
    testWindow: number;
    stepSize: number;
    estimatedWindows: number;
    expectedOOSTradesPerWindow: number;
    minTrades: number;
    minOOSTradesPerWindow: number;
    minTotalOOSTrades: number;
};

export function estimateWalkForwardWindowCount(
    totalBars: number,
    optimizationWindow: number,
    testWindow: number,
    stepSize: number
): number {
    if (totalBars <= 0 || optimizationWindow <= 0 || testWindow <= 0 || stepSize <= 0) return 0;
    const windowSize = optimizationWindow + testWindow;
    if (windowSize > totalBars) return 0;
    return Math.floor((totalBars - windowSize) / stepSize) + 1;
}

export function suggestWalkForwardWindowsFromTradeFrequency(
    totalBars: number,
    totalTrades: number,
    tradesPerBar: number
): WalkForwardWindowSuggestion {
    const minWindows = 8;
    const maxWindows = 60;
    const minTestByWindows = Math.max(20, Math.floor(totalBars / maxWindows));
    const maxTestByWindows = Math.max(minTestByWindows, Math.floor(totalBars / minWindows));
    const desiredOOSTradesPerWindow = 8;

    let testWindow = tradesPerBar > 0
        ? Math.ceil(desiredOOSTradesPerWindow / tradesPerBar)
        : maxTestByWindows;
    testWindow = Math.max(minTestByWindows, Math.min(maxTestByWindows, testWindow));

    let optimizationWindow = Math.max(testWindow * 2, Math.floor(testWindow * 3));
    optimizationWindow = Math.min(totalBars - testWindow, optimizationWindow);
    if (optimizationWindow < testWindow) {
        optimizationWindow = testWindow;
    }

    let stepSize = testWindow;
    let estimatedWindows = estimateWalkForwardWindowCount(totalBars, optimizationWindow, testWindow, stepSize);

    if (estimatedWindows > maxWindows) {
        const scale = Math.ceil(estimatedWindows / maxWindows);
        testWindow = Math.min(maxTestByWindows, testWindow * scale);
        stepSize = testWindow;
        optimizationWindow = Math.min(totalBars - testWindow, Math.max(testWindow * 2, optimizationWindow * scale));
        estimatedWindows = estimateWalkForwardWindowCount(totalBars, optimizationWindow, testWindow, stepSize);
    }

    if (estimatedWindows < 3 && totalBars >= 3) {
        testWindow = Math.max(minTestByWindows, Math.floor(totalBars / 5));
        stepSize = testWindow;
        optimizationWindow = Math.min(totalBars - testWindow, Math.max(testWindow * 2, Math.floor(totalBars / 2)));
        estimatedWindows = estimateWalkForwardWindowCount(totalBars, optimizationWindow, testWindow, stepSize);
    }

    return {
        optimizationWindow,
        testWindow,
        stepSize,
        estimatedWindows,
        ...deriveWalkForwardTradeThresholds(totalTrades, tradesPerBar, testWindow, estimatedWindows),
    };
}

export function resolveWalkForwardAutoSuggestedThresholds(args: {
    totalBars: number;
    totalTrades: number;
    tradesPerBar: number;
    currentOptimizationWindow: number;
    currentTestWindow: number;
    currentStepSize: number;
    autoApply: boolean;
    applySuggestion: (suggestion: WalkForwardWindowSuggestion, statusPrefix: string) => boolean;
    onAutoApplied?: (suggestion: WalkForwardWindowSuggestion) => void;
    onSuggestionAvailable?: (suggestion: WalkForwardWindowSuggestion) => void;
}): {
    minOOSTradesPerWindow: number;
    minTotalOOSTrades: number;
} {
    const {
        totalBars,
        totalTrades,
        tradesPerBar,
        currentOptimizationWindow,
        currentTestWindow,
        currentStepSize,
        autoApply,
        applySuggestion,
        onAutoApplied,
        onSuggestionAvailable,
    } = args;

    const currentWindows = estimateWalkForwardWindowCount(
        totalBars,
        currentOptimizationWindow,
        currentTestWindow,
        currentStepSize
    );
    const currentExpectedOOSTrades = tradesPerBar * currentTestWindow;
    const currentThresholds = deriveWalkForwardTradeThresholds(
        totalTrades,
        tradesPerBar,
        currentTestWindow,
        currentWindows
    );

    const suggestion = suggestWalkForwardWindowsFromTradeFrequency(totalBars, totalTrades, tradesPerBar);
    const shouldAdjust = currentWindows > 120 || currentExpectedOOSTrades < 2 || currentWindows < 3;

    if (shouldAdjust && autoApply) {
        const applied = applySuggestion(suggestion, "Auto window suggestion applied");
        if (applied) {
            onAutoApplied?.(suggestion);
        }
    } else if (shouldAdjust && !autoApply) {
        onSuggestionAvailable?.(suggestion);
    }

    return shouldAdjust && autoApply
        ? {
            minOOSTradesPerWindow: suggestion.minOOSTradesPerWindow,
            minTotalOOSTrades: suggestion.minTotalOOSTrades,
        }
        : {
            minOOSTradesPerWindow: currentThresholds.minOOSTradesPerWindow,
            minTotalOOSTrades: currentThresholds.minTotalOOSTrades,
        };
}
