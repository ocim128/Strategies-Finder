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
