import { normalizeStoredBacktestSettings } from "../settings-model";
import type {
    FinderArmPerformanceCandidate,
    FinderArmPerformanceRunContext,
} from "../types/finder";

export function buildFinderArmPerformanceApplySettings(
    context: FinderArmPerformanceRunContext,
    candidate: FinderArmPerformanceCandidate,
) {
    return normalizeStoredBacktestSettings({
        ...context.uiBacktestSettings,
        ...candidate.backtestSettings,
        ...context.capitalSettings,
        exitStrategyOverrideEnabled: Boolean(candidate.exitStrategyKey),
        exitStrategyKey: candidate.exitStrategyKey ?? "",
        exitStrategyParams: { ...(candidate.exitStrategyParams ?? {}) },
    });
}
