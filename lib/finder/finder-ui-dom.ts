import { getRequiredElement } from "../dom-utils";

export const FINDER_UI_REQUIRED_IDS = [
    "finderList",
    "finderCopyTopResults",
    "finderEmpty",
    "finderProgress",
    "finderProgressFill",
    "finderProgressText",
    "finderStatus",
    "finderBenchmark",
    "finderBenchmarkBody",
] as const;

export function createFinderUiDom() {
    return {
        finderList: getRequiredElement("finderList"),
        finderCopyTopResults: getRequiredElement<HTMLButtonElement>("finderCopyTopResults"),
        finderEmpty: getRequiredElement("finderEmpty"),
        finderProgress: getRequiredElement("finderProgress"),
        finderProgressFill: getRequiredElement("finderProgressFill"),
        finderProgressText: getRequiredElement("finderProgressText"),
        finderStatus: getRequiredElement("finderStatus"),
        finderBenchmark: getRequiredElement("finderBenchmark"),
        finderBenchmarkBody: getRequiredElement("finderBenchmarkBody"),
    };
}

export type FinderUiDom = ReturnType<typeof createFinderUiDom>;
