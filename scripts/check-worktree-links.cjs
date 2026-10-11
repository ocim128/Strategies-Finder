#!/usr/bin/env node
/**
 * Guard against destroying the main checkout's dependencies when removing a Git worktree.
 *
 * `git worktree remove` walks the working tree and dereferences directory junctions /
 * symlinks. When a worktree wires its dependencies in as a junction pointing at the main
 * checkout, removal therefore deletes the MAIN checkout's `node_modules` — silently, with
 * no error and a successful exit code. Removal visits the parent `node_modules` first,
 * which can also unlink the main checkout's own `node_modules/@types`.
 *
 * This script inspects a worktree before removal. It reports every reparse point and, by
 * default, refuses to authorize removal when any link resolves into another Git worktree.
 *
 * Usage:
 *   node scripts/check-worktree-links.cjs <worktree-path>          # inspect
 *   node scripts/check-worktree-links.cjs <worktree-path> --unlink # unlink links, then re-check
 *
 * Exit codes:
 *   0 — no links present, or links were successfully unlinked
 *   1 — links present and removal is unsafe (nothing was modified)
 *   2 — usage error or unreadable path
 */

const fs = require("node:fs");
const path = require("node:path");

/** Directory names that are never scanned for links (volume is large and irrelevant). */
const SKIP_DIRS = new Set([".git", ".cache", "dist", "node_modules/.vite"]);

/**
 * Resolve a junction/symlink target to an absolute path without following it.
 * Windows junctions expose the target through `fs.readlinkSync`, but it may be either
 * absolute or relative to the link's own directory.
 */
function resolveLinkTarget(linkPath) {
    let raw;
    try {
        raw = fs.readlinkSync(linkPath);
    } catch {
        return null;
    }
    if (path.isAbsolute(raw)) return path.normalize(raw);
    return path.resolve(path.dirname(linkPath), raw);
}

/**
 * Structural fingerprint of a directory that is meaningful for proving survival.
 *
 * Uses `readdirSync` with `withFileTypes` plus a no-follow `lstat`, because plain
 * `readdirSync` follows symlinks: a symlinked child appears as a real directory and
 * vanishes silently when the link is removed. Counting only real directory entries
 * would also miss nested links, so link-ness is recorded explicitly.
 */
function fingerprintDir(dirPath) {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).length;
        const files = entries.filter((e) => e.isFile()).length;
        const links = entries.filter((e) => e.isSymbolicLink()).length;
        return { ok: true, dirs, files, links, total: entries.length };
    } catch {
        return { ok: false, dirs: 0, files: 0, links: 0, total: 0 };
    }
}

function formatFingerprint(fp) {
    if (!fp.ok) return "UNREADABLE";
    return `${fp.total} entries (${fp.dirs} dirs, ${fp.files} files, ${fp.links} links)`;
}

/** Recursively collect reparse points, without ever descending through one. */
function collectLinks(root, dir = root, found = [], depth = 0) {
    if (depth > 12) return found;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
            // Still report the link itself even though we do not descend into it.
            if (entry.isSymbolicLink()) {
                found.push({ path: full, rel, target: resolveLinkTarget(full), kind: "dir" });
            }
            continue;
        }
        if (entry.isSymbolicLink()) {
            found.push({
                path: full,
                rel,
                target: resolveLinkTarget(full),
                kind: entry.isDirectory() ? "dir" : "file",
            });
            continue; // never descend through a link
        }
        if (entry.isDirectory()) collectLinks(root, full, found, depth + 1);
    }
    return found;
}

/**
 * The main checkout for a worktree.
 *
 * Resolved from the `.git` file/structure on disk rather than by spawning `git`, because
 * spawning `git` is unreliable in this environment (`spawnSync git EBUSY`).
 *
 * - In a linked worktree, `.git` is a FILE containing `gitdir: <main>/.git/worktrees/<name>`.
 *   The main checkout is the ancestor of that path above `.git`.
 * - In the main checkout, `.git` is a directory, so the worktree is itself the main checkout.
 */
function mainCheckoutFor(worktreePath) {
    const dotGit = path.join(worktreePath, ".git");
    let stat;
    try {
        stat = fs.lstatSync(dotGit);
    } catch {
        return null;
    }
    if (stat.isDirectory()) return path.resolve(worktreePath);

    let contents;
    try {
        contents = fs.readFileSync(dotGit, "utf8");
    } catch {
        return null;
    }
    const match = /^gitdir:\s*(.+)$/m.exec(contents);
    if (!match) return null;
    const gitDir = path.resolve(worktreePath, match[1].trim());

    // Expect <main>/.git/worktrees/<name>; walk up to the directory holding `.git`.
    let cursor = gitDir;
    for (let i = 0; i < 6; i += 1) {
        if (path.basename(cursor) === ".git") return path.dirname(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return null;
}

function sameOrInside(candidate, parent) {
    const a = path.resolve(candidate);
    const b = path.resolve(parent);
    if (a === b) return true;
    const rel = path.relative(b, a);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function unlink(linkPath) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isDirectory()) {
        // Remove the reparse point only. This does NOT recurse into the target.
        fs.rmdirSync(linkPath);
    } else {
        fs.unlinkSync(linkPath);
    }
}

/**
 * Inspect (and optionally unlink) the links that make `git worktree remove` dangerous.
 *
 * Pure with respect to process state: it returns a report instead of exiting, so tests can
 * call it in-process. Spawning a child process from inside the test runner is unreliable in
 * this environment (`spawnSync ... EBUSY`), which is why this is importable.
 *
 * @returns {{ status: number, log: string[], mainCheckout: string|null, links: any[] }}
 */
function checkWorktreeLinks(worktreePath, options = {}) {
    const doUnlink = options.unlink === true;
    const log = [];
    const say = (line) => log.push(line);

    const worktree = path.resolve(worktreePath);
    if (!fs.existsSync(worktree)) {
        return { status: 2, log: [`MISSING worktree path: ${worktree}`], mainCheckout: null, links: [] };
    }

    const mainCheckout = mainCheckoutFor(worktree);
    const links = collectLinks(worktree);

    say(`Worktree : ${worktree}`);
    say(`Main     : ${mainCheckout ?? "(unresolved)"}`);
    say(`Links    : ${links.length}`);

    if (links.length === 0) {
        say("SAFE: no reparse points found; `git worktree remove` will not escape this worktree.");
        return { status: 0, log, mainCheckout, links };
    }

    const dangerous = [];
    for (const link of links) {
        let hazard = "outside-this-worktree";
        if (link.target === null) {
            hazard = "unreadable-target";
        } else if (sameOrInside(link.target, worktree)) {
            hazard = "inside-this-worktree (safe)";
        } else if (mainCheckout && sameOrInside(link.target, mainCheckout)) {
            hazard = "INTO-MAIN-CHECKOUT";
            dangerous.push(link);
        }
        say(`  ${link.rel} -> ${link.target ?? "(unreadable)"} [${hazard}]`);
    }

    if (!doUnlink) {
        if (dangerous.length > 0) {
            say(
                `UNSAFE: ${dangerous.length} link(s) resolve into the main checkout. ` +
                    "`git worktree remove` would delete the main checkout's dependencies.",
            );
            say("Re-run with --unlink to remove the links first, then remove the worktree.");
            return { status: 1, log, mainCheckout, links };
        }
        say("UNSAFE: links resolve outside this worktree. Unlink them before removal.");
        return { status: 1, log, mainCheckout, links };
    }

    // Record target integrity before touching anything, so the report can prove survival.
    // Only targets that are NOT inside this worktree are recorded: those are the ones a
    // mistake would destroy.
    const before = new Map();
    for (const link of links) {
        if (!link.target) continue;
        if (sameOrInside(link.target, worktree)) continue;
        before.set(link.target, fingerprintDir(link.target));
    }

    // Capture the main checkout's own links too. Removing a link whose TARGET is the main
    // checkout's `node_modules` also unlinks children of that target (such as the main
    // checkout's `@types` symlink), so their state must be verified as well.
    const mainLinks = mainCheckout ? collectLinks(mainCheckout) : [];
    const mainBefore = new Map();
    for (const link of mainLinks) {
        if (link.target && !sameOrInside(link.target, worktree)) {
            mainBefore.set(link.path, fingerprintDir(link.target));
        }
    }

    let failures = 0;
    for (const link of links) {
        try {
            unlink(link.path);
            say(`unlinked ${link.rel}`);
        } catch (error) {
            say(`FAILED to unlink ${link.rel}: ${error.message}`);
            failures += 1;
        }
    }

    say("");
    say("Target integrity after unlink:");
    for (const [target, fp] of before) {
        const after = fingerprintDir(target);
        const ok =
            after.ok &&
            fp.ok &&
            after.dirs === fp.dirs &&
            after.links === fp.links &&
            after.total === fp.total;
        say(`  ${ok ? "OK  " : "LOST"} ${target}`);
        say(`        before: ${formatFingerprint(fp)}`);
        say(`        after : ${formatFingerprint(after)}`);
        if (!ok) failures += 1;
    }

    if (mainBefore.size > 0) {
        say("");
        say("Main checkout links:");
        for (const [linkPath] of mainBefore) {
            let exists = true;
            try {
                fs.lstatSync(linkPath);
            } catch {
                exists = false;
            }
            say(`  ${exists ? "OK  " : "LOST"} ${linkPath}`);
            if (!exists) {
                say("        the main checkout lost this link; restore it (see docs/testing.md)");
                failures += 1;
            } else {
                const target = resolveLinkTarget(linkPath);
                const after = target ? fingerprintDir(target) : { ok: false };
                say(`        target: ${formatFingerprint(after)}`);
            }
        }
    }

    const remaining = collectLinks(worktree);
    if (remaining.length > 0) {
        say("");
        say(`${remaining.length} link(s) still present. Do not remove the worktree yet.`);
        return { status: 1, log, mainCheckout, links };
    }
    if (failures > 0) {
        say("");
        say(`${failures} problem(s) detected. Do not remove the worktree yet.`);
        return { status: 1, log, mainCheckout, links };
    }
    say("");
    say("SAFE: links removed and all targets verified intact. `git worktree remove` may run now.");
    return { status: 0, log, mainCheckout, links };
}

function printReport(report) {
    for (const line of report.log) {
        if (line.startsWith("SAFE:") || line.startsWith("LOST") || line.startsWith("FAILED")) {
            console.log(line);
        } else if (line.startsWith("UNSAFE:") || line.startsWith("MISSING") || line.startsWith("usage:")) {
            console.error(line);
        } else {
            console.log(line);
        }
    }
}

function main() {
    const args = process.argv.slice(2);
    const doUnlink = args.includes("--unlink");
    const positional = args.filter((a) => !a.startsWith("--"));
    if (positional.length !== 1) {
        console.error("usage: node scripts/check-worktree-links.cjs <worktree-path> [--unlink]");
        process.exit(2);
    }
    const report = checkWorktreeLinks(positional[0], { unlink: doUnlink });
    printReport(report);
    process.exit(report.status);
}

module.exports = {
    checkWorktreeLinks,
    collectLinks,
    fingerprintDir,
    formatFingerprint,
    mainCheckoutFor,
    resolveLinkTarget,
    sameOrInside,
};

if (require.main === module) main();
