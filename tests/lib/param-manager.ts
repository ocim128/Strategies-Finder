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
        return Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-param]'))
            .find((input) => input.dataset.param === key) ?? null;
    }

    public render(strategy: Strategy) {
        const container = this.getParamContainer();
        const paramKeys = Object.keys(strategy.defaultParams);
        const fragment = document.createDocumentFragment();

        for (let i = 0; i < paramKeys.length; i += 2) {
            const row = document.createElement('div');
            row.className = 'param-row';
            for (let j = i; j < Math.min(i + 2, paramKeys.length); j++) {
                const key = paramKeys[j];
                const value = strategy.defaultParams[key];
                const label = strategy.paramLabels[key] || key;
                const group = document.createElement('div');
                group.className = 'param-group';
                group.id = `param_group_${key}`;

                const labelEl = document.createElement('label');
                labelEl.className = 'param-label';
                labelEl.id = `param_label_${key}`;
                labelEl.htmlFor = `param_${key}`;
                labelEl.textContent = label;

                group.append(labelEl, this.renderParamInput(key, value));
                row.appendChild(group);
            }
            fragment.appendChild(row);
        }
        container.replaceChildren(fragment);
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

    private renderParamInput(key: string, value: number): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'param-input';
        input.id = `param_${key}`;
        input.value = String(value);
        input.dataset.param = key;
        return input;
    }
}

export const paramManager = new ParamManager();
