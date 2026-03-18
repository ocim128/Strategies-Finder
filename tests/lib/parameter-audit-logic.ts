import type {
    ParameterAuditClassification,
    ParameterAuditEvidenceStrength,
    ParameterAuditMetricsLike,
    ParameterAuditParameterInput,
    ParameterAuditReport,
    ParameterAuditReportInput,
    ParameterAuditRow,
    ParameterAuditSample,
    ParameterAuditSuggestedAction,
} from "./types/parameter-audit";

type NumericCluster = {
    min: number;
    max: number;
    count: number;
    values: number[];
    meanScore: number;
    ratio: number;
    touchesBoundary: boolean;
    touchesDisable: boolean;
};

type RowDraft = {
    row: ParameterAuditRow;
    cluster: NumericCluster | null;
    acceptedSamples: ParameterAuditSample[];
    allSamples: ParameterAuditSample[];
};

const EPSILON = 1e-9;

export function computeParameterAuditPerformanceScore(metrics: ParameterAuditMetricsLike): number {
    const safeProfitFactor = Number.isFinite(metrics.profitFactor)
        ? Math.min(metrics.profitFactor, 4)
        : 0;
    const safeSharpe = Number.isFinite(metrics.sharpeRatio)
        ? Math.max(-3, Math.min(4, metrics.sharpeRatio))
        : 0;
    const safeExpectancy = Number.isFinite(metrics.expectancy)
        ? Math.max(-8, Math.min(8, metrics.expectancy))
        : 0;
    const safeNet = Number.isFinite(metrics.netProfitPercent)
        ? Math.max(-100, Math.min(200, metrics.netProfitPercent))
        : 0;
    const safeWinRate = Number.isFinite(metrics.winRate)
        ? Math.max(0, Math.min(100, metrics.winRate))
        : 0;
    const safeDrawdown = Number.isFinite(metrics.maxDrawdownPercent)
        ? Math.max(0, Math.min(100, metrics.maxDrawdownPercent))
        : 100;

    return (
        safeNet * 0.35 +
        safeSharpe * 12 +
        safeExpectancy * 4 +
        safeProfitFactor * 8 +
        (safeWinRate - 50) * 0.2 -
        safeDrawdown * 0.35
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function formatValue(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value - Math.round(value)) < EPSILON) {
        return String(Math.round(value));
    }
    return value.toFixed(3).replace(/\.?0+$/, "");
}

function nearlyEqual(a: number, b: number, tolerance = EPSILON): boolean {
    return Math.abs(a - b) <= tolerance;
}

function rangeStepCount(range: ParameterAuditParameterInput["range"]): number {
    if (range.step <= 0 || range.max <= range.min) return 1;
    return Math.max(1, Math.floor((range.max - range.min) / range.step) + 1);
}

function isBoundaryValue(value: number, range: ParameterAuditParameterInput["range"]): boolean {
    const tolerance = Math.max(EPSILON, Math.abs(range.step) * 0.2);
    return Math.abs(value - range.min) <= tolerance || Math.abs(value - range.max) <= tolerance;
}

function isDisableLikeValue(value: number, range: ParameterAuditParameterInput["range"]): boolean {
    if (Math.abs(value) <= Math.max(EPSILON, Math.abs(range.step) * 0.2)) {
        return true;
    }
    return nearlyEqual(range.min, 0) && nearlyEqual(value, range.min, Math.abs(range.step) * 0.2);
}

function normalizeAcceptedSamples(input: ParameterAuditParameterInput): ParameterAuditSample[] {
    const finiteSamples = input.samples.filter((sample) =>
        Number.isFinite(sample.value) && Number.isFinite(sample.score)
    );
    const accepted = finiteSamples.filter((sample) => sample.accepted);
    if (accepted.length > 0) {
        return accepted;
    }

    return [...finiteSamples]
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.min(2, finiteSamples.length));
}

function buildClusters(
    values: Array<{ value: number; score: number }>,
    range: ParameterAuditParameterInput["range"]
): NumericCluster[] {
    if (values.length === 0) return [];

    const sorted = [...values].sort((left, right) => left.value - right.value);
    const tolerance = Math.max(Math.abs(range.step) * 0.75, Math.abs(range.max - range.min) * 0.04, 0.0001);
    const clusters: Array<{ values: number[]; scores: number[] }> = [];

    for (const item of sorted) {
        const lastCluster = clusters[clusters.length - 1];
        if (!lastCluster) {
            clusters.push({ values: [item.value], scores: [item.score] });
            continue;
        }

        const lastValue = lastCluster.values[lastCluster.values.length - 1];
        if (Math.abs(item.value - lastValue) <= tolerance) {
            lastCluster.values.push(item.value);
            lastCluster.scores.push(item.score);
            continue;
        }

        clusters.push({ values: [item.value], scores: [item.score] });
    }

    return clusters.map((cluster) => {
        const meanScore = cluster.scores.reduce((sum, score) => sum + score, 0) / Math.max(1, cluster.scores.length);
        const min = Math.min(...cluster.values);
        const max = Math.max(...cluster.values);
        return {
            min,
            max,
            count: cluster.values.length,
            values: cluster.values,
            meanScore,
            ratio: cluster.values.length / Math.max(1, values.length),
            touchesBoundary: cluster.values.some((value) => isBoundaryValue(value, range)),
            touchesDisable: cluster.values.some((value) => isDisableLikeValue(value, range)),
        };
    });
}

function resolveBestCluster(clusters: NumericCluster[]): NumericCluster | null {
    if (clusters.length === 0) return null;

    return [...clusters].sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return right.meanScore - left.meanScore;
    })[0] ?? null;
}

function buildBestClusterLabel(cluster: NumericCluster | null): string {
    if (!cluster) return "n/a";
    const clusterLabel = nearlyEqual(cluster.min, cluster.max)
        ? formatValue(cluster.min)
        : `${formatValue(cluster.min)}-${formatValue(cluster.max)}`;
    return `${clusterLabel} (${Math.round(cluster.ratio * 100)}%)`;
}

function computeImpactScore(input: ParameterAuditParameterInput): number {
    const samples = input.samples.filter((sample) =>
        Number.isFinite(sample.value) && Number.isFinite(sample.score)
    );
    if (samples.length < 2) return 0;

    const grouped = new Map<string, number[]>();
    for (const sample of samples) {
        const key = formatValue(sample.value);
        const bucket = grouped.get(key) ?? [];
        bucket.push(sample.score);
        grouped.set(key, bucket);
    }

    const groupMeans = [...grouped.values()].map((scores) =>
        scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length)
    );
    if (groupMeans.length < 2) return 0;

    const spread = Math.max(...groupMeans) - Math.min(...groupMeans);
    const meanAbsScore = groupMeans.reduce((sum, score) => sum + Math.abs(score), 0) / Math.max(1, groupMeans.length);
    const relativeSpread = spread / Math.max(12, meanAbsScore, 1);
    const coverageFactor = Math.min(1, groupMeans.length / Math.max(2, rangeStepCount(input.range)));
    const evidenceFactor = Math.min(1, samples.length / 8);

    return round(clamp(relativeSpread * 60 + coverageFactor * 10 + evidenceFactor * 10, 0, 100), 1);
}

function computeEvidenceStrength(input: ParameterAuditParameterInput, acceptedSamples: ParameterAuditSample[]): ParameterAuditEvidenceStrength {
    const hasReuse = input.samples.some((sample) => sample.origin !== "mini_run");
    if (hasReuse && acceptedSamples.length >= 4) return "strong";
    if (hasReuse && acceptedSamples.length >= 2) return "moderate";
    if (!hasReuse && acceptedSamples.length >= 5 && input.samples.length >= 8) return "moderate";
    return "weak";
}

function buildInteractionNote(
    currentInput: ParameterAuditParameterInput,
    currentCluster: NumericCluster | null,
    acceptedSamples: ParameterAuditSample[],
    peerDrafts: Map<string, RowDraft>
): { note: string | null; confidence: number } {
    if (!currentCluster || acceptedSamples.length < 3) {
        return { note: null, confidence: 0 };
    }

    const currentClusterSamples = acceptedSamples.filter((sample) =>
        sample.params[currentInput.name] !== undefined &&
        sample.params[currentInput.name] >= currentCluster.min - EPSILON &&
        sample.params[currentInput.name] <= currentCluster.max + EPSILON
    );
    if (currentClusterSamples.length < 3) {
        return { note: null, confidence: 0 };
    }

    let bestNote: string | null = null;
    let bestConfidence = 0;

    for (const [peerKey, peerDraft] of peerDrafts.entries()) {
        const peerCluster = peerDraft.cluster;
        if (peerKey === currentInput.name || !peerCluster) continue;

        const paired = currentClusterSamples.filter((sample) => {
            const peerValue = sample.params[peerKey];
            if (!Number.isFinite(peerValue)) return false;
            return peerValue >= peerCluster.min - EPSILON && peerValue <= peerCluster.max + EPSILON;
        });
        if (paired.length < 2) continue;

        const coOccurrence = paired.length / currentClusterSamples.length;
        if (coOccurrence < 0.75) continue;

        const pairedScore = paired.reduce((sum, sample) => sum + sample.score, 0) / paired.length;
        const overallScore = currentClusterSamples.reduce((sum, sample) => sum + sample.score, 0) / currentClusterSamples.length;
        const lift = pairedScore - overallScore;
        const confidence = clamp(coOccurrence * 100 + Math.max(0, lift) * 3, 0, 100);

        if (confidence <= bestConfidence) continue;

        bestConfidence = confidence;
        bestNote = `Often pairs with ${peerDraft.row.parameter} ${peerDraft.row.bestValueCluster}.`;
    }

    return { note: bestNote, confidence: round(bestConfidence, 1) };
}

function classifyRow(
    impactScore: number,
    stability: number,
    boundaryHitPercent: number,
    rangeOccupancy: number,
    evidenceStrength: ParameterAuditEvidenceStrength,
    interactionConfidence: number,
    bestCluster: NumericCluster | null
): ParameterAuditClassification {
    const weakEvidence = evidenceStrength === "weak";
    const boundaryHeavy = boundaryHitPercent >= 60;
    const disableHeavy = Boolean(bestCluster?.touchesDisable) && boundaryHitPercent >= 45;
    const occupancyLow = rangeOccupancy <= 30;
    const impactLow = impactScore < 35;
    const impactModerate = impactScore < 50;
    const stabilityHigh = stability >= 70;
    const stabilityLow = stability < 45;

    if (interactionConfidence >= 70 && impactModerate) return "interaction_only";
    if (weakEvidence) {
        if (boundaryHeavy && (Boolean(bestCluster?.touchesDisable) || Boolean(bestCluster?.touchesBoundary))) {
            return "boundary_problem";
        }
        return "weak";
    }
    if (disableHeavy && stabilityHigh) return "redundant";
    if (disableHeavy && impactLow) return "likely_useless";
    if (boundaryHeavy && occupancyLow && (impactScore >= 35 || Boolean(bestCluster?.touchesBoundary))) {
        return "boundary_problem";
    }
    if (impactLow && stabilityHigh && occupancyLow) return "redundant";
    if (impactLow && stabilityLow) return "likely_useless";
    if (!weakEvidence && impactScore >= 55 && stability >= 55) return "core";
    return "weak";
}

function suggestAction(
    classification: ParameterAuditClassification,
    stability: number,
    boundaryHitPercent: number,
    bestCluster: NumericCluster | null,
    evidenceStrength: ParameterAuditEvidenceStrength
): ParameterAuditSuggestedAction {
    if (evidenceStrength === "weak" && classification !== "interaction_only") {
        if (classification === "boundary_problem") {
            if (bestCluster?.touchesDisable) {
                return "narrow_range";
            }
            return bestCluster?.touchesBoundary ? "widen_range" : "narrow_range";
        }
        return "narrow_range";
    }

    switch (classification) {
        case "core":
            return "keep";
        case "interaction_only":
            return "investigate_interaction";
        case "likely_useless":
            return "remove";
        case "redundant":
            return "fix_constant";
        case "boundary_problem":
            if (bestCluster?.touchesDisable) return "narrow_range";
            return bestCluster?.touchesBoundary ? "widen_range" : "narrow_range";
        case "weak":
        default:
            if (stability >= 70 && boundaryHitPercent < 40) return "fix_constant";
            return "narrow_range";
    }
}

function buildRowNotes(
    bestCluster: NumericCluster | null,
    impactScore: number,
    stability: number,
    boundaryHitPercent: number,
    rangeOccupancy: number,
    evidenceStrength: ParameterAuditEvidenceStrength,
    interactionNote: string | null
): string {
    const notes: string[] = [];

    if (bestCluster) {
        if (bestCluster.ratio >= 0.75) {
            notes.push(`Selection is tightly concentrated around ${buildBestClusterLabel(bestCluster)}.`);
        } else {
            notes.push(`Best runs cluster around ${buildBestClusterLabel(bestCluster)}.`);
        }
    }

    if (boundaryHitPercent >= 50) {
        if (bestCluster?.touchesDisable) {
            if (impactScore < 25) {
                notes.push("Selected values often land on a disable-like state, suggesting the rule is usually better off.");
            } else {
                notes.push("Disable-like or edge values win often, which may mean the search range is misaligned.");
            }
        } else {
            notes.push("Selections hit the explored boundary frequently.");
        }
    }

    if (rangeOccupancy <= 20) {
        notes.push("Only a small fraction of the explored range is used by stronger samples.");
    } else if (rangeOccupancy >= 60) {
        notes.push("Stronger samples spread across much of the tested range.");
    }

    if (stability < 45) {
        notes.push("Chosen values do not cluster consistently across stronger samples.");
    } else if (stability >= 70) {
        notes.push("Chosen values stay fairly stable across stronger samples.");
    }

    if (impactScore < 25) {
        notes.push("Standalone sensitivity is fairly flat.");
    } else if (impactScore >= 60) {
        notes.push("Changing this value moves performance materially.");
    }

    if (interactionNote) {
        notes.push(interactionNote);
    }

    if (evidenceStrength === "weak") {
        notes.push("Evidence is limited, so treat this as a directional signal rather than a hard conclusion.");
    }

    return notes.join(" ");
}

function buildDraft(input: ParameterAuditParameterInput): RowDraft {
    const acceptedSamples = normalizeAcceptedSamples(input);
    const acceptedSourceSamples = acceptedSamples.filter((sample) => sample.origin !== "mini_run");
    const selectionSamples = acceptedSourceSamples.length > 0 ? acceptedSourceSamples : acceptedSamples;
    const clusters = buildClusters(
        selectionSamples.map((sample) => ({ value: sample.value, score: sample.score })),
        input.range
    );
    const bestCluster = resolveBestCluster(clusters);
    const boundaryHitPercent = selectionSamples.length === 0
        ? 0
        : round(
            selectionSamples.filter((sample) => isBoundaryValue(sample.value, input.range) || isDisableLikeValue(sample.value, input.range)).length
            / selectionSamples.length * 100,
            1
        );
    const distinctValues = new Set(selectionSamples.map((sample) => formatValue(sample.value))).size;
    const rangeOccupancy = round(distinctValues / Math.max(1, rangeStepCount(input.range)) * 100, 1);
    const stabilityMultiplier = acceptedSourceSamples.length > 0 ? 1 : 0.7;
    const stability = bestCluster
        ? round(bestCluster.ratio * 100 * stabilityMultiplier, 1)
        : 0;
    const impactScore = computeImpactScore(input);
    const evidenceStrength = computeEvidenceStrength(input, acceptedSamples);

    return {
        row: {
            parameter: input.label,
            key: input.name,
            baseValue: input.baseValue,
            bestValueCluster: buildBestClusterLabel(bestCluster),
            impactScore,
            stability,
            boundaryHitPercent,
            rangeOccupancy,
            classification: "weak",
            suggestedAction: "narrow_range",
            notes: "",
            evidenceStrength,
        },
        cluster: bestCluster,
        acceptedSamples,
        allSamples: input.samples,
    };
}

function buildSummary(report: ParameterAuditReport, drafts: RowDraft[]): ParameterAuditReport["summary"] {
    const removableOrFixable = report.rows
        .filter((row) => row.suggestedAction === "remove" || row.suggestedAction === "fix_constant")
        .sort((left, right) => {
            const severity = (row: ParameterAuditRow) => {
                switch (row.classification) {
                    case "likely_useless":
                        return 5;
                    case "redundant":
                        return 4;
                    case "boundary_problem":
                        return 3;
                    case "interaction_only":
                        return 2;
                    case "weak":
                        return 1;
                    case "core":
                    default:
                        return 0;
                }
            };
            if (severity(right) !== severity(left)) return severity(right) - severity(left);
            return left.impactScore - right.impactScore;
        });

    const nonCoreCount = report.rows.filter((row) => row.classification !== "core").length;
    const highBloatCount = report.rows.filter((row) =>
        row.classification === "likely_useless" ||
        row.classification === "redundant" ||
        row.classification === "boundary_problem"
    ).length;

    let overallParameterBloat = "Lean parameter set.";
    if (highBloatCount >= Math.ceil(report.rows.length / 2)) {
        overallParameterBloat = "High parameter bloat: several parameters look removable or badly ranged.";
    } else if (nonCoreCount >= 2) {
        overallParameterBloat = "Moderate parameter bloat: a few parameters deserve simplification work.";
    }

    const topPriorityParams = removableOrFixable.slice(0, 3).map((row) => row.parameter);
    const simplificationPriority = topPriorityParams.length === 0
        ? "No immediate simplification priority. Focus on keeping current ranges honest."
        : `Start with ${topPriorityParams.join(", ")}.`;

    const weakRows = drafts.filter((draft) => draft.row.evidenceStrength === "weak").length;
    const weakEvidenceWarning = weakRows > Math.floor(report.rows.length / 2)
        ? "Evidence is weak for much of this report. Reuse fresher Finder/WFA runs or allow a few more mini-runs before removing parameters."
        : null;

    const evidenceMode = report.rows.some((row) => row.evidenceStrength === "strong")
        ? "Mixed reuse plus targeted checks."
        : "Mostly lightweight evidence.";

    return {
        overallParameterBloat,
        simplificationPriority,
        topPriorityParams,
        weakEvidenceWarning,
        evidenceMode,
    };
}

export function buildParameterAuditReport(input: ParameterAuditReportInput): ParameterAuditReport {
    const drafts = input.parameters.map(buildDraft);
    const draftMap = new Map(drafts.map((draft) => [draft.row.key, draft]));

    const rows = input.parameters.map((parameter) => {
        const draft = draftMap.get(parameter.name)!;
        const interaction = buildInteractionNote(parameter, draft.cluster, draft.acceptedSamples, draftMap);
        const classification = classifyRow(
            draft.row.impactScore,
            draft.row.stability,
            draft.row.boundaryHitPercent,
            draft.row.rangeOccupancy,
            draft.row.evidenceStrength,
            interaction.confidence,
            draft.cluster
        );
        const suggestedAction = suggestAction(
            classification,
            draft.row.stability,
            draft.row.boundaryHitPercent,
            draft.cluster,
            draft.row.evidenceStrength
        );
        const notes = buildRowNotes(
            draft.cluster,
            draft.row.impactScore,
            draft.row.stability,
            draft.row.boundaryHitPercent,
            draft.row.rangeOccupancy,
            draft.row.evidenceStrength,
            interaction.note
        );

        return {
            ...draft.row,
            classification,
            suggestedAction,
            notes,
        };
    });

    const report: ParameterAuditReport = {
        strategyKey: input.strategyKey,
        strategyName: input.strategyName,
        sourceType: input.sourceType,
        sourceLabel: input.sourceLabel,
        includedParams: rows.map((row) => row.parameter),
        rows,
        summary: {
            overallParameterBloat: "",
            simplificationPriority: "",
            topPriorityParams: [],
            weakEvidenceWarning: null,
            evidenceMode: "",
        },
    };

    report.summary = buildSummary(report, drafts);
    return report;
}
