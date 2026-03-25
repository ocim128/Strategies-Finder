import { expect } from "chai";
import { describe, it } from "node:test";
import { State, state } from "./lib/state";
import {
    selectBacktestState,
    selectChartState,
    selectLayoutState,
    selectMarketState,
} from "./lib/state-domains";
import {
    setBlockRange,
    setChartMode,
    setCurrentStrategyKey,
    setDarkTheme,
    setMarketSelection,
    setMockChartBars,
    setMockChartModel,
    setStrategyTimeframeSettings,
    setTwoHourCloseParity,
} from "./lib/state-actions";

describe("State domains", () => {
    it("slices a state instance into domain snapshots", () => {
        const localState = new State();
        localState.currentSymbol = "BTCUSDT";
        localState.currentInterval = "4h";
        localState.ohlcvData = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
        localState.twoHourCloseParity = "both";
        localState.mockChartModel = "v5";
        localState.mockChartBars = 1234;
        localState.chartMode = "heikin-ashi";
        localState.currentBacktestResultSource = "finder_selection";
        localState.strategyTimeframeEnabled = true;
        localState.strategyTimeframeMinutes = 240;
        localState.currentStrategyKey = "demo_strategy";
        localState.isDarkTheme = false;
        localState.blockRange = { from: 10, to: 20 };

        expect(selectMarketState(localState)).to.deep.equal({
            currentSymbol: "BTCUSDT",
            currentInterval: "4h",
            ohlcvData: localState.ohlcvData,
            twoHourCloseParity: "both",
        });
        expect(selectChartState(localState).mockChartModel).to.equal("v5");
        expect(selectChartState(localState).chartMode).to.equal("heikin-ashi");
        expect(selectBacktestState(localState)).to.include({
            currentBacktestResultSource: "finder_selection",
            strategyTimeframeEnabled: true,
            strategyTimeframeMinutes: 240,
        });
        expect(selectLayoutState(localState)).to.deep.equal({
            currentStrategyKey: "demo_strategy",
            isDarkTheme: false,
            blockRange: { from: 10, to: 20 },
        });
    });

    it("updates singleton domains through named actions", () => {
        const previous = {
            currentSymbol: state.currentSymbol,
            currentInterval: state.currentInterval,
            twoHourCloseParity: state.twoHourCloseParity,
            currentStrategyKey: state.currentStrategyKey,
            isDarkTheme: state.isDarkTheme,
            blockRange: state.blockRange,
            chartMode: state.chartMode,
            mockChartModel: state.mockChartModel,
            mockChartBars: state.mockChartBars,
            strategyTimeframeEnabled: state.strategyTimeframeEnabled,
            strategyTimeframeMinutes: state.strategyTimeframeMinutes,
        };

        try {
            setMarketSelection({ symbol: "SOLUSDT", interval: "2h" });
            setTwoHourCloseParity("even");
            setCurrentStrategyKey("test_strategy");
            setDarkTheme(false);
            setBlockRange({ from: 100, to: 200 });
            setChartMode("heikin-ashi");
            setMockChartModel("v4");
            setMockChartBars(4321);
            setStrategyTimeframeSettings({ enabled: true, minutes: 180 });

            expect(selectMarketState()).to.include({
                currentSymbol: "SOLUSDT",
                currentInterval: "2h",
                twoHourCloseParity: "even",
            });
            expect(selectLayoutState()).to.deep.equal({
                currentStrategyKey: "test_strategy",
                isDarkTheme: false,
                blockRange: { from: 100, to: 200 },
            });
            expect(selectChartState()).to.include({
                chartMode: "heikin-ashi",
                mockChartModel: "v4",
                mockChartBars: 4321,
            });
            expect(selectBacktestState()).to.include({
                strategyTimeframeEnabled: true,
                strategyTimeframeMinutes: 180,
            });
        } finally {
            setMarketSelection({ symbol: previous.currentSymbol, interval: previous.currentInterval });
            setTwoHourCloseParity(previous.twoHourCloseParity);
            setCurrentStrategyKey(previous.currentStrategyKey);
            setDarkTheme(previous.isDarkTheme);
            setBlockRange(previous.blockRange);
            setChartMode(previous.chartMode);
            setMockChartModel(previous.mockChartModel);
            setMockChartBars(previous.mockChartBars);
            setStrategyTimeframeSettings({
                enabled: previous.strategyTimeframeEnabled,
                minutes: previous.strategyTimeframeMinutes,
            });
        }
    });
});
