/** Guard both the entry chunk and all statically imported startup JavaScript. */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const DIST_DIR = path.resolve(path.dirname(currentFilePath), "../dist");
const MAX_ENTRY_KIB = 650;
// Baseline: 610.4 KiB entry + 170.8 KiB vendor-charts, with ~9% headroom.
// Changes to either budget require a measured baseline and explanation.
const MAX_STARTUP_KIB = 850;

export type BuildManifest = Record<string, {
    file: string;
    isEntry?: boolean;
    imports?: string[];
    dynamicImports?: string[];
}>;

export function collectStartupAssets(manifest: BuildManifest, entryFile: string): string[] {
    const entry = Object.keys(manifest).find(key => manifest[key].isEntry && manifest[key].file === entryFile);
    if (!entry) throw new Error(`Entry script ${entryFile} is missing from the Vite manifest.`);
    const visited = new Set<string>();
    const assets = new Set<string>();
    function visit(key: string): void {
        if (visited.has(key)) return;
        const chunk = manifest[key];
        if (!chunk) throw new Error(`Static import ${key} is missing from the Vite manifest.`);
        visited.add(key);
        if (/\.m?js$/.test(chunk.file)) assets.add(chunk.file);
        for (const dependency of chunk.imports ?? []) visit(dependency);
        // dynamicImports belong to lazy features and are deliberately excluded.
    }
    visit(entry);
    return [...assets];
}

export function measureStartupBundle(distDir: string): {
    entry: string;
    assets: Array<{ file: string; rawBytes: number; gzipBytes: number }>;
} {
    const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    // Resolve the script referenced by HTML; nested dynamic entries can also
    // have index-* filenames. Attribute order is irrelevant.
    const script = [...html.matchAll(/<script\b[^>]*>/g)].find(match => /\btype="module"/.test(match[0]));
    const src = script?.[0].match(/\bsrc="([^"]+\.m?js)"/);
    if (!src) throw new Error("dist/index.html has no module entry script.");
    const entry = src[1].replace(/^\/+/, "");
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, ".vite/manifest.json"), "utf8")) as BuildManifest;
    const assets = collectStartupAssets(manifest, entry).map(file => {
        const assetPath = path.resolve(distDir, file);
        const relative = path.relative(path.resolve(distDir), assetPath);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Manifest asset escapes dist: ${file}`);
        }
        const bytes = fs.readFileSync(assetPath);
        return { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    });
    return { entry, assets };
}

function main(): void {
    const { entry, assets } = measureStartupBundle(DIST_DIR);
    const entrySize = assets.find(asset => asset.file === entry)!;
    const totalRaw = assets.reduce((sum, asset) => sum + asset.rawBytes, 0);
    const totalGzip = assets.reduce((sum, asset) => sum + asset.gzipBytes, 0);
    for (const asset of assets) {
        console.log(`${asset.file}: ${(asset.rawBytes / 1024).toFixed(1)} KiB raw, ${(asset.gzipBytes / 1024).toFixed(1)} KiB gzip`);
    }
    console.log(`Entry: ${(entrySize.rawBytes / 1024).toFixed(1)} / ${MAX_ENTRY_KIB} KiB raw budget`);
    console.log(`Startup JS: ${(totalRaw / 1024).toFixed(1)} / ${MAX_STARTUP_KIB} KiB raw budget (${(totalGzip / 1024).toFixed(1)} KiB gzip)`);
    if (entrySize.rawBytes > MAX_ENTRY_KIB * 1024 || totalRaw > MAX_STARTUP_KIB * 1024) {
        throw new Error("Startup JavaScript exceeds its bundle budget. Check static imports and vendor growth; update budgets only with a measured baseline and explanation.");
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
