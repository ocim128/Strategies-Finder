/**
 * Balanced pair-list generator for Batch Markets — deterministic,
 * degree-balanced, capped at {@link BALANCED_PAIR_LIST_MAX_PAIRS}.
 *
 * Pure helper. No network, no storage, no settings persistence. The browser
 * service applies the emitted pair list to the existing Batch textarea.
 *
 * Contract (see docs/max-active-validation-pair-list-generator-implementation-plan.md):
 *   - One asset token per input line (incl. marked stock/IBKR tokens).
 *   - Each non-self relationship is emitted once (no `A+B` and `B+A`).
 *   - Effective `maxPairs` is clamped to `1..BALANCED_PAIR_LIST_MAX_PAIRS`.
 *   - When the full relationship set exceeds the cap, a seeded degree-balanced
 *     round-robin subset keeps submitted asset degrees within one.
 *   - Pair orientation is a deterministic balanced graph orientation
 *     performed AFTER relationship selection; every asset's base-minus-quote
 *     count stays within one.
 *   - Selector ties use one versioned seeded asset order shared by every
 *     selector. Alphabetical names and input order are NEVER tie-breaks.
 *
 * The construction is O(assets + emitted pairs): never build the full
 * N*(N-1)/2 relationship set when capped.
 */

import { normalizeBatchSymbols } from "./batch-run-contract";
import { createSeededRandom } from "../param-math-utils";
import { fnv1a64Hex } from "./max-active-research-contract";
import {
    canonicalizeLegIdentity,
    dedupeWithinProviderAliases,
    detectAliasCollisions,
    type AliasCollision,
    type CanonicalLegIdentity,
} from "../synthetic-leg-identity";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BalancedPairListOptions {
    assets: readonly string[];
    /** Effective integer clamped to 1..BALANCED_PAIR_LIST_MAX_PAIRS. */
    maxPairs?: number;
    /** Effective uint32; non-finite/zero becomes 1. */
    seed?: number;
}

export type BalancedPairListResult = {
    ok: false;
    errors: string[];
    invalidTokens: string[];
    aliasCollisions: AliasCollision[];
} | {
    ok: true;
    canonicalAssets: CanonicalLegIdentity[];
    pairs: string[];
    candidatePairCount: number;
    omittedPairCount: number;
    effectiveSeed: number;
    effectiveMaxPairs: number;
    degreeByAsset: Record<string, number>;
    baseDegreeByAsset: Record<string, number>;
    quoteDegreeByAsset: Record<string, number>;
    invalidTokens: string[];
    aliasCollisions: AliasCollision[];
    provenance: PairListProvenanceV1;
    warnings: string[];
};

export interface PairListProvenanceV1 {
    schema: "batch.pair_list.v1";
    algorithm: "seeded_round_robin_v1";
    effectiveSeed: number;
    effectiveMaxPairs: number;
    canonicalAssetListHash: string;
    emittedPairListHash: string;
    assetCount: number;
    pairCount: number;
    degree: { min: number; median: number; max: number };
    orientationImbalanceMax: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on nonempty input lines before alias collapse. */
export const BALANCED_PAIR_LIST_MAX_INPUT_LINES = 500;

/** Generator-only pair ceiling; normal Batch row intake remains capped separately. */
export const BALANCED_PAIR_LIST_MAX_PAIRS = 1_000_000;

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateBalancedPairList(options: BalancedPairListOptions): BalancedPairListResult {
    const errors: string[] = [];
    const invalidTokens: string[] = [];
    const warnings: string[] = [];

    // --- Normalize options ------------------------------------------------
    const effectiveSeed = normalizeSeed(options.seed);
    const effectiveMaxPairs = normalizeMaxPairs(options.maxPairs);

    // --- Parse + canonicalize input --------------------------------------
    const rawLines = String((options.assets ?? []).join("\n")).split(/\r?\n/);
    const nonemptyLines: string[] = [];
    for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        nonemptyLines.push(trimmed);
    }
    if (nonemptyLines.length === 0) {
        return failResult(["No nonempty input lines provided."], [], []);
    }
    if (nonemptyLines.length > BALANCED_PAIR_LIST_MAX_INPUT_LINES) {
        return failResult(
            [`Input exceeds the ${BALANCED_PAIR_LIST_MAX_INPUT_LINES}-line limit (got ${nonemptyLines.length}).`],
            [],
            [],
        );
    }

    const identities: CanonicalLegIdentity[] = [];
    for (const line of nonemptyLines) {
        const id = canonicalizeLegIdentity(line);
        if (!id) {
            invalidTokens.push(line);
            continue;
        }
        identities.push(id);
    }
    if (identities.length < 2) {
        if (invalidTokens.length > 0) {
            errors.push(`Invalid tokens (cannot canonicalize): ${invalidTokens.join(", ")}`);
        }
        errors.push("At least two valid assets are required to form a pair.");
        return failResult(errors, invalidTokens, []);
    }

    // --- Cross-provider alias collisions ---------------------------------
    const aliasCollisions = detectAliasCollisions(identities);
    if (aliasCollisions.length > 0) {
        for (const c of aliasCollisions) {
            errors.push(
                `Alias collision on scoring asset ${c.scoringAsset}: tokens ${c.tokens.join(", ")} map to different providers. Pick one data source.`,
            );
        }
        return failResult(errors, invalidTokens, aliasCollisions);
    }

    // --- Dedupe within-provider aliases (BTC / BTCUSDT) ------------------
    const deduped = dedupeWithinProviderAliases(identities);
    if (deduped.length < 2) {
        errors.push("After collapsing same-provider aliases, fewer than two distinct assets remain.");
        return failResult(errors, invalidTokens, aliasCollisions);
    }

    // --- Sort + seeded permutation ---------------------------------------
    // Sort canonical assets deterministically so the same asset set + options
    // is invariant to input order, then apply one seeded Fisher-Yates to
    // assign the shared permutated order used by relationship generation AND
    // orientation. Asset name and input order are NEVER tie-breaks.
    const sorted = [...deduped].sort(compareCanonical);
    const shuffled = seededPermutation(sorted, effectiveSeed);

    // --- Relationship generation (capped, degree-balanced) ---------------
    const candidatePairCount = (shuffled.length * (shuffled.length - 1)) / 2;
    const cap = Math.min(effectiveMaxPairs, BALANCED_PAIR_LIST_MAX_PAIRS, candidatePairCount);
    const relationships = generateRelationships(shuffled.length, cap);
    if (relationships.length === 0) {
        errors.push("Internal failure: relationship generation produced zero pairs.");
        return failResult(errors, invalidTokens, aliasCollisions);
    }

    // --- Balanced orientation (Euler-tour on augmented graph) ------------
    const oriented = orientRelationships(shuffled, relationships);

    // --- Verify invariants -----------------------------------------------
    const invariantCheck = verifyInvariants(shuffled, relationships, oriented);
    if (!invariantCheck.ok) {
        errors.push(...invariantCheck.errors);
        return failResult(errors, invalidTokens, aliasCollisions);
    }

    // --- Build emitted pair strings + degree maps ------------------------
    const pairs: string[] = oriented.map((r) => `${r.base.emittedToken}+${r.quote.emittedToken}`);
    // Ensure the emitted list is in normalizeBatchSymbols order so the
    // server-side hash matches what the Batch textarea would produce after
    // a round-trip through parseBatchSymbols.
    const normalizedEmitted = normalizeBatchSymbols(pairs.join("\n"));
    if (normalizedEmitted.length !== pairs.length) {
        // Defensive: a duplicate or empty slug crept in. Surface loudly.
        errors.push("Internal failure: emitted pair list contains a duplicate or empty slug.");
        return failResult(errors, invalidTokens, aliasCollisions);
    }

    const degreeByAsset: Record<string, number> = {};
    const baseDegreeByAsset: Record<string, number> = {};
    const quoteDegreeByAsset: Record<string, number> = {};
    for (const id of shuffled) {
        degreeByAsset[id.scoringAsset] = 0;
        baseDegreeByAsset[id.scoringAsset] = 0;
        quoteDegreeByAsset[id.scoringAsset] = 0;
    }
    for (const r of oriented) {
        degreeByAsset[r.base.scoringAsset]! += 1;
        degreeByAsset[r.quote.scoringAsset]! += 1;
        baseDegreeByAsset[r.base.scoringAsset]! += 1;
        quoteDegreeByAsset[r.quote.scoringAsset]! += 1;
    }
    const degrees = Object.values(degreeByAsset);
    const orientationImbalanceMax = Math.max(
        ...shuffled.map((id) => Math.abs(baseDegreeByAsset[id.scoringAsset]! - quoteDegreeByAsset[id.scoringAsset]!)),
    );

    // --- Provenance hashes -----------------------------------------------
    const canonicalAssetListHash = hashCanonicalAssetList(shuffled);
    const emittedPairListHash = hashEmittedPairList(normalizedEmitted);
    const omittedPairCount = Math.max(0, candidatePairCount - oriented.length);

    if (invalidTokens.length > 0) {
        warnings.push(`Skipped invalid tokens: ${invalidTokens.join(", ")}`);
    }
    if (omittedPairCount > 0) {
        warnings.push(`Capped at ${oriented.length} of ${candidatePairCount} candidate relationships.`);
    }

    const provenance: PairListProvenanceV1 = {
        schema: "batch.pair_list.v1",
        algorithm: "seeded_round_robin_v1",
        effectiveSeed,
        effectiveMaxPairs: cap,
        canonicalAssetListHash,
        emittedPairListHash,
        assetCount: shuffled.length,
        pairCount: oriented.length,
        degree: {
            min: degrees.length ? Math.min(...degrees) : 0,
            median: medianSorted([...degrees].sort((a, b) => a - b)),
            max: degrees.length ? Math.max(...degrees) : 0,
        },
        orientationImbalanceMax,
    };

    return {
        ok: true,
        canonicalAssets: shuffled,
        pairs: normalizedEmitted,
        candidatePairCount,
        omittedPairCount,
        effectiveSeed,
        effectiveMaxPairs: cap,
        degreeByAsset,
        baseDegreeByAsset,
        quoteDegreeByAsset,
        invalidTokens,
        aliasCollisions,
        provenance,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Helpers — option normalization
// ---------------------------------------------------------------------------

function normalizeSeed(seed: number | undefined): number {
    if (seed === undefined || !Number.isFinite(seed)) return 1;
    return (Math.floor(seed) >>> 0) || 1;
}

function normalizeMaxPairs(maxPairs: number | undefined): number {
    if (maxPairs === undefined || !Number.isFinite(maxPairs)) return BALANCED_PAIR_LIST_MAX_PAIRS;
    return Math.max(1, Math.min(BALANCED_PAIR_LIST_MAX_PAIRS, Math.floor(maxPairs)));
}

// ---------------------------------------------------------------------------
// Helpers — canonical sort + seeded permutation
// ---------------------------------------------------------------------------

function compareCanonical(a: CanonicalLegIdentity, b: CanonicalLegIdentity): number {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.loaderSymbol !== b.loaderSymbol) return a.loaderSymbol < b.loaderSymbol ? -1 : 1;
    return a.scoringAsset < b.scoringAsset ? -1 : a.scoringAsset > b.scoringAsset ? 1 : 0;
}

/**
 * Fisher-Yates shuffle on a COPY of the input, using the project's shared
 * `createSeededRandom` so the permutated asset order is reproducible across
 * the generator and any consumer that mirrors the rule. The original array
 * is not mutated.
 */
function seededPermutation<T>(items: readonly T[], seed: number): T[] {
    const out = [...items];
    const rand = createSeededRandom(seed);
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        if (j !== i) {
            const tmp = out[i]!;
            out[i] = out[j]!;
            out[j] = tmp;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Relationship generation
// ---------------------------------------------------------------------------

interface Relationship {
    aIdx: number;
    bIdx: number;
}

/**
 * Generate at most `cap` undirected relationships covering every asset
 * evenly. Uses the circle method (even N) or the Walecki Hamiltonian-cycle
 * decomposition (odd N). The cap is split into full rounds/cycles plus at
 * most ONE partial round/cycle, so the emitted subset is degree-balanced.
 */
function generateRelationships(n: number, cap: number): Relationship[] {
    if (n < 2 || cap <= 0) return [];
    return n % 2 === 0 ? emitEvenCircle(n, cap) : emitOddWalecki(n, cap);
}

/**
 * Even-N circle method. N-1 rounds, each a disjoint perfect matching of N/2
 * pairs. The cap is split into `fullRounds = floor(cap / (N/2))` complete
 * rounds plus at most one partial round of `partial = cap - fullRounds*N/2`
 * disjoint pairs. Mid-round emission keeps degree max-min <= 1 because each
 * partial pair touches two previously-untouched-in-this-round vertices.
 */
function emitEvenCircle(n: number, cap: number): Relationship[] {
    const out: Relationship[] = [];
    const pairsPerRound = n / 2;
    const rounds = n - 1;
    const fullRounds = Math.min(rounds, Math.floor(cap / pairsPerRound));
    const partial = cap - fullRounds * pairsPerRound;

    const positions = Array.from({ length: n }, (_, i) => i);
    for (let r = 0; r < fullRounds; r += 1) {
        for (let i = 0; i < pairsPerRound; i += 1) {
            out.push({ aIdx: positions[i]!, bIdx: positions[n - 1 - i]! });
        }
        rotateClockwise(positions);
    }
    // Partial round: emit `partial` disjoint pairs of the next round.
    if (partial > 0 && fullRounds < rounds) {
        for (let i = 0; i < partial; i += 1) {
            out.push({ aIdx: positions[i]!, bIdx: positions[n - 1 - i]! });
        }
    }
    return out;
}

/** Rotate `arr[1..]` one step clockwise: last -> arr[1], others shift right. */
function rotateClockwise(arr: number[]): void {
    if (arr.length <= 2) return;
    const last = arr[arr.length - 1]!;
    for (let i = arr.length - 1; i > 1; i -= 1) arr[i] = arr[i - 1]!;
    arr[1] = last;
}

/**
 * Odd-N (N=2m+1) Walecki Hamiltonian-cycle decomposition. Asset 0 is `∞`;
 * the remaining 2m positions are taken modulo 2m. Cycle i (i=0..m-1) walks
 *   `∞, i, i-1, i+1, i-2, i+2, ..., i-m, ∞`
 * producing 2m+1 edges (a Hamiltonian cycle on N vertices). The m cycles
 * partition all N*(N-1)/2 edges of K_n.
 *
 * The cap is split into `fullCycles = floor(cap / (2m+1))` complete cycles
 * plus at most one partial cycle. The partial-cycle emission follows the
 * plan's non-adjacent rule so the resulting subset stays degree-balanced:
 *   - The non-adjacent edge sequence of a cycle is the edges at EVEN indices
 *     [0, 2, ..., 2m] (m+1 edges).
 *   - For a partial cycle of `r <= m` edges: emit even-indexed edges
 *     0, 2, ..., 2(r-1).
 *   - For `r > m`: emit the whole cycle EXCEPT the first N-r edges from
 *     the same non-adjacent sequence.
 */
function emitOddWalecki(n: number, cap: number): Relationship[] {
    const m = (n - 1) / 2;
    const edgesPerCycle = 2 * m + 1;
    const fullCycles = Math.min(m, Math.floor(cap / edgesPerCycle));
    const partial = cap - fullCycles * edgesPerCycle;
    const out: Relationship[] = [];
    for (let i = 0; i < fullCycles; i += 1) {
        const edges = buildWaleckyCycleEdges(n, m, i);
        for (const [a, b] of edges) out.push({ aIdx: a, bIdx: b });
    }
    if (partial > 0 && fullCycles < m) {
        const edges = buildWaleckyCycleEdges(n, m, fullCycles);
        const picked = pickPartialCycleEdges(edges, n, partial);
        for (const [a, b] of picked) out.push({ aIdx: a, bIdx: b });
    }
    return out;
}

/**
 * Build the edge list of Walecki cycle i. The vertex walk is
 *   ∞, i, i-1, i+1, i-2, i+2, ..., i-(m-1), i+(m-1), i-m, ∞
 * (length 2m+2), producing 2m+1 edges.
 */
function buildWaleckyCycleEdges(n: number, m: number, i: number): Array<[number, number]> {
    void n;
    const mod = 2 * m;
    const inf = 0;
    const assetAt = (p: number): number => 1 + ((p % mod) + mod) % mod;
    const walk: number[] = [inf];
    walk.push(assetAt(i));
    for (let k = 1; k < m; k += 1) {
        walk.push(assetAt(i - k));
        walk.push(assetAt(i + k));
    }
    walk.push(assetAt(i - m));
    walk.push(inf);
    const edges: Array<[number, number]> = [];
    for (let k = 0; k + 1 < walk.length; k += 1) {
        edges.push([walk[k]!, walk[k + 1]!]);
    }
    return edges;
}

/**
 * Pick `r` edges from a Walecki cycle per the plan's non-adjacent rule.
 * See {@link emitOddWalecki} for the rule.
 */
function pickPartialCycleEdges(
    edges: ReadonlyArray<[number, number]>,
    n: number,
    r: number,
): Array<[number, number]> {
    const m = (n - 1) / 2;
    const evenIdxSeq: number[] = [];
    for (let k = 0; k <= m; k += 1) evenIdxSeq.push(2 * k);
    const evenIdxSet = new Set(evenIdxSeq);

    if (r <= m) {
        // Emit the first r even-indexed edges: indices 0, 2, ..., 2(r-1).
        return evenIdxSeq.slice(0, r).map((idx) => edges[idx]!);
    }
    // r > m: emit the whole cycle EXCEPT the first N-r even-indexed edges.
    const removeCount = n - r;
    const removed = new Set(evenIdxSeq.slice(0, removeCount));
    const picked: Array<[number, number]> = [];
    for (let k = 0; k < edges.length; k += 1) {
        if (evenIdxSet.has(k) && removed.has(k)) continue;
        picked.push(edges[k]!);
    }
    return picked;
}

// ---------------------------------------------------------------------------
// Balanced orientation (Euler-tour on augmented graph)
// ---------------------------------------------------------------------------

interface OrientedRelationship {
    base: CanonicalLegIdentity;
    quote: CanonicalLegIdentity;
}

/**
 * Deterministic balanced orientation of an undirected graph.
 *
 * Algorithm:
 *   1. Pair odd-degree vertices inside each connected component (shuffled
 *      asset-index order). Add dummy edges between pairs so every vertex
 *      has even degree and the augmented graph is Eulerian.
 *   2. Run Hierholzer's algorithm with edges traversed in RELATIONSHIP-INDEX
 *      order (deterministic; not asset order or insertion order). Dummy
 *      edges are picked after real edges at each vertex.
 *   3. Orient every REAL edge along the tour direction; discard dummy edges.
 *
 * After this, every vertex's in-degree and out-degree differ by at most one
 * (the Euler-tour property on a balanced graph).
 */
function orientRelationships(
    assets: readonly CanonicalLegIdentity[],
    relationships: readonly Relationship[],
): OrientedRelationship[] {
    if (relationships.length === 0) return [];

    interface AdjEdge { to: number; relIdx: number; isDummy: boolean; }
    const adj: AdjEdge[][] = assets.map(() => []);
    const realConsumed = new Array<boolean>(relationships.length).fill(false);
    const dummyConsumed = new Set<string>();
    const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

    relationships.forEach((r, idx) => {
        adj[r.aIdx]!.push({ to: r.bIdx, relIdx: idx, isDummy: false });
        adj[r.bIdx]!.push({ to: r.aIdx, relIdx: idx, isDummy: false });
    });

    // Pair odd-degree vertices inside each connected component.
    const componentOf = findComponents(assets.length, relationships);
    const oddByComponent = new Map<number, number[]>();
    for (let v = 0; v < assets.length; v += 1) {
        if (adj[v]!.length % 2 === 1) {
            const c = componentOf[v]!;
            let bucket = oddByComponent.get(c);
            if (!bucket) { bucket = []; oddByComponent.set(c, bucket); }
            bucket.push(v);
        }
    }
    for (const bucket of oddByComponent.values()) {
        for (let i = 0; i + 1 < bucket.length; i += 2) {
            const a = bucket[i]!;
            const b = bucket[i + 1]!;
            adj[a]!.push({ to: b, relIdx: -1, isDummy: true });
            adj[b]!.push({ to: a, relIdx: -1, isDummy: true });
        }
    }

    // Sort each adjacency bucket: real edges first (by relIdx asc), then
    // dummy edges (by `to` asc). This makes Hierholzer deterministic.
    for (const bucket of adj) {
        bucket.sort((x, y) => {
            if (x.isDummy && !y.isDummy) return 1;
            if (!x.isDummy && y.isDummy) return -1;
            if (x.isDummy && y.isDummy) return x.to - y.to;
            return x.relIdx - y.relIdx;
        });
    }

    // Iterative Hierholzer. Record each real edge's tour orientation.
    const orientationByRelIdx = new Map<number, { from: number; to: number }>();
    const ptr = new Array<number>(assets.length).fill(0);
    const stack: number[] = [0];
    while (stack.length > 0) {
        const v = stack[stack.length - 1]!;
        let found = -1;
        while (ptr[v]! < adj[v]!.length) {
            const e = adj[v]![ptr[v]!];
            if (e.isDummy) {
                if (dummyConsumed.has(edgeKey(v, e.to))) {
                    ptr[v]! += 1;
                    continue;
                }
            } else if (realConsumed[e.relIdx]!) {
                ptr[v]! += 1;
                continue;
            }
            found = ptr[v]!;
            break;
        }
        if (found < 0) {
            stack.pop();
            continue;
        }
        const e = adj[v]![found]!;
        ptr[v]! += 1;
        if (e.isDummy) {
            dummyConsumed.add(edgeKey(v, e.to));
        } else {
            realConsumed[e.relIdx] = true;
            orientationByRelIdx.set(e.relIdx, { from: v, to: e.to });
        }
        stack.push(e.to);
    }

    const out: OrientedRelationship[] = [];
    relationships.forEach((r, idx) => {
        const o = orientationByRelIdx.get(idx);
        if (!o) {
            // Defensive fallback: the tour missed this edge (cannot happen on
            // a balanced connected graph). Use natural (aIdx -> bIdx).
            out.push({ base: assets[r.aIdx]!, quote: assets[r.bIdx]! });
            return;
        }
        const from = o.from === r.aIdx ? assets[r.aIdx]! : assets[r.bIdx]!;
        const to = o.from === r.aIdx ? assets[r.bIdx]! : assets[r.aIdx]!;
        out.push({ base: from, quote: to });
    });
    return out;
}

/** Union-find connected components of an undirected graph. */
function findComponents(n: number, relationships: readonly Relationship[]): number[] {
    const parent = new Array<number>(n).fill(0).map((_, i) => i);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]]!;
            x = parent[x]!;
        }
        return x;
    };
    for (const r of relationships) {
        const ra = find(r.aIdx);
        const rb = find(r.bIdx);
        if (ra !== rb) parent[ra] = rb;
    }
    return parent.map((_, i) => find(i));
}

// ---------------------------------------------------------------------------
// Invariant verification
// ---------------------------------------------------------------------------

function verifyInvariants(
    assets: readonly CanonicalLegIdentity[],
    relationships: readonly Relationship[],
    oriented: readonly OrientedRelationship[],
): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (oriented.length !== relationships.length) {
        errors.push(`Orientation produced ${oriented.length} pairs from ${relationships.length} relationships.`);
    }
    // Submitted degree max-min <= 1.
    const degree = new Array<number>(assets.length).fill(0);
    for (const r of relationships) {
        degree[r.aIdx]! += 1;
        degree[r.bIdx]! += 1;
    }
    const degValues = degree.filter((d) => d > 0);
    if (degValues.length > 0) {
        const dMin = Math.min(...degValues);
        const dMax = Math.max(...degValues);
        if (dMax - dMin > 1) {
            errors.push(`Submitted degree invariant violated: max=${dMax}, min=${dMin} (must be within 1).`);
        }
    }
    // Per-asset base/quote imbalance <= 1.
    const baseDeg = new Array<number>(assets.length).fill(0);
    const quoteDeg = new Array<number>(assets.length).fill(0);
    for (const r of oriented) {
        const bi = assets.indexOf(r.base);
        const qi = assets.indexOf(r.quote);
        if (bi >= 0) baseDeg[bi]! += 1;
        if (qi >= 0) quoteDeg[qi]! += 1;
    }
    let worstImbalance = 0;
    for (let i = 0; i < assets.length; i += 1) {
        const imb = Math.abs(baseDeg[i]! - quoteDeg[i]!);
        if (imb > worstImbalance) worstImbalance = imb;
    }
    if (worstImbalance > 1) {
        errors.push(`Orientation imbalance invariant violated: max abs(base-quote)=${worstImbalance} (must be <= 1).`);
    }
    return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/**
 * Asset-list hash: sorted newline-delimited `provider|loaderSymbol|scoringAsset`.
 * Sorted so the hash is invariant to input order.
 */
function hashCanonicalAssetList(assets: readonly CanonicalLegIdentity[]): string {
    const lines = [...assets]
        .map((a) => `${a.provider}|${a.loaderSymbol}|${a.scoringAsset}`)
        .sort()
        .join("\n");
    return fnv1a64Hex(lines);
}

/**
 * Emitted-pair-list hash: the newline-delimited, order-preserving output of
 * `normalizeBatchSymbols(pairs)`. The server recomputes this with the same
 * normalization so the two sides agree on what was submitted.
 */
function hashEmittedPairList(normalizedPairs: readonly string[]): string {
    return fnv1a64Hex(normalizedPairs.join("\n"));
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function medianSorted(sortedAsc: number[]): number {
    if (sortedAsc.length === 0) return 0;
    const mid = sortedAsc.length >> 1;
    return sortedAsc.length % 2 === 1
        ? sortedAsc[mid]!
        : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function failResult(errors: string[], invalidTokens: string[], aliasCollisions: AliasCollision[]): BalancedPairListResult {
    return { ok: false, errors, invalidTokens, aliasCollisions };
}
