/**
 * Small, deterministic artifact primitives shared by the snapshot writer and
 * the offline feature-pack generator.
 *
 * This leaf intentionally has no application imports. It owns the file-byte
 * details that must stay identical across future artifact producers.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, link, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import { gunzipSync, gzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export interface EncodedCanonicalJsonl {
    compressed: Buffer;
    uncompressed: Buffer;
    compressedSha256: string;
    uncompressedSha256: string;
}

export interface CanonicalJsonlEncodeOptions {
    /** zlib compression level; defaults to the established level 6. */
    gzipLevel?: number;
    /** Caller guarantees every record is a validated flat scalar tuple. */
    flatTuples?: boolean;
    /** Encode a record directly as one canonical JSON value. */
    lineEncoder?: (record: unknown, index: number) => string;
}

export interface FileHash {
    sha256: string;
    bytes: number;
}

export interface EncodedBinaryArtifact {
    compressed: Buffer;
    uncompressed: Buffer;
    compressedSha256: string;
    uncompressedSha256: string;
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
    const lines = new Array<string>(records.length);
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        // Source snapshots use flat tuples for bars and entry bindings. Their
        // elements have no object keys to sort, so JSON.stringify is already
        // the canonical representation. Keep the recursive path for every
        // other shape (including trade objects) to preserve exact bytes.
        if (isFlatCanonicalTuple(record)) {
            lines[index] = `${JSON.stringify(record)}\n`;
        } else {
            lines[index] = `${canonicalJson(record)}\n`;
        }
    }
    return Buffer.from(lines.join(""), "utf8");
}

function isFlatCanonicalTuple(value: unknown): value is readonly unknown[] {
    if (!Array.isArray(value)) return false;
    for (const item of value) {
        if (item === null || typeof item === "string" || typeof item === "boolean") continue;
        if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) continue;
        return false;
    }
    return true;
}

function canonicalFlatJsonl(records: readonly unknown[]): Buffer {
    if (records.length === 0) return Buffer.alloc(0);
    const lines = new Array<string>(records.length);
    for (let index = 0; index < records.length; index += 1) {
        lines[index] = `${JSON.stringify(records[index])}\n`;
    }
    return Buffer.from(lines.join(""), "utf8");
}

function canonicalMappedJsonl(
    records: readonly unknown[],
    lineEncoder: (record: unknown, index: number) => string,
): Buffer {
    if (records.length === 0) return Buffer.alloc(0);
    const lines = new Array<string>(records.length);
    for (let index = 0; index < records.length; index += 1) {
        lines[index] = `${lineEncoder(records[index], index)}\n`;
    }
    return Buffer.from(lines.join(""), "utf8");
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

/**
 * Async twin for large JSONL snapshots. Canonical serialization stays
 * deterministic on the caller, while compression runs in Node's zlib worker
 * pool so independent snapshot partitions can be compressed concurrently.
 * The default level remains 6; source-snapshot callers can choose a faster
 * level when the format only requires a readable gzip stream.
 */
export async function encodeCanonicalJsonlAsync(
    records: readonly unknown[],
    options: CanonicalJsonlEncodeOptions = {},
): Promise<EncodedCanonicalJsonl> {
    const uncompressed = options.lineEncoder
        ? canonicalMappedJsonl(records, options.lineEncoder)
        : options.flatTuples
            ? canonicalFlatJsonl(records)
            : canonicalJsonl(records);
    const compressed = await gzipAsync(uncompressed, { level: options.gzipLevel ?? 6 });
    return {
        compressed,
        uncompressed,
        compressedSha256: sha256(compressed),
        uncompressedSha256: sha256(uncompressed),
    };
}

function encodeBinaryArtifact(uncompressed: Buffer): EncodedBinaryArtifact {
    const compressed = gzipSync(uncompressed, { level: 6 });
    return {
        compressed,
        uncompressed,
        compressedSha256: sha256(compressed),
        uncompressedSha256: sha256(uncompressed),
    };
}

/** Encode consecutive IEEE-754 Float64 values in little-endian order. */
export function encodeFloat64Le(values: readonly number[]): EncodedBinaryArtifact {
    const uncompressed = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => {
        if (!Number.isFinite(value)) throw new Error(`Float64 column value ${index} must be finite.`);
        uncompressed.writeDoubleLE(Object.is(value, -0) ? 0 : value, index * 8);
    });
    return encodeBinaryArtifact(uncompressed);
}

/** Encode one validity byte per row. Only 0 and 1 are accepted. */
export function encodeUint8(values: readonly number[]): EncodedBinaryArtifact {
    const uncompressed = Buffer.alloc(values.length);
    values.forEach((value, index) => {
        if (value !== 0 && value !== 1) throw new Error(`UInt8 column value ${index} must be 0 or 1.`);
        uncompressed[index] = value;
    });
    return encodeBinaryArtifact(uncompressed);
}

/** Encode consecutive UInt32 values in little-endian order without wrapping. */
export function encodeUint32Le(values: readonly number[]): EncodedBinaryArtifact {
    const uncompressed = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => {
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
            throw new Error(`UInt32 column value ${index} is out of range.`);
        }
        uncompressed.writeUInt32LE(value, index * 4);
    });
    return encodeBinaryArtifact(uncompressed);
}

/** Decode and validate a gzipped Float64 column. */
export function decodeFloat64Le(compressed: Buffer): number[] {
    return decodeFloat64LeUncompressed(gunzipSync(compressed));
}

/** Decode and validate an already-inflated Float64 column. */
export function decodeFloat64LeUncompressed(uncompressed: Buffer): number[] {
    if (uncompressed.length % 8 !== 0) throw new Error("Float64 column byte length is not divisible by 8.");
    const values: number[] = [];
    for (let offset = 0; offset < uncompressed.length; offset += 8) {
        const value = uncompressed.readDoubleLE(offset);
        if (!Number.isFinite(value)) throw new Error("Float64 column contains a non-finite value.");
        if (Object.is(value, -0)) throw new Error("Float64 column contains a non-canonical negative zero.");
        values.push(value);
    }
    return values;
}

/** Decode and validate a gzipped validity column. */
export function decodeUint8(compressed: Buffer): number[] {
    return decodeUint8Uncompressed(gunzipSync(compressed));
}

/** Decode and validate an already-inflated validity column. */
export function decodeUint8Uncompressed(uncompressed: Buffer): number[] {
    const values: number[] = [];
    for (const value of uncompressed) {
        if (value !== 0 && value !== 1) throw new Error("UInt8 column contains a value other than 0 or 1.");
        values.push(value);
    }
    return values;
}

/** Decode and validate a gzipped UInt32 column. */
export function decodeUint32Le(compressed: Buffer): number[] {
    return decodeUint32LeUncompressed(gunzipSync(compressed));
}

/** Decode and validate an already-inflated UInt32 column. */
export function decodeUint32LeUncompressed(uncompressed: Buffer): number[] {
    if (uncompressed.length % 4 !== 0) throw new Error("UInt32 column byte length is not divisible by 4.");
    const values: number[] = [];
    for (let offset = 0; offset < uncompressed.length; offset += 4) values.push(uncompressed.readUInt32LE(offset));
    return values;
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
    // Windows can briefly deny the rename while an antivirus scanner, indexer,
    // or the Vite watcher still holds the destination. The same bounded retry
    // the batch exporter's atomic writes use; other platforms attempt once.
    const attempts = process.platform === "win32" ? 10 : 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await rename(temporaryPath, filePath);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException | null)?.code;
            const retryable = process.platform === "win32"
                && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
            if (!retryable || attempt === attempts - 1) break;
            await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(25 * (attempt + 1), 100)));
        }
    }
    await unlink(temporaryPath).catch(() => { /* best effort */ });
    throw lastError;
}

/** Publish a deterministic artifact without overwriting a concurrent file. */
export async function publishArtifactIfMissing(filePath: string, data: string | Buffer): Promise<boolean> {
    const expected = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const expectedHash = hashBytes(expected);
    try {
        const stats = await lstat(filePath);
        if (!stats.isFile() || isReparsePoint(stats)) throw new Error(`Published artifact is not a regular file: ${filePath}.`);
        const existing = await hashFile(filePath);
        if (existing.bytes !== expected.length || existing.sha256 !== expectedHash) {
            throw new Error(`Published artifact differs from the requested bytes: ${filePath}.`);
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    }

    const temporaryPath = `${filePath}.tmp-${process.pid}-${++atomicWriteCounter}`;
    let reused = false;
    await writeFile(temporaryPath, expected, { flag: "wx" });
    try {
        try {
            await link(temporaryPath, filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
            reused = true;
        }
    } finally {
        await unlink(temporaryPath).catch(() => { /* best effort */ });
    }

    const publishedStats = await lstat(filePath);
    if (!publishedStats.isFile() || isReparsePoint(publishedStats)) throw new Error(`Published artifact is not a regular file: ${filePath}.`);
    const published = await hashFile(filePath);
    if (published.bytes !== expected.length || published.sha256 !== expectedHash) {
        throw new Error(`Published artifact differs from the requested bytes: ${filePath}.`);
    }
    return reused;
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
