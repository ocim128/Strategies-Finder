import { expect } from "chai";
import { describe, it } from "node:test";
import { buildSync } from "esbuild";

/**
 * Locks the documented Vite-config bundle trap (AGENTS.md "Server-side import
 * hygiene"): anything imported by `vite.config.ts` (transitively) is bundled
 * by esbuild for the Node dev server, and any module that reaches
 * `lightweight-charts` — which is ESM-only — breaks the CJS config bundle with
 * `Failed to resolve "lightweight-charts". This package is ESM only but it was
 * tried to load by require`.
 *
 * The Finder Asset Opportunity server path (`finder-vite-plugin` ->
 * `finder-asset-opportunity-runner`) is verified safe here, so the parallel
 * `runServerAssetIsSearch` leaf must not be mistaken for a bundle-safety
 * requirement (see the module headers). If a future import re-introduces the
 * trap, this test fails in CI instead of at dev-server startup.
 */
describe("vite.config.ts bundle hygiene", () => {
    it("bundles the Vite config without a lightweight-charts ESM-only resolution error", () => {
        const result = buildSync({
            entryPoints: ["vite.config.ts"],
            bundle: true,
            platform: "node",
            format: "cjs",
            write: false,
            logLevel: "silent",
            external: ["vite"],
        });
        const fatal = result.errors.filter((error) =>
            /lightweight-charts/.test(error.text)
            && /ESM only|Failed to resolve/i.test(error.text),
        );
        expect(
            fatal,
            result.errors.length > 0
                ? `vite.config.ts bundle failed:\n${result.errors.map((error) => error.text).join("\n")}`
                : undefined,
        ).to.deep.equal([]);
    });
});
