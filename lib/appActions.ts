import { MouseEventParams, Time, CandlestickData } from "lightweight-charts";
import { state } from "./state";
import { uiManager } from "./uiManager";
import { debugLogger } from "./debugLogger";
import { chartManager } from "./chartManager";

export function handleCrosshairMove(param: MouseEventParams<Time>) {
    if (!param.time || !param.seriesData) {
        chartManager.hideTooltip();
        return;
    }

    const data = param.seriesData.get(state.candlestickSeries) as CandlestickData<Time> | undefined;
    if (!data) {
        chartManager.hideTooltip();
        return;
    }

    const ohlc = state.ohlcvData.find(d => d.time === data.time);
    if (!ohlc) {
        chartManager.hideTooltip();
        return;
    }

    // Update the OHLC display panel
    uiManager.updateOHLCDisplay(ohlc);

    // Update the enhanced tooltip
    chartManager.updateTooltip(param, ohlc);
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

