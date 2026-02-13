import { getOptionalElement } from "./dom-utils";

export function readNumberInputValue(id: string, fallback: number, min?: number): number {
    const input = getOptionalElement<HTMLInputElement>(id);
    if (!input) return fallback;
    const value = parseFloat(input.value);
    if (!Number.isFinite(value)) return fallback;
    return min === undefined ? value : Math.max(min, value);
}

export function readToggleValue(id: string, fallback: boolean): boolean {
    const toggle = getOptionalElement<HTMLInputElement>(id);
    return toggle ? toggle.checked : fallback;
}
