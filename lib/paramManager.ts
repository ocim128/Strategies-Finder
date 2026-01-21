import { StrategyParams, Strategy } from "./strategies/index";
import { getRequiredElement } from "./domUtils";

export class ParamManager {
    public render(strategy: Strategy) {
        const container = getRequiredElement('strategyParams');
        let html = '';
        const paramKeys = Object.keys(strategy.defaultParams);

        for (let i = 0; i < paramKeys.length; i += 2) {
            html += '<div class="param-row">';
            for (let j = i; j < Math.min(i + 2, paramKeys.length); j++) {
                const key = paramKeys[j];
                const value = strategy.defaultParams[key];
                const label = strategy.paramLabels[key] || key;
                html += `
					<div class="param-group">
						<label class="param-label">${label}</label>
						<input type="number" class="param-input" id="param_${key}" value="${value}" data-param="${key}">
					</div>
				`;
            }
            html += '</div>';
        }
        container.innerHTML = html;
    }

    public getValues(strategy: Strategy): StrategyParams {
        const params: StrategyParams = {};
        for (const key of Object.keys(strategy.defaultParams)) {
            const input = document.getElementById(`param_${key}`) as HTMLInputElement;
            if (input) {
                const parsed = parseFloat(input.value);
                params[key] = isNaN(parsed) ? strategy.defaultParams[key] : parsed;
            } else {
                params[key] = strategy.defaultParams[key];
            }
        }
        return params;
    }

    public setValues(strategy: Strategy, params: StrategyParams): void {
        for (const key of Object.keys(strategy.defaultParams)) {
            const input = document.getElementById(`param_${key}`) as HTMLInputElement | null;
            if (input && params[key] !== undefined) {
                input.value = String(params[key]);
            }
        }
    }
}

export const paramManager = new ParamManager();
