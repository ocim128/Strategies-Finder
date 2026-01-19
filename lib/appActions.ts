import { MouseEventParams, Time, CandlestickData } from "lightweight-charts";
import { state } from "./state";
import { uiManager } from "./uiManager";
import { debugLogger } from "./debugLogger";
import { chartManager } from "./chartManager";

export function handleCrosshairMove(param: MouseEventParams<Time>) {
    if (!param.time || !param.seriesData) return;
    const data = param.seriesData.get(state.candlestickSeries) as CandlestickData<Time> | undefined;
    if (!data) return;
    const ohlc = state.ohlcvData.find(d => d.time === data.time);
    if (!ohlc) return;
    uiManager.updateOHLCDisplay(ohlc);
}

export function clearAll() {
    debugLogger.event('ui.clear');
    chartManager.clearIndicators();
    if (state.markersPlugin) {
        state.markersPlugin.detach();
        state.set('markersPlugin', null);
    }
    state.equitySeries.setData([]);
    state.clearTradeResults();
    uiManager.clearUI();
}
