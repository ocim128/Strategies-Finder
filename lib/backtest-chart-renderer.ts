import { chartManager } from "./chart-manager";
import { getOptionalElement } from "./dom-utils";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { uiManager } from "./ui-manager";
import type { OHLCVData, StrategyParams } from "./strategies/index";

export function addStrategyIndicators(params: StrategyParams) {
    chartManager.clearIndicators();
    const indicatorsPanel = getOptionalElement('indicatorsPanel');
    if (indicatorsPanel) indicatorsPanel.innerHTML = '';

    const strategy = strategyRegistry.get(state.currentStrategyKey);
    if (!strategy) {
        return;
    }

    const indicators = strategy.indicators ? strategy.indicators(state.ohlcvData, params) : [];
    const times = state.ohlcvData.map(d => d.time);

    indicators.forEach(ind => {
        if (Array.isArray(ind.values)) {
            const values = ind.values as (number | null)[];
            const color = ind.color || (ind.type === 'histogram' ? '#ef5350' : '#2962ff');
            addIndicatorToChart(ind.name, values, times, color, ind.type);
        }
    });
}

function addIndicatorToChart(
    name: string,
    values: (number | null)[],
    times: OHLCVData['time'][],
    color: string,
    type: 'line' | 'band' | 'histogram'
) {
    const lineData = values
        .map((v, i) => v !== null ? { time: times[i], value: v } : null)
        .filter(d => d !== null) as { time: OHLCVData['time']; value: number }[];

    if (type === 'histogram') {
        const id = chartManager.addIndicatorHistogram(name, 0, lineData, color);
        uiManager.addIndicatorBadge(id, name, 0, color);
    } else {
        const id = chartManager.addIndicatorLine(name, 0, lineData, color);
        uiManager.addIndicatorBadge(id, name, 0, color);
    }
}
