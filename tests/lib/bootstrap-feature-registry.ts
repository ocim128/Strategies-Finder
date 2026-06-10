import { debugLogger } from "./debug-logger";

export type AppBootstrapStage = "pre_restore" | "post_restore";

export interface AppBootstrapFeature<TContext = unknown> {
    id: string;
    stage: AppBootstrapStage;
    /** Declared for documentation; features execute in array order within each stage. */
    dependsOn?: readonly string[];
    init?: (context: TContext) => void | Promise<void>;
    restore?: (context: TContext) => void | Promise<void>;
}

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDurationMs(startedAt: number): number {
    return Math.round((nowMs() - startedAt) * 10) / 10;
}

function logBootstrapFeature(
    level: "event" | "error",
    message: string,
    data: Record<string, unknown>
): void {
    try {
        debugLogger[level](message, data);
    } catch {
        // Bootstrap telemetry must never change bootstrap control flow.
    }
}

/**
 * Runs all features matching `stage`, calling `handler` (init or restore)
 * on each, in array definition order. Features must be listed in dependency
 * order in the source array — this is enforced by code review, not by a
 * runtime topological sort.
 */
export async function runBootstrapFeatureStage<TContext>(
    features: readonly AppBootstrapFeature<TContext>[],
    stage: AppBootstrapStage,
    handler: "init" | "restore",
    context: TContext
): Promise<void> {
    const stageFeatures = features.filter((f) => f.stage === stage);
    for (const feature of stageFeatures) {
        const step = feature[handler];
        if (!step) continue;
        const startedAt = nowMs();
        try {
            await step(context);
            logBootstrapFeature("event", "app.bootstrap.feature_complete", {
                id: feature.id,
                stage,
                handler,
                durationMs: roundedDurationMs(startedAt),
            });
        } catch (error) {
            logBootstrapFeature("error", "app.bootstrap.feature_failed", {
                id: feature.id,
                stage,
                handler,
                durationMs: roundedDurationMs(startedAt),
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            throw error;
        }
    }
}
