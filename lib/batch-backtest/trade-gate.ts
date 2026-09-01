import type { TradeGateFeatureRow } from "./trade-ledger-features";

export interface TradeGateRule {
    ruleId: string;
    ruleName: string;
    sourceHash: string;
    evaluate: (row: TradeGateFeatureRow) => boolean;
}

export interface TradeGatePairContext {
    pair: string;
    featuresBySignalKey: ReadonlyMap<string, TradeGateFeatureRow>;
}

export interface TradeGateProvenance {
    schema: "batch.trade_gate.v1";
    folderId: string;
    sweepId: string;
    rules: Array<{ ruleId: string; ruleName: string; sourceHash: string }>;
}

export interface TradeGate {
    enabled: true;
    provenance: TradeGateProvenance;
    rules: readonly TradeGateRule[];
    pairs: ReadonlyMap<string, TradeGatePairContext>;
}

export interface TradeGateStats {
    signalsEvaluated: number;
    admitted: number;
    rejectedByGate: number;
    blocked: number;
}

export function createTradeGateStats(): TradeGateStats {
    return { signalsEvaluated: 0, admitted: 0, rejectedByGate: 0, blocked: 0 };
}

export function addTradeGateStats(target: TradeGateStats, source: TradeGateStats | undefined): void {
    if (!source) return;
    target.signalsEvaluated += source.signalsEvaluated;
    target.admitted += source.admitted;
    target.rejectedByGate += source.rejectedByGate;
    target.blocked += source.blocked;
}

export class TradeGateEvaluationError extends Error {
    constructor(ruleName: string, cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        super(`Trade gate rule ${ruleName} failed: ${message}`);
        this.name = "TradeGateEvaluationError";
    }
}

export function isTradeGateEvaluationError(error: unknown): error is TradeGateEvaluationError {
    return error instanceof TradeGateEvaluationError;
}

export function evaluateTradeGate(
    gate: TradeGate,
    row: TradeGateFeatureRow,
    stats: TradeGateStats,
): boolean {
    stats.signalsEvaluated += 1;
    for (const rule of gate.rules) {
        try {
            if (rule.evaluate(row) === true) {
                stats.admitted += 1;
                return true;
            }
        } catch (error) {
            throw new TradeGateEvaluationError(rule.ruleName, error);
        }
    }
    stats.rejectedByGate += 1;
    return false;
}
