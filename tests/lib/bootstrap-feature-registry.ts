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
 * Verifies that within `stageFeatures`, every `dependsOn` entry that resolves
 * to another feature in the same stage appears earlier in execution order.
 * Cross-stage dependencies are intentionally allowed: `pre_restore` always
 * runs before `post_restore`, so a `post_restore` feature may legitimately
 * depend on a `pre_restore` feature without an ordering violation here.
 *
 * Throws on the first within-stage ordering violation so startup cannot
 * silently continue with features initializing ahead of their dependencies.
 */
function assertBootstrapStageOrdering<TContext>(
    stageFeatures: readonly AppBootstrapFeature<TContext>[]
): void {
    const indexById = new Map<string, number>();
    for (let i = 0; i < stageFeatures.length; i++) {
        indexById.set(stageFeatures[i]!.id, i);
    }
    for (let i = 0; i < stageFeatures.length; i++) {
        const feature = stageFeatures[i]!;
        if (!feature.dependsOn || feature.dependsOn.length === 0) continue;
        for (const dep of feature.dependsOn) {
            const depIndex = indexById.get(dep);
            if (depIndex === undefined) continue; // cross-stage or unknown dep
            if (depIndex >= i) {
                throw new Error(
                    `Bootstrap ordering violation: feature "${feature.id}" declares dependsOn "${dep}", `
                    + `but "${dep}" appears later in stage "${feature.stage}". `
                    + `List dependencies before their dependents in APP_BOOTSTRAP_FEATURES.`
                );
            }
        }
    }
}

/**
 * Runs all features matching `stage`, calling `handler` (init or restore)
 * on each, in array definition order. Within a stage, features must be listed
 * in dependency order — runtime-validated against each feature's `dependsOn`.
 * Cross-stage ordering (e.g. post_restore depending on pre_restore) is allowed.
 */
export async function runBootstrapFeatureStage<TContext>(
    features: readonly AppBootstrapFeature<TContext>[],
    stage: AppBootstrapStage,
    handler: "init" | "restore",
    context: TContext
): Promise<void> {
    const stageFeatures = features.filter((f) => f.stage === stage);
    assertBootstrapStageOrdering(stageFeatures);
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
