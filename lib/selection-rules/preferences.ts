export const SELECTION_RULES_PREFERENCES_STORAGE = {
    key: "playground_selection_rules_preferences",
    schema: "selection_rules.preferences",
    version: 1,
} as const;

export interface SelectionRulesPreferences {
    folderId: string | null;
    horizonBars: number | null;
    ruleKeys: string[];
}

export function normalizeSelectionRulesPreferences(
    value: unknown,
    availableRuleKeys: readonly string[],
): SelectionRulesPreferences | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Partial<SelectionRulesPreferences>;
    if (raw.folderId !== undefined && raw.folderId !== null && typeof raw.folderId !== "string") return null;
    if (
        raw.horizonBars !== undefined
        && raw.horizonBars !== null
        && (typeof raw.horizonBars !== "number" || !Number.isInteger(raw.horizonBars) || raw.horizonBars <= 0)
    ) return null;
    const folderId = raw.folderId === undefined ? null : raw.folderId;
    const horizonBars = raw.horizonBars === undefined ? null : raw.horizonBars;
    if (!Array.isArray(raw.ruleKeys)) return null;
    const available = new Set(availableRuleKeys);
    const ruleKeys: string[] = [];
    for (const key of raw.ruleKeys) {
        if (typeof key !== "string" || !available.has(key) || ruleKeys.includes(key)) continue;
        ruleKeys.push(key);
    }
    return { folderId, horizonBars, ruleKeys };
}
