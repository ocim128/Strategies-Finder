export type AppBootstrapStage = "pre_restore" | "post_restore";

export interface AppBootstrapFeature<TContext = unknown> {
    id: string;
    stage: AppBootstrapStage;
    dependsOn?: readonly string[];
    init?: (context: TContext) => void | Promise<void>;
    restore?: (context: TContext) => void | Promise<void>;
}

const STAGE_ORDER: readonly AppBootstrapStage[] = ["pre_restore", "post_restore"];
const STAGE_INDEX = new Map(STAGE_ORDER.map((stage, index) => [stage, index] as const));

function assertBootstrapRegistry<TContext>(
    features: readonly AppBootstrapFeature<TContext>[]
): Map<string, AppBootstrapFeature<TContext>> {
    const byId = new Map<string, AppBootstrapFeature<TContext>>();
    for (const feature of features) {
        if (byId.has(feature.id)) {
            throw new Error(`Duplicate bootstrap feature id "${feature.id}".`);
        }
        byId.set(feature.id, feature);
    }
    return byId;
}

export function resolveBootstrapFeatureStageOrder<TContext>(
    features: readonly AppBootstrapFeature<TContext>[],
    stage: AppBootstrapStage
): AppBootstrapFeature<TContext>[] {
    const byId = assertBootstrapRegistry(features);
    const stageFeatures = features.filter((feature) => feature.stage === stage);
    const stageFeatureIds = new Set(stageFeatures.map((feature) => feature.id));
    const stageIndex = STAGE_INDEX.get(stage) ?? 0;
    const definitionIndex = new Map(features.map((feature, index) => [feature.id, index] as const));
    const inDegree = new Map(stageFeatures.map((feature) => [feature.id, 0]));
    const edges = new Map(stageFeatures.map((feature) => [feature.id, [] as string[]]));

    for (const feature of stageFeatures) {
        for (const dependencyId of feature.dependsOn ?? []) {
            const dependency = byId.get(dependencyId);
            if (!dependency) {
                throw new Error(`Bootstrap feature "${feature.id}" depends on missing feature "${dependencyId}".`);
            }

            const dependencyStageIndex = STAGE_INDEX.get(dependency.stage) ?? 0;
            if (dependencyStageIndex > stageIndex) {
                throw new Error(`Bootstrap feature "${feature.id}" depends on later-stage feature "${dependencyId}".`);
            }

            if (!stageFeatureIds.has(dependencyId)) {
                continue;
            }

            edges.get(dependencyId)!.push(feature.id);
            inDegree.set(feature.id, (inDegree.get(feature.id) ?? 0) + 1);
        }
    }

    const queue = stageFeatures
        .filter((feature) => (inDegree.get(feature.id) ?? 0) === 0)
        .sort((left, right) => (definitionIndex.get(left.id) ?? 0) - (definitionIndex.get(right.id) ?? 0));
    const ordered: AppBootstrapFeature<TContext>[] = [];

    while (queue.length > 0) {
        const feature = queue.shift()!;
        ordered.push(feature);

        const dependents = edges.get(feature.id) ?? [];
        for (const dependentId of dependents) {
            const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
            inDegree.set(dependentId, nextDegree);
            if (nextDegree === 0) {
                queue.push(byId.get(dependentId)!);
                queue.sort((left, right) => (definitionIndex.get(left.id) ?? 0) - (definitionIndex.get(right.id) ?? 0));
            }
        }
    }

    if (ordered.length !== stageFeatures.length) {
        throw new Error(`Bootstrap feature cycle detected in "${stage}" stage.`);
    }

    return ordered;
}

export async function runBootstrapFeatureStage<TContext>(
    features: readonly AppBootstrapFeature<TContext>[],
    stage: AppBootstrapStage,
    handler: "init" | "restore",
    context: TContext
): Promise<void> {
    const ordered = resolveBootstrapFeatureStageOrder(features, stage);
    for (const feature of ordered) {
        const step = feature[handler];
        if (!step) continue;
        await step(context);
    }
}
