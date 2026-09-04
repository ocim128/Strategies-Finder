/**
 * Causal, snapshot-only TOP_MEAN feature construction.
 *
 * The state machine is deliberately independent of outcomes except for the
 * strictly-prior, completed incumbent returns needed by the fourth feature.
 * Rows at one decision timestamp are emitted before that timestamp changes
 * any state, so input order and same-timestamp ordering cannot create a leak.
 */
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "./batch-open-score-usd-replay-engine";
import { tieBreakDigest } from "./max-active-research-contract";

export const TOP_MEAN_CANDIDATE_FEATURES_SCHEMA = "top_mean_candidate_features.v1" as const;
export const TOP_MEAN_FEATURE_CONTRACT_VERSION = "top_mean_feature_set.v2" as const;
export const TOP_MEAN_FEATURE_FORMULA_VERSION = "tm_feature_formulas.v1" as const;
export const TOP_MEAN_FEATURE_AVAILABILITY_POLICY = "strict_prior_exit_v1" as const;

export const TOP_MEAN_CAUSAL_FEATURE_FIELDS = [
    "priorCoverageSlope5",
    "priorSignedVoteDelta3",
    "priorScoreStdDev5",
    "priorTopMeanReturnMean3",
] as const;

export type TopMeanCausalFeatureField = typeof TOP_MEAN_CAUSAL_FEATURE_FIELDS[number];

export interface TopMeanCandidateFeatureRow {
    eventId: string;
    decisionTimeSec: number;
    asset: string;
    priorCoverageSlope5: number | null;
    priorSignedVoteDelta3: number | null;
    priorScoreStdDev5: number | null;
    priorTopMeanReturnMean3: number | null;
}

export interface TopMeanCausalFeatureBuildInput {
    snapshots: readonly PoolSnapshotRecord[];
    outcomes: readonly CandidateOutcomeRecord[];
}

interface SnapshotHistory {
    activePairCounts: number[];
    signedVotes: number[];
    scores: Array<number | null>;
}

interface IncumbentSelection {
    eventId: string;
    decisionTimeSec: number;
    asset: string;
    returnValue: number;
    exitTimeSec: number;
}

interface EventGroup {
    decisionTimeSec: number;
    events: Map<string, PoolSnapshotRecord[]>;
}

function codeUnitCompare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function numberCompare(left: number, right: number): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function scoreOf(row: PoolSnapshotRecord): number | null {
    if (!Number.isFinite(row.activePairCount) || row.activePairCount <= 0 || !Number.isFinite(row.signedVotes)) return null;
    const score = row.signedVotes / row.activePairCount;
    return Number.isFinite(score) ? score : null;
}

/** OLS slope of five observations at x=-2,-1,0,1,2. */
export function priorCoverageSlope5(values: readonly number[]): number | null {
    if (values.length < 5) return null;
    const last = values.slice(-5);
    if (last.some((value) => !finite(value))) return null;
    return last.reduce((sum, value, index) => sum + (index - 2) * value, 0) / 10;
}

/** Difference between the newest and oldest of three signed-vote observations. */
export function priorSignedVoteDelta3(values: readonly number[]): number | null {
    if (values.length < 3) return null;
    const last = values.slice(-3);
    if (last.some((value) => !finite(value))) return null;
    return last[2]! - last[0]!;
}

/** Population standard deviation of five recomputed scores. */
export function priorScoreStdDev5(values: readonly (number | null)[]): number | null {
    if (values.length < 5) return null;
    const last = values.slice(-5);
    if (last.some((value) => !finite(value))) return null;
    const numbers = last.map((value) => value!);
    const mean = numbers.reduce((sum, value) => sum + value, 0) / 5;
    const variance = numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 5;
    return Number.isFinite(variance) ? Math.sqrt(variance) : null;
}

/** Mean of the three most recent already-available incumbent returns. */
export function priorTopMeanReturnMean3(values: readonly number[]): number | null {
    if (values.length < 3) return null;
    const last = values.slice(-3);
    if (last.some((value) => !finite(value))) return null;
    return last.reduce((sum, value) => sum + value, 0) / 3;
}

// Verbose aliases make the formula exports self-describing to offline tests.
export const computePriorCoverageSlope5 = priorCoverageSlope5;
export const computePriorSignedVoteDelta3 = priorSignedVoteDelta3;
export const computePriorScoreStdDev5 = priorScoreStdDev5;
export const computePriorTopMeanReturnMean3 = priorTopMeanReturnMean3;

function snapshotOrder(left: PoolSnapshotRecord, right: PoolSnapshotRecord): number {
    return numberCompare(left.decisionTimeSec, right.decisionTimeSec)
        || codeUnitCompare(left.eventId, right.eventId)
        || codeUnitCompare(left.asset, right.asset);
}

function outcomeOrder(left: CandidateOutcomeRecord, right: CandidateOutcomeRecord): number {
    return codeUnitCompare(left.eventId, right.eventId)
        || codeUnitCompare(left.asset, right.asset)
        || numberCompare(left.horizonBars, right.horizonBars)
        || codeUnitCompare(left.direction, right.direction)
        || numberCompare(left.exitTimeSec ?? Number.POSITIVE_INFINITY, right.exitTimeSec ?? Number.POSITIVE_INFINITY)
        || codeUnitCompare(left.status, right.status);
}

function outcomeKey(eventId: string, asset: string): string {
    return `${eventId}|24|long|${asset}`;
}

function makeEventGroups(snapshots: readonly PoolSnapshotRecord[]): EventGroup[] {
    const ordered = [...snapshots].sort(snapshotOrder);
    const groups: EventGroup[] = [];
    for (const row of ordered) {
        let group = groups[groups.length - 1];
        if (!group || group.decisionTimeSec !== row.decisionTimeSec) {
            group = { decisionTimeSec: row.decisionTimeSec, events: new Map<string, PoolSnapshotRecord[]>() };
            groups.push(group);
        }
        const rows = group.events.get(row.eventId);
        if (rows) rows.push(row);
        else group.events.set(row.eventId, [row]);
    }
    return groups;
}

function incumbent(rows: readonly PoolSnapshotRecord[], decisionTimeSec: number): PoolSnapshotRecord | null {
    const candidates = rows
        .map((row) => ({ row, score: scoreOf(row) }))
        .filter((candidate): candidate is { row: PoolSnapshotRecord; score: number } =>
            candidate.score !== null && candidate.score > 0 && candidate.row.longEligible === true)
        .sort((left, right) =>
            numberCompare(right.score, left.score)
            || codeUnitCompare(tieBreakDigest(decisionTimeSec, left.row.asset), tieBreakDigest(decisionTimeSec, right.row.asset))
            || codeUnitCompare(left.row.asset, right.row.asset));
    return candidates[0]?.row ?? null;
}

function createHistory(): SnapshotHistory {
    return { activePairCounts: [], signedVotes: [], scores: [] };
}

function appendSnapshot(historyByAsset: Map<string, SnapshotHistory>, row: PoolSnapshotRecord): void {
    const history = historyByAsset.get(row.asset) ?? createHistory();
    history.activePairCounts.push(row.activePairCount);
    history.signedVotes.push(row.signedVotes);
    history.scores.push(scoreOf(row));
    historyByAsset.set(row.asset, history);
}

function incumbentKeys(snapshots: readonly PoolSnapshotRecord[]): Set<string> {
    const selected = new Set<string>();
    for (const group of makeEventGroups(snapshots)) {
        for (const [eventId, eventRows] of group.events) {
            const row = incumbent(eventRows, group.decisionTimeSec);
            if (row) selected.add(outcomeKey(eventId, row.asset));
        }
    }
    return selected;
}

function buildOutcomeIndex(
    outcomes: Iterable<CandidateOutcomeRecord>,
    selectedKeys: ReadonlySet<string>,
): Map<string, CandidateOutcomeRecord> {
    const index = new Map<string, CandidateOutcomeRecord>();
    for (const row of outcomes) {
        if (row.horizonBars !== 24 || row.direction !== "long") continue;
        const key = outcomeKey(row.eventId, row.asset);
        if (!selectedKeys.has(key)) continue;
        const previous = index.get(key);
        if (!previous || outcomeOrder(row, previous) < 0) index.set(key, row);
    }
    return index;
}

/**
 * Small state-machine facade used by the archive writer and unit tests.
 * `run` is pure from the caller's perspective: every mutable collection is
 * local to the invocation and the inputs are never modified.
 */
export class TopMeanCausalFeatureStateMachine {
    private runWithOutcomeIndex(
        snapshots: readonly PoolSnapshotRecord[],
        outcomeIndex: ReadonlyMap<string, CandidateOutcomeRecord>,
    ): TopMeanCandidateFeatureRow[] {
        const historyByAsset = new Map<string, SnapshotHistory>();
        const availableSelectionsByAsset = new Map<string, IncumbentSelection[]>();
        const pendingSelections: IncumbentSelection[] = [];
        const activatedSelections = new Set<string>();
        const rows: TopMeanCandidateFeatureRow[] = [];

        for (const group of makeEventGroups(snapshots)) {
            const timestamp = group.decisionTimeSec;
            const due = pendingSelections
                .filter((selection) => selection.decisionTimeSec < timestamp && selection.exitTimeSec < timestamp)
                .sort((left, right) =>
                    numberCompare(left.decisionTimeSec, right.decisionTimeSec)
                    || codeUnitCompare(left.eventId, right.eventId)
                    || numberCompare(left.exitTimeSec, right.exitTimeSec));
            for (const selection of due) {
                const key = `${selection.eventId}|${selection.asset}`;
                if (activatedSelections.has(key)) continue;
                activatedSelections.add(key);
                const history = availableSelectionsByAsset.get(selection.asset) ?? [];
                history.push(selection);
                availableSelectionsByAsset.set(selection.asset, history);
            }

            // Emit before applying any snapshot or selection at this timestamp.
            for (const [eventId, eventRows] of group.events) {
                for (const row of eventRows) {
                    const history = historyByAsset.get(row.asset) ?? createHistory();
                    const returns = (availableSelectionsByAsset.get(row.asset) ?? [])
                        .slice()
                        .sort((left, right) =>
                            numberCompare(left.decisionTimeSec, right.decisionTimeSec)
                            || codeUnitCompare(left.eventId, right.eventId))
                        .map((selection) => selection.returnValue);
                    rows.push({
                        eventId,
                        decisionTimeSec: timestamp,
                        asset: row.asset,
                        priorCoverageSlope5: priorCoverageSlope5(history.activePairCounts),
                        priorSignedVoteDelta3: priorSignedVoteDelta3(history.signedVotes),
                        priorScoreStdDev5: priorScoreStdDev5(history.scores),
                        priorTopMeanReturnMean3: priorTopMeanReturnMean3(returns),
                    });
                }
            }

            // Apply every snapshot in the timestamp group only after emission.
            for (const eventRows of group.events.values()) {
                for (const row of eventRows) appendSnapshot(historyByAsset, row);
            }

            // Incumbents are selected from the just-completed event snapshot,
            // but their returns become available only after their strict exit.
            for (const [eventId, eventRows] of group.events) {
                const selected = incumbent(eventRows, timestamp);
                if (!selected) continue;
                const outcome = outcomeIndex.get(outcomeKey(eventId, selected.asset));
                if (
                    outcome?.eligible !== true
                    || outcome.status !== "ok"
                    || !finite(outcome.return)
                    || !finite(outcome.exitTimeSec)
                ) continue;
                pendingSelections.push({
                    eventId,
                    decisionTimeSec: timestamp,
                    asset: selected.asset,
                    returnValue: outcome.return,
                    exitTimeSec: outcome.exitTimeSec,
                });
            }
        }

        return rows;
    }

    run(input: TopMeanCausalFeatureBuildInput): TopMeanCandidateFeatureRow[] {
        return this.runWithOutcomeIndex(input.snapshots, buildOutcomeIndex(input.outcomes, incumbentKeys(input.snapshots)));
    }

    async runStreaming(
        snapshots: readonly PoolSnapshotRecord[],
        outcomes: AsyncIterable<CandidateOutcomeRecord>,
    ): Promise<TopMeanCandidateFeatureRow[]> {
        const selectedKeys = incumbentKeys(snapshots);
        const selectedOutcomes: CandidateOutcomeRecord[] = [];
        for await (const outcome of outcomes) {
            if (outcome.horizonBars === 24 && outcome.direction === "long" && selectedKeys.has(outcomeKey(outcome.eventId, outcome.asset))) {
                selectedOutcomes.push(outcome);
            }
        }
        return this.runWithOutcomeIndex(snapshots, buildOutcomeIndex(selectedOutcomes, selectedKeys));
    }
}

export function createTopMeanCausalFeatureStateMachine(): TopMeanCausalFeatureStateMachine {
    return new TopMeanCausalFeatureStateMachine();
}

export function buildCandidateFeatures(input: TopMeanCausalFeatureBuildInput): TopMeanCandidateFeatureRow[] {
    return new TopMeanCausalFeatureStateMachine().run(input);
}

export async function buildCandidateFeaturesFromOutcomeStream(args: {
    snapshots: readonly PoolSnapshotRecord[];
    outcomes: AsyncIterable<CandidateOutcomeRecord>;
}): Promise<TopMeanCandidateFeatureRow[]> {
    return new TopMeanCausalFeatureStateMachine().runStreaming(args.snapshots, args.outcomes);
}
