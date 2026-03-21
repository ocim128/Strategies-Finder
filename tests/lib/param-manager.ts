import { StrategyParams, Strategy } from "./strategies/index";
import { getRequiredElement } from "./dom-utils";
import { bindFormAccessibility } from "./form-accessibility";
import { parseInputNumber } from "./dom-input-readers";

export class ParamManager {
    private getParamContainer(): HTMLElement {
        return getRequiredElement('strategyParams');
    }

    private getParamInput(key: string): HTMLInputElement | HTMLSelectElement | null {
        const container = this.getParamContainer();
        return container.querySelector(`#param_${key}`) as HTMLInputElement | HTMLSelectElement | null;
    }

    public render(strategy: Strategy) {
        const container = this.getParamContainer();
        let html = '';
        const paramKeys = Object.keys(strategy.defaultParams);

        for (let i = 0; i < paramKeys.length; i += 2) {
            html += '<div class="param-row">';
            for (let j = i; j < Math.min(i + 2, paramKeys.length); j++) {
                const key = paramKeys[j];
                const value = strategy.defaultParams[key];
                const label = strategy.paramLabels[key] || key;
                html += `
					<div class="param-group" id="param_group_${key}">
						<label class="param-label" id="param_label_${key}" for="param_${key}">${label}</label>
						${this.renderParamInput(key, value)}
					</div>
				`;
            }
            html += '</div>';
        }
        container.innerHTML = html;
        bindFormAccessibility(container);
    }

    public getValues(strategy: Strategy): StrategyParams {
        const params: StrategyParams = {};
        for (const key of Object.keys(strategy.defaultParams)) {
            const input = this.getParamInput(key);
            if (!input) {
                params[key] = strategy.defaultParams[key];
                continue;
            }

            if (input instanceof HTMLSelectElement) {
                const parsed = parseInputNumber(input.value);
                params[key] = parsed === null ? strategy.defaultParams[key] : parsed;
                continue;
            }

            if (input.type === 'checkbox') {
                params[key] = input.checked ? 1 : 0;
                continue;
            }

            const parsed = parseInputNumber(input.value);
            params[key] = parsed === null ? strategy.defaultParams[key] : parsed;
        }
        return params;
    }

    public setValues(strategy: Strategy, params: StrategyParams): void {
        for (const key of Object.keys(strategy.defaultParams)) {
            const input = this.getParamInput(key);
            if (!input || params[key] === undefined) continue;

            if (input instanceof HTMLSelectElement) {
                input.value = String(params[key]);
                continue;
            }

            if (input.type === 'checkbox') {
                input.checked = params[key] !== 0;
                continue;
            }

            input.value = String(params[key]);
        }
    }

    private renderParamInput(key: string, value: number): string {
        return `<input type="number" class="param-input" id="param_${key}" value="${value}" data-param="${key}">`;
    }
}

export const paramManager = new ParamManager();
