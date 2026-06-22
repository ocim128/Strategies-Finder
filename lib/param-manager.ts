import { StrategyParams, Strategy } from "./strategies/index";
import { getRequiredElement } from "./dom-utils";
import { bindFormAccessibility } from "./form-accessibility";
import { parseInputNumber } from "./dom-input-readers";

export class ParamManager {
    private inputsByParam = new Map<string, HTMLInputElement | HTMLSelectElement>();

    constructor(
        private readonly containerId: string = 'strategyParams',
        private readonly idPrefix: string = 'param_',
    ) {}

    private getParamContainer(): HTMLElement {
        return getRequiredElement(this.containerId);
    }

    private getParamInput(key: string): HTMLInputElement | HTMLSelectElement | null {
        return this.inputsByParam.get(key) ?? null;
    }

    public render(strategy: Strategy) {
        const container = this.getParamContainer();
        const paramKeys = Object.keys(strategy.defaultParams);
        const fragment = document.createDocumentFragment();
        this.inputsByParam.clear();

        for (let i = 0; i < paramKeys.length; i += 2) {
            const row = document.createElement('div');
            row.className = 'param-row';
            for (let j = i; j < Math.min(i + 2, paramKeys.length); j++) {
                const key = paramKeys[j];
                const value = strategy.defaultParams[key];
                const label = strategy.paramLabels[key] || key;
                const group = document.createElement('div');
                group.className = 'param-group';
                group.id = `${this.idPrefix}group_${key}`;

                const labelEl = document.createElement('label');
                labelEl.className = 'param-label';
                labelEl.id = `${this.idPrefix}label_${key}`;
                labelEl.htmlFor = `${this.idPrefix}${key}`;
                labelEl.textContent = label;

                const input = this.renderParamInput(key, value);
                this.inputsByParam.set(key, input);
                group.append(labelEl, input);
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
        input.id = `${this.idPrefix}${key}`;
        input.value = String(value);
        input.dataset.param = key;
        return input;
    }
}

export const paramManager = new ParamManager();
export const exitStrategyParamManager = new ParamManager('exitStrategyParamsContainer', 'exit_param_');
