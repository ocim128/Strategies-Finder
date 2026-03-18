import { parseInputNumber } from "./dom-input-readers";

export function readSettingsNumber(id: string, fallback: number): number {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return fallback;
    const value = parseInputNumber(input.value);
    return value ?? fallback;
}

export function readSettingsCheckbox(id: string, fallback: boolean): boolean {
    const checkbox = document.getElementById(id) as HTMLInputElement | null;
    return checkbox ? checkbox.checked : fallback;
}

export function readSettingsSelect(id: string, fallback: string): string {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    return select ? select.value : fallback;
}

export function writeSettingsNumber(id: string, value: number): void {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) {
        input.value = String(value);
    }
}

export function writeSettingsCheckbox(id: string, value: boolean): void {
    const checkbox = document.getElementById(id) as HTMLInputElement | null;
    if (checkbox) {
        checkbox.checked = value;
    }
}

export function writeSettingsSelect(id: string, value: string): void {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (select) {
        select.value = value;
    }
}

export function triggerSettingsChangeEvents(toggleIds: readonly string[]): void {
    for (const id of toggleIds) {
        const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        element?.dispatchEvent(new Event("change", { bubbles: true }));
    }
}
