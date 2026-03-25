import { getRequiredElement } from "./dom-utils";

export const PARAMETER_AUDIT_REQUIRED_IDS = [
    "parameterAuditSource",
    "parameterAuditSavedConfigGroup",
    "parameterAuditSavedConfig",
    "parameterAuditRun",
    "parameterAuditProgress",
    "parameterAuditProgressFill",
    "parameterAuditProgressText",
    "parameterAuditStatus",
    "parameterAuditSourceSummary",
    "parameterAuditIncludedParams",
    "parameterAuditEvidence",
    "parameterAuditSummary",
    "parameterAuditEmpty",
    "parameterAuditTableBody",
] as const;

export function createParameterAuditDom() {
    return {
        parameterAuditSource: getRequiredElement<HTMLSelectElement>("parameterAuditSource"),
        parameterAuditSavedConfigGroup: getRequiredElement("parameterAuditSavedConfigGroup"),
        parameterAuditSavedConfig: getRequiredElement<HTMLSelectElement>("parameterAuditSavedConfig"),
        parameterAuditRun: getRequiredElement<HTMLButtonElement>("parameterAuditRun"),
        parameterAuditProgress: getRequiredElement("parameterAuditProgress"),
        parameterAuditProgressFill: getRequiredElement("parameterAuditProgressFill"),
        parameterAuditProgressText: getRequiredElement("parameterAuditProgressText"),
        parameterAuditStatus: getRequiredElement("parameterAuditStatus"),
        parameterAuditSourceSummary: getRequiredElement("parameterAuditSourceSummary"),
        parameterAuditIncludedParams: getRequiredElement("parameterAuditIncludedParams"),
        parameterAuditEvidence: getRequiredElement("parameterAuditEvidence"),
        parameterAuditSummary: getRequiredElement("parameterAuditSummary"),
        parameterAuditEmpty: getRequiredElement("parameterAuditEmpty"),
        parameterAuditTableBody: getRequiredElement("parameterAuditTableBody"),
    };
}

export type ParameterAuditDom = ReturnType<typeof createParameterAuditDom>;
