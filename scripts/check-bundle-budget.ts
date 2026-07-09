/**
 * Bundle budget guard for the production entry chunk.
 *
 * The app has many lazy-loaded features, and a single accidental static
 * import can silently pull a whole feature into startup JS. Vite only
 * warns on chunk size; this script turns that warning into a hard gate so
 * lazy-loading regressions fail CI instead of slipping through.
 *
 * Run after `vite build`:
 *   npm run build:check
 *
 * The entry chunk is resolved from `dist/index.html` (the script tag Vite
 * rewrites with the hashed bundle path), NOT by globbing `dist/assets/index-*.js`
 * — Vite can emit multiple `index-*` chunks (e.g. nested dynamic-entry splits),
 * and only the one referenced by index.html is the true startup payload.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");

// Current entry is ~844 KB. Budget is current + ~7% headroom so trivial
// changes don't trip the gate while a real lazy-load regression (tens of
// KB) will. Lower this as the entry shrinks; raise only with cause.
const MAX_ENTRY_KB = 900;

function resolveEntryAssetPath(): string {
    if (!fs.existsSync(INDEX_HTML)) {
        throw new Error(`dist/index.html not found at ${INDEX_HTML}. Run \`vite build\` first.`);
    }
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    // Vite rewrites `<script type="module" src="index.ts">` to the hashed
    // `assets/<name>-<hash>.js` (with `crossorigin` and a leading `/`).
    // Attributes can appear in any order, so match the whole tag and extract
    // the src separately. There is exactly one entry script tag in this app's
    // index.html.
    const scriptTagMatch = html.match(/<script[^>]*type="module"[^>]*>/);
    if (!scriptTagMatch || !scriptTagMatch[0]) {
        throw new Error(`Could not find module entry script in ${INDEX_HTML}.`);
    }
    const srcMatch = scriptTagMatch[0].match(/src="([^"]+\.js)"/);
    if (!srcMatch || !srcMatch[1]) {
        throw new Error(`Module entry script in ${INDEX_HTML} has no .js src.`);
    }
    // Normalize `/assets/...` → `assets/...` so it joins cleanly with dist dir.
    return srcMatch[1].replace(/^\/+/, "");
}

function main(): void {
    const entryAssetRelative = resolveEntryAssetPath();
    const entryAssetPath = path.join(DIST_DIR, entryAssetRelative);
    if (!fs.existsSync(entryAssetPath)) {
        throw new Error(`Entry chunk ${entryAssetPath} referenced by index.html does not exist.`);
    }
    const sizeBytes = fs.statSync(entryAssetPath).size;
    const sizeKb = sizeBytes / 1024;

    const status = sizeKb <= MAX_ENTRY_KB
        ? "OK"
        : `OVER BUDGET (max ${MAX_ENTRY_KB} KB)`;

    console.log(`Entry chunk: ${entryAssetRelative}`);
    console.log(`Size: ${sizeKb.toFixed(1)} KB / ${MAX_ENTRY_KB} KB budget — ${status}`);

    if (sizeKb > MAX_ENTRY_KB) {
        console.error(
            `\nEntry chunk exceeds the ${MAX_ENTRY_KB} KB budget by ${(sizeKb - MAX_ENTRY_KB).toFixed(1)} KB.\n` +
            `A lazy-loaded feature likely regressed into a static import. Check Vite's build output\n` +
            `for new "dynamic import will not be split" warnings, or raise MAX_ENTRY_KB in\n` +
            `scripts/check-bundle-budget.ts with cause.`
        );
        process.exit(1);
    }
}

main();
