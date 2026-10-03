import { FINDER_CAUSAL_ARMS_V1 as DEFINITIONS } from "./causal-arm-constants";

export interface GraphEdge { base: number; quote: number; vote: number; count: number }
export interface GraphStrengthResult { scores: Map<number, number>; component: Set<number>; failed: boolean }

/**
 * Integer ranks derived from the SAME `localeCompare` order the original
 * string sorts used, so integer-rank sorting reproduces the previous ordering
 * exactly while dropping per-comparison string collation. Built once per
 * sweep (asset names are fixed) and passed into every solve.
 */
export function buildNameRanks(names: readonly string[]): Int32Array {
    const order = names.map((_, i) => i).sort((a, b) => names[a]!.localeCompare(names[b]!));
    const ranks = new Int32Array(names.length);
    order.forEach((assetIndex, position) => { ranks[assetIndex] = position; });
    return ranks;
}

/**
 * One equally weighted observation per active pair identity, including net-zero edges.
 *
 * Performance contract (the causal-arm graph solve used to dominate the event
 * sweep): sorts use the caller-provided integer name ranks instead of
 * per-comparison `localeCompare`, the conjugate-gradient loop runs without
 * inner event-loop yields (the sweep checks `shouldStop` per bucket and the
 * entry check remains), scratch vectors are reused across iterations, and
 * every solve stays cold. Every ordering derives from the
 * same comparisons the original implementation performed, so results are
 * unchanged.
 */
export async function scoreGraphStrength(
    names: readonly string[],
    input: readonly GraphEdge[],
    shouldStop: () => boolean = () => false,
    maxIterations: number = DEFINITIONS.graphMaxIterations,
    nameRanks?: Int32Array,
): Promise<GraphStrengthResult> {
    const check = (): void => { if (shouldStop()) throw new Error("OPEN_SCORE USD replay cancelled during graph solve."); };
    check();
    const ranks = nameRanks ?? buildNameRanks(names);
    // Orientation normalization keeps the ORIGINAL codepoint comparison AND
    // the original sign flip verbatim: the vote is directional (base minus
    // quote), so flipping the edge flips its vote.
    const edges: Array<{ a: number; b: number; y: number }> = [];
    for (let i = 0; i < input.length; i++) {
        const edge = input[i]!;
        if (edge.count <= 0) continue;
        const [a, b, y] = names[edge.base]! < names[edge.quote]!
            ? [edge.base, edge.quote, edge.vote / edge.count]
            : [edge.quote, edge.base, -edge.vote / edge.count];
        edges.push({ a, b, y });
    }
    edges.sort((x, y) => ranks[x.a]! - ranks[y.a]! || ranks[x.b]! - ranks[y.b]! || x.y - y.y);
    const neighbors = new Map<number, number[]>();
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i]!;
        for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
            let list = neighbors.get(a!); if (!list) neighbors.set(a!, list = []); list.push(b!);
        }
    }
    const visited = new Set<number>();
    let vertices: number[] = [];
    const rankSequenceLess = (a: number[], b: number[]): boolean => {
        const shared = Math.min(a.length, b.length);
        for (let i = 0; i < shared; i++) {
            if (ranks[a[i]!] !== ranks[b[i]!]) return ranks[a[i]!]! < ranks[b[i]!]!;
        }
        return a.length < b.length;
    };
    for (const start of [...neighbors.keys()].sort((a, b) => ranks[a]! - ranks[b]!)) {
        if (visited.has(start)) continue;
        const component = [start]; visited.add(start);
        for (let i = 0; i < component.length; i++) {
            for (const next of neighbors.get(component[i]!)!) if (!visited.has(next)) { visited.add(next); component.push(next); }
        }
        component.sort((a, b) => ranks[a]! - ranks[b]!);
        if (component.length > vertices.length || component.length === vertices.length
            && rankSequenceLess(component, vertices)) vertices = component;
    }
    const component = new Set(vertices);
    const failure = (): GraphStrengthResult => ({ scores: new Map(), component, failed: true });
    if (!vertices.length) return { scores: new Map(), component, failed: false };
    const local = new Map(vertices.map((v, i) => [v, i]));
    const selected = edges.filter((edge) => component.has(edge.a)).map((edge) => ({ a: local.get(edge.a)!, b: local.get(edge.b)!, y: edge.y }));
    if (selected.some((edge) => !Number.isFinite(edge.y))) return failure();
    const n = vertices.length;
    // The CG loop visits these same edges up to 500 times. Pack endpoints
    // once, preserving sorted edge order and every floating-point operation.
    const edgeA = new Uint32Array(selected.length), edgeB = new Uint32Array(selected.length);
    for (let i = 0; i < selected.length; i++) { edgeA[i] = selected[i]!.a; edgeB[i] = selected[i]!.b; }
    const rhs = new Float64Array(n), diagonal = new Float64Array(n);
    for (const edge of selected) { rhs[edge.a] += edge.y; rhs[edge.b] -= edge.y; diagonal[edge.a]++; diagonal[edge.b]++; }
    rhs[0] = 0; // Lexicographically first vertex anchored at zero.
    const multiply = (out: Float64Array, vec: Float64Array): void => {
        out.fill(0);
        for (let i = 0; i < edgeA.length; i++) {
            const a = edgeA[i]!, b = edgeB[i]!, d = vec[a]! - vec[b]!;
            out[a] += d; out[b] -= d;
        }
        out[0] = 0; return;
    };
    const dot = (a: Float64Array, b: Float64Array): number => { let sum = 0; for (let i = 1; i < n; i++) sum += a[i]! * b[i]!; return sum; };
    const x = new Float64Array(n), r = rhs.slice(), z = new Float64Array(n), p = new Float64Array(n);
    const ap = new Float64Array(n), ax = new Float64Array(n);
    const norm = Math.sqrt(dot(rhs, rhs));
    if (norm !== 0) {
        for (let i = 1; i < n; i++) p[i] = z[i] = r[i]! / diagonal[i]!;
        let rz = dot(r, z), converged = false;
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            multiply(ap, p);
            const denominator = dot(p, ap);
            if (!(denominator > 0) || !Number.isFinite(denominator)) return failure();
            const alpha = rz / denominator;
            for (let i = 1; i < n; i++) { x[i] += alpha * p[i]!; r[i] -= alpha * ap[i]!; }
            if (Math.sqrt(dot(r, r)) <= DEFINITIONS.graphResidualTolerance * norm) {
                // Verify the actual residual, not just the recursively updated one.
                multiply(ax, x);
                for (let i = 1; i < n; i++) r[i] = rhs[i]! - ax[i]!;
                if (Math.sqrt(dot(r, r)) <= DEFINITIONS.graphResidualTolerance * norm) { converged = true; break; }
            }
            for (let i = 1; i < n; i++) z[i] = r[i]! / diagonal[i]!;
            const next = dot(r, z), beta = next / rz; rz = next;
            for (let i = 1; i < n; i++) p[i] = z[i]! + beta * p[i]!;
        }
        if (!converged) return failure();
    }
    let mean = 0; for (const value of x) mean += value / n;
    const scores = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        const score = Math.round((x[i]! - mean) / DEFINITIONS.graphRankingPrecision) * DEFINITIONS.graphRankingPrecision;
        if (!Number.isFinite(score)) return failure(); scores.set(vertices[i]!, score === 0 ? 0 : score);
    }
    return { scores, component, failed: false };
}
