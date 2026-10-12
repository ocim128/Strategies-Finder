/**
 * Shared harness for the two Rust-engine admission scripts:
 * `scripts/bench-rust-engine-admission.ts` (raw transport) and
 * `scripts/validate-finder-admission.ts` (end-to-end). Both used to carry
 * byte-identical private copies of everything below; they now share this module
 * so the harness — CLI argument parsing, deterministic data seeding, server
 * lifecycle, and RSS sampling — has a single owner.
 *
 * `ensureReleaseBinary` takes the repo root as a parameter on purpose: each
 * caller resolves its own `ROOT` from `import.meta.dirname`, which is
 * module-scoped and would silently point at `scripts/` instead of the repo root
 * if it were hoisted here.
 *
 * The two `parse*` helpers are local to this harness: their semantics
 * (`--flag value` pairs read straight from `process.argv`, integer fallback on
 * any non-positive value) differ from the `toFinite`/`toPositiveInt` helpers in
 * `./cli-args`, which operate on an already-extracted value.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";

export function parseString(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

export function parseIntOption(name: string, fallback: number): number {
    const index = process.argv.indexOf(`--${name}`);
    const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Deterministic mulberry32 PRNG so every invocation drives the same data. */
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 1);
        t ^= t + (t << 13);
        return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
}

export function ensureReleaseBinary(root: string): void {
    const { status } = spawnSync("cargo", ["build", "--release", "--locked"], {
        cwd: path.join(root, "rust-engine"),
        stdio: "inherit",
    });
    if (status !== 0) throw new Error("cargo build --release failed");
}

export async function waitHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("server did not become healthy in time");
}

export function stopServer(child: ChildProcess | undefined): void {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/F", "/T"], {
            stdio: "ignore",
        });
    } else {
        child.kill("SIGKILL");
    }
}

/**
 * Genuinely asynchronous RSS sampler (spawn, never spawnSync) so the
 * benchmark's event loop is never blocked by a PowerShell cold start. The
 * reported maximum is a SAMPLED maximum and misses transient peaks between
 * samples; it is not true peak RSS.
 */
export type RssSampler = { stop: () => void; sampledMaxRssBytes: () => number | null };

export function sampleRss(pid: number | undefined, intervalMs = 250): RssSampler {
    if (process.platform !== "win32" || pid === undefined) {
        return { stop: () => {}, sampledMaxRssBytes: () => null };
    }
    let peak: number | null = null;
    let inFlight = false;
    const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        const child = spawn(
            "powershell",
            [
                "-NoProfile",
                "-Command",
                `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
        );
        child.stdout.on("data", (chunk: Buffer) => {
            const value = Number.parseInt(chunk.toString().trim(), 10);
            if (Number.isFinite(value) && (peak === null || value > peak)) {
                peak = value;
            }
        });
        child.on("close", () => {
            inFlight = false;
        });
        child.on("error", () => {
            inFlight = false;
        });
    }, intervalMs);
    return {
        stop: () => clearInterval(timer),
        sampledMaxRssBytes: () => peak,
    };
}
