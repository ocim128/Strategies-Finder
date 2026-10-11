import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

// Called in-process rather than through a child process: spawning from inside the test runner
// is unreliable in this environment (`spawnSync ... EBUSY`), and the guard is deliberately
// written as an importable function so its logic can be verified directly.
const guard = require(path.join(root, "scripts/check-worktree-links.cjs")) as {
    checkWorktreeLinks: (p: string, o?: { unlink?: boolean }) => {
        status: number;
        log: string[];
        mainCheckout: string | null;
        links: Array<{ rel: string; target: string | null }>;
    };
    collectLinks: (root: string) => Array<{ rel: string; target: string | null }>;
    fingerprintDir: (p: string) => { ok: boolean; dirs: number; files: number; links: number; total: number };
    mainCheckoutFor: (p: string) => string | null;
};

/** Build a pretend main checkout plus a linked worktree inside a temp dir. */
function makeFixture(prefix: string) {
    const base = fs.mkdtempSync(path.join(root, "artifacts", prefix));
    const main = path.join(base, "main");
    const wt = path.join(base, "worktree");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "linked"), { recursive: true });
    fs.mkdirSync(path.join(main, "node_modules", "@types"), { recursive: true });
    fs.writeFileSync(path.join(main, "node_modules", "@types", "marker.txt"), "types\n");
    fs.mkdirSync(wt, { recursive: true });
    // A linked worktree has `.git` as a FILE pointing into the main checkout.
    fs.writeFileSync(
        path.join(wt, ".git"),
        `gitdir: ${path.join(main, ".git", "worktrees", "linked").replace(/\\/g, "/")}\n`,
    );
    return { base, main, wt };
}

function tryJunction(linkPath: string, target: string): boolean {
    // Creating a link may be refused on a locked-down host, so tests that need one skip
    // rather than fail. The pure-logic tests below need no privileges.
    try {
        fs.symlinkSync(target, linkPath, "junction");
        return true;
    } catch {
        try {
            fs.symlinkSync(target, linkPath, "dir");
            return true;
        } catch {
            return false;
        }
    }
}

describe("worktree link guard", () => {
    it("resolves the main checkout from a linked worktree's .git file", () => {
        const { base, main, wt } = makeFixture("worktree-guard-main-");
        try {
            assert.equal(
                path.resolve(guard.mainCheckoutFor(wt) ?? ""),
                path.resolve(main),
                "a linked worktree must resolve to its main checkout",
            );
            assert.equal(
                path.resolve(guard.mainCheckoutFor(main) ?? ""),
                path.resolve(main),
                "the main checkout resolves to itself",
            );
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("reports a clean worktree as safe to remove", () => {
        const { base, wt } = makeFixture("worktree-guard-clean-");
        try {
            const report = guard.checkWorktreeLinks(wt);
            assert.equal(report.status, 0, report.log.join("\n"));
            assert.ok(report.log.some((l) => /Links\s*:\s*0/.test(l)));
            assert.ok(report.log.some((l) => l.startsWith("SAFE:")));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("refuses removal when a link escapes into the main checkout", () => {
        const { base, main, wt } = makeFixture("worktree-guard-escape-");
        try {
            const created = tryJunction(path.join(wt, "node_modules"), path.join(main, "node_modules"));
            if (!created) return; // host does not permit link creation

            const report = guard.checkWorktreeLinks(wt);
            assert.equal(report.status, 1, report.log.join("\n"));
            assert.ok(
                report.log.some((l) => l.includes("INTO-MAIN-CHECKOUT")),
                "the escaping link must be identified",
            );
            assert.ok(report.log.some((l) => l.includes("would delete the main checkout")));

            // Inspection must not modify anything.
            assert.ok(fs.existsSync(path.join(main, "node_modules", "@types", "marker.txt")));
            assert.ok(fs.existsSync(path.join(wt, "node_modules")));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("treats a link that resolves inside the worktree as internal, not escaping", () => {
        const { base, wt } = makeFixture("worktree-guard-internal-");
        try {
            const inner = path.join(wt, "real-deps");
            fs.mkdirSync(inner, { recursive: true });
            const created = tryJunction(path.join(wt, "link-to-inner"), inner);
            if (!created) return;

            const report = guard.checkWorktreeLinks(wt);
            assert.ok(
                !report.log.some((l) => l.includes("INTO-MAIN-CHECKOUT")),
                "an internal link must not be reported as escaping",
            );
            assert.ok(report.log.some((l) => l.includes("inside-this-worktree (safe)")));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("removes an escaping link and proves the main checkout survived", () => {
        const { base, main, wt } = makeFixture("worktree-guard-unlink-");
        try {
            const created = tryJunction(path.join(wt, "node_modules"), path.join(main, "node_modules"));
            if (!created) return;

            const before = guard.fingerprintDir(path.join(main, "node_modules"));
            const report = guard.checkWorktreeLinks(wt, { unlink: true });

            assert.equal(report.status, 0, report.log.join("\n"));
            assert.ok(report.log.some((l) => l.startsWith("unlinked")));
            assert.ok(
                report.log.some((l) => l.trim().startsWith("OK") && l.includes("node_modules")),
                "target integrity must be reported as OK",
            );

            // The link is gone, its target is intact, and a repeat inspection now passes.
            assert.equal(fs.existsSync(path.join(wt, "node_modules")), false);
            assert.ok(fs.existsSync(path.join(main, "node_modules", "@types", "marker.txt")));
            const after = guard.fingerprintDir(path.join(main, "node_modules"));
            assert.equal(after.total, before.total, "the main checkout must keep every entry");

            assert.equal(guard.checkWorktreeLinks(wt).status, 0);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("counts symlinked children as links so a removed link cannot go unnoticed", () => {
        // Regression guard for the original defect: plain readdirSync follows symlinks, so a
        // symlinked child looked like a real directory and its loss was invisible. The
        // fingerprint must therefore report link counts for the directory it actually scanned.
        const { base, main } = makeFixture("worktree-guard-links-");
        try {
            const typesDir = path.join(main, "node_modules", "@types");
            const created = tryJunction(path.join(typesDir, "nested-link"), typesDir);
            if (!created) return; // host does not permit link creation

            // Fingerprint the directory that DIRECTLY contains the link, not its parent.
            const fp = guard.fingerprintDir(typesDir);
            assert.equal(fp.ok, true);
            assert.equal(fp.links, 1, "a symlinked child must be counted as a link");
            assert.equal(
                fp.dirs + fp.files + fp.links,
                fp.total,
                "the fingerprint must account for every entry as dir, file, or link",
            );

            // A directory containing no links must report zero, so the count is meaningful.
            const clean = guard.fingerprintDir(path.join(main, "node_modules"));
            assert.equal(clean.links, 0);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("rejects a missing path with a distinct status", () => {
        const report = guard.checkWorktreeLinks(path.join(root, "artifacts", "definitely-not-here-xyz"));
        assert.equal(report.status, 2, "usage/path errors must be distinguishable from unsafe removals");
        assert.ok(report.log.some((l) => l.startsWith("MISSING worktree path")));
    });

    it("never descends into .git when collecting links", () => {
        const { base, wt } = makeFixture("worktree-guard-skip-");
        try {
            // Place a link inside .git; it must not be treated as a removable worktree link.
            const created = tryJunction(
                path.join(wt, ".git", "escaping-link"),
                path.join(base, "main"),
            );
            if (!created) return;
            const found = guard.collectLinks(wt);
            assert.ok(
                !found.some((l) => l.rel.includes(".git")),
                ".git internals must not be scanned",
            );
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});
