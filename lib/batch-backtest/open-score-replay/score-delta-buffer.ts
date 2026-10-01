import type { ScoreDelta } from "./internal-types";

/** Columnar delta storage: 37 bytes per delta, with no retained JS row objects.
 * Float64 preserves fractional timestamps, weighted votes and P&L exactly. */
export class ScoreDeltaBuffer {
    readonly timeSecs: Float64Array;
    readonly assetIndices: Uint32Array;
    readonly deltas: Float64Array;
    readonly pnlShares: Float64Array;
    readonly confidenceWeights: Float64Array;
    /** Bit 0: entry; bit 1: causal vote applies. */
    readonly flags: Uint8Array;

    constructor(readonly length: number) {
        this.timeSecs = new Float64Array(length);
        this.assetIndices = new Uint32Array(length);
        this.deltas = new Float64Array(length);
        this.pnlShares = new Float64Array(length);
        this.confidenceWeights = new Float64Array(length);
        this.flags = new Uint8Array(length);
    }

    static from(rows: readonly ScoreDelta[]): ScoreDeltaBuffer {
        const buffer = new ScoreDeltaBuffer(rows.length);
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i]!;
            buffer.timeSecs[i] = row.timeSec;
            buffer.assetIndices[i] = row.assetIndex;
            buffer.deltas[i] = row.delta;
            buffer.pnlShares[i] = row.pnlShare;
            buffer.confidenceWeights[i] = row.profitNowConfidenceWeight;
            buffer.flags[i] = row.isEntry | (row.voteApplied ? 2 : 0);
        }
        return buffer;
    }

    copyFrom(slot: number, source: ScoreDeltaBuffer, index: number): void {
        this.timeSecs[slot] = source.timeSecs[index]!;
        this.assetIndices[slot] = source.assetIndices[index]!;
        this.deltas[slot] = source.deltas[index]!;
        this.pnlShares[slot] = source.pnlShares[index]!;
        this.confidenceWeights[slot] = source.confidenceWeights[index]!;
        this.flags[slot] = source.flags[index]!;
    }
}
