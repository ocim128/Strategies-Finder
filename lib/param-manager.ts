import { StrategyParams, Strategy } from "./strategies/index";
import { getRequiredElement } from "./dom-utils";

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
					<div class="param-group" id="param_group_${key}">
						<label class="param-label">${label}</label>
						${this.renderParamInput(key, value)}
					</div>
				`;
            }
            html += '</div>';
        }
        container.innerHTML = html;

        this.bindParamDependencies(strategy);
    }

    public getValues(strategy: Strategy): StrategyParams {
        const params: StrategyParams = {};
        for (const key of Object.keys(strategy.defaultParams)) {
            const input = document.getElementById(`param_${key}`) as HTMLInputElement | HTMLSelectElement | null;
            if (!input) {
                params[key] = strategy.defaultParams[key];
                continue;
            }

            if (input instanceof HTMLSelectElement) {
                const parsed = parseFloat(input.value);
                params[key] = Number.isNaN(parsed) ? strategy.defaultParams[key] : parsed;
                continue;
            }

            if (input.type === 'checkbox') {
                params[key] = input.checked ? 1 : 0;
                continue;
            }

            const parsed = parseFloat(input.value);
            params[key] = Number.isNaN(parsed) ? strategy.defaultParams[key] : parsed;
        }
        return params;
    }

    public setValues(strategy: Strategy, params: StrategyParams): void {
        for (const key of Object.keys(strategy.defaultParams)) {
            const input = document.getElementById(`param_${key}`) as HTMLInputElement | HTMLSelectElement | null;
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
        this.bindParamDependencies(strategy);
    }

    private renderParamInput(key: string, value: number): string {
        if (key === 'entryMode' || key === 'retestMode') {
            const options = [
                { value: 0, label: 'Cross' },
                { value: 1, label: 'Close' },
                { value: 2, label: 'Touch' }
            ];
            const optionsHtml = options
                .map(option => `<option value="${option.value}" ${option.value === value ? 'selected' : ''}>${option.label}</option>`)
                .join('');
            return `<select class="param-input" id="param_${key}" data-param="${key}">${optionsHtml}</select>`;
        }

        return `<input type="number" class="param-input" id="param_${key}" value="${value}" data-param="${key}">`;
    }

    private bindParamDependencies(strategy: Strategy): void {
        if (!('entryMode' in strategy.defaultParams) && !('retestMode' in strategy.defaultParams)) {
            return;
        }

        const updateDependencies = () => {
            const entryMode = this.readParamValue('entryMode', strategy.defaultParams);
            const retestMode = this.readParamValue('retestMode', strategy.defaultParams);
            const targetPct = 'targetPct' in strategy.defaultParams
                ? this.readParamValue('targetPct', strategy.defaultParams)
                : 0;
            const usesWick = 'touchUsesWick' in strategy.defaultParams
                ? this.readParamValue('touchUsesWick', strategy.defaultParams) !== 0
                : false;

            const entryUsesTouch = entryMode === 2;
            const retestUsesTouch = retestMode === 2;
            const retestUsesClose = retestMode === 1;
            const useTarget = targetPct > 0;

            this.setGroupEnabled('touchUsesWick', entryUsesTouch || retestUsesTouch);

            const toleranceRelevant = retestUsesClose || entryUsesTouch || (retestUsesTouch && !usesWick);
            this.setGroupEnabled('touchTolerancePct', toleranceRelevant);

            if ('retestMode' in strategy.defaultParams) {
                this.setGroupEnabled('retestMode', !useTarget);
            }
            if ('maxRetests' in strategy.defaultParams) {
                this.setGroupEnabled('maxRetests', !useTarget);
            }
            if ('minRetestsForWin' in strategy.defaultParams) {
                this.setGroupEnabled('minRetestsForWin', !useTarget);
            }
        };

        const entryModeEl = document.getElementById('param_entryMode') as HTMLElement | null;
        const retestModeEl = document.getElementById('param_retestMode') as HTMLElement | null;
        const touchUsesWickEl = document.getElementById('param_touchUsesWick') as HTMLElement | null;
        const targetPctEl = document.getElementById('param_targetPct') as HTMLElement | null;

        if (entryModeEl && entryModeEl.dataset.bound !== '1') {
            entryModeEl.addEventListener('change', updateDependencies);
            entryModeEl.dataset.bound = '1';
        }
        if (retestModeEl && retestModeEl.dataset.bound !== '1') {
            retestModeEl.addEventListener('change', updateDependencies);
            retestModeEl.dataset.bound = '1';
        }
        if (touchUsesWickEl && touchUsesWickEl.dataset.bound !== '1') {
            touchUsesWickEl.addEventListener('change', updateDependencies);
            touchUsesWickEl.dataset.bound = '1';
        }
        if (targetPctEl && targetPctEl.dataset.bound !== '1') {
            targetPctEl.addEventListener('change', updateDependencies);
            targetPctEl.dataset.bound = '1';
        }

        updateDependencies();
    }

    private readParamValue(key: string, defaults: StrategyParams): number {
        const input = document.getElementById(`param_${key}`) as HTMLInputElement | HTMLSelectElement | null;
        if (!input) return defaults[key];
        if (input instanceof HTMLSelectElement) {
            const parsed = parseFloat(input.value);
            return Number.isNaN(parsed) ? defaults[key] : parsed;
        }
        if (input.type === 'checkbox') {
            return input.checked ? 1 : 0;
        }
        const parsed = parseFloat(input.value);
        return Number.isNaN(parsed) ? defaults[key] : parsed;
    }

    private setGroupEnabled(key: string, enabled: boolean): void {
        const group = document.getElementById(`param_group_${key}`);
        const input = document.getElementById(`param_${key}`) as HTMLInputElement | HTMLSelectElement | null;
        if (!group || !input) return;
        group.classList.toggle('is-disabled', !enabled);
        input.disabled = !enabled;
    }
}

export const paramManager = new ParamManager();
