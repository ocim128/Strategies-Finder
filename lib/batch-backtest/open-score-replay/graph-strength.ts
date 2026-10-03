import { FINDER_CAUSAL_ARMS_V1 as DEFINITIONS } from "./causal-arm-constants";
import { yieldLoop } from "./runtime";

export interface GraphEdge { base: number; quote: number; vote: number; count: number }
export interface GraphStrengthResult { scores: Map<number, number>; component: Set<number>; failed: boolean }

/** One equally weighted observation per active pair identity, including net-zero edges. */
export async function scoreGraphStrength(names: readonly string[], input: readonly GraphEdge[], shouldStop: () => boolean = () => false,
    maxIterations: number = DEFINITIONS.graphMaxIterations): Promise<GraphStrengthResult> {
    const check = (): void => { if (shouldStop()) throw new Error("OPEN_SCORE USD replay cancelled during graph solve."); };
    check();
    const edges = input.filter((edge) => edge.count > 0).map((edge) => names[edge.base]! < names[edge.quote]!
        ? edge : { base: edge.quote, quote: edge.base, vote: -edge.vote, count: edge.count })
        .sort((a, b) => names[a.base]!.localeCompare(names[b.base]!) || names[a.quote]!.localeCompare(names[b.quote]!) || a.vote / a.count - b.vote / b.count);
    const neighbors = new Map<number, number[]>();
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i]!;
        for (const [a, b] of [[edge.base, edge.quote], [edge.quote, edge.base]]) {
            let list = neighbors.get(a!); if (!list) neighbors.set(a!, list = []); list.push(b!);
        }
        if (i % 2000 === 0) { await yieldLoop(); check(); }
    }
    const visited = new Set<number>();
    let vertices: number[] = [];
    for (const start of [...neighbors.keys()].sort((a, b) => names[a]!.localeCompare(names[b]!))) {
        if (visited.has(start)) continue;
        const component = [start]; visited.add(start);
        for (let i = 0; i < component.length; i++) {
            for (const next of neighbors.get(component[i]!)!) if (!visited.has(next)) { visited.add(next); component.push(next); }
            if (i % 2000 === 0) { await yieldLoop(); check(); }
        }
        component.sort((a, b) => names[a]!.localeCompare(names[b]!));
        if (component.length > vertices.length || component.length === vertices.length
            && JSON.stringify(component.map((i) => names[i])) < JSON.stringify(vertices.map((i) => names[i]))) vertices = component;
    }
    const component = new Set(vertices);
    const failure = (): GraphStrengthResult => ({ scores: new Map(), component, failed: true });
    if (!vertices.length) return { scores: new Map(), component, failed: false };
    const local = new Map(vertices.map((v, i) => [v, i]));
    const selected = edges.filter((edge) => component.has(edge.base)).map((edge) => ({ a: local.get(edge.base)!, b: local.get(edge.quote)!, y: edge.vote / edge.count }));
    if (selected.some((edge) => !Number.isFinite(edge.y))) return failure();
    const n = vertices.length;
    const rhs = new Float64Array(n), diagonal = new Float64Array(n);
    for (const edge of selected) { rhs[edge.a] += edge.y; rhs[edge.b] -= edge.y; diagonal[edge.a]++; diagonal[edge.b]++; }
    rhs[0] = 0; // Lexicographically first vertex anchored at zero.
    const multiply = async (x: Float64Array): Promise<Float64Array> => {
        const result = new Float64Array(n);
        for (let i = 0; i < selected.length; i++) {
            const edge = selected[i]!, d = x[edge.a]! - x[edge.b]!;
            result[edge.a] += d; result[edge.b] -= d;
            if (i > 0 && i % 2000 === 0) { await yieldLoop(); check(); }
        }
        result[0] = 0; return result;
    };
    const dot = (a: Float64Array, b: Float64Array): number => { let sum = 0; for (let i = 1; i < n; i++) sum += a[i]! * b[i]!; return sum; };
    const x = new Float64Array(n), r = rhs.slice(), z = new Float64Array(n), p = new Float64Array(n);
    const norm = Math.sqrt(dot(rhs, rhs));
    if (norm !== 0) {
        for (let i = 1; i < n; i++) p[i] = z[i] = r[i]! / diagonal[i]!;
        let rz = dot(r, z), converged = false;
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            if (iteration % 16 === 0) { await yieldLoop(); check(); }
            const ap = await multiply(p), denominator = dot(p, ap);
            if (!(denominator > 0) || !Number.isFinite(denominator)) return failure();
            const alpha = rz / denominator;
            for (let i = 1; i < n; i++) { x[i] += alpha * p[i]!; r[i] -= alpha * ap[i]!; }
            if (Math.sqrt(dot(r, r)) <= DEFINITIONS.graphResidualTolerance * norm) {
                // Verify the actual residual, not just the recursively updated one.
                const ax = await multiply(x);
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
