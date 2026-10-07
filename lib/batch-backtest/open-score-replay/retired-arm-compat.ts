import { compactCausalArmDefinitions } from "./causal-arm-constants";
import { compactCausalArmDiagnostics, compactRankingMeasurement } from "./types";

// Historical snapshots may contain these fields. They are never calculated,
// displayed, or exported by the current seventeen-arm implementation.
const RETIRED_FIELDS = ["topCoverage", "topPriceStrength", "topGraphStrength", "TOP_COVERAGE", "TOP_PRICE_STRENGTH", "TOP_GRAPH_STRENGTH"];
const isRetired = (key: string): boolean => RETIRED_FIELDS.some((field) => key.startsWith(field));
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Project saved replay sections onto the retained arms without changing their metrics. */
export function removeRetiredCausalArms<T extends object>(source: T): T {
    const target = { ...source } as Record<string, unknown>;
    for (const key of Object.keys(target)) if (isRetired(key)) delete target[key];
    for (const key of ["arms", "armComparisons", "armComparisonsExTopContributor", "armTopContributors", "armExTopContributorComparisons", "armTopContributorAssets", "armTopContributorEvents"]) {
        const section = target[key];
        if (isRecord(section)) target[key] = Object.fromEntries(Object.entries(section).filter(([field]) => !isRetired(field)));
    }
    for (const key of ["horizons", "annualReports"]) {
        const sections = target[key];
        if (Array.isArray(sections)) target[key] = sections.map((section: unknown) => isRecord(section) ? removeRetiredCausalArms(section) : section);
    }
    if (isRecord(target.assetSwitch)) target.assetSwitch = removeRetiredCausalArms(target.assetSwitch);
    if (isRecord(target.latestSelections) && Array.isArray(target.latestSelections.selections)) {
        target.latestSelections = { ...target.latestSelections, selections: target.latestSelections.selections
            .filter((row: unknown) => !isRecord(row) || typeof row.selector !== "string" || !isRetired(row.selector)) };
    }
    for (const key of ["trades", "eventDetails", "openScoreEventDetails", "ongoingEventDetails"]) {
        const rows = target[key];
        if (Array.isArray(rows)) target[key] = rows.filter((row: unknown) => !isRecord(row)
            || ![row.arm, row.selector].some((field) => typeof field === "string" && isRetired(field)));
    }
    if (Array.isArray(target.reportLines)) target.reportLines = target.reportLines
        .filter((line: unknown) => typeof line !== "string" || !RETIRED_FIELDS.some((field) => line.includes(field)));
    if ("causalArmDefinitions" in target) target.causalArmDefinitions = compactCausalArmDefinitions(target.causalArmDefinitions);
    if ("causalArmDiagnostics" in target) target.causalArmDiagnostics = compactCausalArmDiagnostics(target.causalArmDiagnostics);
    if ("rankingMeasurement" in target) target.rankingMeasurement = compactRankingMeasurement(target.rankingMeasurement);
    return target as T;
}
