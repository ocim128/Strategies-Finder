import type { ParameterRange } from "../strategies/walk-forward";
import type { StrategyParams } from "./strategies";

export type ParameterAuditSourceType =
    | "current_strategy"
    | "saved_configuration"
    | "latest_finder_candidate"
    | "latest_wfa_result";

export type ParameterAuditEvidenceOrigin =
    | "wfa_window"
    | "finder_result"
    | "mini_run";

export type ParameterAuditClassification =
    | "core"
    | "weak"
    | "redundant"
    | "likely_useless"
    | "boundary_problem"
    | "interaction_only";

export type ParameterAuditSuggestedAction =
    | "keep"
    | "fix_constant"
    | "narrow_range"
    | "widen_range"
    | "remove"
    | "investigate_interaction";

export type ParameterAuditEvidenceStrength = "strong" | "moderate" | "weak";

export interface ParameterAuditMetricsLike {
    netProfitPercent: number;
    sharpeRatio: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    winRate: number;
}

export interface ParameterAuditSample {
    origin: ParameterAuditEvidenceOrigin;
    value: number;
    score: number;
    accepted: boolean;
    params: StrategyParams;
    label: string;
}

export interface ParameterAuditParameterInput {
    name: string;
    label: string;
    baseValue: number;
    range: ParameterRange;
    samples: ParameterAuditSample[];
}

export interface ParameterAuditReportInput {
    strategyKey: string;
    strategyName: string;
    sourceType: ParameterAuditSourceType;
    sourceLabel: string;
    parameters: ParameterAuditParameterInput[];
    usedWfaReuse: boolean;
    usedFinderReuse: boolean;
    usedMiniRuns: boolean;
}

export interface ParameterAuditRow {
    parameter: string;
    key: string;
    baseValue: number;
    bestValueCluster: string;
    impactScore: number;
    stability: number;
    boundaryHitPercent: number;
    rangeOccupancy: number;
    classification: ParameterAuditClassification;
    suggestedAction: ParameterAuditSuggestedAction;
    notes: string;
    evidenceStrength: ParameterAuditEvidenceStrength;
}

export interface ParameterAuditSummary {
    overallParameterBloat: string;
    simplificationPriority: string;
    topPriorityParams: string[];
    weakEvidenceWarning: string | null;
    evidenceMode: string;
}

export interface ParameterAuditReport {
    strategyKey: string;
    strategyName: string;
    sourceType: ParameterAuditSourceType;
    sourceLabel: string;
    includedParams: string[];
    rows: ParameterAuditRow[];
    summary: ParameterAuditSummary;
}
