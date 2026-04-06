import type {
    BacktestSingleRequest,
    BacktestErrorResponse,
    DatasetUploadResponse,
    EngineMode,
} from "./backtest-endpoint-contract";
import { BACKTEST_ENDPOINT_CAPITAL_SETTINGS } from "./backtest-endpoint-contract";
import type { BacktestRunEngine } from "./backtest-run-presenter";
import { stripEndpointIgnoredBacktestSettings } from "./backtest-endpoint-settings";
import { isSupportedPolymarketMultiIntervalRun } from "./polymarket-btc5m";
import type { CapitalSettings } from "./types/backtest";
import type { BacktestSettings, OHLCVData, StrategyParams } from "./types/strategies";

export interface UiBacktestEndpointSnapshot {
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    nowSec: number;
    blockRange: { from: number; to: number } | null;
    annotatePolymarket: boolean;
    engineUsed: BacktestRunEngine;
    datasetFingerprint: string;
}

let currentUiBacktestEndpointSnapshot: UiBacktestEndpointSnapshot | null = null;
let currentUiBacktestEndpointCandles: OHLCVData[] | null = null;

export const BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER = "replace-with-dataset-ref";
const BACKTEST_ENDPOINT_REQUEST_TIMEOUT_MS = 8000;

export interface BacktestEndpointCopyBundle {
    url: string;
    method: "POST";
    datasetUploadUrl: string;
    strategyKey: string;
    payload: BacktestSingleRequest;
}

export interface BacktestEndpointDatasetUploadResult {
    datasetUploadUrl: string;
    datasetRef: string;
    candleCount: number;
}

export interface PreparedBacktestEndpointCopyBundle {
    bundle: BacktestEndpointCopyBundle;
    datasetRef: string;
    candleCount: number;
    datasetUploaded: boolean;
    datasetUploadError: string | null;
}

export class BacktestEndpointUnavailableError extends Error {
    public readonly targetUrl: string;

    constructor(message: string, targetUrl: string) {
        super(message);
        this.name = "BacktestEndpointUnavailableError";
        this.targetUrl = targetUrl;
    }
}

function cloneBlockRange(
    blockRange: { from: number; to: number } | null
): { from: number; to: number } | null {
    return blockRange ? { ...blockRange } : null;
}

function cloneCapitalSettings(capitalSettings: CapitalSettings): CapitalSettings {
    return {
        ...capitalSettings,
        advancedSizing: capitalSettings.advancedSizing ? { ...capitalSettings.advancedSizing } : undefined,
    };
}

function cloneSnapshot(snapshot: UiBacktestEndpointSnapshot): UiBacktestEndpointSnapshot {
    return {
        symbol: snapshot.symbol,
        interval: snapshot.interval,
        strategyKey: snapshot.strategyKey,
        strategyParams: { ...snapshot.strategyParams },
        backtestSettings: { ...snapshot.backtestSettings },
        capitalSettings: cloneCapitalSettings(snapshot.capitalSettings),
        nowSec: snapshot.nowSec,
        blockRange: cloneBlockRange(snapshot.blockRange),
        annotatePolymarket: snapshot.annotatePolymarket,
        engineUsed: snapshot.engineUsed,
        datasetFingerprint: snapshot.datasetFingerprint,
    };
}

function cloneCandles(candles: OHLCVData[]): OHLCVData[] {
    return candles.map((candle) => ({ ...candle }));
}

function normalizeBacktestEndpointBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}

function describeBacktestEndpointBaseUrl(baseUrl: string): string {
    const normalizedBaseUrl = normalizeBacktestEndpointBaseUrl(baseUrl);
    return normalizedBaseUrl || "the current page origin";
}

function mixFingerprint(hash: number, value: string): number {
    let nextHash = hash >>> 0;
    for (let i = 0; i < value.length; i += 1) {
        nextHash = Math.imul(nextHash ^ value.charCodeAt(i), 16777619) >>> 0;
    }
    return nextHash >>> 0;
}

function toFingerprintUnixSeconds(time: OHLCVData["time"]): number {
    if (typeof time === "number") {
        return time > 1e12 ? Math.floor(time / 1000) : time;
    }
    if (typeof time === "string") {
        const parsed = Date.parse(time);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    }
    if (time && typeof time === "object" && "year" in time) {
        return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
    }
    return 0;
}

async function readBacktestEndpointJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return { error: text };
    }
}

function extractBacktestEndpointError(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const error = (payload as BacktestErrorResponse).error;
    return typeof error === "string" && error.trim().length > 0
        ? error
        : null;
}

function isAbortLikeError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function createBacktestEndpointRequestTimeoutSignal(): AbortSignal | undefined {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(BACKTEST_ENDPOINT_REQUEST_TIMEOUT_MS)
        : undefined;
}

export function buildBacktestEndpointUrl(snapshot: UiBacktestEndpointSnapshot, baseUrl: string): string {
    const normalizedBaseUrl = normalizeBacktestEndpointBaseUrl(baseUrl);
    const encodedStrategyKey = encodeURIComponent(snapshot.strategyKey);
    return `${normalizedBaseUrl}/api/backtest/${encodedStrategyKey}`;
}

export function buildBacktestDatasetUploadUrl(baseUrl: string): string {
    return `${normalizeBacktestEndpointBaseUrl(baseUrl)}/api/backtest/datasets`;
}

export function buildBacktestEndpointHealthUrl(baseUrl: string): string {
    return `${normalizeBacktestEndpointBaseUrl(baseUrl)}/api/backtest/health`;
}

export function setCurrentUiBacktestEndpointSnapshot(snapshot: UiBacktestEndpointSnapshot | null): void {
    currentUiBacktestEndpointSnapshot = snapshot ? cloneSnapshot(snapshot) : null;
}

export function setCurrentUiBacktestEndpointCandles(candles: OHLCVData[] | null): void {
    currentUiBacktestEndpointCandles = candles ? cloneCandles(candles) : null;
}

export function clearCurrentUiBacktestEndpointSnapshot(): void {
    currentUiBacktestEndpointSnapshot = null;
    currentUiBacktestEndpointCandles = null;
}

export function getCurrentUiBacktestEndpointSnapshot(): UiBacktestEndpointSnapshot | null {
    return currentUiBacktestEndpointSnapshot ? cloneSnapshot(currentUiBacktestEndpointSnapshot) : null;
}

export function getCurrentUiBacktestEndpointCandles(): OHLCVData[] | null {
    return currentUiBacktestEndpointCandles ? cloneCandles(currentUiBacktestEndpointCandles) : null;
}

export function hasCurrentUiBacktestEndpointSnapshot(): boolean {
    return currentUiBacktestEndpointSnapshot !== null;
}

export function hasCurrentUiBacktestEndpointCandles(): boolean {
    return Array.isArray(currentUiBacktestEndpointCandles) && currentUiBacktestEndpointCandles.length > 0;
}

export function resolveEndpointCopyEngineMode(engineUsed: BacktestRunEngine): EngineMode {
    return engineUsed === "rust" ? "rust_preferred" : "typescript";
}

export function resolveEndpointPolymarketAnnotation(snapshot: Pick<UiBacktestEndpointSnapshot, "symbol" | "interval" | "annotatePolymarket">): boolean {
    return snapshot.annotatePolymarket || isSupportedPolymarketMultiIntervalRun(snapshot.symbol, snapshot.interval);
}

function buildEndpointBacktestSettings(snapshot: UiBacktestEndpointSnapshot): Record<string, unknown> {
    return {
        ...stripEndpointIgnoredBacktestSettings(snapshot.backtestSettings),
        polymarketAnnotationEnabled: resolveEndpointPolymarketAnnotation(snapshot),
    };
}

export function computeBacktestEndpointDatasetFingerprint(candles: OHLCVData[]): string {
    let hash = 2166136261;
    hash = mixFingerprint(hash, String(candles.length));

    if (candles.length === 0) {
        return `fp_${hash.toString(16).padStart(8, "0")}_0`;
    }

    const stride = Math.max(1, Math.floor(candles.length / 128));
    for (let i = 0; i < candles.length; i += stride) {
        const candle = candles[i];
        hash = mixFingerprint(
            hash,
            `${toFingerprintUnixSeconds(candle.time)}|${candle.open}|${candle.high}|${candle.low}|${candle.close}|${candle.volume};`
        );
    }

    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];
    hash = mixFingerprint(
        hash,
        `first:${toFingerprintUnixSeconds(firstCandle.time)}|${firstCandle.open}|${firstCandle.high}|${firstCandle.low}|${firstCandle.close}|${firstCandle.volume}`
    );
    hash = mixFingerprint(
        hash,
        `last:${toFingerprintUnixSeconds(lastCandle.time)}|${lastCandle.open}|${lastCandle.high}|${lastCandle.low}|${lastCandle.close}|${lastCandle.volume}`
    );

    return `fp_${hash.toString(16).padStart(8, "0")}_${candles.length}`;
}

export function buildBacktestEndpointRequestFromSnapshot(
    snapshot: UiBacktestEndpointSnapshot,
    candles: OHLCVData[]
): BacktestSingleRequest {
    const annotatePolymarket = resolveEndpointPolymarketAnnotation(snapshot);
    return {
        symbol: snapshot.symbol,
        interval: snapshot.interval,
        dataset: {
            candles: cloneCandles(candles),
        },
        strategyParams: { ...snapshot.strategyParams },
        backtestSettings: buildEndpointBacktestSettings(snapshot),
        context: {
            nowSec: snapshot.nowSec,
            blockRange: cloneBlockRange(snapshot.blockRange),
            annotatePolymarket,
            engineMode: resolveEndpointCopyEngineMode(snapshot.engineUsed),
        },
    };
}

export function buildBacktestEndpointCopyBundleFromSnapshot(
    snapshot: UiBacktestEndpointSnapshot,
    baseUrl: string,
    datasetRef: string = BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER
): BacktestEndpointCopyBundle {
    const annotatePolymarket = resolveEndpointPolymarketAnnotation(snapshot);
    return {
        url: buildBacktestEndpointUrl(snapshot, baseUrl),
        method: "POST",
        datasetUploadUrl: buildBacktestDatasetUploadUrl(baseUrl),
        strategyKey: snapshot.strategyKey,
        payload: {
            symbol: snapshot.symbol,
            interval: snapshot.interval,
            dataset: {
                ref: datasetRef,
            },
            strategyParams: { ...snapshot.strategyParams },
            backtestSettings: buildEndpointBacktestSettings(snapshot),
            context: {
                nowSec: snapshot.nowSec,
                blockRange: cloneBlockRange(snapshot.blockRange),
                annotatePolymarket,
                engineMode: resolveEndpointCopyEngineMode(snapshot.engineUsed),
            },
        },
    };
}

export function isBacktestEndpointUnavailableError(error: unknown): error is BacktestEndpointUnavailableError {
    return error instanceof BacktestEndpointUnavailableError
        || (error instanceof Error && error.name === "BacktestEndpointUnavailableError");
}

export async function prepareBacktestEndpointCopyBundleFromSnapshot(
    snapshot: UiBacktestEndpointSnapshot,
    baseUrl: string,
    candles: OHLCVData[]
): Promise<PreparedBacktestEndpointCopyBundle> {
    try {
        const upload = await uploadBacktestEndpointDataset(baseUrl, candles);
        return {
            bundle: buildBacktestEndpointCopyBundleFromSnapshot(snapshot, baseUrl, upload.datasetRef),
            datasetRef: upload.datasetRef,
            candleCount: upload.candleCount,
            datasetUploaded: true,
            datasetUploadError: null,
        };
    } catch (error) {
        if (!isBacktestEndpointUnavailableError(error)) {
            throw error;
        }

        return {
            bundle: buildBacktestEndpointCopyBundleFromSnapshot(snapshot, baseUrl),
            datasetRef: BACKTEST_ENDPOINT_DATASET_REF_PLACEHOLDER,
            candleCount: candles.length,
            datasetUploaded: false,
            datasetUploadError: error.message,
        };
    }
}

export async function uploadBacktestEndpointDataset(
    baseUrl: string,
    candles: OHLCVData[]
): Promise<BacktestEndpointDatasetUploadResult> {
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error("No chart candles are available for endpoint dataset upload.");
    }

    const datasetUploadUrl = buildBacktestDatasetUploadUrl(baseUrl);
    const healthUrl = buildBacktestEndpointHealthUrl(baseUrl);
    let response: Response;
    try {
        response = await fetch(datasetUploadUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            signal: createBacktestEndpointRequestTimeoutSignal(),
            body: JSON.stringify({
                candles: cloneCandles(candles),
            }),
        });
    } catch (error) {
        if (isAbortLikeError(error)) {
            throw new BacktestEndpointUnavailableError(
                `Backtest endpoint dataset upload timed out after ${Math.round(BACKTEST_ENDPOINT_REQUEST_TIMEOUT_MS / 1000)}s. Start the Vite dev server and verify ${healthUrl}.`,
                datasetUploadUrl
            );
        }

        throw new BacktestEndpointUnavailableError(
            `Backtest endpoint is unavailable at ${describeBacktestEndpointBaseUrl(baseUrl)}. Start the Vite dev server and verify ${healthUrl}.`,
            datasetUploadUrl
        );
    }
    const payload = await readBacktestEndpointJson(response);

    if (!response.ok) {
        throw new Error(
            extractBacktestEndpointError(payload)
            ?? `Dataset upload failed with HTTP ${response.status}.`
        );
    }

    if (
        !payload
        || typeof payload !== "object"
        || (payload as DatasetUploadResponse).ok !== true
        || typeof (payload as DatasetUploadResponse).datasetRef !== "string"
    ) {
        throw new Error("Dataset upload returned an invalid response.");
    }

    const upload = payload as DatasetUploadResponse;
    return {
        datasetUploadUrl,
        datasetRef: upload.datasetRef,
        candleCount: upload.candleCount,
    };
}

export function matchesEndpointCapitalProfile(capitalSettings: CapitalSettings): boolean {
    return capitalSettings.initialCapital === BACKTEST_ENDPOINT_CAPITAL_SETTINGS.initialCapital
        && capitalSettings.positionSize === BACKTEST_ENDPOINT_CAPITAL_SETTINGS.positionSize
        && capitalSettings.commission === BACKTEST_ENDPOINT_CAPITAL_SETTINGS.commission
        && capitalSettings.sizingMode === BACKTEST_ENDPOINT_CAPITAL_SETTINGS.sizingMode
        && capitalSettings.fixedTradeAmount === BACKTEST_ENDPOINT_CAPITAL_SETTINGS.fixedTradeAmount;
}
