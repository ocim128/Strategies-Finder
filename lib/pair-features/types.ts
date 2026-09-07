/** Data-only contracts for pair-ledger compatibility decisions. */

import type { OHLCVData, Trade } from "../types/strategies";

export type PairFeatureCapability = string;

export interface PairFeatureVersionPair {
    ledgerVersion: number;
    featureVersion: number;
}

export interface PairFeatureCompatibilityEntry extends PairFeatureVersionPair {
    capabilities: readonly PairFeatureCapability[];
}

export type PairFeatureCompatibilityRefusalReason =
    | "unknown_ledger_version"
    | "unknown_feature_version"
    | "unsupported_version_pair"
    | "missing_capability";

export interface PairFeatureCompatibilityRequest {
    ledgerVersion: unknown;
    featureVersion?: unknown;
    requiredCapabilities?: readonly PairFeatureCapability[];
}

export interface PairFeatureCompatibilityResult {
    supported: boolean;
    ledgerVersion: number | null;
    featureVersion: number | null;
    capabilities: readonly PairFeatureCapability[];
    missingCapabilities: readonly PairFeatureCapability[];
    reason: PairFeatureCompatibilityRefusalReason | null;
    message: string | null;
}

export interface PairFeatureRequirement {
    libraryRelease: string;
    columns: readonly string[];
}

export interface PairFeatureDefinitionDependency {
    id: string;
    definitionDigest: string;
}

export interface PairFeatureImplementationFile {
    path: string;
    sha256: string;
}

export interface PairFeatureDefinition {
    id: string;
    family: string;
    revision: number;
    units: string;
    directionConvention: string;
    parameters: Readonly<Record<string, number | string | boolean>>;
    requiredCapabilities: readonly PairFeatureCapability[];
    minimumObservations: number;
    missingPolicy: string;
    cutoff: string;
    formula: string;
    dependencies: readonly PairFeatureDefinitionDependency[];
    implementationFiles: readonly PairFeatureImplementationFile[];
    definitionDigest: string;
}

export interface PairFeatureEvaluationResult {
    value: number | null;
    observations: number;
}

export interface PairFeatureEvaluationContext {
    bars: readonly PairFeatureSnapshotBar[];
    signalBarIndex: number;
    historicalTrades: readonly PairFeatureSnapshotTrade[];
}

export interface PairFeatureRelease {
    releaseId: string;
    catalogFormatVersion: 1;
    runtime: PairFeatureSnapshotRuntimeFingerprint;
    definitions: readonly PairFeatureDefinition[];
}

export interface PairFeatureColumnArtifact {
    path: string;
    bytes: number;
    sha256: string;
    uncompressedBytes: number;
    uncompressedSha256: string;
}

export interface PairFeatureColumnPairManifest {
    pairKey: string;
    values: PairFeatureColumnArtifact;
    valid: PairFeatureColumnArtifact;
    observations: PairFeatureColumnArtifact;
    rowCount: number;
    nullCount: number;
    observationMin: number;
    observationMax: number;
}

export interface PairFeatureFamilyFeatureManifest {
    id: string;
    definitionDigest: string;
    pairs: readonly PairFeatureColumnPairManifest[];
}

export interface PairFeatureFamilyManifest {
    formatVersion: 1;
    familyId: string;
    ledgerSha256: string;
    ledgerRowCount: number;
    sourceSnapshotSha256: string;
    features: readonly PairFeatureFamilyFeatureManifest[];
}

export interface PairFeatureFamilyManifestReference {
    path: string;
    sha256: string;
}

export interface PairFeaturePackManifest {
    formatVersion: 1;
    libraryRelease: string;
    libraryReleaseSha256: string;
    ledgerSha256: string;
    ledgerRowCount: number;
    sourceSnapshotSha256: string;
    requestedFeatureIds: readonly string[];
    familyManifests: readonly PairFeatureFamilyManifestReference[];
}

export const PAIR_FEATURE_SNAPSHOT_CAPABILITIES = [
    "pair_bars_v1",
    "closed_trade_records_v1",
    "entry_candidates_v1",
] as const;

export type PairFeatureSnapshotCapability = (typeof PAIR_FEATURE_SNAPSHOT_CAPABILITIES)[number];

export interface PairFeatureSnapshotIdentity {
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
}

export type PairFeatureSnapshotBar = readonly [
    timeSec: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
];

export interface PairFeatureSnapshotTrade {
    tradeOrdinal: number;
    id: number;
    direction: "long" | "short";
    entryTimeSec: number;
    exitTimeSec: number;
    entryBarIndex: number;
    exitBarIndex: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    size: number;
    fees: number | null;
    exitReason: Trade["exitReason"] | null;
}

export type PairFeatureSnapshotEntry = readonly [
    rowOrdinal: number,
    signalBarIndex: number,
    direction: "long" | "short",
    signalTimeSec: number,
];

export interface PairFeatureSnapshotArtifact {
    path: string;
    recordCount: number;
    compressedBytes: number;
    compressedSha256: string;
    uncompressedBytes: number;
    uncompressedSha256: string;
}

export interface PairFeatureSnapshotPairManifest extends PairFeatureSnapshotIdentity {
    pairKey: string;
    barCount: number;
    firstTimeSec: number | null;
    lastTimeSec: number | null;
    tradeCount: number;
    rowStart: number;
    rowCount: number;
    files: {
        bars: PairFeatureSnapshotArtifact;
        trades: PairFeatureSnapshotArtifact;
        entries: PairFeatureSnapshotArtifact;
    };
}

export interface PairFeatureSnapshotRuntimeFingerprint {
    node: string;
    v8: string;
    zlib: string;
    platform: NodeJS.Platform;
    arch: string;
}

export interface PairFeatureSnapshotManifest {
    formatVersion: 1;
    writerRevision: 1;
    complete: true;
    ledgerSha256: string;
    ledgerBytes: number;
    ledgerRowCount: number;
    provenanceSha256: string;
    summarySha256: string;
    ranksSha256: string | null;
    runtime: PairFeatureSnapshotRuntimeFingerprint;
    capabilities: readonly PairFeatureSnapshotCapability[];
    pairs: readonly PairFeatureSnapshotPairManifest[];
}

export interface PairFeatureSnapshotSource {
    identity: PairFeatureSnapshotIdentity;
    bars: readonly OHLCVData[];
    trades: readonly Trade[];
    entries: readonly PairFeatureSnapshotEntry[];
    rowStart: number;
}

export interface PairFeatureSnapshotFinalizeInput {
    ledgerComplete: boolean;
    ledgerRowCount: number;
    ledgerPath: string;
    provenancePath: string;
    summaryPath: string;
    ranksPath: string;
}

export interface PairFeatureSnapshotFinalizeResult {
    complete: boolean;
    error: string | null;
    manifestSha256: string | null;
}
