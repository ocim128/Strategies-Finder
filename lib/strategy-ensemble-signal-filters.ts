import { timeKey, type Signal, type Trade, type TradeDirection } from "./strategies";
import type { EnsembleEntryPresence, EnsembleVoteLabel } from "./strategy-ensemble-types";

export interface EnsembleSignalFilterArtifact {
    tradeDirection: TradeDirection;
    preparedSignals: Signal[];
    entryPresenceByTime: Map<string, EnsembleEntryPresence>;
}

export function resolveContextVote(
    direction: Trade["type"],
    presence: EnsembleEntryPresence | null | undefined
): EnsembleVoteLabel {
    if (!presence) {
        return "neutral";
    }

    const agrees = direction === "long" ? presence.longEntry : presence.shortEntry;
    const opposes = direction === "long" ? presence.shortEntry : presence.longEntry;

    if (agrees && opposes) {
        return "conflict";
    }
    if (agrees) {
        return "agree";
    }
    if (opposes) {
        return "oppose";
    }
    return "neutral";
}

export function isEntrySignalForTradeDirection(signal: Signal, tradeDirection: TradeDirection): boolean {
    if (
        tradeDirection === "both"
        || tradeDirection === "both_no_flip"
        || tradeDirection === "both_flip_loss_2"
        || tradeDirection === "combined"
    ) {
        return signal.type === "buy" || signal.type === "sell";
    }

    return tradeDirection === "short" ? signal.type === "sell" : signal.type === "buy";
}

export function buildTargetConflictFilterPreparedSignals<TArtifact extends EnsembleSignalFilterArtifact>(
    targetArtifact: TArtifact,
    contextArtifacts: readonly TArtifact[]
): Signal[] {
    return targetArtifact.preparedSignals
        .filter((signal) => {
            if (!isEntrySignalForTradeDirection(signal, targetArtifact.tradeDirection)) {
                return true;
            }

            const direction = signal.type === "buy" ? "long" : "short";
            return contextArtifacts.every((artifact) => {
                const vote = resolveContextVote(direction, artifact.entryPresenceByTime.get(timeKey(signal.time)));
                return vote !== "oppose" && vote !== "conflict";
            });
        })
        .sort(compareSignalsByBarIndexThenTime);
}

export function buildPrimaryVetoPreparedSignals<TArtifact extends EnsembleSignalFilterArtifact>(
    primaryArtifact: TArtifact,
    vetoArtifact: TArtifact
): Signal[] {
    return primaryArtifact.preparedSignals
        .filter((signal) => {
            if (!isEntrySignalForTradeDirection(signal, primaryArtifact.tradeDirection)) {
                return true;
            }

            const direction = signal.type === "buy" ? "long" : "short";
            const vote = resolveContextVote(direction, vetoArtifact.entryPresenceByTime.get(timeKey(signal.time)));
            return vote !== "oppose" && vote !== "conflict";
        })
        .sort(compareSignalsByBarIndexThenTime);
}

export function buildPrimarySecondaryOverridePreparedSignals<TArtifact extends EnsembleSignalFilterArtifact>(
    primaryArtifact: TArtifact,
    secondaryArtifact: TArtifact
): Signal[] {
    const secondarySignalByEventSide = buildSignalLookupByEventSide(secondaryArtifact.preparedSignals);
    const deduped = new Map<string, Signal>();

    for (const signal of primaryArtifact.preparedSignals) {
        if (!isEntrySignalForTradeDirection(signal, primaryArtifact.tradeDirection)) {
            deduped.set(buildEventSideKey(signal.time, signal.type), signal);
            continue;
        }

        const direction = signal.type === "buy" ? "long" : "short";
        const vote = resolveContextVote(direction, secondaryArtifact.entryPresenceByTime.get(timeKey(signal.time)));
        if (vote === "oppose" || vote === "conflict") {
            const replacementType: Signal["type"] = signal.type === "buy" ? "sell" : "buy";
            const replacement = secondarySignalByEventSide.get(buildEventSideKey(signal.time, replacementType));
            if (replacement) {
                deduped.set(buildEventSideKey(replacement.time, replacement.type), replacement);
            }
            continue;
        }

        deduped.set(buildEventSideKey(signal.time, signal.type), signal);
    }

    return Array.from(deduped.values()).sort(compareSignalsByBarIndexThenTime);
}

export function buildBestSideOwnerPreparedSignals<TArtifact extends EnsembleSignalFilterArtifact>(args: {
    longArtifact?: TArtifact | null;
    shortArtifact?: TArtifact | null;
}): Signal[] {
    const byTime = new Map<string, { buy?: Signal; sell?: Signal }>();

    for (const signal of args.longArtifact?.preparedSignals ?? []) {
        if (signal.type !== "buy") {
            continue;
        }
        const bucket = byTime.get(timeKey(signal.time)) ?? {};
        bucket.buy ??= signal;
        byTime.set(timeKey(signal.time), bucket);
    }

    for (const signal of args.shortArtifact?.preparedSignals ?? []) {
        if (signal.type !== "sell") {
            continue;
        }
        const bucket = byTime.get(timeKey(signal.time)) ?? {};
        bucket.sell ??= signal;
        byTime.set(timeKey(signal.time), bucket);
    }

    const merged: Signal[] = [];
    for (const bucket of byTime.values()) {
        if (bucket.buy && bucket.sell) {
            continue;
        }
        if (bucket.buy) {
            merged.push(bucket.buy);
        }
        if (bucket.sell) {
            merged.push(bucket.sell);
        }
    }

    return merged.sort(compareSignalsByBarIndexThenTime);
}

function buildSignalLookupByEventSide(signals: readonly Signal[]): Map<string, Signal> {
    const lookup = new Map<string, Signal>();
    for (const signal of signals) {
        const key = buildEventSideKey(signal.time, signal.type);
        if (!lookup.has(key)) {
            lookup.set(key, signal);
        }
    }
    return lookup;
}

function buildEventSideKey(time: Signal["time"], type: Signal["type"]): string {
    return `${timeKey(time)}:${type}`;
}

function compareSignalsByBarIndexThenTime(left: Signal, right: Signal): number {
    const leftBarIndex = Number.isFinite(left.barIndex as number) ? Math.trunc(left.barIndex as number) : null;
    const rightBarIndex = Number.isFinite(right.barIndex as number) ? Math.trunc(right.barIndex as number) : null;
    if (leftBarIndex !== null && rightBarIndex !== null && leftBarIndex !== rightBarIndex) {
        return leftBarIndex - rightBarIndex;
    }

    const leftKey = timeKey(left.time);
    const rightKey = timeKey(right.time);
    if (leftKey === rightKey) {
        return 0;
    }
    return leftKey < rightKey ? -1 : 1;
}
