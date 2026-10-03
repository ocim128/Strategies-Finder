import type { ScoreDelta } from "./internal-types";

/** Columnar delta storage: 37 bytes per delta (45 with causal entry times), with no retained JS row objects.
 * Float64 preserves fractional timestamps, weighted votes and P&L exactly. */
export class ScoreDeltaBuffer {
    readonly entrySecs?: Float64Array;
    readonly timeSecs: Float64Array;
    readonly assetIndices: Uint32Array;
    readonly deltas: Float64Array;
    readonly pnlShares: Float64Array;
    readonly confidenceWeights: Float64Array;
    /** Bit 0: entry; bit 1: causal vote applies. */
    readonly flags: Uint8Array;

    /**
     * When {@link columns} is supplied the buffer WRAPS those arrays instead of
     * allocating (zero-copy per-pair views over one packed shard buffer). The
     * caller owns column lifetimes; lengths must each be >= `length`.
     */
    constructor(readonly length: number, columns?: {
        entrySecs?: Float64Array;
        timeSecs: Float64Array;
        assetIndices: Uint32Array;
        deltas: Float64Array;
        pnlShares: Float64Array;
        confidenceWeights: Float64Array;
        flags: Uint8Array;
    }, causal = false) {
        this.entrySecs = columns?.entrySecs ?? (causal ? new Float64Array(length) : undefined);
        this.timeSecs = columns?.timeSecs ?? new Float64Array(length);
        this.assetIndices = columns?.assetIndices ?? new Uint32Array(length);
        this.deltas = columns?.deltas ?? new Float64Array(length);
        this.pnlShares = columns?.pnlShares ?? new Float64Array(length);
        this.confidenceWeights = columns?.confidenceWeights ?? new Float64Array(length);
        this.flags = columns?.flags ?? new Uint8Array(length);
    }

    static from(rows: readonly ScoreDelta[], causal = false): ScoreDeltaBuffer {
        const buffer = new ScoreDeltaBuffer(rows.length, undefined, causal);
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i]!;
            if (buffer.entrySecs) buffer.entrySecs[i] = row.entrySec!;
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
        if (this.entrySecs) this.entrySecs[slot] = source.entrySecs![index]!;
        this.timeSecs[slot] = source.timeSecs[index]!;
        this.assetIndices[slot] = source.assetIndices[index]!;
        this.deltas[slot] = source.deltas[index]!;
        this.pnlShares[slot] = source.pnlShares[index]!;
        this.confidenceWeights[slot] = source.confidenceWeights[index]!;
        this.flags[slot] = source.flags[index]!;
    }
}
