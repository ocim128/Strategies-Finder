import { expect } from "chai";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The bootstrap registry in lib/app-bootstrap.ts declares an ordered feature
// list with `dependsOn` edges and a `stage`. Within-stage ordering is already
// validated at runtime by assertBootstrapStageOrdering, but two latent risks
// are NOT runtime-checked:
//   1. a typo'd dependency id (e.g. "initial-ui-sync" when the real id is
//      "initialUiSync") silently resolves to undefined and is skipped
//      (the runtime loop uses `if (depIndex === undefined) continue;`)
//   2. a cross-stage dependency cycle (pre_restore <-> post_restore) is
//      explicitly allowed by the runtime check, so a cycle would not be caught
//
// We parse the registry source as text (same approach feature-dom-contracts
// uses for html-partials) rather than importing app-bootstrap, because
// app-bootstrap transitively imports the chart manager and the root
// lightweight-charts package, whose `exports` map has no CJS `require`
// condition and breaks under the esno test runner.

type FeatureShape = {
    id: string;
    stage: "pre_restore" | "post_restore";
    dependsOn: string[];
};

function parseFeatures(source: string): FeatureShape[] {
    const features: FeatureShape[] = [];
    // Locate the APP_BOOTSTRAP_FEATURES array body and walk its object literals.
    const start = source.indexOf("APP_BOOTSTRAP_FEATURES");
    if (start < 0) throw new Error("APP_BOOTSTRAP_FEATURES not found");
    const arrayStart = source.indexOf("[", start);
    const arrayEnd = source.indexOf("];", arrayStart);
    const body = source.slice(arrayStart, arrayEnd);

    const objectRe = /\{([\s\S]*?)\}/g;
    let match: RegExpExecArray | null;
    while ((match = objectRe.exec(body)) !== null) {
        const inner = match[1]!;
        const idMatch = /id:\s*"([^"]+)"/.exec(inner);
        if (!idMatch) continue;
        const stageMatch = /stage:\s*"([^"]+)"/.exec(inner);
        const dependsOnMatches = Array.from(
            inner.matchAll(/dependsOn:\s*\[([^\]]*)\]/g)
        );
        const deps = dependsOnMatches.flatMap((m) =>
            (m[1] ?? "")
                .split(",")
                .map((s) => s.trim().replace(/"/g, ""))
                .filter(Boolean)
        );
        features.push({
            id: idMatch[1]!,
            stage: (stageMatch?.[1] as FeatureShape["stage"]) ?? "pre_restore",
            dependsOn: deps,
        });
    }
    return features;
}

describe("bootstrap feature dependency graph", () => {
    const source = readFileSync(
        path.resolve(__dirname, "../lib/app-bootstrap.ts"),
        "utf8"
    );
    const features = parseFeatures(source);
    const ids = new Set(features.map((f) => f.id));
    const nodes = new Map(features.map((f) => [f.id, f]));

    it("parses every declared feature (guards against source-format drift)", () => {
        // Self-calibrating: the parser must extract exactly as many features as the
        // source declares via `id: "..."`. If the non-greedy brace regex silently
        // truncates an object (e.g. an `init: () => { ... }` callback placed before
        // `id`/`stage`/`dependsOn`), parsedCount drops below idCount and this fails.
        const idCount = (source.match(/id:\s*"([^"]+)"/g) ?? []).length;
        expect(
            features.length,
            `parsed ${features.length} features but source declares ${idCount} via id: "..." — parser likely truncated by nested braces`
        ).to.equal(idCount);
    });

    it("every dependsOn target resolves to a real feature id", () => {
        const dangling: string[] = [];
        for (const feature of features) {
            for (const dep of feature.dependsOn) {
                if (!ids.has(dep)) {
                    dangling.push(`${feature.id} -> ${dep} (no such feature id)`);
                }
            }
        }
        expect(
            dangling,
            `dangling dependsOn references would be silently skipped at startup: ${dangling.join("; ")}`
        ).to.deep.equal([]);
    });

    it("the combined cross-stage dependency graph is acyclic", () => {
        const state = new Map<string, "visiting" | "done">();
        const cycle: string[] = [];

        const visit = (id: string, path: string[]): boolean => {
            if (state.get(id) === "done") return false;
            if (state.get(id) === "visiting") {
                cycle.push(path.slice(path.indexOf(id)).concat(id).join(" -> "));
                return true;
            }
            state.set(id, "visiting");
            for (const dep of nodes.get(id)!.dependsOn) {
                if (ids.has(dep) && visit(dep, [...path, id])) return true;
            }
            state.set(id, "done");
            return false;
        };

        for (const id of ids) {
            if (!state.has(id)) visit(id, []);
        }

        expect(
            cycle,
            `dependency cycle would deadlock or reorder startup: ${cycle.join("; ")}`
        ).to.deep.equal([]);
    });

    it("every feature declares a valid stage", () => {
        const invalid = features
            .filter((f) => f.stage !== "pre_restore" && f.stage !== "post_restore")
            .map((f) => `${f.id}: ${f.stage}`);
        expect(invalid, `features with unknown stage: ${invalid.join("; ")}`).to.deep.equal([]);
    });
});
