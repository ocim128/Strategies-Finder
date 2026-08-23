import type { BacktestSettings, OHLCVData, Strategy } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import { simulateFinderAssetOpportunityForwardOutcome } from "../lib/finder/finder-asset-opportunity-forward-contract";
import { runAssetCandidateBacktest } from "../lib/finder/finder-asset-candidate-execution";

function candle(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as unknown as OHLCVData["time"], open, high, low, close, volume: 1_000 };
}

const strategy: Strategy = {
    name: "audit-forward",
    description: "audit fixture",
    defaultParams: {},
    paramLabels: {},
    execute(candles) {
        return [{ time: candles[0]!.time, type: "buy", price: candles[0]!.close }];
    },
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0.1,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

const options = {
    mode: "random",
    scope: "asset_opportunity",
    sortPriority: ["netProfit"],
    dataSlice: "all",
    freezeRiskManagement: false,
} as unknown as FinderOptions;

async function engineTrade(data: OHLCVData[], executionModel: BacktestSettings["executionModel"], allowSameBarExit: boolean) {
    const result = await runAssetCandidateBacktest({
        data,
        symbol: "AUDIT",
        interval: "5m",
        strategy,
        strategyKey: "audit-forward",
        strategyParams: {},
        riskOverrideParams: {},
        settings: {
            executionModel,
            allowSameBarExit,
            tradeDirection: "long",
            riskMode: "percentage",
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
            slippageBps: 10,
        },
        capitalSettings,
        options,
        closedCandleDataOverride: data,
        needs: { compact: false, trades: true, fullAnalytics: false, endpointSelection: false },
    });
    return result.result.trades[0] ?? null;
}

function contract(data: OHLCVData[], executionModel: BacktestSettings["executionModel"], entryBarIndex: number, entryPrice: number, allowSameBarExit: boolean) {
    const direction = "long" as const;
    return simulateFinderAssetOpportunityForwardOutcome({
        candles: data,
        direction,
        entryPrice,
        entryBarIndex,
        // The production engine resolves percentage targets from the
        // slippage-adjusted entry price; mirror that here so this fixture
        // isolates execution-model differences rather than target setup.
        takeProfitPrice: entryPrice * 1.001 * 1.02,
        stopLossPrice: entryPrice * 1.001 * 0.98,
        horizonBars: 3,
        executionModel: executionModel!,
        allowSameBarExit,
        slippageBps: 10,
        commissionPercent: 0.1,
    });
}

const cases: Array<{
    name: string;
    data: OHLCVData[];
    model: BacktestSettings["executionModel"];
    entryIndex: number;
    entryPrice: number;
    allow: boolean;
}> = [
    {
        name: "signal-close TP gap",
        data: [candle(1, 100, 100, 100, 100), candle(2, 100, 110, 99, 105), candle(3, 105, 105, 105, 105)],
        model: "signal_close",
        entryIndex: 0,
        entryPrice: 100,
        allow: false,
    },
    {
        name: "signal-close SL gap",
        data: [candle(1, 100, 100, 100, 100), candle(2, 95, 99, 90, 94), candle(3, 94, 94, 94, 94)],
        model: "signal_close",
        entryIndex: 0,
        entryPrice: 100,
        allow: false,
    },
    {
        name: "next-open entry bar TP+SL allow false",
        data: [candle(1, 100, 100, 100, 100), candle(2, 100, 103, 97, 100), candle(3, 100, 100, 100, 100), candle(4, 100, 100, 100, 100)],
        model: "next_open",
        entryIndex: 1,
        entryPrice: 100,
        allow: false,
    },
    {
        name: "next-close entry bar TP+SL allow true",
        data: [candle(1, 100, 100, 100, 100), candle(2, 100, 103, 97, 100), candle(3, 100, 100, 100, 100), candle(4, 100, 100, 100, 100)],
        model: "next_close",
        entryIndex: 1,
        entryPrice: 100,
        allow: true,
    },
];

(async () => {
    for (const item of cases) {
        const actual = await engineTrade(item.data, item.model, item.allow);
        const expected = contract(item.data, item.model, item.entryIndex, item.entryPrice, item.allow);
        console.log(JSON.stringify({
            name: item.name,
            engine: actual && { exitReason: actual.exitReason, entryTime: actual.entryTime, exitTime: actual.exitTime, entryPrice: actual.entryPrice, exitPrice: actual.exitPrice, pnlPercent: actual.pnlPercent },
            contract: expected,
        }));
    }

    const shortData = [
        candle(1, 100, 100, 100, 100),
        candle(2, 100, 103, 90, 95),
        candle(3, 95, 95, 95, 95),
    ];
    const short = simulateFinderAssetOpportunityForwardOutcome({
        candles: shortData,
        direction: "short",
        entryPrice: 100,
        entryBarIndex: 0,
        takeProfitPrice: 98,
        stopLossPrice: 102,
        horizonBars: 1,
        executionModel: "signal_close",
        allowSameBarExit: false,
        slippageBps: 10,
        commissionPercent: 0.1,
    });
    console.log(JSON.stringify({ name: "short TP gap/asymmetry", contract: short }));
})();
