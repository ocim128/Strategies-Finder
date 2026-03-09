export interface WalkForwardTradeThresholds {
    expectedOOSTradesPerWindow: number;
    minTrades: number;
    minOOSTradesPerWindow: number;
    minTotalOOSTrades: number;
}

export function deriveWalkForwardTradeThresholds(
    totalTrades: number,
    tradesPerBar: number,
    testWindow: number,
    estimatedWindows: number
): WalkForwardTradeThresholds {
    const safeTotalTrades = Math.max(0, Math.floor(totalTrades));
    const safeTradesPerBar = Number.isFinite(tradesPerBar) ? Math.max(0, tradesPerBar) : 0;
    const safeTestWindow = Math.max(1, Math.floor(testWindow));
    const safeEstimatedWindows = Math.max(1, Math.floor(estimatedWindows));

    const expectedOOSTradesPerWindow = safeTradesPerBar * safeTestWindow;
    const minOOSTradesPerWindow = Math.max(1, Math.floor(expectedOOSTradesPerWindow * 0.5));
    const minTotalOOSTrades = Math.max(
        20,
        Math.min(
            safeTotalTrades,
            Math.floor(minOOSTradesPerWindow * Math.max(5, safeEstimatedWindows * 0.5))
        )
    );

    return {
        expectedOOSTradesPerWindow,
        minTrades: Math.max(1, minOOSTradesPerWindow),
        minOOSTradesPerWindow,
        minTotalOOSTrades
    };
}
