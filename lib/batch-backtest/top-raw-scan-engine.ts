import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseIntervalSeconds } from "../interval-utils";
import { canonicalizeLegIdentity } from "../synthetic-leg-identity";
import { enumerateSp500Pairs } from "./sp500-pair-enumerator";
import { ScanWorkerPool } from "./top-raw-scan-pool";
import { ScanStore, scanFileRevision, scanHash, type ScanManifest, type ScanReservation } from "./top-raw-scan-store";
import { parseScanAssets, scanBudget, TOP_RAW_SCAN_ORIENTATION, TOP_RAW_SCAN_SAMPLING, TOP_RAW_SCAN_TIES, type ScanPair, type ScanRequest, type ScanResult, type ScanStatus, type ScanVote, type ScanAssetCoverage } from "./top-raw-scan-contract";
import { chooseScanFinalists, planScanDiscovery, planScanRefinement, reduceScanDiscovery, reduceScanFinalists } from "./top-raw-scan-sampling";
import { ScanEndpointCoverage, hasScanEndpointHistory, scanSourceIntervals, scanPrimarySourceInterval, scanSyncReference } from "./top-raw-scan-preflight";
import { TOP_RAW_SCAN_SHARD_SIZE } from "./top-raw-scan-contract";
import { summarizeScanFailures } from "./top-raw-scan-diagnostics";

const SHARD_SIZE = TOP_RAW_SCAN_SHARD_SIZE;
export class TopRawScanEngine {
    private stopped = false;
    private halted = false;
    private pool: ScanWorkerPool;
    private manifest: ScanManifest | null = null;
    private status: ScanStatus;
    private writer: Promise<void> = Promise.resolve();
    constructor(public readonly request: ScanRequest, private readonly store = new ScanStore(), pool = new ScanWorkerPool(), private readonly baseDir = process.cwd()) {
        this.pool = pool;
        this.status = { runId: request.runId, phase: "preflight", completed: 0, total: 0, message: "Checking local assets and data." };
    }
    getStatus(): ScanStatus { return { ...this.status, ...(this.manifest ? { result: this.manifest.result } : {}) }; }
    stop(): void { this.stopped = true; this.pool.stop(); }
    private checkStop(): void { if (this.stopped || this.halted) throw new Error("Scan stopped or failed."); }
    private async checkSources(): Promise<void> {
        for (const source of this.manifest!.sources) { this.checkStop(); if (await scanFileRevision(source.path) !== source.revision) throw new Error(`Source changed: ${source.asset}. Resume requires the original data snapshot. Start a new Run after syncing.`); }
    }
    private checkpoint(): Promise<void> {
        const snapshot = structuredClone(this.manifest!);
        this.writer = this.writer.then(() => this.store.saveManifest(snapshot));
        return this.writer;
    }
    async run(emit: (status: ScanStatus) => void = () => {}, release: (status: ScanStatus) => void = () => {}): Promise<ScanStatus> {
        const terminal = await this.execute(emit);
        await this.pool.dispose();
        await this.writer.catch(() => undefined);
        if (this.stopped && terminal.phase === "completed") {
            terminal.phase = "interrupted"; terminal.message = "Scan stopped during teardown.";
            if (this.manifest) {
                const result = this.manifest.result;
                result.status = "interrupted"; result.reason = "incomplete"; result.error = terminal.message;
                result.globalRankingExact = false; result.bestVerifiedCandidates = [];
                this.manifest.status = terminal;
                try { await this.store.saveResult(result); await this.store.saveManifest(this.manifest); }
                catch (error) { terminal.message += ` Terminal persistence failed: ${String(error)}`; }
            }
        }
        // Release server ownership synchronously before either stream or polling
        // can observe a terminal phase, including completed-scan reopen.
        release(terminal);
        this.status = terminal;
        emit(terminal);
        return terminal;
    }
    private async execute(emit: (status: ScanStatus) => void): Promise<ScanStatus> {
        const start = performance.now();
        const votes = new Map<string, ScanVote>();
        let discoveryPlan: ScanPair[] = [];
        let reservation: ScanReservation | null = null;
        const progress = () => emit({ ...this.status });
        try {
            const parsed = parseScanAssets(this.request.assetListText);
            const intervalSeconds = parseIntervalSeconds(this.request.interval);
            if (!intervalSeconds) throw new Error("Invalid interval.");
            // Resume is a transport flag; every semantic input remains part of the hash.
            const { resume: _resume, assetListText: _text, ...semantic } = this.request;
            const requestHash = scanHash({ ...semantic, assets: parsed.assets });
            const existing = await this.store.readManifest(this.request.runId);
            reservation = await this.store.readReservation(this.request.runId);
            if ((existing || reservation) && !this.request.resume) throw new Error("Run already exists; use Resume for its exact manifest.");
            if (!existing && !reservation && this.request.resume) throw new Error("No saved scan to resume.");
            if (reservation && reservation.requestHash !== requestHash) throw new Error("Resume configuration mismatch.");
            if (!reservation) {
                reservation = { schema: "top_raw_scan.reservation.v1", requestHash, cutoff: existing?.cutoff ?? Math.floor(Date.now() / 1000), status: this.status };
                await this.store.saveReservation(this.request.runId, reservation);
            }
            this.checkStop();
            await this.pool.initialize(this.request.workerCount); this.checkStop();
            const engineIdentity = await this.pool.task<string>(0, { type: "engine_identity", useRust: this.request.useRustEnginePreference === true });
            const implementationHash = scanHash({ worker: await readFile(this.pool.workerPath, "utf8"), engineIdentity });
            if (existing) {
                if (!this.request.resume) throw new Error("Run already exists; use Resume for its exact manifest.");
                if (existing.requestHash !== requestHash || existing.implementationHash !== implementationHash) throw new Error("Resume configuration or execution implementation mismatch.");
                this.manifest = existing; await this.checkSources();
                if (existing.result.status === "completed") return { ...existing.status, result: existing.result };
            } else {
                const cutoff = reservation.cutoff;
                // Catalog/30m seed identity only. The worker checks the actual
                // synthetic target rather than requiring a standalone target CSV.
                const enumeration = enumerateSp500Pairs({ pairListText: parsed.assets.join("\n"), interval: "4h", baseDir: this.baseDir });
                const canonical = [...new Set(enumeration.canonicalPairs.map(s => canonicalizeLegIdentity(s)!.loaderSymbol))].sort();
                const exclusions = enumeration.skippedPairTokens.map(asset => ({ asset, reason: "Not in local catalog or required source CSV missing." }));
                const assets: string[] = [];
                let sources: ScanManifest["sources"] = [], endpoints: Record<string, number> = {};
                const details = new Map<string, ScanAssetCoverage>(exclusions.map(row => [row.asset, { asset: row.asset, closedBars: null, firstTime: null, lastTime: null }]));
                const coverage = new ScanEndpointCoverage();
                this.status.total = canonical.length; progress();
                const catalogPath = resolve(this.baseDir, "price-data", "ibkr", "catalog.json");
                sources.push({ asset: "catalog", path: catalogPath, revision: await scanFileRevision(catalogPath) });
                for (const asset of canonical) {
                    this.checkStop();
                    const ticker = canonicalizeLegIdentity(asset)!.scoringAsset;
                    const paths = scanSourceIntervals(asset, this.request.interval).map(interval => resolve(this.baseDir, "price-data", "ibkr", "csv", interval, `${ticker}.csv`));
                    try {
                        const revisions = await Promise.all(paths.map(async path => ({ asset, path, revision: await scanFileRevision(path) })));
                        const times = await this.pool.task<number[]>(0, { type: "preflight", asset, interval: this.request.interval, cutoff });
                        details.set(asset, { asset, closedBars: times.length, firstTime: times[0] ?? null, lastTime: times.at(-1) ?? null });
                        for (const revision of revisions) if (await scanFileRevision(revision.path) !== revision.revision) throw new Error("Source changed during preflight.");
                        if (!hasScanEndpointHistory(times, times.at(-1)!)) throw new Error(`Only ${times.length} closed ${this.request.interval} bars; at least 200 are required. Sync a longer source history.`);
                        coverage.add(times);
                        endpoints[asset] = times.at(-1)!; assets.push(asset); sources.push(...revisions);
                    } catch (error) { this.checkStop(); if (!details.has(asset)) details.set(asset, { asset, closedBars: null, firstTime: null, lastTime: null }); exclusions.push({ asset, reason: error instanceof Error ? error.message : String(error) }); }
                    this.status.completed++; progress();
                }
                const selection = coverage.select();
                // Price-data problems shrink the scanned universe instead of
                // rejecting the run: keep the newest candle supported by the
                // most usable assets and exclude the histories lacking it.
                if (selection && !selection.complete) {
                    this.status.message = `Selecting the best-supported common candle across ${assets.length} usable assets.`; progress(); this.checkStop();
                    const staleReason = `Missing a closed ${this.request.interval} candle with 200 bars of history at ${new Date(selection.asOf * 1000).toISOString()}; excluded so the remaining assets can be scanned. Sync/check the source history.`;
                    const retained: string[] = [];
                    for (const asset of assets) {
                        this.checkStop();
                        let missing = endpoints[asset]! < selection.asOf;
                        if (!missing) {
                            const revisions = sources.filter(source => source.asset === asset);
                            for (const source of revisions) if (await scanFileRevision(source.path) !== source.revision) throw new Error("Source changed during preflight.");
                            const times = await this.pool.task<number[]>(0, { type: "preflight", asset, interval: this.request.interval, cutoff });
                            for (const source of revisions) if (await scanFileRevision(source.path) !== source.revision) throw new Error("Source changed during preflight.");
                            missing = !hasScanEndpointHistory(times, selection.asOf);
                        }
                        if (missing) exclusions.push({ asset, reason: staleReason });
                        else retained.push(asset);
                    }
                    const kept = new Set(retained);
                    assets.length = 0; assets.push(...retained);
                    sources = sources.filter(source => source.asset === "catalog" || kept.has(source.asset));
                    endpoints = Object.fromEntries(retained.map(asset => [asset, endpoints[asset]!]));
                }
                if (!selection || assets.length < 2) {
                    this.status.message = "Building sync report; preserving the full asset list."; progress(); this.checkStop();
                    const referenceAsOf = scanSyncReference(Object.values(endpoints), intervalSeconds);
                    const assetsToSync = exclusions.map(row => ({ ...details.get(row.asset)!, asset: row.asset, reason: row.reason }));
                    if (referenceAsOf !== null) for (const asset of assets) {
                        this.checkStop();
                        const detail = details.get(asset)!;
                        if (detail.lastTime === referenceAsOf) continue;
                        let missing = detail.lastTime! < referenceAsOf;
                        if (!missing) {
                            const revisions = sources.filter(source => source.asset === asset);
                            for (const source of revisions) if (await scanFileRevision(source.path) !== source.revision) throw new Error("Source changed during sync diagnostics.");
                            const times = await this.pool.task<number[]>(0, { type: "preflight", asset, interval: this.request.interval, cutoff });
                            for (const source of revisions) if (await scanFileRevision(source.path) !== source.revision) throw new Error("Source changed during sync diagnostics.");
                            missing = !hasScanEndpointHistory(times, referenceAsOf);
                        }
                        if (missing) assetsToSync.push({ ...detail, reason: `Missing a closed ${this.request.interval} candle with 200 bars of history at ${new Date(referenceAsOf * 1000).toISOString()}. Sync/check the source history.` });
                    }
                    if (await scanFileRevision(catalogPath) !== sources[0]!.revision) throw new Error("Catalog source changed during preflight.");
                    this.status.preflight = { schema: "top_raw_scan.preflight.v1", runId: this.request.runId, interval: this.request.interval, cutoff,
                        requestedAssetCount: parsed.assets.length, usableAssetCount: assets.length, referenceAsOf,
                        sourceInterval: scanPrimarySourceInterval(parsed.assets[0]!, this.request.interval),
                        assetsToSync: assetsToSync.sort((a, b) => a.asset.localeCompare(b.asset)) };
                    throw new Error(`Only ${assets.length} eligible assets have usable local data. All ${parsed.assets.length} requested assets were kept; no pairs were evaluated. Review the sync report (${assetsToSync.length} histories).`);
                }
                const asOf = selection.asOf, budget = scanBudget(assets.length, this.request);
                const sourceRevisions = Object.fromEntries(sources.map(s => [`${s.asset}:${s.path.split(/[\\/]/).slice(-2).join("/")}`, s.revision]));
                const fingerprint = scanHash({ requestHash, implementationHash, sourceRevisions, asOf, assets, orientation: TOP_RAW_SCAN_ORIENTATION, sampling: TOP_RAW_SCAN_SAMPLING, ties: TOP_RAW_SCAN_TIES });
                const result: ScanResult = {
                    schema: "top_raw_scan.result.v1", mode: "fast_top_raw", runId: this.request.runId, status: "preflight", cutoff, asOf, fingerprint,
                    universeHash: scanHash(assets), sourceRevisions, scoreContract: "unweighted_open_position_sum_v1", orientationVersion: TOP_RAW_SCAN_ORIENTATION,
                    samplingVersion: TOP_RAW_SCAN_SAMPLING, tieVersion: TOP_RAW_SCAN_TIES, seedDerivation: "fnv1a32_domain_xor_seed_v1",
                    requested: { opponentsPerAsset: this.request.opponentsPerAsset, finalistCount: this.request.finalistCount, seed: this.request.seed }, effective: budget.effective,
                    configuration: { strategyKey: this.request.strategyKey, strategyParams: this.request.strategyParams, backtestSettings: this.request.backtestSettings, capitalSettings: this.request.capitalSettings, interval: this.request.interval, useRustEnginePreference: this.request.useRustEnginePreference },
                    rawCount: parsed.rawCount, canonicalCount: parsed.assets.length, duplicateCount: parsed.duplicateCount + enumeration.canonicalPairs.length - canonical.length,
                    eligibleAssets: assets, exclusions, discovery: [], finalists: [], cutoffTies: [], omittedCutoffTies: [], globalRankingExact: false,
                    bestVerifiedCandidates: [], reason: "incomplete", pairCounts: { discovery: 0, refinement: 0, reused: 0, successful: 0, failed: 0 }, engineUsage: { typescript: 0, rust: 0 },
                    timings: { preflightMs: performance.now() - start }, legEndpoints: endpoints,
                };
                this.manifest = { schema: "top_raw_scan.manifest.v1", request: this.request, requestHash, implementationHash, cutoff, asOf, evaluationCutoff: asOf + intervalSeconds, assets, sources, result, completedShards: [], status: this.status };
                await this.checkSources(); await this.checkpoint(); this.checkStop();
                this.status.message = `${assets.length} eligible assets, ${exclusions.length} exclusions. Frozen evaluation ${new Date(asOf * 1000).toISOString()}.`;
                emit({ ...this.status, result });
            }
            const manifest = this.manifest, result = manifest.result;
            delete result.error; result.status = "discovery"; result.globalRankingExact = false; result.bestVerifiedCandidates = [];
            result.discovery = []; result.finalists = [];
            result.pairCounts = { discovery: 0, refinement: 0, reused: 0, successful: 0, failed: 0 };
            result.failureDiagnostics = summarizeScanFailures([]);
            result.engineUsage = { typescript: 0, rust: 0 };
            const discovery = planScanDiscovery(manifest.assets, this.request);
            discoveryPlan = discovery;
            result.pairCounts.discovery = discovery.length;
            const runPairs = async (pairs: ScanPair[], offset: number, phase: "discovery" | "refinement") => {
                const phaseStart = performance.now(); let next = 0;
                this.status = { runId: this.request.runId, phase, completed: 0, total: pairs.length, message: `${phase}: evaluating frozen relationships.` };
                result.status = phase;
                manifest.status = this.status; progress();
                const outcomes = await Promise.allSettled(Array.from({ length: this.pool.size }, async (_, slot) => {
                    try {
                    while (next < pairs.length) {
                        this.checkStop(); const begin = next; next += SHARD_SIZE;
                        const batch = pairs.slice(begin, begin + SHARD_SIZE), index = offset + Math.floor(begin / SHARD_SIZE);
                        let records = await this.store.readShard(this.request.runId, index, result.fingerprint);
                        if (manifest.completedShards.includes(index) && !records) throw new Error(`Completed scan shard ${index} is missing.`);
                        const validate = (values: ScanVote[], expected: ScanPair[]) => {
                            if (values.length !== expected.length || values.some((v, i) => !v || v.key !== expected[i]!.key || !Number.isInteger(v.vote) || !Number.isInteger(v.active) || v.active < 0 || Math.abs(v.vote) > v.active || !["typescript", "rust"].includes(v.engine) || (v.error !== undefined && typeof v.error !== "string"))) throw new Error(`Invalid shard coverage ${index}.`);
                        };
                        if (records) { validate(records, batch); for (const record of records) votes.set(record.key, record); }
                        const retry = records ? batch.filter((_, i) => this.request.resume && records![i]!.error) : batch;
                        if (retry.length) {
                            const used = new Set(retry.flatMap(p => [p.base, p.quote]));
                            const fresh = await this.pool.task<ScanVote[]>(slot, { type: "pairs", pairs: retry, request: this.request, asOf: manifest.asOf, cutoff: manifest.evaluationCutoff, sources: manifest.sources.filter(s => used.has(s.asset) || s.asset === "catalog"), engineIdentity });
                            validate(fresh, retry);
                            const recovered = new Map(fresh.map(vote => [vote.key, vote]));
                            records = records ? records.map(vote => recovered.get(vote.key) ?? vote) : fresh;
                            this.checkStop();
                            await this.store.saveShard(this.request.runId, index, result.fingerprint, records); this.checkStop();
                        }
                        this.checkStop();
                        if (!manifest.completedShards.includes(index)) manifest.completedShards.push(index);
                        for (const record of records!) votes.set(record.key, record);
                        this.status.completed += batch.length; progress();
                    }
                    } catch (error) { this.halted = true; this.pool.stop(); throw error; }
                }));
                const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
                if (failure) throw failure.reason;
                result.timings[`${phase}Ms`] = performance.now() - phaseStart;
                await this.checkpoint();
            };
            await runPairs(discovery, 0, "discovery"); this.checkStop();
            result.discovery = reduceScanDiscovery(manifest.assets, discovery, votes);
            const allPairs = manifest.assets.length * (manifest.assets.length - 1) / 2;
            const selection = chooseScanFinalists(result.discovery, discovery.length === allPairs ? manifest.assets.length : result.effective.finalistCount, this.request.seed);
            result.cutoffTies = selection.cutoffTies; result.omittedCutoffTies = selection.omittedCutoffTies;
            if (result.discovery.every(row => row.coverageComplete)) {
                const refinement = planScanRefinement(manifest.assets, selection.selected, this.request.seed, new Set(votes.keys()));
                result.pairCounts.refinement = refinement.length;
                const required = selection.selected.length * (manifest.assets.length - selection.selected.length) + selection.selected.length * (selection.selected.length - 1) / 2;
                result.pairCounts.reused = required - refinement.length;
                if (refinement.length) await runPairs(refinement, Math.ceil(discovery.length / SHARD_SIZE), "refinement");
                result.finalists = reduceScanFinalists(manifest.assets, selection.selected, this.request.seed, votes);
            } else { result.finalists = []; }
            await this.checkSources(); this.checkStop();
            result.pairCounts.successful = [...votes.values()].filter(v => !v.error).length;
            result.pairCounts.failed = votes.size - result.pairCounts.successful;
            result.failureDiagnostics = summarizeScanFailures(votes.values());
            for (const vote of votes.values()) if (!vote.error) result.engineUsage[vote.engine]++;
            const complete = result.discovery.every(r => r.coverageComplete) && result.finalists.every(r => r.complete);
            result.globalRankingExact = complete && (discovery.length === allPairs || result.finalists.length === manifest.assets.length);
            const verified = result.finalists.filter(r => r.complete && r.exactRaw! > 0).sort((a, b) => b.exactRaw! - a.exactRaw!);
            result.bestVerifiedCandidates = complete && verified.length ? verified.filter(r => r.exactRaw === verified[0]!.exactRaw).map(r => r.asset) : [];
            result.reason = !complete ? "incomplete_coverage" : !verified.length ? result.globalRankingExact ? "no_positive_candidates" : "no_positive_fully_evaluated_candidates" : result.globalRankingExact ? "exact_global_ranking" : "highest_score_among_fully_evaluated_candidates_global_ranking_estimated";
            result.status = complete ? "completed" : "failed";
            result.timings.totalMs = performance.now() - start;
            await this.store.saveResult(result); this.checkStop();
            const terminal: ScanStatus = { ...this.status, phase: result.status, message: result.reason, result };
            manifest.status = terminal; await this.checkpoint(); this.checkStop();
            return terminal;
        } catch (error) {
            // Drain outstanding tasks/writers before publishing a terminal state.
            this.halted = true; this.pool.stop(); await this.pool.dispose(); await this.writer.catch(() => undefined);
            const phase = this.stopped ? "interrupted" : "failed", message = error instanceof Error ? error.message : String(error);
            const terminal: ScanStatus = { ...this.status, phase, message };
            if (this.manifest) {
                const result = this.manifest.result;
                if (discoveryPlan.length && result.discovery.length === 0) result.discovery = reduceScanDiscovery(this.manifest.assets, discoveryPlan, votes);
                result.pairCounts.successful = [...votes.values()].filter(v => !v.error).length;
                result.pairCounts.failed = [...votes.values()].filter(v => v.error).length;
                result.failureDiagnostics = summarizeScanFailures(votes.values());
                result.status = phase; result.reason = "incomplete"; result.error = message; result.globalRankingExact = false; result.bestVerifiedCandidates = [];
                if (/source|revision|implementation|capability/i.test(message)) for (const row of result.finalists) { row.complete = false; row.exactRaw = null; }
                terminal.result = result; this.manifest.status = terminal;
                try { await this.store.saveResult(result); await this.store.saveManifest(this.manifest); }
                catch (writeError) { terminal.message += ` Terminal persistence failed: ${String(writeError)}`; }
            }
            if (reservation && !this.manifest) {
                reservation.status = terminal;
                try { await this.store.saveReservation(this.request.runId, reservation); }
                catch (writeError) { terminal.message += ` Terminal persistence failed: ${String(writeError)}`; }
            }
            return terminal;
        }
    }
}
