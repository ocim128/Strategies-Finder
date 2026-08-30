/**
 * Additive interlock for server-owned research workloads.
 *
 * Batch and Finder keep their existing local owner locks. This leaf only
 * prevents a Ledger Sweep from competing for the same machine memory while
 * allowing the established Batch/Finder relationship to remain unchanged.
 */

export type ResearchWorkloadKind = "batch" | "finder" | "ledger_sweep";

export interface ResearchWorkloadToken {
    readonly tokenId: string;
    readonly kind: ResearchWorkloadKind;
    readonly ownerId: string;
    readonly startedAt: number;
}

export interface ResearchWorkloadSnapshot {
    kind: ResearchWorkloadKind;
    ownerId: string;
    startedAt: number;
}

let nextTokenId = 0;
const activeTokens = new Map<string, ResearchWorkloadToken>();

function conflicts(kind: ResearchWorkloadKind): boolean {
    if (kind === "ledger_sweep") return activeTokens.size > 0;
    for (const token of activeTokens.values()) {
        if (token.kind === "ledger_sweep") return true;
    }
    return false;
}

export function tryAcquire(kind: ResearchWorkloadKind, ownerId: string): ResearchWorkloadToken | null {
    if (conflicts(kind)) return null;
    const token: ResearchWorkloadToken = Object.freeze({
        tokenId: `research-${++nextTokenId}`,
        kind,
        ownerId,
        startedAt: Date.now(),
    });
    activeTokens.set(token.tokenId, token);
    return token;
}

export function releaseIfOwner(token: ResearchWorkloadToken): void {
    const active = activeTokens.get(token.tokenId);
    if (!active || active !== token) return;
    activeTokens.delete(token.tokenId);
}

export function getActiveWorkloads(): ResearchWorkloadSnapshot[] {
    return [...activeTokens.values()].map(({ kind, ownerId, startedAt }) => ({ kind, ownerId, startedAt }));
}

export function resetForTests(): void {
    activeTokens.clear();
    nextTokenId = 0;
}

export const serverResearchJobCoordinator = {
    tryAcquire,
    releaseIfOwner,
    getActiveWorkloads,
    resetForTests,
};
