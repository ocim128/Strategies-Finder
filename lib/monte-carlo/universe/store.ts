import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { UNIVERSE_ALGORITHM, UNIVERSE_LIMITS, assertUniverseFinite, isUniverseTerminal, shortUniverseError, universeCoverage,
    validateUniverseRequest, validateUniverseRunId, type UniverseJournalRecord, type UniverseManifest, type UniverseRow } from './model';

/** Property order is irrelevant to retry/digest identity, array order is significant. */
export function universeDigest(value: unknown): string {
    const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, stable(item)])) : v;
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export interface StoredUniverseRun {
    manifest: UniverseManifest; rows: UniverseRow[]; offsets: Array<{ offset: number; bytes: number }>;
    bytes: number; writer: Promise<void>; readers: number;
}

/** Two files per run. Only scalar rows and byte offsets are retained by the parent. */
export class UniverseStore {
    readonly root: string;
    private runs = new Map<string, StoredUniverseRun>();
    private latest: string | null = null;
    constructor(projectRoot: string) { this.root = resolve(projectRoot, 'artifacts/monte-carlo-universe'); }
    private directoryName(id: string): string { validateUniverseRunId(id); return `run-${createHash('sha256').update(id).digest('hex')}`; }
    /** Server-owned name avoids Windows reserved names and case-insensitive aliases. */
    directory(id: string): string { return join(this.root, this.directoryName(id)); }
    private async safeDirectory(path: string): Promise<void> {
        const stat = await fs.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_artifact_directory');
    }
    async initialize(): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        await this.safeDirectory(this.root);
        const recovered: StoredUniverseRun[] = [];
        for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
            let run: StoredUniverseRun | undefined;
            try {
                const dir = join(this.root, entry.name);
                await this.safeDirectory(dir);
                const manifestFile = join(dir, 'manifest.json');
                if ((await fs.stat(manifestFile)).size > UNIVERSE_LIMITS.manifestBytes) throw new Error('manifest_limit');
                const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as UniverseManifest;
                const validated = validateUniverseRequest(manifest.request);
                if (this.directoryName(manifest.request.runId) !== entry.name || manifest.schemaVersion !== 1 || manifest.algorithmVersion !== UNIVERSE_ALGORITHM
                    || !['accepted', 'running', 'completed', 'cancelled', 'failed', 'interrupted'].includes(manifest.state)
                    || universeDigest(validated.inventory) !== universeDigest(manifest.inventory)
                    || universeDigest(manifest.request) !== manifest.requestDigest) throw new Error('incompatible_manifest_rerun');
                run = { manifest, rows: [], offsets: [], bytes: 0, writer: Promise.resolve(), readers: 0 };
                await this.scan(run);
                if (!isUniverseTerminal(manifest.state)) {
                    manifest.state = 'interrupted'; manifest.finishedAt = Date.now(); manifest.error = 'Server restarted; run interrupted. Rerun to continue.';
                    await this.writeManifest(run);
                }
                recovered.push(run);
            } catch (error) {
                // A readable manifest gives the browser a useful explicit recovery failure.
                if (run) { run.manifest.state = 'failed'; run.manifest.error = shortUniverseError(`Recovery error: ${shortUniverseError(error)}`); run.manifest.finishedAt = Date.now(); recovered.push(run); }
            }
        }
        recovered.sort((a, b) => b.manifest.startedAt - a.manifest.startedAt);
        if (recovered[0]) { this.latest = recovered[0].manifest.request.runId; this.runs.set(this.latest, recovered[0]); }
        await this.cleanup();
    }
    private async scan(run: StoredUniverseRun): Promise<void> {
        const file = join(this.directory(run.manifest.request.runId), 'replay-inputs.jsonl');
        const stat = await fs.stat(file);
        if (stat.size > UNIVERSE_LIMITS.journalBytes) throw new Error('journal_limit');
        let pending = Buffer.alloc(0), offset = 0;
        for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
            pending = Buffer.concat([pending, chunk as Buffer]);
            let newline: number;
            while ((newline = pending.indexOf(10)) >= 0) {
                if (newline + 1 > UNIVERSE_LIMITS.recordBytes) throw new Error('record_limit');
                const record = JSON.parse(pending.subarray(0, newline).toString('utf8')) as UniverseJournalRecord;
                this.checkRecord(run, record);
                run.rows.push(record.row); run.offsets.push({ offset, bytes: newline + 1 });
                offset += newline + 1; pending = pending.subarray(newline + 1);
            }
            if (pending.length > UNIVERSE_LIMITS.recordBytes) throw new Error('record_limit');
        }
        // A crash can leave the last append incomplete. Only the complete prefix is durable.
        if (pending.length) await fs.truncate(file, offset);
        run.bytes = offset;
    }
    private checkRecord(run: StoredUniverseRun, record: UniverseJournalRecord): void {
        const item = run.manifest.inventory[run.rows.length];
        if (!item || record.row.index !== item.index || record.row.key !== item.key) throw new Error('corrupt_journal_order');
        const row = record.row;
        if (row.token !== item.token || row.mode !== item.mode || !['evaluated', 'insufficient_trades', 'load_failed', 'backtest_failed', 'simulation_failed', 'resource_limit'].includes(row.status)
            || Object.values(row).some(v => v !== null && typeof v === 'object')
            || (row.reason !== null && (typeof row.reason !== 'string' || row.reason.length > 256))
            || (row.status === 'evaluated' ? (!['Pass', 'Fail'].includes(row.verdict ?? '') || !record.replay) : row.verdict !== null)) throw new Error('corrupt_journal_row');
        assertUniverseFinite(record);
        if (record.row.detailAvailable !== !!record.replay || (!!record.replay && (record.replay.algorithmVersion !== UNIVERSE_ALGORITHM
            || record.row.inputDigest !== universeDigest(record.replay)))) throw new Error('replay_digest_mismatch_rerun');
    }
    get(id: string): StoredUniverseRun | undefined { validateUniverseRunId(id); return this.runs.get(id); }
    async create(manifest: UniverseManifest): Promise<StoredUniverseRun> {
        await this.cleanup();
        const dir = this.directory(manifest.request.runId);
        await fs.mkdir(dir); // Never reuse a path from a previous/replaced request.
        const run: StoredUniverseRun = { manifest, rows: [], offsets: [], bytes: 0, writer: Promise.resolve(), readers: 0 };
        await fs.writeFile(join(dir, 'replay-inputs.jsonl'), '', { flag: 'wx' });
        await this.writeManifest(run);
        this.runs.set(manifest.request.runId, run);
        return run;
    }
    async writeManifest(run: StoredUniverseRun): Promise<void> {
        const dir = this.directory(run.manifest.request.runId);
        await this.safeDirectory(dir);
        run.manifest.counts = universeCoverage(run.rows, run.manifest.inventory.length);
        const bytes = Buffer.from(JSON.stringify(run.manifest));
        if (bytes.length > UNIVERSE_LIMITS.manifestBytes) throw new Error('manifest_limit');
        const temporary = join(dir, 'manifest.tmp');
        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, join(dir, 'manifest.json'));
    }
    append(run: StoredUniverseRun, record: UniverseJournalRecord): Promise<void> {
        const task = run.writer.then(async () => {
            this.checkRecord(run, record);
            const data = Buffer.from(JSON.stringify(record) + '\n');
            if (data.length > UNIVERSE_LIMITS.recordBytes || run.bytes + data.length > UNIVERSE_LIMITS.journalBytes) throw new Error('journal_resource_limit');
            const file = join(this.directory(run.manifest.request.runId), 'replay-inputs.jsonl');
            const handle = await fs.open(file, 'a');
            let failure: unknown;
            try { await handle.appendFile(data); await handle.sync(); } catch (error) { failure = error; }
            try { await handle.close(); } catch (error) { failure ??= error; }
            if (failure) {
                // A failed flush can leave a complete-looking line. Do not let
                // recovery promote that unacknowledged append into the prefix.
                // Windows append-only handles cannot truncate: close first.
                await fs.truncate(file, run.bytes).catch(() => undefined);
                throw failure;
            }
            run.offsets.push({ offset: run.bytes, bytes: data.length }); run.bytes += data.length; run.rows.push(record.row);
        });
        run.writer = task;
        return task;
    }
    async readRecord(run: StoredUniverseRun, index: number): Promise<UniverseJournalRecord> {
        const location = run.offsets[index];
        if (!location || location.bytes > UNIVERSE_LIMITS.recordBytes) throw new Error('detail_unavailable');
        run.readers++;
        let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
        try {
            handle = await fs.open(join(this.directory(run.manifest.request.runId), 'replay-inputs.jsonl'), 'r');
            const bytes = Buffer.alloc(location.bytes);
            const read = await handle.read(bytes, 0, bytes.length, location.offset);
            if (read.bytesRead !== bytes.length) throw new Error('corrupt_replay_rerun');
            return JSON.parse(bytes.toString('utf8')) as UniverseJournalRecord;
        } finally { await handle?.close(); run.readers--; }
    }
    async finish(run: StoredUniverseRun): Promise<void> {
        await run.writer.catch(() => undefined);
        try { await this.writeManifest(run); }
        catch (error) { run.manifest.state = 'failed'; run.manifest.error = shortUniverseError(`Terminal write failed: ${shortUniverseError(error)}`); }
        this.latest = run.manifest.request.runId;
        await this.cleanup();
    }
    private async cleanup(): Promise<void> {
        for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
            const run = [...this.runs.values()].find(candidate => this.directoryName(candidate.manifest.request.runId) === entry.name);
            if ((this.latest && entry.name === this.directoryName(this.latest)) || (run && (!isUniverseTerminal(run.manifest.state) || run.readers))) continue;
            const dir = join(this.root, entry.name);
            // Delete only regular files we own; never recursively follow a junction.
            await this.safeDirectory(dir);
            const files = await fs.readdir(dir, { withFileTypes: true });
            if (files.some(f => !f.isFile() || f.isSymbolicLink() || !['manifest.json', 'manifest.tmp', 'replay-inputs.jsonl'].includes(f.name))) continue;
            if (dirname(resolve(dir)) !== this.root) throw new Error('unsafe_artifact_directory');
            for (const file of files) await fs.unlink(join(dir, file.name));
            await fs.rmdir(dir); if (run) this.runs.delete(run.manifest.request.runId);
        }
    }
}
