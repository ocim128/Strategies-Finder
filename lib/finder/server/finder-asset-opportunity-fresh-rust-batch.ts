/**
 * Server-side Rust batching for Asset Opportunity fresh-entry rechecks.
 *
 * Signal generation remains in the shared TypeScript executor. This leaf only
 * batches the resulting signal sets for the capability-gated execution models
 * that fresh detection supports, then returns only the latest-entry summary
 * required by the existing detector.
 */

import type { BacktestResult } from "../../types/strategies";
import { createEmptyBacktestResult } from "../../strategies/index";
import { rustEngine } from "../../rust-engine-client";
import {
    buildAssetOpportunityRustDatasetCacheKey,
    dispatchAssetOpportunityRustFreshEntryBatch,
    resolveAssetOpportunityRustBatchEligibility,
    resolveAssetOpportunityRustBatchFeatureConfig,
    type AssetOpportunityRustFreshBatchClient,
} from "./finder-asset-opportunity-rust-batch";
import type { AssetOpportunityRustMultiBatchCoordinator } from "./finder-asset-opportunity-multi-rust-batch";
import type {
    AssetOpportunityFreshEntryBatchEvaluation,
    AssetOpportunityFreshEntryBatchInput,
} from "../finder-asset-opportunity-runner";
import { hasRequiredRustCapabilities } from "../../rust-settings-sanitizer";

export async function runServerAssetOpportunityFreshRustBatch(args: {
    input: AssetOpportunityFreshEntryBatchInput;
    client?: AssetOpportunityRustFreshBatchClient;
    rustMultiAssetBatch?: AssetOpportunityRustMultiBatchCoordinator;
    datasetCache?: Map<string, Promise<string | null>>;
    signal?: AbortSignal;
}): Promise<Map<string, AssetOpportunityFreshEntryBatchEvaluation> | null> {
    const { input } = args;
    const signal = args.signal ?? input.signal;
    if (input.candidates.length === 0) return new Map();

    const featureConfig = resolveAssetOpportunityRustBatchFeatureConfig();
    const eligibility = resolveAssetOpportunityRustBatchEligibility({
        featureConfig,
        useRustEnginePreference: input.useRustEnginePreference,
        settings: input.settings,
        capitalSettings: input.capitalSettings,
        selectedStrategy: input.selectedStrategy,
        exitStrategyCandidates: input.exitStrategyCandidates,
        rustCapabilities: input.rustCapabilities,
    });
    if (!eligibility.eligible) return null;
    const candidateRequiresUnavailableCapability = input.candidates.some((candidate) =>
        !hasRequiredRustCapabilities(input.rustCapabilities, {
            ...candidate.backtestSettings,
            executionModel: input.settings.executionModel,
            riskMaxHoldEnabled: candidate.backtestSettings.riskMaxHoldEnabled ?? input.settings.riskMaxHoldEnabled,
            riskMaxHoldBars: candidate.backtestSettings.riskMaxHoldBars ?? input.settings.riskMaxHoldBars,
        })
    );
    if (candidateRequiresUnavailableCapability) return null;

    const client = args.client ?? rustEngine;
    let cacheId: string | undefined;
    let cacheKey: string | undefined;
    if (!args.rustMultiAssetBatch && args.datasetCache && client.cacheData && client.runCachedFreshEntryBatchBacktestWithStatus) {
        cacheKey = buildAssetOpportunityRustDatasetCacheKey({
            symbol: input.symbol,
            interval: input.interval,
            data: input.data,
            client,
        });
        let cachePromise = args.datasetCache.get(cacheKey);
        if (!cachePromise) {
            cachePromise = client.cacheData(input.data, {
                signal,
                maxRequestBytes: featureConfig.maxRequestBytes,
                maxResponseBytes: 1 * 1024 * 1024,
            }).catch(() => null);
            args.datasetCache.set(cacheKey, cachePromise);
        }
        cacheId = (await cachePromise) ?? undefined;
    }

    const dispatched = await (args.rustMultiAssetBatch
        ? args.rustMultiAssetBatch.dispatchFresh
        : dispatchAssetOpportunityRustFreshEntryBatch)({
        client,
        data: input.data,
        ...(input.cacheData ? { cacheData: input.cacheData } : {}),
        ...(input.datasetEndIndex !== undefined ? { datasetEndIndex: input.datasetEndIndex } : {}),
        items: input.candidates.map((candidate) => ({
            id: candidate.id,
            signals: candidate.signals,
            settings: {
                ...candidate.backtestSettings,
                executionModel: input.settings.executionModel,
                slippageBps: input.settings.slippageBps,
                riskCooldownEnabled: input.settings.riskCooldownEnabled,
                riskCooldownBars: input.settings.riskCooldownBars,
                riskMaxHoldEnabled: candidate.backtestSettings.riskMaxHoldEnabled ?? input.settings.riskMaxHoldEnabled,
                riskMaxHoldBars: candidate.backtestSettings.riskMaxHoldBars ?? input.settings.riskMaxHoldBars,
            },
        })),
        initialCapital: input.capitalSettings.initialCapital,
        positionSizePercent: input.capitalSettings.positionSize,
        commissionPercent: input.capitalSettings.commission,
        baseSettings: {
            ...input.candidates[0]!.backtestSettings,
            executionModel: input.settings.executionModel,
            slippageBps: input.settings.slippageBps,
            riskCooldownEnabled: input.settings.riskCooldownEnabled,
            riskCooldownBars: input.settings.riskCooldownBars,
            riskMaxHoldEnabled: input.candidates[0]!.backtestSettings.riskMaxHoldEnabled ?? input.settings.riskMaxHoldEnabled,
            riskMaxHoldBars: input.candidates[0]!.backtestSettings.riskMaxHoldBars ?? input.settings.riskMaxHoldBars,
        },
        sizing: {
            mode: input.capitalSettings.sizingMode,
            fixedTradeAmount: input.capitalSettings.fixedTradeAmount,
            advancedSizing: input.capitalSettings.advancedSizing,
        },
        maxRequestBytes: featureConfig.maxRequestBytes,
        maxResponseBytes: featureConfig.maxResponseBytes,
        ...(cacheId ? { cacheId } : {}),
        signal,
        rustCapabilities: input.rustCapabilities,
    });
    if (dispatched.status !== "completed") {
        if (cacheKey) args.datasetCache?.delete(cacheKey);
        if (dispatched.status === "cancelled") {
            const error = new Error("Rust fresh-entry batch cancelled");
            error.name = "AbortError";
            throw error;
        }
        return null;
    }

    const evaluations = new Map<string, AssetOpportunityFreshEntryBatchEvaluation>();
    for (const candidate of input.candidates) {
        const summary = dispatched.results.get(candidate.id)?.summary;
        if (!summary) return null;
        evaluations.set(candidate.id, {
            result: buildFreshSummaryBacktestResult(summary),
            engineUsed: "rust",
            rustAttempted: true,
        });
    }
    return evaluations;
}

function buildFreshSummaryBacktestResult(summary: {
    totalTrades: number;
    latestTrade: {
        type: "long" | "short";
        entryTime: BacktestResult["trades"][number]["entryTime"];
        entryPrice: number;
        exitReason: string;
    } | null;
    isOpen: boolean;
}): BacktestResult {
    const result = createEmptyBacktestResult();
    result.totalTrades = summary.totalTrades;
    if (summary.latestTrade) {
        result.trades = [{
            id: 0,
            type: summary.latestTrade.type,
            entryTime: summary.latestTrade.entryTime,
            entryPrice: summary.latestTrade.entryPrice,
            exitTime: summary.latestTrade.entryTime,
            exitPrice: summary.latestTrade.entryPrice,
            pnl: 0,
            pnlPercent: 0,
            size: 0,
            exitReason: summary.latestTrade.exitReason as BacktestResult["trades"][number]["exitReason"],
        }];
    }
    return result;
}
