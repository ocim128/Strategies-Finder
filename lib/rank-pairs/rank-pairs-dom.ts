import { getRequiredElement } from "../dom-utils";

/**
 * Structural DOM contract for the Rank Pairs tab.
 *
 * Mirrors the `lib/batch-backtest/batch-backtest-dom.ts` pattern: a
 * required-ids array used by `tests/feature-dom-contracts.spec.ts`, plus a
 * `create*Dom()` factory that resolves the elements through `getRequiredElement`.
 *
 * Every id here must also exist in `html-partials/tab-rank-pairs.html`.
 */
export const RANK_PAIRS_REQUIRED_IDS = [
    "rankpairsTab",
    "rankPairsMode",
    "rankPairsSymbols",
    "rankPairsUseCurrent",
    "rankPairsClear",
    "rankPairsRunBtn",
    "rankPairsStopBtn",
    "rankPairsCopyBtn",
    "rankPairsProgress",
    "rankPairsProgressFill",
    "rankPairsProgressText",
    "rankPairsStatus",
    "rankPairsSummary",
    "rankPairsResults",
    "rankPairsEmpty",
] as const;

export function createRankPairsDom() {
    return {
        rankpairsTab: getRequiredElement("rankpairsTab"),
        rankPairsMode: getRequiredElement<HTMLSelectElement>("rankPairsMode"),
        rankPairsSymbols: getRequiredElement<HTMLTextAreaElement>("rankPairsSymbols"),
        rankPairsUseCurrent: getRequiredElement<HTMLButtonElement>("rankPairsUseCurrent"),
        rankPairsClear: getRequiredElement<HTMLButtonElement>("rankPairsClear"),
        rankPairsRunBtn: getRequiredElement<HTMLButtonElement>("rankPairsRunBtn"),
        rankPairsStopBtn: getRequiredElement<HTMLButtonElement>("rankPairsStopBtn"),
        rankPairsCopyBtn: getRequiredElement<HTMLButtonElement>("rankPairsCopyBtn"),
        rankPairsProgress: getRequiredElement("rankPairsProgress"),
        rankPairsProgressFill: getRequiredElement<HTMLDivElement>("rankPairsProgressFill"),
        rankPairsProgressText: getRequiredElement<HTMLDivElement>("rankPairsProgressText"),
        rankPairsStatus: getRequiredElement<HTMLDivElement>("rankPairsStatus"),
        rankPairsSummary: getRequiredElement<HTMLDivElement>("rankPairsSummary"),
        rankPairsResults: getRequiredElement<HTMLDivElement>("rankPairsResults"),
        rankPairsEmpty: getRequiredElement<HTMLDivElement>("rankPairsEmpty"),
    };
}

export type RankPairsDom = ReturnType<typeof createRankPairsDom>;
