import type {
    PairSelectionDetailPairPerformance,
    PairSelectionDetailRow,
    PairSelectionRuleDetail,
} from "../pair-selection/tally";

/**
 * Server-side retention cap per ruleKey|horizonBars. Older history beyond
 * the cap is intentionally omitted (surfaced as historyTruncated) while the
 * pair aggregates, computed by the tally before capping, still cover every
 * completed event.
 */
export const SELECTION_RULES_DETAIL_HISTORY_CAP = 2_000;

export interface SelectionRulesDetailEntry {
    latest: PairSelectionDetailRow | null;
    /** Newest-first, capped at SELECTION_RULES_DETAIL_HISTORY_CAP rows. */
    rows: PairSelectionDetailRow[];
    totalRows: number;
    historyTruncated: boolean;
    pairPerformance: PairSelectionDetailPairPerformance[];
}

export interface SelectionRulesDetailStore {
    store(ruleKey: string, horizonBars: number, detail: PairSelectionRuleDetail): void;
    get(ruleKey: string, horizonBars: number): SelectionRulesDetailEntry | null;
    clear(): void;
}

export function createSelectionRulesDetailStore(): SelectionRulesDetailStore {
    const entries = new Map<string, SelectionRulesDetailEntry>();
    return {
        store(ruleKey, horizonBars, detail) {
            const newestFirst = [...detail.history].reverse();
            entries.set(`${ruleKey}|${horizonBars}`, {
                latest: detail.latest,
                rows: newestFirst.slice(0, SELECTION_RULES_DETAIL_HISTORY_CAP),
                totalRows: newestFirst.length,
                historyTruncated: newestFirst.length > SELECTION_RULES_DETAIL_HISTORY_CAP,
                pairPerformance: detail.pairPerformance,
            });
        },
        get(ruleKey, horizonBars) {
            return entries.get(`${ruleKey}|${horizonBars}`) ?? null;
        },
        clear() {
            entries.clear();
        },
    };
}
