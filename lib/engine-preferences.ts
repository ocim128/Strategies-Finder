export type EnginePreference = 'rust' | 'typescript';

export const ENGINE_TOGGLE_ID = 'useRustEngineToggle';
const DEFAULT_ENGINE_PREFERENCE: EnginePreference = 'rust';

export function getEnginePreference(): EnginePreference {
    const toggle = document.getElementById(ENGINE_TOGGLE_ID) as HTMLInputElement | null;
    if (!toggle) return DEFAULT_ENGINE_PREFERENCE;
    return toggle.checked ? 'rust' : 'typescript';
}

export function shouldUseRustEngine(): boolean {
    return getEnginePreference() === 'rust';
}

export function setEnginePreference(preference: EnginePreference): void {
    const toggle = document.getElementById(ENGINE_TOGGLE_ID) as HTMLInputElement | null;
    if (!toggle) return;
    const shouldCheck = preference === 'rust';
    if (toggle.checked === shouldCheck) return;
    toggle.checked = shouldCheck;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
}

export function toggleEnginePreference(): EnginePreference {
    const current = getEnginePreference();
    const next: EnginePreference = current === 'rust' ? 'typescript' : 'rust';
    setEnginePreference(next);
    return next;
}
