/**
 * Small, deterministic artifact primitives shared by the snapshot writer and
 * the offline feature-pack generator.
 *
 * This leaf intentionally has no application imports. It owns the file-byte
 * details that must stay identical across future artifact producers.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export interface EncodedCanonicalJsonl {
    compressed: Buffer;
    uncompressed: Buffer;
    compressedSha256: string;
    uncompressedSha256: string;
}

export interface FileHash {
    sha256: string;
    bytes: number;
}

/**
 * Recursively canonicalize a JSON value. Object keys use JavaScript's default
 * UTF-16/code-unit ordering; arrays retain their caller-provided order.
 */
function canonicalize(value: unknown, path: string): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}.`);
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
    if (typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`Unsupported object type at ${path}.`);
        }
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            result[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`);
        }
        return result;
    }
    throw new Error(`Unsupported JSON value at ${path}.`);
}

/** Serialize one JSON value with stable recursive object-key ordering. */
export function canonicalJson(value: unknown): string {
    const serialized = JSON.stringify(canonicalize(value, "$"));
    if (serialized === undefined) throw new Error("Canonical JSON serialization produced no value.");
    return serialized;
}

/** Serialize canonical JSONL with LF separators and a trailing LF. */
export function canonicalJsonl(records: readonly unknown[]): Buffer {
    if (records.length === 0) return Buffer.alloc(0);
    return Buffer.from(records.map((record) => `${canonicalJson(record)}\n`).join(""), "utf8");
}

function sha256(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

let atomicWriteCounter = 0;

/** Canonical JSONL encoded with the fixed snapshot gzip settings. */
export function encodeCanonicalJsonl(records: readonly unknown[]): EncodedCanonicalJsonl {
    const uncompressed = canonicalJsonl(records);
    // Node's gzip implementation emits an all-zero MTIME by default. The
    // current Node typings do not expose the historical mtime option, so the
    // fixed default header is used. No filename/comment options are supplied.
    const compressed = gzipSync(uncompressed, { level: 6 });
    return {
        compressed,
        uncompressed,
        compressedSha256: sha256(compressed),
        uncompressedSha256: sha256(uncompressed),
    };
}

/** Hash a file without materializing it in memory. */
export async function hashFile(filePath: string): Promise<FileHash> {
    const digest = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(filePath);
    try {
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            digest.update(buffer);
            bytes += buffer.length;
        }
    } finally {
        stream.destroy();
    }
    return { sha256: digest.digest("hex"), bytes };
}

/** Hash an already encoded artifact buffer. */
export function hashBytes(data: Buffer): string {
    return sha256(data);
}

function isReparsePoint(stats: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean } & { isReparsePoint?: () => boolean }): boolean {
    return stats.isSymbolicLink() || stats.isReparsePoint?.() === true;
}

/**
 * Resolve a forward-slash artifact path and reject traversal, absolute paths,
 * symlink/reparse components, and paths outside the run directory.
 */
export async function safeArtifactPath(runDir: string, relativePath: string): Promise<string> {
    if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
        throw new Error(`Unsafe artifact path: ${String(relativePath)}.`);
    }
    if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
        throw new Error(`Unsafe artifact path: ${relativePath}.`);
    }
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
        throw new Error(`Unsafe artifact path: ${relativePath}.`);
    }
    const root = resolve(runDir);
    const target = resolve(root, ...parts);
    if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
        throw new Error(`Artifact path escapes run directory: ${relativePath}.`);
    }

    let current = root;
    for (const part of parts) {
        current = join(current, part);
        try {
            const stats = await lstat(current);
            if (isReparsePoint(stats)) throw new Error(`Artifact path traverses a symlink/reparse point: ${relativePath}.`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") break;
            throw error;
        }
    }
    return target;
}

/** Write a file through a same-directory temporary file and rename. */
export async function writeArtifactAtomically(filePath: string, data: string | Buffer): Promise<void> {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${++atomicWriteCounter}`;
    await writeFile(temporaryPath, data, { flag: "wx" });
    try {
        await rename(temporaryPath, filePath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => { /* best effort */ });
        throw error;
    }
}

/** Ensure a path's parent exists without allowing a symlinked artifact path. */
export async function prepareArtifactDirectory(runDir: string, relativePath: string): Promise<string> {
    const target = await safeArtifactPath(runDir, relativePath);
    await mkdir(target, { recursive: true });
    // Re-check after mkdir: a pre-existing symlink or a race must not become an
    // accepted artifact root.
    await safeArtifactPath(runDir, relativePath);
    return target;
}
