import { readPersistedJson, writePersistedJson } from "../../persisted-json";
import { DEFAULT_SCAN_OPTIONS, validateScanOptions, type ScanOptions, type ScanRequest, type ScanResult } from "../top-raw-scan-contract";
import { DEFAULT_SCAN_ARM, SCAN_ARMS, type ScanArm } from "../top-raw-scan-arms";
import { normalizeScanFailureDiagnostics } from "../top-raw-scan-diagnostics";

const storage = (name: string) => ({ key: `playground_top_raw_scan_${name}`, schema: `top_raw_scan.${name}`, version: 1 });
const scanArmOr = (value: unknown, fallback: ScanArm | null): ScanArm | null => (SCAN_ARMS as readonly string[]).includes(value as string) ? value as ScanArm : fallback;
export interface ScanPreferences extends ScanOptions { enabled: boolean; assetListText: string; arm: ScanArm }
export function readScanPreferences(): ScanPreferences {
    return readPersistedJson({ ...storage("preferences"), fallback: { ...DEFAULT_SCAN_OPTIONS, arm: DEFAULT_SCAN_ARM, enabled: false, assetListText: "" }, migrate: ({ data, version }) => {
        if (version !== 1 || !data || typeof data !== "object") return null;
        const value = data as ScanPreferences;
        try { return { ...validateScanOptions(value), arm: scanArmOr(value.arm, DEFAULT_SCAN_ARM)!, enabled: value.enabled === true, assetListText: typeof value.assetListText === "string" && value.assetListText.length <= 256 * 1024 ? value.assetListText : "" }; } catch { return null; }
    } });
}
export function saveScanPreferences(data: ScanPreferences): void { writePersistedJson({ ...storage("preferences"), data }); }
export function normalizeScanResult(data: unknown): ScanResult | null {
    if (!data || typeof data !== "object") return null;
    const value = data as ScanResult;
    if (value.schema !== "top_raw_scan.result.v1" || value.mode !== "fast_top_raw" || typeof value.runId !== "string"
        || !Array.isArray(value.discovery) || value.discovery.length > 5000 || !Array.isArray(value.finalists) || value.finalists.length > 5000
        || !Array.isArray(value.eligibleAssets) || value.eligibleAssets.length > 5000 || !Array.isArray(value.exclusions)
        || !Array.isArray(value.bestVerifiedCandidates) || !value.pairCounts || !value.effective || !Number.isFinite(value.asOf) || !Number.isFinite(value.cutoff)
        || !["preflight", "discovery", "refinement", "completed", "interrupted", "failed"].includes(value.status)
        || !["top_raw", "top_mean", "max_active", "top_raw_profit_now", "top_mean_profit_now", "top_raw_profit_now_conf"].includes(value.arm ?? "top_raw")
        || ![value.eligibleAssets, value.bestVerifiedCandidates, value.cutoffTies, value.omittedCutoffTies].every(list => Array.isArray(list) && list.length <= 5000 && list.every(asset => typeof asset === "string"))
        || value.discovery.some(r => !r || typeof r.asset !== "string" || !Number.isFinite(r.sampledRaw) || (r.estimatedRaw !== null && r.estimatedRaw !== undefined && !Number.isFinite(r.estimatedRaw))
            || ![r.sampledDegree, r.evaluatedDegree, r.failedDegree, r.flatDegree, r.activePositions].every(n => Number.isInteger(n) && n >= 0) || typeof r.coverageComplete !== "boolean")
        || value.finalists.some(r => !r || typeof r.asset !== "string" || (r.exactRaw !== null && r.exactRaw !== undefined && !Number.isFinite(r.exactRaw))
            || ![r.candidateRank, r.evaluatedOpponents, r.expectedOpponents, r.failedOpponents].every(n => Number.isInteger(n) && n >= 0)
            || typeof r.complete !== "boolean" || (r.complete && (r.exactRaw === null || r.evaluatedOpponents !== value.eligibleAssets.length - 1 || r.failedOpponents !== 0)))) return null;
    if (value.globalRankingExact && (value.status !== "completed" || !(value.discovery.length === value.eligibleAssets.length && value.discovery.every(r => r.evaluatedDegree === value.eligibleAssets.length - 1 && r.coverageComplete)
        || value.finalists.length === value.eligibleAssets.length && value.finalists.every(r => r.complete)))) return null;
    try { validateScanOptions(value.requested); validateScanOptions(value.effective); } catch { return null; }
    // Arm and the per-arm columns are additive: default older saved results.
    const finiteOrNull = (field: number | null | undefined): number | null => field === null || field === undefined || Number.isFinite(field) ? field ?? null : null;
    const integerOr = (field: number | undefined, fallback: number): number => Number.isInteger(field) ? field! : fallback;
    return { ...value, arm: scanArmOr(value.arm, DEFAULT_SCAN_ARM)!,
        discovery: value.discovery.map(r => ({ ...r, estimatedRaw: finiteOrNull(r.estimatedRaw), estimatedActiveDegree: finiteOrNull(r.estimatedActiveDegree), activeDegree: integerOr(r.activeDegree, 0), sampledProfitNow: Number.isFinite(r.sampledProfitNow) ? r.sampledProfitNow : 0, sampledProfitNowActiveDegree: integerOr(r.sampledProfitNowActiveDegree, 0), sampledProfitNowConf: Number.isFinite(r.sampledProfitNowConf) ? r.sampledProfitNowConf : 0, estimatedProfitNow: finiteOrNull(r.estimatedProfitNow), estimatedProfitNowActiveDegree: finiteOrNull(r.estimatedProfitNowActiveDegree), estimatedProfitNowConf: finiteOrNull(r.estimatedProfitNowConf) })),
        finalists: value.finalists.map(r => ({ ...r, exactRaw: finiteOrNull(r.exactRaw), exactActiveDegree: r.exactActiveDegree === null || r.exactActiveDegree === undefined || Number.isInteger(r.exactActiveDegree) ? r.exactActiveDegree ?? null : null, exactProfitNow: finiteOrNull(r.exactProfitNow), exactProfitNowActiveDegree: r.exactProfitNowActiveDegree === null || r.exactProfitNowActiveDegree === undefined || Number.isInteger(r.exactProfitNowActiveDegree) ? r.exactProfitNowActiveDegree ?? null : null, exactProfitNowConf: finiteOrNull(r.exactProfitNowConf) })),
        failureDiagnostics: normalizeScanFailureDiagnostics(value.failureDiagnostics, value.pairCounts.failed) };
}
export function readScanResult(): ScanResult | null { return readPersistedJson({ ...storage("result"), fallback: null, migrate: ({ data, version }) => version === 1 ? normalizeScanResult(data) : null }); }
export function saveScanResult(data: ScanResult | null): boolean { return writePersistedJson({ ...storage("result"), data }); }
export function saveScanActive(runId: string | null): void { writePersistedJson({ ...storage("active"), data: runId }); }
export function readScanActive(): string | null { return readPersistedJson({ ...storage("active"), fallback: null, migrate: ({ data, version }) => version === 1 && typeof data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data) ? data : null }); }
export function saveScanRequest(data: ScanRequest): void { writePersistedJson({ ...storage("request"), data }); }
export function readScanRequest(): ScanRequest | null { return readPersistedJson({ ...storage("request"), fallback: null, migrate: ({ data, version }) => {
    const value = data as ScanRequest;
    if (version !== 1 || !value || typeof value.runId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.runId) || typeof value.assetListText !== "string" || !value.strategyParams || !value.backtestSettings || !value.capitalSettings) return null;
    if (value.arm !== undefined && scanArmOr(value.arm, null) === null) return null;
    try { validateScanOptions(value); return value; } catch { return null; }
} }); }
