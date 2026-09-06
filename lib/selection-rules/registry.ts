import { top_mean } from "./reference-top-mean";
import { top_raw } from "./reference-top-raw";
import { top_active } from "./reference-top-active";
import type { SelectionRule } from "./types";

export const selectionRuleRegistry: ReadonlyMap<string, SelectionRule> = new Map([
    [top_mean.key, top_mean],
    [top_raw.key, top_raw],
    [top_active.key, top_active],
]);

export function getSelectionRule(key: string): SelectionRule | undefined {
    return selectionRuleRegistry.get(key);
}
