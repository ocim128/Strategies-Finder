import { getOptionalElement } from "./dom-utils";

export function parseInputNumber(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    let normalized = trimmed.replace(/\s+/g, "");
    const lastComma = normalized.lastIndexOf(",");
    const lastDot = normalized.lastIndexOf(".");

    if (lastComma >= 0 && lastDot >= 0) {
        if (lastComma > lastDot) {
            normalized = normalized.replace(/\./g, "").replace(",", ".");
        } else {
            normalized = normalized.replace(/,/g, "");
        }
    } else if (lastComma >= 0) {
        normalized = normalized.replace(",", ".");
    }

    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}

export function readNumberInputValue(id: string, fallback: number, min?: number): number {
    const input = getOptionalElement<HTMLInputElement>(id);
    if (!input) return fallback;
    const value = parseInputNumber(input.value);
    if (value === null) return fallback;
    return min === undefined ? value : Math.max(min, value);
}

export function readToggleValue(id: string, fallback: boolean): boolean {
    const toggle = getOptionalElement<HTMLInputElement>(id);
    return toggle ? toggle.checked : fallback;
}
