import { canonicalizeLegIdentity, dedupeWithinProviderAliases } from "../synthetic-leg-identity";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { ScanArm } from "./top-raw-scan-arms";

export const TOP_RAW_SCAN_VERSION = "top_raw_scan.v1";
export const TOP_RAW_SCAN_ORIENTATION = "top_raw_scan_orientation_v1";
export const TOP_RAW_SCAN_SAMPLING = "top_raw_scan_round_robin_v1";
export const TOP_RAW_SCAN_TIES = "top_raw_scan_ties_v1";
export const TOP_RAW_SCAN_MAX_BYTES = 256 * 1024;
export const TOP_RAW_SCAN_MAX_PAIRS = 1_000_000;
export const TOP_RAW_SCAN_MAX_ASSETS = 5000;
export const TOP_RAW_SCAN_SHARD_SIZE = 32;
// Mandatory 30m, primary source and target fallback, plus the catalog.
export const TOP_RAW_SCAN_MAX_SOURCES_PER_ASSET = 3;
export type ScanPhase = "preflight" | "discovery" | "refinement" | "completed" | "interrupted" | "failed";
export interface ScanOptions { opponentsPerAsset: number; finalistCount: number; seed: number }
export const DEFAULT_SCAN_OPTIONS: Readonly<ScanOptions> = Object.freeze({ opponentsPerAsset: 64, finalistCount: 20, seed: 1 });
export function validateScanOptions(value: Partial<Record<keyof ScanOptions, unknown>>): ScanOptions {
    const integer = (key: keyof ScanOptions, min: number, max: number) => {
        const n = value[key] === undefined ? DEFAULT_SCAN_OPTIONS[key] : value[key];
        if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in ${min}..${max}.`);
        return n;
    };
    return { opponentsPerAsset: integer("opponentsPerAsset", 1, 256), finalistCount: integer("finalistCount", 1, 100), seed: integer("seed", 0, 0xffffffff) };
}
export function parseScanAssets(text: string): { assets: string[]; rawCount: number; duplicateCount: number } {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > TOP_RAW_SCAN_MAX_BYTES) throw new Error("Asset list exceeds 256 KiB.");
    const lines = text.split(/\r?\n/);
    if (lines.length > TOP_RAW_SCAN_MAX_ASSETS) throw new Error("Asset list exceeds 5,000 input lines.");
    const identities = [];
    for (let row = 0; row < lines.length; row++) {
        const token = lines[row]!.trim();
        if (!token) continue;
        const id = canonicalizeLegIdentity(token);
        if (!id || id.provider !== "ibkr") throw new Error(`Row ${row + 1}: use one marked stock such as AAPL•; synthetic pairs and unmarked symbols are unsupported.`);
        identities.push(id);
    }
    const assets = dedupeWithinProviderAliases(identities).map(id => id.loaderSymbol).sort();
    if (assets.length < 2) throw new Error("At least two distinct marked stocks are required.");
    return { assets, rawCount: identities.length, duplicateCount: identities.length - assets.length };
}
export interface ScanRequest extends ScanOptions {
    runId: string; strategyKey: string; strategyParams: StrategyParams; backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings; interval: string; assetListText: string; workerCount?: number;
    useRustEnginePreference?: boolean; resume?: boolean; arm?: ScanArm;
}
export interface ScanPair { key: string; base: string; quote: string; symbol: string }
/** profitNow: signed open-vote count under the causal realized-profit gate;
 * profitNowConf: the same votes weighted by the closed-history confidence. */
export interface ScanVote { key: string; vote: number; active: number; engine: "typescript" | "rust"; profitNow?: number; profitNowConf?: number; error?: string }
export interface ScanRow {
    asset: string; sampledRaw: number; estimatedRaw: number | null; sampledDegree: number;
    evaluatedDegree: number; failedDegree: number; activePositions: number; flatDegree: number; coverageComplete: boolean;
    activeDegree: number; estimatedActiveDegree: number | null;
    sampledProfitNow: number; sampledProfitNowActiveDegree: number; sampledProfitNowConf: number;
    estimatedProfitNow: number | null; estimatedProfitNowActiveDegree: number | null; estimatedProfitNowConf: number | null;
}
export interface ScanFinalist {
    asset: string; candidateRank: number; exactRaw: number | null; evaluatedOpponents: number;
    expectedOpponents: number; failedOpponents: number; complete: boolean; exactActiveDegree: number | null;
    exactProfitNow: number | null; exactProfitNowActiveDegree: number | null; exactProfitNowConf: number | null;
}
export interface ScanResult {
    schema: "top_raw_scan.result.v1"; mode: "fast_top_raw"; runId: string; status: ScanPhase;
    cutoff: number; asOf: number; fingerprint: string; universeHash: string; sourceRevisions: Record<string, string>; legEndpoints: Record<string, number>;
    arm: ScanArm; scoreContract: "unweighted_open_position_sum_v1"; orientationVersion: typeof TOP_RAW_SCAN_ORIENTATION;
    samplingVersion: typeof TOP_RAW_SCAN_SAMPLING; tieVersion: typeof TOP_RAW_SCAN_TIES;
    seedDerivation: "fnv1a32_domain_xor_seed_v1"; requested: ScanOptions; effective: ScanOptions;
    configuration: Pick<ScanRequest, "strategyKey" | "strategyParams" | "backtestSettings" | "capitalSettings" | "interval" | "useRustEnginePreference">;
    rawCount: number; canonicalCount: number; duplicateCount: number; eligibleAssets: string[];
    exclusions: Array<{ asset: string; reason: string }>; discovery: ScanRow[]; finalists: ScanFinalist[];
    cutoffTies: string[]; omittedCutoffTies: string[]; globalRankingExact: boolean;
    bestVerifiedCandidates: string[]; reason: string; error?: string;
    failureDiagnostics?: ScanFailureDiagnostics;
    pairCounts: { discovery: number; refinement: number; reused: number; successful: number; failed: number };
    engineUsage: { typescript: number; rust: number }; timings: Record<string, number>;
}
export interface ScanFailureDiagnostics {
    schema: "top_raw_scan.failures.v1"; total: number;
    groups: Array<{ reason: string; count: number; pairs: string[] }>;
    otherCount: number;
}
export interface ScanAssetCoverage {
    asset: string; closedBars: number | null; firstTime: number | null; lastTime: number | null; reason?: string;
}
export interface ScanPreflightDiagnostics {
    schema: "top_raw_scan.preflight.v1"; runId: string; interval: string; cutoff: number;
    requestedAssetCount: number; usableAssetCount: number; referenceAsOf: number | null; sourceInterval: string;
    assetsToSync: ScanAssetCoverage[];
}
export interface ScanStatus { runId: string; phase: ScanPhase; completed: number; total: number; message: string; result?: ScanResult; preflight?: ScanPreflightDiagnostics }
export function scanBudget(n: number, options: ScanOptions) {
    const k = Math.min(options.opponentsPerAsset, n - 1), finalists = Math.min(options.finalistCount, n);
    const all = n * (n - 1) / 2, discovery = Math.min(all, Math.ceil(n * k / 2));
    const upper = Math.min(all, discovery + finalists * (n - finalists) + finalists * (finalists - 1) / 2);
    if (upper > TOP_RAW_SCAN_MAX_PAIRS) throw new Error(`Requested scan budget ${upper.toLocaleString()} exceeds 1,000,000 unique pairs. Reduce opponents or finalists.`);
    return { discovery, upper, all, effective: { seed: options.seed, opponentsPerAsset: k, finalistCount: finalists } };
}
